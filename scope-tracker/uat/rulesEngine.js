'use strict';

const { inferNextVersion } = require('./versionInference');

// Disposition constants
const DISPOSITION = {
  PUSHED: 'PUSHED',
  ACTIVE_BLOCKER: 'ACTIVE_BLOCKER',
  PARKED: 'PARKED',
  PASSED: 'PASSED',
  PASSED_WITH_ITERATION: 'PASSED_WITH_ITERATION',
  TO_BE_TESTED: 'TO_BE_TESTED',
  NO_ACTION: 'NO_ACTION',
};

/**
 * Normalise a raw cell value for comparison.
 * @param {string} val
 * @returns {string}
 */
function norm(val) {
  return (val || '').trim().toLowerCase();
}

/**
 * Apply the Section 9 rules to a single UAT row.
 *
 * @param {string} uatStatus   - Value from the latest UAT Status column
 * @param {string} blocker     - Value from the Blocker column ("Yes"/"No"/empty)
 * @param {string} currentTarget - Feature's current target version (e.g. "V1")
 * @returns {{ disposition: string, targetVersion: string, note: string }}
 */
function applyRules(uatStatus, blocker, currentTarget) {
  const status = norm(uatStatus);
  const isBlocker = norm(blocker) === 'yes';

  if (status === 'failed') {
    if (isBlocker) {
      return {
        disposition: DISPOSITION.ACTIVE_BLOCKER,
        targetVersion: currentTarget || '',
        note: 'Active blocker — do not park',
      };
    }
    return {
      disposition: DISPOSITION.PUSHED,
      targetVersion: inferNextVersion(currentTarget),
      note: 'Pushed to next release',
    };
  }

  if (status === 'parked for later') {
    return {
      disposition: DISPOSITION.PARKED,
      targetVersion: 'TBD',
      note: 'Parked — no version assigned',
    };
  }

  if (status === 'passed') {
    return {
      disposition: DISPOSITION.PASSED,
      targetVersion: currentTarget || '',
      note: 'Passed UAT',
    };
  }

  if (status === 'passed with iteration') {
    return {
      disposition: DISPOSITION.PASSED_WITH_ITERATION,
      targetVersion: currentTarget || '',
      note: 'Passed with iteration',
    };
  }

  if (status === 'to be tested') {
    return {
      disposition: DISPOSITION.TO_BE_TESTED,
      targetVersion: currentTarget || '',
      note: 'To be tested',
    };
  }

  // Unknown status → no action
  return {
    disposition: DISPOSITION.NO_ACTION,
    targetVersion: currentTarget || '',
    note: '',
  };
}

module.exports = { applyRules, DISPOSITION };
