'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseFeatures, parseSlackChannels, parseRunState } = require('../config/configReader');

// --- parseFeatures ---

test('parseFeatures returns structured manifest from sheet rows', () => {
  const rows = [
    ['Feature ID', 'Feature Name', 'Active', 'PRD Page ID', 'UAT Sheet URL', 'Output Sheet ID', 'Target Version', 'Current Status', 'Start Date', 'Notes'],
    ['FEAT-001', 'Scalper', 'Y', 'page123', 'https://sheet.url', 'sheet456', 'V1', 'In Scope', '2024-01-01', 'some notes'],
    ['FEAT-002', 'Analytics', 'N', 'page789', '', 'sheet999', 'V2', 'Parked', '2024-02-01', ''],
  ];

  const result = parseFeatures(rows);

  assert.equal(result.length, 2);
  assert.equal(result[0].featureId, 'FEAT-001');
  assert.equal(result[0].featureName, 'Scalper');
  assert.equal(result[0].active, true);
  assert.equal(result[0].prdPageId, 'page123');
  assert.equal(result[0].targetVersion, 'V1');
  assert.deepEqual(result[0].slackChannels, []);
  assert.deepEqual(result[0].runState, { lastPrdRun: null, lastSlackRun: null, lastUatRun: null });
  assert.equal(result[1].featureId, 'FEAT-002');
  assert.equal(result[1].active, false);
});

test('parseFeatures filters out rows with missing Feature ID', () => {
  const rows = [
    ['Feature ID', 'Feature Name', 'Active'],
    ['', 'Unnamed', 'Y'],
    ['FEAT-001', 'Scalper', 'Y'],
  ];

  const result = parseFeatures(rows);

  assert.equal(result.length, 1);
  assert.equal(result[0].featureId, 'FEAT-001');
});

test('parseFeatures returns empty array when only header row present', () => {
  const rows = [['Feature ID', 'Feature Name', 'Active']];
  assert.deepEqual(parseFeatures(rows), []);
});

test('parseFeatures returns empty array for null/undefined input', () => {
  assert.deepEqual(parseFeatures(null), []);
  assert.deepEqual(parseFeatures(undefined), []);
});

test('parseFeatures treats Active case-insensitively', () => {
  const rows = [
    ['Feature ID', 'Feature Name', 'Active'],
    ['FEAT-001', 'A', 'y'],
    ['FEAT-002', 'B', 'Y'],
    ['FEAT-003', 'C', 'n'],
    ['FEAT-004', 'D', 'N'],
  ];

  const result = parseFeatures(rows);
  assert.equal(result[0].active, true);
  assert.equal(result[1].active, true);
  assert.equal(result[2].active, false);
  assert.equal(result[3].active, false);
});

// --- parseSlackChannels ---

test('parseSlackChannels groups channels by Feature ID', () => {
  const rows = [
    ['Feature ID', 'Channel Name', 'Channel ID', 'Keywords'],
    ['FEAT-001', '#scalper-dev', 'C001', 'scope, parking, blocker'],
    ['FEAT-001', '#scalper-pm', 'C002', 'decision'],
    ['FEAT-002', '#analytics', 'C003', ''],
  ];

  const result = parseSlackChannels(rows);

  assert.equal(result['FEAT-001'].length, 2);
  assert.equal(result['FEAT-001'][0].channelId, 'C001');
  assert.equal(result['FEAT-001'][0].channelName, '#scalper-dev');
  assert.deepEqual(result['FEAT-001'][0].keywords, ['scope', 'parking', 'blocker']);
  assert.equal(result['FEAT-001'][1].channelId, 'C002');
  assert.deepEqual(result['FEAT-001'][1].keywords, ['decision']);
  assert.equal(result['FEAT-002'].length, 1);
  assert.deepEqual(result['FEAT-002'][0].keywords, []);
});

test('parseSlackChannels skips rows with missing Feature ID', () => {
  const rows = [
    ['Feature ID', 'Channel Name', 'Channel ID', 'Keywords'],
    ['', '#orphan', 'C999', ''],
    ['FEAT-001', '#scalper', 'C001', ''],
  ];

  const result = parseSlackChannels(rows);

  assert.equal(Object.keys(result).length, 1);
  assert.ok(result['FEAT-001']);
});

test('parseSlackChannels returns empty object for null input', () => {
  assert.deepEqual(parseSlackChannels(null), {});
});

// --- parseRunState ---

test('parseRunState returns timestamps keyed by Feature ID', () => {
  const rows = [
    ['Feature ID', 'Last PRD Run', 'Last Slack Run', 'Last UAT Run'],
    ['FEAT-001', '2024-03-01T10:00:00Z', '2024-03-01T11:00:00Z', '2024-03-01T09:00:00Z'],
    ['FEAT-002', '', '', ''],
  ];

  const result = parseRunState(rows);

  assert.equal(result['FEAT-001'].lastPrdRun, '2024-03-01T10:00:00Z');
  assert.equal(result['FEAT-001'].lastSlackRun, '2024-03-01T11:00:00Z');
  assert.equal(result['FEAT-001'].lastUatRun, '2024-03-01T09:00:00Z');
  assert.equal(result['FEAT-002'].lastPrdRun, null);
  assert.equal(result['FEAT-002'].lastSlackRun, null);
  assert.equal(result['FEAT-002'].lastUatRun, null);
});

test('parseRunState returns empty object for null input', () => {
  assert.deepEqual(parseRunState(null), {});
});

// --- load() integration: manifest assembly ---

test('parseFeatures + parseSlackChannels + parseRunState compose into full manifest', () => {
  const featureRows = [
    ['Feature ID', 'Feature Name', 'Active', 'PRD Page ID', 'UAT Sheet URL', 'Output Sheet ID', 'Target Version', 'Current Status', 'Start Date', 'Notes'],
    ['FEAT-001', 'Scalper', 'Y', 'p1', 'http://uat', 's1', 'V1', 'In Scope', '2024-01-01', ''],
    ['FEAT-002', 'Parked Feature', 'N', 'p2', '', 's2', 'V2', 'Parked', '2024-02-01', ''],
  ];
  const slackRows = [
    ['Feature ID', 'Channel Name', 'Channel ID', 'Keywords'],
    ['FEAT-001', '#scalper', 'C001', 'scope'],
  ];
  const runStateRows = [
    ['Feature ID', 'Last PRD Run', 'Last Slack Run', 'Last UAT Run'],
    ['FEAT-001', '2024-03-01T10:00:00Z', '2024-03-01T11:00:00Z', ''],
  ];

  const features = parseFeatures(featureRows);
  const slackMap = parseSlackChannels(slackRows);
  const runStateMap = parseRunState(runStateRows);

  for (const f of features) {
    f.slackChannels = slackMap[f.featureId] || [];
    f.runState = runStateMap[f.featureId] || { lastPrdRun: null, lastSlackRun: null, lastUatRun: null };
  }

  const activeFeatures = features.filter((f) => f.active);

  assert.equal(activeFeatures.length, 1);
  assert.equal(activeFeatures[0].featureId, 'FEAT-001');
  assert.equal(activeFeatures[0].slackChannels.length, 1);
  assert.equal(activeFeatures[0].slackChannels[0].channelId, 'C001');
  assert.equal(activeFeatures[0].runState.lastPrdRun, '2024-03-01T10:00:00Z');
  assert.equal(activeFeatures[0].runState.lastUatRun, null);
});
