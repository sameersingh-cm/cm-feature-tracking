'use strict';

/**
 * Retry an async function up to maxAttempts times with exponential backoff.
 * Backoff schedule: 1s → 2s → 4s (baseDelayMs * 2^(attempt-1))
 *
 * @param {Function} fn - async function to call
 * @param {Object} [options]
 * @param {number} [options.maxAttempts=3]
 * @param {number} [options.baseDelayMs=1000]
 * @returns {Promise<any>}
 */
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

module.exports = { withRetry };
