'use strict';

const axios = require('axios');

// ---------------------------------------------------------------------------
// Task 6.5 — Slack thread classifier (Claude API)
// ---------------------------------------------------------------------------

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are a product analyst reviewing Slack threads for a software product team. Your job is to identify whether a thread contains a scope decision.

A scope decision is any explicit decision about what is in scope, out of scope, pushed to a future version, parked, blocked, or otherwise materially affecting the delivery plan.

Return ONLY a valid JSON object — no markdown, no explanation, no surrounding text.

The object must have exactly these fields:
  "is_scope_decision"  — boolean: true if this thread contains a scope decision
  "decision_type"      — one of: "parking", "scope_change", "fast_follower", "blocker", "discussion", "none"
  "task_name"          — string: the specific user story, feature, or task being discussed (e.g. "Login UI", "OTP Verification"). Use the shortest recognisable name that matches how a PRD or test sheet would refer to it. null if unclear.
  "target_version"     — string: "V1", "V2", "V3", or null if not mentioned
  "reason"             — string: the reason given for the decision, or null
  "actor"              — string: name or @handle of the person who made the decision, or null
  "confidence"         — float 0.0–1.0: your confidence in this classification
  "evidence_excerpt"   — string: a short excerpt (under 100 chars) from the thread as evidence, or null`;

/**
 * Classify a Slack thread for scope decisions using Claude.
 *
 * @param {Array}  threadMessages - Array of Slack message objects
 * @param {string} featureName    - Feature name for context (optional)
 * @returns {Promise<Object>} Classification result object
 */
async function classifyThread(threadMessages, featureName = '') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY must be set');

  const threadText = threadMessages
    .map((m) => {
      const user = m.username || m.user || 'unknown';
      const text = m.text || '';
      return `[${user}]: ${text}`;
    })
    .join('\n');

  const userContent = featureName
    ? `Feature: ${featureName}\n\nSlack Thread:\n${threadText}`
    : `Slack Thread:\n${threadText}`;

  let response;
  try {
    response = await axios.post(
      ANTHROPIC_API_URL,
      {
        model: MODEL,
        max_tokens: 1024,
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
  } catch (axiosErr) {
    const status = axiosErr.response?.status;
    const body = axiosErr.response?.data;
    throw new Error(
      `classifier: Anthropic API HTTP ${status}: ${JSON.stringify(body)}`
    );
  }

  const text = response.data?.content?.[0]?.text || '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      parsed = JSON.parse(match[1].trim());
    } else {
      throw new Error(`classifier: Claude returned non-JSON response: ${text.slice(0, 200)}`);
    }
  }

  return parsed;
}

module.exports = { classifyThread };
