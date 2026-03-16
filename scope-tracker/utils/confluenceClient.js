'use strict';

const axios = require('axios');

/**
 * confluenceClient.js
 *
 * Authenticates with Confluence Cloud using HTTP Basic Auth (email + API token).
 * Exposes getPage(pageId) — fetches the page body in storage format and returns
 * clean plain text (HTML stripped).
 *
 * Required env vars:
 *   CONFLUENCE_BASE_URL  — e.g. https://mintcapbrokers.atlassian.net
 *   CONFLUENCE_EMAIL     — Atlassian account email
 *   CONFLUENCE_API_TOKEN — Atlassian API token
 */

function getAuthHeader() {
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  if (!email || !token) {
    throw new Error('CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN must be set');
  }
  const encoded = Buffer.from(`${email}:${token}`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Strip HTML tags and decode common HTML entities to produce clean plain text.
 */
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')          // remove all tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')            // collapse whitespace
    .trim();
}

/**
 * Fetch a Confluence page by ID, strip HTML, and return clean text.
 *
 * @param {string} pageId - Confluence page ID
 * @returns {Promise<string>} Plain text content of the page
 */
async function getPage(pageId) {
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  if (!baseUrl) throw new Error('CONFLUENCE_BASE_URL must be set');

  const url = `${baseUrl}/wiki/rest/api/content/${pageId}?expand=body.storage`;

  let response;
  try {
    response = await axios.get(url, {
      headers: {
        Authorization: getAuthHeader(),
        Accept: 'application/json',
      },
      timeout: 15000,
    });
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    throw new Error(
      `Confluence API HTTP ${status} for page ${pageId}: ${JSON.stringify(body)}`
    );
  }

  const storageHtml = response.data?.body?.storage?.value || '';
  if (!storageHtml) {
    throw new Error(`Empty body returned for Confluence page ${pageId}`);
  }

  return stripHtml(storageHtml);
}

module.exports = { getPage };
