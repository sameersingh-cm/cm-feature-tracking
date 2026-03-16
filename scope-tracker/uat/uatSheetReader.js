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

/**
 * Extract spreadsheet ID and optional sheet GID from a Google Sheets URL.
 * Supports formats:
 *   https://docs.google.com/spreadsheets/d/SHEET_ID/edit#gid=GID
 *   https://docs.google.com/spreadsheets/d/SHEET_ID/edit?gid=GID
 *   https://docs.google.com/spreadsheets/d/SHEET_ID/...
 */
function parseSheetUrl(url) {
  const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!idMatch) throw new Error(`Cannot extract spreadsheet ID from URL: ${url}`);
  const spreadsheetId = idMatch[1];

  const gidMatch = url.match(/[#&?]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : null;

  return { spreadsheetId, gid };
}

/**
 * Find all column indices matching "UAT * Status" (case-insensitive).
 * Returns an array of { index, number } sorted by number ascending.
 * @param {string[]} headers
 * @returns {Array<{ index: number, number: number|null }>}
 */
function findUatStatusColumns(headers) {
  const pattern = /^uat\s+(.+?)\s+status$/i;
  const matches = [];

  headers.forEach((h, i) => {
    const m = h.trim().match(pattern);
    if (m) {
      const numericSuffix = parseInt(m[1], 10);
      matches.push({
        index: i,
        number: isNaN(numericSuffix) ? null : numericSuffix,
        raw: h.trim(),
      });
    }
  });

  return matches;
}

/**
 * Pick the active UAT Status column index using Section 9 rules:
 * - Use column with highest numeric suffix
 * - If no numeric suffix, use last matching column by position
 * @param {string[]} headers
 * @returns {number|null} column index or null if none found
 */
function pickLatestUatStatusColumn(headers) {
  const candidates = findUatStatusColumns(headers);
  if (candidates.length === 0) return null;

  const withNumbers = candidates.filter((c) => c.number !== null);
  if (withNumbers.length > 0) {
    return withNumbers.reduce((best, c) => (c.number > best.number ? c : best)).index;
  }

  // No numeric suffix — use last by position
  return candidates[candidates.length - 1].index;
}

/**
 * Fetch all rows and headers from a UAT Google Sheet.
 * @param {string} uatSheetUrl - Full Google Sheet URL
 * @returns {Promise<{ headers: string[], rows: string[][], activeUatStatusIndex: number|null }>}
 */
async function fetchUatSheet(uatSheetUrl) {
  const { spreadsheetId, gid } = parseSheetUrl(uatSheetUrl);

  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  // If a gid is specified, we need to find the sheet name first
  let range;
  if (gid) {
    const metaRes = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = metaRes.data.sheets.find(
      (s) => String(s.properties.sheetId) === gid
    );
    const sheetName = sheet ? sheet.properties.title : null;
    range = sheetName ? `'${sheetName}'!A:ZZ` : 'A:ZZ';
  } else {
    range = 'A:ZZ';
  }

  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const allRows = res.data.values || [];

  if (allRows.length === 0) {
    return { headers: [], rows: [], activeUatStatusIndex: null };
  }

  const [headers, ...rows] = allRows;
  const activeUatStatusIndex = pickLatestUatStatusColumn(headers);

  return { headers, rows, activeUatStatusIndex };
}

module.exports = { fetchUatSheet, pickLatestUatStatusColumn, parseSheetUrl };
