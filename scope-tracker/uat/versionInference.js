'use strict';

/**
 * Derive the next version from a current target version string.
 * Supports patterns like "V1", "V2", "v3", "MVP", etc.
 *
 * Rules (from Section 10):
 *   V1 → V2, V2 → V3, Vn → V(n+1)
 *   If no numeric suffix can be found, returns "TBD"
 *
 * @param {string} currentTarget - e.g. "V1", "V2", "MVP"
 * @returns {string} next version string
 */
function inferNextVersion(currentTarget) {
  if (!currentTarget) return 'TBD';

  const match = currentTarget.trim().match(/^[Vv](\d+)$/);
  if (match) {
    const n = parseInt(match[1], 10);
    return `V${n + 1}`;
  }

  // Cannot determine next version
  return 'TBD';
}

module.exports = { inferNextVersion };
