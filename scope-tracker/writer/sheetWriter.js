'use strict';

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

const TAB_FEATURES = 'Features';
const TAB_SCOPE_REGISTRY = 'Scope Registry';
const TAB_CHANGELOG = 'Changelog';
const TAB_RUN_LOG = 'Run Log';

const CHANGELOG_HEADERS = [
  'Timestamp',
  'Feature ID',
  'Source',
  'Decision Type',
  'Reason',
  'Actor',
  'Target Version',
  'Confidence Score',
  'Evidence',
  'Source Message ID',
];

const RUN_LOG_HEADERS = [
  'Run ID',
  'Triggered By',
  'Run Start',
  'Run End',
  'PRD Status',
  'UAT Status',
  'Slack Status',
  'Changelog Entries Added',
  'Errors',
];

const FEATURES_HEADERS = [
  'Feature ID',
  'Feature Name',
  'Target Version',
  'Current Status',
  'PRD Status',
  'UAT Status',
  'Last Updated',
];

const SCOPE_REGISTRY_HEADERS = [
  'Feature ID',
  'Task Name',
  'Status',
  'Source',
  'Target Version',
  'Last Updated',
];

function getAuthClient() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: SCOPES,
  });
}

async function getSheetsClient() {
  const auth = getAuthClient();
  return google.sheets({ version: 'v4', auth });
}

/**
 * Fetch all rows from a tab. Returns { headers, rows, rawValues }.
 */
async function fetchTab(sheets, spreadsheetId, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:ZZ`,
  });
  const values = res.data.values || [];
  if (values.length === 0) return { headers: [], rows: [], rawValues: values };
  const [headers, ...rows] = values;
  return { headers, rows, rawValues: values };
}

/**
 * Ensure a tab exists with the given headers. If tab is missing, create it.
 * If tab exists but has no header row, write headers.
 */
async function ensureTab(sheets, spreadsheetId, tabName, headers) {
  // Check if tab exists
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheets_ = meta.data.sheets || [];
  const exists = sheets_.some((s) => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          { addSheet: { properties: { title: tabName } } },
        ],
      },
    });
    // Write header row
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
    return;
  }

  // Tab exists — check for header row
  const { rawValues } = await fetchTab(sheets, spreadsheetId, tabName);
  if (rawValues.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
}

/**
 * Upsert rows into a tab keyed by a single column (keyField).
 * featureRows: array of objects with keys matching FEATURES_HEADERS or SCOPE_REGISTRY_HEADERS.
 */
async function upsertRows(sheets, spreadsheetId, tabName, tabHeaders, rows, getKey) {
  await ensureTab(sheets, spreadsheetId, tabName, tabHeaders);
  const { headers, rows: existingRows } = await fetchTab(sheets, spreadsheetId, tabName);

  // Use actual headers from sheet if present, otherwise use tabHeaders
  const hdrs = headers.length > 0 ? headers : tabHeaders;
  const colIdx = (name) => hdrs.findIndex((h) => h.trim() === name.trim());

  // Build index: key → row index (1-based, accounting for header row)
  const index = {};
  for (let i = 0; i < existingRows.length; i++) {
    const rowKey = getKey(existingRows[i], hdrs);
    if (rowKey) index[rowKey] = i + 2; // +2 for 1-based + header row
  }

  const updates = [];
  const appends = [];

  for (const rowData of rows) {
    const key = getKey(Object.values(rowData), hdrs, rowData);
    const rowArray = hdrs.map((h) => rowData[h] !== undefined ? String(rowData[h]) : '');

    if (index[key] !== undefined) {
      updates.push({ rowNum: index[key], values: rowArray });
    } else {
      appends.push(rowArray);
    }
  }

  // Apply updates (batch)
  if (updates.length > 0) {
    const data = updates.map(({ rowNum, values }) => ({
      range: `${tabName}!A${rowNum}`,
      values: [values],
    }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data },
    });
  }

  // Append new rows
  if (appends.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: appends },
    });
  }
}

/**
 * Task 3.1 + 3.2: Upsert Features tab — keyed by Feature ID.
 * featureRows: array of { 'Feature ID', 'Feature Name', 'Target Version', ... }
 */
async function upsertFeatures(spreadsheetId, featureRows) {
  const sheets = await getSheetsClient();

  function getKey(row, headers, obj) {
    if (obj) return obj['Feature ID'] || '';
    const i = headers.findIndex((h) => h.trim() === 'Feature ID');
    return (i >= 0 && row[i]) ? row[i] : '';
  }

  await upsertRows(sheets, spreadsheetId, TAB_FEATURES, FEATURES_HEADERS, featureRows, getKey);
}

/**
 * Task 3.3: Upsert Scope Registry — keyed by (Feature ID + Task Name) composite key.
 * scopeRows: array of { 'Feature ID', 'Task Name', 'Status', 'Source', 'Target Version', 'Last Updated' }
 */
async function upsertScopeRegistry(spreadsheetId, scopeRows) {
  const sheets = await getSheetsClient();

  function getKey(row, headers, obj) {
    if (obj) return `${obj['Feature ID']}::${obj['Task Name']}`;
    const fi = headers.findIndex((h) => h.trim() === 'Feature ID');
    const ti = headers.findIndex((h) => h.trim() === 'Task Name');
    const fid = (fi >= 0 && row[fi]) ? row[fi] : '';
    const tname = (ti >= 0 && row[ti]) ? row[ti] : '';
    return `${fid}::${tname}`;
  }

  await upsertRows(sheets, spreadsheetId, TAB_SCOPE_REGISTRY, SCOPE_REGISTRY_HEADERS, scopeRows, getKey);
}

/**
 * Task 3.4: Append changelog entries — deduped by Source Message ID.
 * entries: array of changelog entry objects.
 */
async function appendChangelog(spreadsheetId, entries) {
  if (!entries || entries.length === 0) return;

  const sheets = await getSheetsClient();
  await ensureTab(sheets, spreadsheetId, TAB_CHANGELOG, CHANGELOG_HEADERS);

  // Load existing Source Message IDs for dedup
  const { rows: existingRows, headers } = await fetchTab(sheets, spreadsheetId, TAB_CHANGELOG);
  const hdrs = headers.length > 0 ? headers : CHANGELOG_HEADERS;
  const msgIdIdx = hdrs.findIndex((h) => h.trim() === 'Source Message ID');

  const existingIds = new Set();
  for (const row of existingRows) {
    const id = msgIdIdx >= 0 ? (row[msgIdIdx] || '') : '';
    if (id) existingIds.add(id);
  }

  const toAppend = [];
  for (const entry of entries) {
    const msgId = entry['Source Message ID'] || '';
    if (msgId && existingIds.has(msgId)) continue; // skip duplicate
    const rowArray = CHANGELOG_HEADERS.map((h) => entry[h] !== undefined ? String(entry[h]) : '');
    toAppend.push(rowArray);
  }

  if (toAppend.length === 0) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${TAB_CHANGELOG}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: toAppend },
  });

  return toAppend.length;
}

/**
 * Task 3.5: Append Run Log — always append, never update.
 */
async function appendRunLog(spreadsheetId, runLogEntry) {
  const sheets = await getSheetsClient();
  await ensureTab(sheets, spreadsheetId, TAB_RUN_LOG, RUN_LOG_HEADERS);

  const rowArray = RUN_LOG_HEADERS.map((h) =>
    runLogEntry[h] !== undefined ? String(runLogEntry[h]) : ''
  );

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${TAB_RUN_LOG}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowArray] },
  });
}

/**
 * Extract the task name from a Source Message ID.
 *
 * Formats:
 *   uat::featureId::issueText::uatStatus  → issueText
 *   prd::featureId::featureName::hash     → featureName
 *   slack::featureId::channelId::ts       → (falls back to Reason)
 *
 * Returns the segment between the 2nd and 3rd "::" delimiters.
 */
function extractTaskName(sourceMessageId, fallback) {
  if (!sourceMessageId) return fallback;
  const parts = sourceMessageId.split('::');
  // parts[0]=source, parts[1]=featureId, parts[2]=taskName/issue, parts[3]=extra
  const extracted = parts.length >= 3 ? parts[2] : '';
  return extracted || fallback;
}

/**
 * Read the full Changelog tab and rollup into Scope Registry entries.
 * Keeps the latest entry per (Feature ID + Task Name) as the source of truth.
 * Task Name is derived from Source Message ID (the actual issue/feature text),
 * not from Reason (which is just the disposition like "Pushed to next release").
 */
async function rollupChangelogToScopeRegistry(spreadsheetId) {
  const sheets = await getSheetsClient();
  await ensureTab(sheets, spreadsheetId, TAB_CHANGELOG, CHANGELOG_HEADERS);
  const { headers, rows } = await fetchTab(sheets, spreadsheetId, TAB_CHANGELOG);
  if (rows.length === 0) return;

  const hdrs = headers.length > 0 ? headers : CHANGELOG_HEADERS;
  const col = (name) => hdrs.findIndex((h) => h.trim() === name.trim());

  const tsIdx = col('Timestamp');
  const fidIdx = col('Feature ID');
  const srcIdx = col('Source');
  const dtIdx = col('Decision Type');
  const reasonIdx = col('Reason');
  const tvIdx = col('Target Version');
  const msgIdIdx = col('Source Message ID');

  // Deduplicate: latest entry per (Feature ID + Task Name)
  const registryMap = {};
  for (const row of rows) {
    const featureId = (fidIdx >= 0 && row[fidIdx]) || '';
    const reason = (reasonIdx >= 0 && row[reasonIdx]) || '';
    const sourceMessageId = (msgIdIdx >= 0 && row[msgIdIdx]) || '';
    const taskName = extractTaskName(sourceMessageId, reason);
    if (!featureId || !taskName) continue;

    const key = `${featureId}::${taskName}`;
    const ts = (tsIdx >= 0 && row[tsIdx]) || '';

    if (!registryMap[key] || ts > registryMap[key].ts) {
      registryMap[key] = {
        ts,
        'Feature ID': featureId,
        'Task Name': taskName,
        'Status': (dtIdx >= 0 && row[dtIdx]) || '',
        'Source': (srcIdx >= 0 && row[srcIdx]) || '',
        'Target Version': (tvIdx >= 0 && row[tvIdx]) || '',
        'Last Updated': ts || new Date().toISOString(),
      };
    }
  }

  const scopeRows = Object.values(registryMap).map(({ ts, ...rest }) => rest);
  if (scopeRows.length > 0) {
    await upsertScopeRegistry(spreadsheetId, scopeRows);
  }
}

/**
 * Task 3.6: writeAll — accepts aggregated result and calls all writers.
 *
 * The orchestrator passes aggregated results grouped per output sheet.
 * aggregated is an array of { spreadsheetId, features, scopeRegistry, changelog }
 */
async function writeAll(aggregatedList) {
  for (const agg of aggregatedList) {
    const { spreadsheetId, features, changelog } = agg;

    const featureRows = (features || []).map((f) => ({
      'Feature ID': f.featureId || '',
      'Feature Name': f.featureName || '',
      'Target Version': f.targetVersion || '',
      'Current Status': f.currentStatus || '',
      'PRD Status': f.prdStatus || '',
      'UAT Status': f.uatStatus || '',
      'Last Updated': new Date().toISOString(),
    }));

    const changelogEntries = (changelog || []).map((c) => ({
      'Timestamp': c.timestamp || new Date().toISOString(),
      'Feature ID': c.featureId || '',
      'Source': c.source || '',
      'Decision Type': c.decisionType || '',
      'Reason': c.reason || '',
      'Actor': c.actor || '',
      'Target Version': c.targetVersion || '',
      'Confidence Score': c.confidenceScore !== undefined ? c.confidenceScore : '',
      'Evidence': c.evidence || '',
      'Source Message ID': c.sourceMessageId || '',
    }));

    // Write features and changelog first
    await Promise.all([
      featureRows.length > 0 ? upsertFeatures(spreadsheetId, featureRows) : Promise.resolve(),
      changelogEntries.length > 0 ? appendChangelog(spreadsheetId, changelogEntries) : Promise.resolve(),
    ]);

    // Then rollup the full changelog into Scope Registry
    await rollupChangelogToScopeRegistry(spreadsheetId);
  }
}

module.exports = {
  upsertFeatures,
  upsertScopeRegistry,
  appendChangelog,
  appendRunLog,
  writeAll,
};
