'use strict';

const { fetchUatSheet } = require('../uat/uatSheetReader');
const { applyRules, DISPOSITION } = require('../uat/rulesEngine');
const { toIST } = require('../utils/ist');

// ---------------------------------------------------------------------------
// Changelog entry builder
// ---------------------------------------------------------------------------

function buildChangelogEntry(featureId, issue, ruleResult, headers, row) {
  const { disposition, targetVersion, note } = ruleResult;

  // Map disposition to decision type
  const decisionTypeMap = {
    [DISPOSITION.PUSHED]: 'scope_change',
    [DISPOSITION.ACTIVE_BLOCKER]: 'blocker',
    [DISPOSITION.PARKED]: 'parking',
  };

  const uatStatusVal = getCellByName(headers, row, 'uat_status') || '';
  const blockerVal = getCellByName(headers, row, 'blocker') || '';

  const evidence = [
    `Issue: ${issue}`,
    `UAT Status: ${uatStatusVal}`,
    `Blocker: ${blockerVal}`,
    note ? `Note: ${note}` : '',
  ]
    .filter(Boolean)
    .join(' | ');

  // Source message ID: stable per (featureId, issue, uatStatus)
  const sourceMessageId = `uat::${featureId}::${issue}::${uatStatusVal}`;

  return {
    timestamp: toIST(),
    featureId,
    source: 'uat',
    decisionType: decisionTypeMap[disposition],
    reason: note || disposition,
    actor: '',
    targetVersion,
    confidenceScore: 1.0,
    evidence,
    sourceMessageId,
  };
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/**
 * Build a normalised header index from the headers array.
 * @param {string[]} headers
 * @returns {Object} map of normalised header name → column index
 */
function buildHeaderIndex(headers) {
  const index = {};
  headers.forEach((h, i) => {
    index[h.trim().toLowerCase().replace(/\s+/g, '_')] = i;
  });
  return index;
}

function getCell(headerIndex, row, normKey) {
  const i = headerIndex[normKey];
  return i !== undefined ? (row[i] || '') : '';
}

function getCellByName(headers, row, normKey) {
  const index = buildHeaderIndex(headers);
  return getCell(index, row, normKey);
}

// ---------------------------------------------------------------------------
// Per-feature UAT run
// ---------------------------------------------------------------------------

async function runFeature(feature) {
  const { featureId, uatSheetUrl, targetVersion } = feature;
  const changelog = [];
  const errors = [];

  if (!uatSheetUrl) return { featureId, changelog, errors };

  let sheetData;
  try {
    sheetData = await fetchUatSheet(uatSheetUrl);
  } catch (err) {
    errors.push({ pipeline: 'uat', feature: featureId, error: err.message });
    return { featureId, changelog, errors };
  }

  const { headers, rows, activeUatStatusIndex } = sheetData;

  if (activeUatStatusIndex === null) {
    errors.push({
      pipeline: 'uat',
      feature: featureId,
      error: 'No UAT Status column found in sheet',
    });
    return { featureId, changelog, errors };
  }

  const headerIndex = buildHeaderIndex(headers);

  // Find the Blocker column index (flexible name matching)
  const blockerKey = Object.keys(headerIndex).find((k) => k.includes('blocker'));

  for (const row of rows) {
    const issue = getCell(headerIndex, row, 'issue') || getCell(headerIndex, row, 'issue_name') || '';
    if (!issue) continue;

    const uatStatus = row[activeUatStatusIndex] || '';
    const blocker = blockerKey ? getCell(headerIndex, row, blockerKey) : '';

    const ruleResult = applyRules(uatStatus, blocker, targetVersion);

    if (ruleResult.disposition !== DISPOSITION.NO_ACTION) {
      changelog.push(buildChangelogEntry(featureId, issue, ruleResult, headers, row));
    }
  }

  return { featureId, changelog, errors };
}

// ---------------------------------------------------------------------------
// Pipeline entry point
// ---------------------------------------------------------------------------

/**
 * run(activeFeatures)
 *
 * @param {Array<Object>} activeFeatures - Feature manifest from configReader
 * @returns {Promise<{ changelog: Array, errors: Array }>}
 */
async function run(activeFeatures) {
  const allChangelog = [];
  const allErrors = [];

  const featuresWithUat = activeFeatures.filter((f) => f.uatSheetUrl);

  const results = await Promise.allSettled(
    featuresWithUat.map((f) => runFeature(f))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { changelog, errors } = result.value;
      allChangelog.push(...changelog);
      allErrors.push(...errors);
    } else {
      allErrors.push({
        pipeline: 'uat',
        feature: 'unknown',
        error: result.reason?.message || String(result.reason),
      });
    }
  }

  return { changelog: allChangelog, errors: allErrors };
}

module.exports = { run };
