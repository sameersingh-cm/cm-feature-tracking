'use strict';

/**
 * Convert a Date to IST (UTC+5:30) and return as an ISO-like string.
 * Format: "2026-03-16T23:30:00.000+05:30"
 *
 * @param {Date} [date] - defaults to now
 * @returns {string}
 */
function toIST(date) {
  const d = date || new Date();
  // IST offset is +5:30 = 330 minutes
  const istOffsetMs = 330 * 60 * 1000;
  const istTime = new Date(d.getTime() + istOffsetMs);
  // Format as YYYY-MM-DDTHH:mm:ss.sss+05:30
  return istTime.toISOString().replace('Z', '+05:30');
}

/**
 * Normalise a task name for dedup grouping.
 * Lowercase, trim, collapse whitespace, strip trailing punctuation.
 *
 * @param {string} name
 * @returns {string}
 */
function normaliseTaskName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.\-_]+$/g, '');
}

module.exports = { toIST, normaliseTaskName };
