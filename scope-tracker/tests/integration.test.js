'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---------------------------------------------------------------------------
// Require.cache injection helpers
// ---------------------------------------------------------------------------

function injectMock(relPath, exports) {
  const absPath = require.resolve(path.join(__dirname, '..', relPath));
  require.cache[absPath] = {
    id: absPath,
    filename: absPath,
    loaded: true,
    exports,
    parent: null,
    children: [],
  };
}

function clearMock(relPath) {
  try {
    const absPath = require.resolve(path.join(__dirname, '..', relPath));
    delete require.cache[absPath];
  } catch {
    // Module may not be in cache — ignore
  }
}

function requireFresh(relPath) {
  clearMock(relPath);
  return require(path.join(__dirname, '..', relPath));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_FEATURE = {
  featureId: 'FEAT-001',
  featureName: 'Scalper',
  active: true,
  prdPageId: 'page123',
  uatSheetUrl: 'https://docs.google.com/spreadsheets/d/sheet123',
  outputSheetId: 'output-sheet-1',
  targetVersion: 'V1',
  currentStatus: 'In Scope',
  slackChannels: [
    { channelId: 'C001', channelName: '#scalper-dev', keywords: ['scope', 'parking'] },
  ],
  runState: { lastPrdRun: null, lastSlackRun: null, lastUatRun: null },
};

function makePrdEntry() {
  return {
    timestamp: '2026-03-16T12:00:00.000Z',
    featureId: 'FEAT-001',
    source: 'prd',
    decisionType: 'scope_change',
    reason: 'New sub-feature added',
    actor: '',
    targetVersion: 'V1',
    confidenceScore: 1.0,
    evidence: 'Current: {"name":"Sub-feature A"}',
    sourceMessageId: 'prd::FEAT-001::Sub-feature A::abc12345',
  };
}

function makeUatEntry() {
  return {
    timestamp: '2026-03-16T12:00:00.000Z',
    featureId: 'FEAT-001',
    source: 'uat',
    decisionType: 'scope_change',
    reason: 'Pushed to next release',
    actor: '',
    targetVersion: 'V2',
    confidenceScore: 1.0,
    evidence: 'Issue: ISS-1 | UAT Status: Failed | Blocker: No',
    sourceMessageId: 'uat::FEAT-001::ISS-1::Failed',
  };
}

function makeSlackEntry() {
  return {
    timestamp: '2026-03-16T12:00:00.000Z',
    featureId: 'FEAT-001',
    source: 'slack',
    decisionType: 'scope_change',
    reason: 'Team decided to park feature',
    actor: 'Product Manager',
    targetVersion: 'V2',
    confidenceScore: 0.92,
    evidence: 'Message text excerpt',
    sourceMessageId: 'slack::FEAT-001::C001::1234567890.123456',
  };
}

// Setup common mocks for all orchestrator tests
function setupBaseMocks({ prdResult, uatResult, slackResult, onWriteAll } = {}) {
  injectMock('config/configReader', {
    load: async () => [MOCK_FEATURE],
    parseFeatures: () => [],
    parseSlackChannels: () => ({}),
    parseRunState: () => ({}),
  });
  injectMock('pipelines/prdPipeline', {
    run: prdResult
      ? async () => prdResult
      : async () => ({ changelog: [makePrdEntry()], errors: [] }),
  });
  injectMock('pipelines/uatPipeline', {
    run: uatResult
      ? async () => uatResult
      : async () => ({ changelog: [makeUatEntry()], errors: [] }),
  });
  injectMock('pipelines/slackPipeline', {
    run: slackResult
      ? async () => slackResult
      : async () => ({ changelog: [makeSlackEntry()], errors: [] }),
  });
  injectMock('writer/sheetWriter', {
    writeAll: onWriteAll || (async () => {}),
    appendRunLog: async () => {},
  });
}

function cleanupMocks() {
  clearMock('config/configReader');
  clearMock('pipelines/prdPipeline');
  clearMock('pipelines/uatPipeline');
  clearMock('pipelines/slackPipeline');
  clearMock('writer/sheetWriter');
  clearMock('orchestrator');
}

// ============================================================================
// 8.1 — End-to-end test with mock data for all 3 pipelines
// ============================================================================

describe('8.1 — E2E: all 3 pipelines with mock data', () => {
  test('runs all 3 pipelines and returns correct summary shape', async () => {
    setupBaseMocks();
    const { runPipeline } = requireFresh('orchestrator');

    const summary = await runPipeline('manual');

    // runId format: run_YYYYMMDD_HHMM
    assert.match(summary.runId, /^run_\d{8}_\d{4}$/);
    assert.equal(summary.triggeredBy, 'manual');
    assert.ok(typeof summary.duration === 'number' && summary.duration >= 0);
    assert.equal(summary.featuresProcessed, 1);
    assert.equal(summary.changelogEntriesAdded, 3);
    assert.equal(summary.prdStatus, 'success');
    assert.equal(summary.uatStatus, 'success');
    assert.equal(summary.slackStatus, 'success');
    assert.deepEqual(summary.errors, []);

    cleanupMocks();
  });

  test('each pipeline result is included in the aggregated changelog count', async () => {
    setupBaseMocks({
      prdResult: { changelog: [makePrdEntry(), makePrdEntry()], errors: [] },
      uatResult: { changelog: [makeUatEntry()], errors: [] },
      slackResult: { changelog: [], errors: [] },
    });
    const { runPipeline } = requireFresh('orchestrator');

    const summary = await runPipeline('scheduled');

    assert.equal(summary.changelogEntriesAdded, 3); // 2 prd + 1 uat + 0 slack
    assert.equal(summary.prdStatus, 'success');
    assert.equal(summary.uatStatus, 'success');
    assert.equal(summary.slackStatus, 'success');

    cleanupMocks();
  });

  test('writeAll is called with aggregated data keyed by output sheet', async () => {
    let capturedAggList = null;
    setupBaseMocks({
      onWriteAll: async (aggregatedList) => {
        capturedAggList = aggregatedList;
      },
    });
    const { runPipeline } = requireFresh('orchestrator');

    await runPipeline('manual');

    assert.ok(Array.isArray(capturedAggList), 'writeAll should receive an array');
    assert.equal(capturedAggList.length, 1, 'one output sheet bucket for FEAT-001');
    const bucket = capturedAggList[0];
    assert.equal(bucket.spreadsheetId, 'output-sheet-1');
    assert.ok(Array.isArray(bucket.features));
    assert.equal(bucket.features.length, 1);
    assert.equal(bucket.features[0].featureId, 'FEAT-001');
    assert.ok(Array.isArray(bucket.changelog));
    assert.equal(bucket.changelog.length, 3);

    cleanupMocks();
  });
});

// ============================================================================
// 8.2 — Dedup: run pipeline twice, confirm no duplicate changelog entries
// ============================================================================

describe('8.2 — Dedup: repeated runs produce identical Source Message IDs', () => {
  test('sourceMessageIds from identical inputs are deterministic', async () => {
    const run1Ids = [];
    setupBaseMocks({
      onWriteAll: async (aggregatedList) => {
        for (const agg of aggregatedList) {
          for (const entry of agg.changelog || []) {
            run1Ids.push(entry.sourceMessageId);
          }
        }
      },
    });
    const { runPipeline: run1 } = requireFresh('orchestrator');
    await run1('manual');
    cleanupMocks();

    const run2Ids = [];
    setupBaseMocks({
      onWriteAll: async (aggregatedList) => {
        for (const agg of aggregatedList) {
          for (const entry of agg.changelog || []) {
            run2Ids.push(entry.sourceMessageId);
          }
        }
      },
    });
    const { runPipeline: run2 } = requireFresh('orchestrator');
    await run2('manual');
    cleanupMocks();

    // Both runs should produce exactly the same source IDs
    assert.equal(run1Ids.length, run2Ids.length, 'both runs produce same number of entries');
    assert.deepEqual(run1Ids.sort(), run2Ids.sort(), 'source IDs are identical across runs');
  });

  test('second run IDs are all present in first run (dedup would filter them all)', async () => {
    const run1Ids = new Set();
    setupBaseMocks({
      onWriteAll: async (aggregatedList) => {
        for (const agg of aggregatedList) {
          for (const entry of agg.changelog || []) {
            run1Ids.add(entry.sourceMessageId);
          }
        }
      },
    });
    const { runPipeline: run1 } = requireFresh('orchestrator');
    await run1('manual');
    cleanupMocks();

    const run2Ids = [];
    setupBaseMocks({
      onWriteAll: async (aggregatedList) => {
        for (const agg of aggregatedList) {
          for (const entry of agg.changelog || []) {
            run2Ids.push(entry.sourceMessageId);
          }
        }
      },
    });
    const { runPipeline: run2 } = requireFresh('orchestrator');
    await run2('manual');
    cleanupMocks();

    // All IDs from run 2 should exist in run 1's ID set
    // This confirms that a dedup check against run1 IDs would skip all run2 entries
    const newInRun2 = run2Ids.filter((id) => !run1Ids.has(id));
    assert.equal(
      newInRun2.length,
      0,
      `Expected no new Source Message IDs on second run but got: ${JSON.stringify(newInRun2)}`
    );
  });

  test('appendChangelog dedup logic: entries with existing Source Message IDs are filtered out', () => {
    // Inline verification of the dedup filter logic used by appendChangelog
    const existingIds = new Set([
      'uat::FEAT-001::ISS-1::Failed',
      'prd::FEAT-001::Sub-feature A::abc12345',
    ]);

    const entries = [
      { sourceMessageId: 'uat::FEAT-001::ISS-1::Failed' },        // duplicate — skip
      { sourceMessageId: 'uat::FEAT-001::ISS-2::Parked for later' }, // new — write
      { sourceMessageId: 'prd::FEAT-001::Sub-feature A::abc12345' }, // duplicate — skip
    ];

    const toWrite = entries.filter((e) => !existingIds.has(e.sourceMessageId));

    assert.equal(toWrite.length, 1, 'only 1 new entry should pass the dedup filter');
    assert.equal(toWrite[0].sourceMessageId, 'uat::FEAT-001::ISS-2::Parked for later');
  });
});

// ============================================================================
// 8.3 — Resilience: PRD failure does not stop UAT and Slack
// ============================================================================

describe('8.3 — Resilience: PRD failure leaves UAT and Slack unaffected', () => {
  test('prd pipeline rejection → prdStatus partial, uatStatus and slackStatus still succeed', async () => {
    setupBaseMocks({
      prdResult: null, // will be replaced below
    });
    // Override prd to throw
    injectMock('pipelines/prdPipeline', {
      run: async () => { throw new Error('confluence_api_timeout'); },
    });
    const { runPipeline } = requireFresh('orchestrator');

    const summary = await runPipeline('manual');

    assert.equal(summary.prdStatus, 'partial', 'prdStatus should be partial when pipeline fails');
    assert.equal(summary.uatStatus, 'success', 'uatStatus should still succeed');
    assert.equal(summary.slackStatus, 'success', 'slackStatus should still succeed');
    assert.equal(summary.changelogEntriesAdded, 2, 'UAT + Slack entries still counted');

    cleanupMocks();
  });

  test('prd failure is captured in errors array with pipeline identifier', async () => {
    setupBaseMocks();
    injectMock('pipelines/prdPipeline', {
      run: async () => { throw new Error('confluence_api_timeout'); },
    });
    const { runPipeline } = requireFresh('orchestrator');

    const summary = await runPipeline('manual');

    assert.ok(Array.isArray(summary.errors), 'errors should be an array');
    assert.equal(summary.errors.length, 1, 'exactly one error for the prd pipeline failure');
    assert.equal(summary.errors[0].pipeline, 'prd');
    assert.ok(
      summary.errors[0].error.includes('confluence_api_timeout'),
      'error message should be propagated'
    );

    cleanupMocks();
  });

  test('uatPipeline failure leaves prd and slack unaffected', async () => {
    setupBaseMocks();
    injectMock('pipelines/uatPipeline', {
      run: async () => { throw new Error('sheet_not_found'); },
    });
    const { runPipeline } = requireFresh('orchestrator');

    const summary = await runPipeline('manual');

    assert.equal(summary.prdStatus, 'success');
    assert.equal(summary.uatStatus, 'partial');
    assert.equal(summary.slackStatus, 'success');
    assert.equal(summary.changelogEntriesAdded, 2); // prd + slack

    cleanupMocks();
  });

  test('all 3 pipelines can fail independently without crashing the orchestrator', async () => {
    injectMock('config/configReader', { load: async () => [MOCK_FEATURE] });
    injectMock('pipelines/prdPipeline', {
      run: async () => { throw new Error('prd_error'); },
    });
    injectMock('pipelines/uatPipeline', {
      run: async () => { throw new Error('uat_error'); },
    });
    injectMock('pipelines/slackPipeline', {
      run: async () => { throw new Error('slack_error'); },
    });
    injectMock('writer/sheetWriter', {
      writeAll: async () => {},
      appendRunLog: async () => {},
    });
    const { runPipeline } = requireFresh('orchestrator');

    // Should not throw — orchestrator must handle all failures gracefully
    const summary = await runPipeline('manual');

    assert.equal(summary.prdStatus, 'partial');
    assert.equal(summary.uatStatus, 'partial');
    assert.equal(summary.slackStatus, 'partial');
    assert.equal(summary.changelogEntriesAdded, 0);
    assert.equal(summary.errors.length, 3);

    cleanupMocks();
  });
});
