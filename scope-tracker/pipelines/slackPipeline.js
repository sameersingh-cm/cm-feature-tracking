'use strict';

const fs = require('fs');
const path = require('path');

const { fetchChannelHistory, fetchThread } = require('../slack/slackClient');
const { threadMatchesKeywords } = require('../slack/keywordFilter');
const { classifyThread } = require('../ai/classifier');

const RUN_STATE_PATH = path.join(__dirname, '../state/runState.json');

// ---------------------------------------------------------------------------
// runState helpers
// ---------------------------------------------------------------------------

function loadRunState() {
  try {
    return JSON.parse(fs.readFileSync(RUN_STATE_PATH, 'utf8'));
  } catch {
    return { lastSlackRun: null, features: {} };
  }
}

function saveRunState(state) {
  fs.writeFileSync(RUN_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function getLastSlackRun(featureId) {
  const state = loadRunState();
  return state.features?.[featureId]?.lastSlackRun || null;
}

function saveLastSlackRun(featureId, isoTimestamp) {
  const state = loadRunState();
  if (!state.features) state.features = {};
  if (!state.features[featureId]) state.features[featureId] = {};
  state.features[featureId].lastSlackRun = isoTimestamp;
  saveRunState(state);
}

// ---------------------------------------------------------------------------
// Changelog entry builder
// ---------------------------------------------------------------------------

function buildChangelogEntry(featureId, channelId, parentMsg, classification) {
  return {
    timestamp: new Date().toISOString(),
    featureId,
    source: 'slack',
    decisionType: classification.decision_type || 'discussion',
    reason: classification.reason || '',
    actor: classification.actor || '',
    targetVersion: classification.target_version || '',
    confidenceScore: classification.confidence ?? 0,
    evidence: classification.evidence_excerpt || '',
    sourceMessageId: `slack::${featureId}::${channelId}::${parentMsg.ts}`,
  };
}

// ---------------------------------------------------------------------------
// Per-channel run (task 6.6 — per-channel error isolation)
// ---------------------------------------------------------------------------

async function runChannel(featureId, featureName, channel, lastSlackRunUnix) {
  const { channelId, keywords } = channel;
  const changelog = [];
  const errors = [];

  const logger = require('../utils/logger');

  // Fetch channel history since last run
  let messages;
  try {
    messages = await fetchChannelHistory(channelId, lastSlackRunUnix);
  } catch (err) {
    logger.error('slack', `fetchChannelHistory failed for ${channelId}`, { error: err.message });
    errors.push({ pipeline: 'slack', feature: featureId, channel: channelId, step: 'fetchHistory', error: err.message });
    return { changelog, errors };
  }

  for (const msg of messages) {
    // Skip system/bot messages
    if (msg.subtype) continue;

    // Fetch full thread if replies exist
    let threadMessages;
    if (msg.reply_count && msg.reply_count > 0) {
      try {
        threadMessages = await fetchThread(channelId, msg.ts);
      } catch (err) {
        logger.error('slack', `fetchThread failed for ${channelId} ts=${msg.ts}`, { error: err.message });
        errors.push({ pipeline: 'slack', feature: featureId, channel: channelId, step: 'fetchThread', error: err.message });
        continue;
      }
    } else {
      threadMessages = [msg];
    }

    // Pre-filter by keywords — discard threads with no matches
    if (!threadMatchesKeywords(threadMessages, keywords)) continue;

    // Classify with Claude
    let classification;
    try {
      classification = await classifyThread(threadMessages, featureName);
    } catch (err) {
      logger.error('slack', `classifyThread failed for ${channelId} ts=${msg.ts}`, { error: err.message });
      errors.push({ pipeline: 'slack', feature: featureId, channel: channelId, step: 'classify', error: err.message });
      continue;
    }

    // Log all scope decisions regardless of confidence (PRD FR-4)
    if (classification.is_scope_decision) {
      changelog.push(buildChangelogEntry(featureId, channelId, msg, classification));
    }
  }

  return { changelog, errors };
}

// ---------------------------------------------------------------------------
// Per-feature Slack run
// ---------------------------------------------------------------------------

async function runFeature(feature) {
  const { featureId, featureName, slackChannels } = feature;
  const changelog = [];
  const errors = [];

  if (!slackChannels || slackChannels.length === 0) {
    return { featureId, changelog, errors };
  }

  const logger = require('../utils/logger');
  logger.info('slack', `Feature ${featureId} has ${slackChannels.length} channel entries`, {
    channels: slackChannels.map((c) => c.channelId),
  });

  // Load last_slack_run and convert ISO → Unix seconds for Slack API
  const lastSlackRunIso = getLastSlackRun(featureId);
  const lastSlackRunUnix = lastSlackRunIso
    ? String(Math.floor(new Date(lastSlackRunIso).getTime() / 1000))
    : null;

  const runTimestamp = new Date().toISOString();

  // Per-channel error isolation via Promise.allSettled
  const channelResults = await Promise.allSettled(
    slackChannels.map((ch) => runChannel(featureId, featureName, ch, lastSlackRunUnix))
  );

  for (const result of channelResults) {
    if (result.status === 'fulfilled') {
      changelog.push(...result.value.changelog);
      errors.push(...result.value.errors);
    } else {
      errors.push({
        pipeline: 'slack',
        feature: featureId,
        channel: 'unknown',
        error: result.reason?.message || String(result.reason),
      });
    }
  }

  // Update last_slack_run after processing all channels
  saveLastSlackRun(featureId, runTimestamp);

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

  const featuresWithSlack = activeFeatures.filter(
    (f) => f.slackChannels && f.slackChannels.length > 0
  );

  const results = await Promise.allSettled(
    featuresWithSlack.map((f) => runFeature(f))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allChangelog.push(...result.value.changelog);
      allErrors.push(...result.value.errors);
    } else {
      allErrors.push({
        pipeline: 'slack',
        feature: 'unknown',
        error: result.reason?.message || String(result.reason),
      });
    }
  }

  return { changelog: allChangelog, errors: allErrors };
}

module.exports = { run };
