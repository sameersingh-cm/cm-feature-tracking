'use strict';

// ---------------------------------------------------------------------------
// Task 6.4 — Keyword pre-filter
// ---------------------------------------------------------------------------

/**
 * Returns true if at least one message in the thread contains at least one keyword.
 * If no keywords are configured, all threads pass through.
 *
 * @param {Array}    threadMessages - Array of Slack message objects
 * @param {string[]} keywords       - Keywords to match (case-insensitive)
 * @returns {boolean}
 */
function threadMatchesKeywords(threadMessages, keywords) {
  if (!keywords || keywords.length === 0) return true;

  const lowerKeywords = keywords.map((k) => k.toLowerCase());

  for (const msg of threadMessages) {
    const text = (msg.text || '').toLowerCase();
    if (lowerKeywords.some((kw) => text.includes(kw))) return true;
  }

  return false;
}

module.exports = { threadMatchesKeywords };
