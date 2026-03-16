'use strict';

const axios = require('axios');

/**
 * prdExtractor.js
 *
 * Calls the Anthropic Claude API with the plain-text PRD content and returns a
 * structured JSON array of features extracted from the document.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY — Anthropic API key
 *
 * Each returned feature object has the shape:
 *   {
 *     name:          string,   // feature / task name as it appears in the PRD
 *     status:        string,   // e.g. "In Scope", "Parked", "Fast Follower", "TBD"
 *     targetVersion: string,   // e.g. "V1", "V2", or "" if not specified
 *     description:   string,   // one-sentence summary from the PRD
 *   }
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are a product analyst. Your job is to extract a structured list of product features from a PRD (Product Requirements Document).

Return ONLY a valid JSON array — no markdown, no explanation, no surrounding text.

Each element must be an object with exactly these fields:
  "name"          — the feature or task name (string, required)
  "status"        — scope status: one of "In Scope", "Parked", "Fast Follower", "TBD", or the exact text from the document (string)
  "targetVersion" — delivery version such as "V1", "V2", "V3", or "" if not mentioned (string)
  "description"   — a concise one-sentence description of the feature (string)

Include every feature, user story, or scope item you can identify. Omit non-feature content (headings, background, glossary entries, etc.).`;

/**
 * Extract a structured feature list from plain-text PRD content using Claude.
 *
 * @param {string} prdText - Plain text content of the PRD page
 * @param {string} featureName - Name of the feature (used for context in the prompt)
 * @returns {Promise<Array<Object>>} Array of extracted feature objects
 */
async function extractFeatures(prdText, featureName = '') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY must be set');

  const userContent = featureName
    ? `Feature: ${featureName}\n\nPRD Content:\n${prdText}`
    : `PRD Content:\n${prdText}`;

  const response = await axios.post(
    ANTHROPIC_API_URL,
    {
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const text = response.data?.content?.[0]?.text || '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Claude sometimes wraps JSON in a code block — try to extract it
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      parsed = JSON.parse(match[1].trim());
    } else {
      throw new Error(`prdExtractor: Claude returned non-JSON response: ${text.slice(0, 200)}`);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`prdExtractor: Expected JSON array, got ${typeof parsed}`);
  }

  return parsed;
}

module.exports = { extractFeatures };
