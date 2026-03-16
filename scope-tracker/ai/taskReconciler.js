'use strict';

const axios = require('axios');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are a product analyst. You will receive a list of task/feature names extracted from different sources (PRD documents, UAT test sheets, Slack discussions) for a single software feature.

Many of these names refer to the SAME user story or task but are worded differently across sources. Your job is to group them.

Rules:
- Group names that clearly refer to the same logical task/user story.
- If two names are ambiguous, keep them separate (do NOT force-merge).
- Pick the clearest, most descriptive name from each group as the canonical name.
- Every input name must appear in exactly one group.

Return ONLY a valid JSON object — no markdown, no explanation.
The object keys are canonical names and values are arrays of all names in that group (including the canonical name itself).

Example input:
["Login UI", "User Authentication Screen", "OTP Verification", "Login Page Design", "OTP flow"]

Example output:
{"Login UI": ["Login UI", "User Authentication Screen", "Login Page Design"], "OTP Verification": ["OTP Verification", "OTP flow"]}`;

/**
 * Given a list of raw task names for a single feature, return a mapping
 * from each raw name to its canonical (grouped) name.
 *
 * @param {string[]} taskNames - unique task names to reconcile
 * @returns {Promise<Object<string, string>>} map of rawName → canonicalName
 */
async function reconcileTaskNames(taskNames) {
  if (!taskNames || taskNames.length <= 1) {
    // Nothing to reconcile
    const map = {};
    if (taskNames && taskNames[0]) map[taskNames[0]] = taskNames[0];
    return map;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fall back to identity mapping if no API key
    const map = {};
    for (const n of taskNames) map[n] = n;
    return map;
  }

  let response;
  try {
    response = await axios.post(
      ANTHROPIC_API_URL,
      {
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(taskNames) }],
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
  } catch (err) {
    // On API failure, fall back to identity mapping — don't break the pipeline
    const map = {};
    for (const n of taskNames) map[n] = n;
    return map;
  }

  const text = response.data?.content?.[0]?.text || '';
  let groups;
  try {
    groups = JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      groups = JSON.parse(match[1].trim());
    } else {
      // Parse failure — fall back to identity
      const map = {};
      for (const n of taskNames) map[n] = n;
      return map;
    }
  }

  // Build reverse map: rawName → canonicalName
  const map = {};
  for (const [canonical, aliases] of Object.entries(groups)) {
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      map[alias] = canonical;
    }
  }

  // Ensure every input name has a mapping (safety net)
  for (const n of taskNames) {
    if (!map[n]) map[n] = n;
  }

  return map;
}

module.exports = { reconcileTaskNames };
