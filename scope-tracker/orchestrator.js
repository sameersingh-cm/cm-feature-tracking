'use strict';

const { google } = require('googleapis');

const configReader = require('./config/configReader');
const prdPipeline = require('./pipelines/prdPipeline');
const uatPipeline = require('./pipelines/uatPipeline');
const slackPipeline = require('./pipelines/slackPipeline');
const sheetWriter = require('./writer/sheetWriter');
const logger = require('./utils/logger');
const { withRetry } = require('./utils/retry');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateRunId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `run_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * Unwrap a Promise.allSettled result. If rejected, log and return empty result.
 */
function getSettledResult(settled, pipelineName) {
  if (settled.status === 'fulfilled') return settled.value;
  logger.error('orchestrator', `${pipelineName} pipeline rejected`, {
    error: settled.reason?.message || String(settled.reason),
  });
  return {
    changelog: [],
    errors: [{ pipeline: pipelineName, error: settled.reason?.message || String(settled.reason) }],
  };
}

// ---------------------------------------------------------------------------
// Task 7.2 — Result aggregator
// ---------------------------------------------------------------------------

/**
 * Merge results from all 3 pipelines into per-output-sheet buckets.
 *
 * @param {{ changelog: Array, errors: Array }} prd
 * @param {{ changelog: Array, errors: Array }} uat
 * @param {{ changelog: Array, errors: Array }} slack
 * @param {Array} activeFeatures
 * @returns {{ aggregatedList, allErrors, prdStatus, uatStatus, slackStatus, changelogEntriesAdded }}
 */
function aggregateResults(prd, uat, slack, activeFeatures) {
  const featureMap = {};
  for (const f of activeFeatures) featureMap[f.featureId] = f;

  const allChangelog = [...prd.changelog, ...uat.changelog, ...slack.changelog];
  const allErrors = [...prd.errors, ...uat.errors, ...slack.errors];

  // Build per-sheet buckets
  const sheetMap = {};

  const getOrCreate = (spreadsheetId) => {
    if (!sheetMap[spreadsheetId]) {
      sheetMap[spreadsheetId] = { spreadsheetId, features: [], scopeRegistry: [], changelog: [] };
    }
    return sheetMap[spreadsheetId];
  };

  // One feature row per active feature (upserted into Features tab)
  for (const f of activeFeatures) {
    if (!f.outputSheetId) continue;
    const bucket = getOrCreate(f.outputSheetId);
    const featurePrdErrors = prd.errors.filter((e) => e.feature === f.featureId);
    const featureUatErrors = uat.errors.filter((e) => e.feature === f.featureId);
    bucket.features.push({
      featureId: f.featureId,
      featureName: f.featureName,
      targetVersion: f.targetVersion,
      currentStatus: f.currentStatus,
      prdStatus: featurePrdErrors.length === 0 ? 'ok' : 'error',
      uatStatus: featureUatErrors.length === 0 ? 'ok' : 'error',
    });
  }

  // Distribute changelog entries to the correct output sheet
  for (const entry of allChangelog) {
    const feature = featureMap[entry.featureId];
    const spreadsheetId = feature?.outputSheetId;
    if (!spreadsheetId) continue;
    getOrCreate(spreadsheetId).changelog.push(entry);
  }

  const prdStatus = prd.errors.length === 0 ? 'success' : 'partial';
  const uatStatus = uat.errors.length === 0 ? 'success' : 'partial';
  const slackStatus = slack.errors.length === 0 ? 'success' : 'partial';

  return {
    aggregatedList: Object.values(sheetMap),
    allErrors,
    prdStatus,
    uatStatus,
    slackStatus,
    changelogEntriesAdded: allChangelog.length,
  };
}

// ---------------------------------------------------------------------------
// Task 7.3 — Update Run State in config sheet Tab 3
// ---------------------------------------------------------------------------

async function updateConfigRunState(activeFeatures) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.CONFIG_SHEET_ID;
    const now = new Date().toISOString();

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Run State!A:D',
    });
    const values = res.data.values || [];

    if (values.length === 0) {
      // Tab empty — write headers + all feature rows
      const newValues = [
        ['Feature ID', 'Last PRD Run', 'Last Slack Run', 'Last UAT Run'],
        ...activeFeatures.map((f) => [f.featureId, now, now, now]),
      ];
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'Run State!A1',
        valueInputOption: 'RAW',
        requestBody: { values: newValues },
      });
      return;
    }

    const [headers, ...rows] = values;
    const fidIdx = headers.findIndex((h) => h.trim().toLowerCase() === 'feature id');

    // Build row-number index (1-based, +1 for header)
    const index = {};
    for (let i = 0; i < rows.length; i++) {
      const fid = rows[i][fidIdx] || '';
      if (fid) index[fid] = i + 2;
    }

    const updates = [];
    const appends = [];

    for (const f of activeFeatures) {
      const rowValues = [f.featureId, now, now, now];
      if (index[f.featureId]) {
        updates.push({ range: `Run State!A${index[f.featureId]}`, values: [rowValues] });
      } else {
        appends.push(rowValues);
      }
    }

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data: updates },
      });
    }
    if (appends.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'Run State!A1',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: appends },
      });
    }

    logger.info('orchestrator', 'Run State updated in config sheet', { features: activeFeatures.length });
  } catch (err) {
    logger.warn('orchestrator', 'Failed to update Run State in config sheet', { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Task 7.1 — Main pipeline orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full pipeline.
 *
 * @param {'scheduled'|'manual'} triggerType
 * @returns {Promise<Object>} Run summary
 */
async function runPipeline(triggerType = 'scheduled') {
  const runId = generateRunId();
  const runStart = new Date();

  logger.info('orchestrator', 'Run started', { runId, triggerType });

  // Load config — retry up to 3 times
  let activeFeatures;
  try {
    activeFeatures = await withRetry(() => configReader.load());
    logger.info('orchestrator', 'Config loaded', { features: activeFeatures.length });
  } catch (err) {
    logger.error('orchestrator', 'Failed to load config after retries', { error: err.message });
    throw err;
  }

  // Run all 3 pipelines in parallel; one failure must never stop the others
  logger.info('orchestrator', 'Starting all pipelines');

  const [prdSettled, uatSettled, slackSettled] = await Promise.allSettled([
    (async () => {
      logger.info('prd', 'Pipeline started');
      const result = await prdPipeline.run(activeFeatures);
      logger.info('prd', 'Pipeline complete', {
        changelog: result.changelog.length,
        errors: result.errors.length,
      });
      return result;
    })(),
    (async () => {
      logger.info('uat', 'Pipeline started');
      const result = await uatPipeline.run(activeFeatures);
      logger.info('uat', 'Pipeline complete', {
        changelog: result.changelog.length,
        errors: result.errors.length,
      });
      return result;
    })(),
    (async () => {
      logger.info('slack', 'Pipeline started');
      const result = await slackPipeline.run(activeFeatures);
      logger.info('slack', 'Pipeline complete', {
        changelog: result.changelog.length,
        errors: result.errors.length,
      });
      return result;
    })(),
  ]);

  const prd = getSettledResult(prdSettled, 'prd');
  const uat = getSettledResult(uatSettled, 'uat');
  const slack = getSettledResult(slackSettled, 'slack');

  const { aggregatedList, allErrors, prdStatus, uatStatus, slackStatus, changelogEntriesAdded } =
    aggregateResults(prd, uat, slack, activeFeatures);

  // Write output sheets
  if (aggregatedList.length > 0) {
    logger.info('orchestrator', 'Writing output sheets', { sheets: aggregatedList.length });
    try {
      await withRetry(() => sheetWriter.writeAll(aggregatedList));
    } catch (err) {
      logger.error('orchestrator', 'Failed to write output sheets after retries', { error: err.message });
      allErrors.push({ pipeline: 'writer', error: err.message });
    }
  }

  const runEnd = new Date();
  const duration = Math.round((runEnd - runStart) / 1000);

  // Append run log entry to each output sheet
  const runLogEntry = {
    'Run ID': runId,
    'Triggered By': triggerType,
    'Run Start': runStart.toISOString(),
    'Run End': runEnd.toISOString(),
    'PRD Status': prdStatus,
    'UAT Status': uatStatus,
    'Slack Status': slackStatus,
    'Changelog Entries Added': String(changelogEntriesAdded),
    'Errors': allErrors.length > 0 ? JSON.stringify(allErrors) : '',
  };

  for (const agg of aggregatedList) {
    try {
      await sheetWriter.appendRunLog(agg.spreadsheetId, runLogEntry);
    } catch (err) {
      logger.warn('orchestrator', 'Failed to write run log', {
        sheet: agg.spreadsheetId,
        error: err.message,
      });
    }
  }

  // Update Run State in config sheet Tab 3
  await updateConfigRunState(activeFeatures);

  const summary = {
    runId,
    triggeredBy: triggerType,
    duration,
    featuresProcessed: activeFeatures.length,
    changelogEntriesAdded,
    prdStatus,
    uatStatus,
    slackStatus,
    errors: allErrors,
  };

  logger.info('orchestrator', 'Run complete', {
    runId,
    duration,
    changelogEntriesAdded,
    errors: allErrors.length,
  });

  return summary;
}

module.exports = { runPipeline };
