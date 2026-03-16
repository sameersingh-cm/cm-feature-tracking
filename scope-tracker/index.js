'use strict';

require('dotenv').config();

const express = require('express');
const { runPipeline } = require('./orchestrator');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory store of recent runs keyed by runId
const runStore = {};
let isRunning = false;

// ---------------------------------------------------------------------------
// GET /health
// Returns system status and last run metadata. Used by cron-job.org to verify
// the server is alive.
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  const runIds = Object.keys(runStore);
  const lastRun = runIds.length > 0 ? runStore[runIds[runIds.length - 1]] : null;

  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    lastRun: lastRun
      ? {
          runId: lastRun.runId,
          triggeredBy: lastRun.triggeredBy,
          duration: lastRun.duration,
          prdStatus: lastRun.prdStatus,
          uatStatus: lastRun.uatStatus,
          slackStatus: lastRun.slackStatus,
          changelogEntriesAdded: lastRun.changelogEntriesAdded,
        }
      : null,
  });
});

// ---------------------------------------------------------------------------
// POST /run
// Triggers a full pipeline run immediately. Returns JSON run summary.
// ---------------------------------------------------------------------------

app.post('/run', async (req, res) => {
  if (isRunning) {
    return res.status(409).json({ error: 'A run is already in progress' });
  }

  isRunning = true;
  logger.info('server', 'Manual run triggered');

  try {
    const result = await runPipeline('manual');
    runStore[result.runId] = result;
    res.json(result);
  } catch (err) {
    logger.error('server', 'Pipeline run failed', { error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    isRunning = false;
  }
});

// ---------------------------------------------------------------------------
// GET /run/:runId
// Returns details of a specific run from the in-memory run store.
// ---------------------------------------------------------------------------

app.get('/run/:runId', (req, res) => {
  const { runId } = req.params;
  const run = runStore[runId];
  if (!run) {
    return res.status(404).json({ error: `Run ${runId} not found` });
  }
  res.json(run);
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  logger.info('server', 'Scope Tracker started', { port: PORT });
});

module.exports = app;
