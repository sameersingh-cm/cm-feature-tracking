'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const confluenceClient = require('../utils/confluenceClient');
const { extractFeatures } = require('../ai/prdExtractor');
const { diff } = require('../utils/diffEngine');
const { toIST } = require('../utils/ist');
const logger = require('../utils/logger');

const RUN_STATE_PATH = path.join(__dirname, '../state/runState.json');

// ---------------------------------------------------------------------------
// runState helpers (Task 4.4 — snapshot storage)
// ---------------------------------------------------------------------------

function loadRunState() {
  try {
    const raw = fs.readFileSync(RUN_STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { lastSlackRun: null, features: {} };
  }
}

function saveRunState(state) {
  fs.writeFileSync(RUN_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Load the previous PRD snapshot for a feature.
 * @returns {{ snapshot: Array|null, snapshotTimestamp: string|null }}
 */
function loadSnapshot(featureId) {
  const state = loadRunState();
  const entry = state.features?.[featureId];
  if (!entry || !entry.prdSnapshot) return { snapshot: null, snapshotTimestamp: null };
  return { snapshot: entry.prdSnapshot, snapshotTimestamp: entry.prdSnapshotTimestamp || null };
}

/**
 * Persist a new PRD snapshot for a feature.
 */
function saveSnapshot(featureId, snapshot) {
  const state = loadRunState();
  if (!state.features) state.features = {};
  if (!state.features[featureId]) state.features[featureId] = {};
  state.features[featureId].prdSnapshot = snapshot;
  state.features[featureId].prdSnapshotTimestamp = toIST();
  saveRunState(state);
}

// ---------------------------------------------------------------------------
// Changelog entry builder
// ---------------------------------------------------------------------------

function hashFeature(feature) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(feature))
    .digest('hex')
    .slice(0, 8);
}

function buildChangelogEntry(featureId, featureName, type, feature, previous = null) {
  const now = toIST();
  const evidenceParts = [];
  if (previous) evidenceParts.push(`Previous: ${JSON.stringify(previous)}`);
  evidenceParts.push(`Current: ${JSON.stringify(feature)}`);

  return {
    timestamp: now,
    featureId,
    source: 'prd',
    decisionType: type,
    reason: feature.description || feature.name || '',
    actor: '',
    targetVersion: feature.targetVersion || '',
    confidenceScore: 1.0,
    evidence: evidenceParts.join(' → '),
    sourceMessageId: `prd::${featureId}::${feature.name || ''}::${hashFeature(feature)}`,
  };
}

// ---------------------------------------------------------------------------
// Per-feature PRD run (Task 4.6)
// ---------------------------------------------------------------------------

async function runFeature(feature) {
  const { featureId, featureName, prdPageId } = feature;
  const changelog = [];
  const errors = [];

  if (!prdPageId) return { featureId, changelog, errors };

  // a. Fetch Confluence page and strip HTML
  let pageText;
  try {
    pageText = await confluenceClient.getPage(prdPageId);
  } catch (err) {
    logger.error('prd', `Confluence fetch failed for feature ${featureId}, pageId=${prdPageId}`, { error: err.message });
    errors.push({ pipeline: 'prd', feature: featureId, error: err.message });
    return { featureId, changelog, errors };
  }

  // b. Extract structured feature list via Claude
  let extracted;
  try {
    extracted = await extractFeatures(pageText, featureName);
  } catch (err) {
    logger.error('prd', `Feature extraction failed for ${featureId}`, { error: err.message });
    errors.push({ pipeline: 'prd', feature: featureId, error: err.message });
    return { featureId, changelog, errors };
  }

  // c. Load previous snapshot
  const { snapshot: prevSnapshot } = loadSnapshot(featureId);

  // d. Diff
  const { added, removed, modified } = diff(prevSnapshot, extracted);

  // e. Build changelog entries (only if not first run)
  if (prevSnapshot !== null) {
    for (const f of added) {
      changelog.push(buildChangelogEntry(featureId, featureName, 'scope_change', f));
    }
    for (const f of removed) {
      changelog.push(buildChangelogEntry(featureId, featureName, 'parking', f));
    }
    for (const { previous: prev, current: curr } of modified) {
      changelog.push(buildChangelogEntry(featureId, featureName, 'scope_change', curr, prev));
    }
  }

  // f. Build scope registry entries from current extracted state
  const scopeRegistry = extracted.map((f) => ({
    featureId,
    taskName: f.name || '',
    status: f.status || '',
    source: 'prd',
    targetVersion: f.targetVersion || '',
  }));

  // g. Store new snapshot with timestamp
  saveSnapshot(featureId, extracted);

  return { featureId, changelog, scopeRegistry, errors };
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
  const allScopeRegistry = [];
  const allErrors = [];

  const featuresWithPrd = activeFeatures.filter((f) => f.prdPageId);

  // Run per-feature with individual error isolation
  const results = await Promise.allSettled(
    featuresWithPrd.map((f) => runFeature(f))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { changelog, scopeRegistry, errors } = result.value;
      allChangelog.push(...changelog);
      if (scopeRegistry) allScopeRegistry.push(...scopeRegistry);
      allErrors.push(...errors);
    } else {
      // Unexpected rejection — capture it
      allErrors.push({ pipeline: 'prd', feature: 'unknown', error: result.reason?.message || String(result.reason) });
    }
  }

  return { changelog: allChangelog, scopeRegistry: allScopeRegistry, errors: allErrors };
}

module.exports = { run };
