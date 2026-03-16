'use strict';

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

function getAuthClient() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: SCOPES,
  });
}

function parseFeatures(rows) {
  if (!rows || rows.length < 2) return [];
  const [headers, ...dataRows] = rows;
  const idx = (name) =>
    headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());

  return dataRows
    .map((row) => ({
      featureId: row[idx('Feature ID')] || '',
      featureName: row[idx('Feature Name')] || '',
      active: (row[idx('Active')] || '').toUpperCase() === 'Y',
      prdPageId: (row[idx('PRD Page ID')] || '').trim(),
      uatSheetUrl: (row[idx('UAT Sheet URL')] || '').trim(),
      outputSheetId: row[idx('Output Sheet ID')] || '',
      targetVersion: row[idx('Target Version')] || '',
      currentStatus: row[idx('Current Status')] || '',
      startDate: row[idx('Start Date')] || '',
      notes: row[idx('Notes')] || '',
      slackChannels: [],
      runState: { lastPrdRun: null, lastSlackRun: null, lastUatRun: null },
    }))
    .filter((f) => f.featureId);
}

function parseSlackChannels(rows) {
  if (!rows || rows.length < 2) return {};
  const [headers, ...dataRows] = rows;
  const idx = (name) =>
    headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());

  const map = {};
  for (const row of dataRows) {
    const featureId = row[idx('Feature ID')] || '';
    if (!featureId) continue;
    if (!map[featureId]) map[featureId] = [];
    const keywords = (row[idx('Keywords')] || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    map[featureId].push({
      channelName: (row[idx('Channel Name')] || '').trim(),
      channelId: (row[idx('Channel ID')] || '').trim(),
      keywords,
    });
  }
  return map;
}

function parseRunState(rows) {
  if (!rows || rows.length < 2) return {};
  const [headers, ...dataRows] = rows;
  const idx = (name) =>
    headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());

  const map = {};
  for (const row of dataRows) {
    const featureId = row[idx('Feature ID')] || '';
    if (!featureId) continue;
    map[featureId] = {
      lastPrdRun: row[idx('Last PRD Run')] || null,
      lastSlackRun: row[idx('Last Slack Run')] || null,
      lastUatRun: row[idx('Last UAT Run')] || null,
    };
  }
  return map;
}

async function load() {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.CONFIG_SHEET_ID;

  const [featuresRes, slackRes, runStateRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: 'Features!A:J' }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: 'Slack Channels!A:D' }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: 'Run State!A:D' }),
  ]);

  const features = parseFeatures(featuresRes.data.values);
  const slackMap = parseSlackChannels(slackRes.data.values);
  const runStateMap = parseRunState(runStateRes.data.values);

  for (const feature of features) {
    feature.slackChannels = slackMap[feature.featureId] || [];
    feature.runState =
      runStateMap[feature.featureId] ||
      { lastPrdRun: null, lastSlackRun: null, lastUatRun: null };
  }

  return features.filter((f) => f.active);
}

module.exports = { load, parseFeatures, parseSlackChannels, parseRunState };
