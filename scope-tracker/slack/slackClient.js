'use strict';

const axios = require('axios');

const BASE_URL = 'https://slack.com/api';

// ---------------------------------------------------------------------------
// Task 6.1 — Authenticate with bot token
// ---------------------------------------------------------------------------

function getHeaders() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN must be set');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Task 6.2 — Channel history fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch all messages from a channel since a given Unix timestamp.
 *
 * @param {string} channelId - Slack channel ID (e.g. "C01234ABC")
 * @param {string|null} oldest - Unix timestamp string (e.g. "1700000000"); null = all history
 * @returns {Promise<Array>} array of Slack message objects
 */
async function fetchChannelHistory(channelId, oldest = null) {
  const messages = [];
  let cursor;

  do {
    const params = { channel: channelId, limit: 200 };
    if (oldest) params.oldest = oldest;
    if (cursor) params.cursor = cursor;

    const response = await axios.get(`${BASE_URL}/conversations.history`, {
      headers: getHeaders(),
      params,
      timeout: 15000,
    });

    if (!response.data.ok) {
      throw new Error(`Slack API error (conversations.history): ${response.data.error}`);
    }

    messages.push(...(response.data.messages || []));
    cursor = response.data.response_metadata?.next_cursor || '';
  } while (cursor);

  return messages;
}

// ---------------------------------------------------------------------------
// Task 6.3 — Thread fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch the full thread for a given parent message.
 *
 * @param {string} channelId - Slack channel ID
 * @param {string} threadTs  - ts of the parent message
 * @returns {Promise<Array>} array of message objects (parent + all replies)
 */
async function fetchThread(channelId, threadTs) {
  const messages = [];
  let cursor;

  do {
    const params = { channel: channelId, ts: threadTs, limit: 200 };
    if (cursor) params.cursor = cursor;

    let response;
    try {
      response = await axios.get(`${BASE_URL}/conversations.replies`, {
        headers: getHeaders(),
        params,
        timeout: 15000,
      });
    } catch (axiosErr) {
      const body = axiosErr.response?.data;
      throw new Error(
        `conversations.replies HTTP ${axiosErr.response?.status}: ${JSON.stringify(body)} (ts=${threadTs})`
      );
    }

    if (!response.data.ok) {
      throw new Error(`Slack API error (conversations.replies): ${response.data.error}`);
    }

    messages.push(...(response.data.messages || []));
    cursor = response.data.response_metadata?.next_cursor || '';
  } while (cursor);

  return messages;
}

module.exports = { fetchChannelHistory, fetchThread };
