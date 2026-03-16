'use strict';

/**
 * diffEngine.js — Compare two PRD feature snapshots and return added/removed/modified entries.
 *
 * A snapshot is an array of feature objects, each with at least a `name` field used as the key.
 * Additional fields (description, status, targetVersion, etc.) are compared for modifications.
 */

/**
 * Normalise a feature entry to a stable string for comparison.
 */
function serialise(feature) {
  return JSON.stringify(feature, Object.keys(feature).sort());
}

/**
 * diff(previous, current)
 *
 * @param {Array<Object>} previous - Prior snapshot feature array (may be null/empty on first run)
 * @param {Array<Object>} current  - Newly extracted feature array
 * @returns {{ added: Array, removed: Array, modified: Array }}
 *   added    — features present in current but not in previous
 *   removed  — features present in previous but not in current
 *   modified — features present in both but with changed fields
 *              Each entry: { previous: Object, current: Object }
 */
function diff(previous, current) {
  if (!previous || previous.length === 0) {
    // Baseline run — no changelog entries
    return { added: [], removed: [], modified: [] };
  }

  const prevMap = new Map();
  for (const f of previous) {
    const key = (f.name || '').trim().toLowerCase();
    if (key) prevMap.set(key, f);
  }

  const currMap = new Map();
  for (const f of current) {
    const key = (f.name || '').trim().toLowerCase();
    if (key) currMap.set(key, f);
  }

  const added = [];
  const removed = [];
  const modified = [];

  for (const [key, curr] of currMap) {
    if (!prevMap.has(key)) {
      added.push(curr);
    } else {
      const prev = prevMap.get(key);
      if (serialise(prev) !== serialise(curr)) {
        modified.push({ previous: prev, current: curr });
      }
    }
  }

  for (const [key, prev] of prevMap) {
    if (!currMap.has(key)) {
      removed.push(prev);
    }
  }

  return { added, removed, modified };
}

module.exports = { diff };
