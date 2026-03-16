# Pipeline Architecture: How the Scope Tracker Works

## Overview

The system pulls data from 3 sources — **Slack**, **PRD (Confluence)**, and **UAT Sheet (Google Sheets)** — to build a unified changelog and scope registry tracking feature decisions over time.

---

## Triggers

Two ways to kick off a run:
1. **HTTP POST `/run`** — manual, on-demand
2. **Cron job (6pm UTC weekdays)** — external service (cron-job.org) hits the `/run` endpoint

Both converge on `orchestrator.js` → `runPipeline()`, which runs all 3 pipelines **in parallel**.

A guard flag (`isRunning`) prevents concurrent runs.

---

## Data Fetching: 3 Sources

### Source 1: Slack (`pipelines/slackPipeline.js`)
- Reads `state/runState.json` for `lastSlackRun` timestamp per feature
- Calls Slack `conversations.history` with `oldest=lastSlackRunUnix` → only fetches messages **since last run**
- For messages with replies, fetches full thread via `conversations.replies` (paginated, 200/page)
- Pre-filters threads by keywords configured per channel
- Sends matching threads to **Claude (claude-sonnet-4-6)** → classifier returns: `is_scope_decision`, `decision_type`, `target_version`, `confidence`, `evidence`
- Saves new timestamp to state file after run
- `sourceMessageId` format: `slack::featureId::channelId::threadTimestamp`

### Source 2: PRD / Confluence (`pipelines/prdPipeline.js`)
- Fetches Confluence page HTML, strips tags → plain text
- Sends to **Claude** → extracts array of feature objects `{name, status, targetVersion, description}`
- Loads previous snapshot from `state/runState.json`
- **First run:** No changelog entries; just saves baseline snapshot
- **Subsequent runs:** Diffs previous vs current snapshot → added/removed/modified features become changelog entries
- Saves new snapshot to state file after run
- `sourceMessageId` format: `prd::featureId::featureName::hash8` (SHA1 of feature JSON)

### Source 3: UAT Sheet (`pipelines/uatPipeline.js`)
- **Stateless** — re-reads the full Google Sheet every single run
- Dynamically finds the active "UAT * Status" column (picks highest numeric suffix, e.g., "UAT 2 Status" beats "UAT Status")
- Applies rules engine per row:
  - Failed + Blocker=Yes → `ACTIVE_BLOCKER` (keep current version)
  - Failed + Blocker=No → `PUSHED` (increment version: V1→V2)
  - Parked for Later → `PARKED` (version=TBD)
  - Passed / Passed with Iteration / To be tested → `NO_ACTION` (no entry created)
- Deduplication handled at output layer (not here)
- `sourceMessageId` format: `uat::featureId::issue::uatStatus`

---

## State Tracking: What's New vs Already Fetched

All persistent state lives in `scope-tracker/state/runState.json`:

```json
{
  "features": {
    "featureId": {
      "lastSlackRun": "2026-03-16T18:00:00.000Z",
      "prdSnapshot": [
        { "name": "...", "status": "...", "targetVersion": "...", "description": "..." }
      ],
      "prdSnapshotTimestamp": "2026-03-16T18:00:00.000Z"
    }
  }
}
```

| Source | State Mechanism | First Run Behavior |
|--------|----------------|-------------------|
| Slack  | ISO timestamp → Unix seconds → `oldest` param in Slack API | Fetches full channel history |
| PRD    | Full snapshot of extracted features, diffed on next run | Saves baseline, no changelog entries |
| UAT    | No state — sheet re-read fully every time | Same as any other run |

> **Warning:** If `state/runState.json` is deleted, Slack will re-fetch full history and PRD will treat next run as a fresh baseline (no changelog entries generated).

The Config sheet also has a **"Run State" tab** with per-feature last-run timestamps — but this is for operational visibility only. Pipelines use the JSON file, not this tab.

---

## Duplicate Handling

**Two layers of deduplication:**

### Layer 1 — Source level (Slack only)
Timestamp cursor prevents re-fetching old messages. Only messages newer than `lastSlackRun` are retrieved.

### Layer 2 — Output level (all sources)
Each changelog entry has a stable `sourceMessageId` (see formats above). Before writing:
1. `sheetWriter.js` reads all existing Source Message IDs from the Changelog tab into a Set
2. Skips any entry whose ID is already in the Set
3. Appends only genuinely new entries

### Scope Registry deduplication
- Keyed by `featureId::taskName` (composite key)
- Upsert logic: update if exists, insert if new
- After every run, a **full rollup** rebuilds the Scope Registry from the entire Changelog:
  - Groups all entries by (Feature ID + Task Name)
  - Latest entry by timestamp wins
  - Scope Registry always reflects the most recent known state per task

---

## Version Identification

Each source handles versioning differently:

| Source | How Version Is Determined |
|--------|--------------------------|
| **UAT** | Rules engine: PUSHED → `inferNextVersion(currentVersion)` → V1→V2, V2→V3. PARKED → "TBD" |
| **PRD** | Taken directly from what Claude extracts from the document text |
| **Slack** | Claude classifier extracts it from thread text (e.g., "push to V2") — or null if not mentioned |

### Version progression example
```
PRD extracted "Login UI" → V1       → Scope Registry: Login UI = V1
UAT: Failed, not a blocker          → Scope Registry: Login UI = V2 (inferred)
Slack: "let's park this for now"    → Scope Registry: Login UI = parked, version cleared
```

---

## Cross-source Deduplication (Resolved)

The same user story/task can appear from all 3 sources (PRD defines it, UAT tests it, Slack discusses it). Three mechanisms prevent duplicate Scope Registry rows:

1. **Claude-based task name reconciliation** — During rollup, unique task names per feature are sent to Claude (`ai/taskReconciler.js`) in a single API call. Claude groups names that refer to the same logical task (e.g., "Login UI" + "User Authentication Screen" → canonical: "Login UI"). This runs once per feature per pipeline run.
2. **Normalised task name grouping** — After reconciliation, the rollup uses `normaliseTaskName()` (lowercase, trim, collapse whitespace) as a safety net for trivial case/spacing differences.
3. **Slack classifier returns `task_name`** — The Claude classifier extracts a `task_name` field (the specific feature/story being discussed). This is used in the Slack `sourceMessageId` (`slack::featureId::taskName::ts`) instead of the old `channelId`, making Slack entries matchable to PRD/UAT entries.

**Fallback:** If the reconciliation API call fails, it falls back to identity mapping (raw names used as-is) — the pipeline never breaks due to reconciliation failure.

## Timestamps (Resolved)

All timestamps are now in **IST (UTC+5:30)** via `utils/ist.js` → `toIST()`. This applies to: changelog entries, run logs, scope registry, PRD snapshots, and config sheet Run State.

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `index.js` | HTTP server — `/health`, `/run`, `/run/:runId` endpoints |
| `orchestrator.js` | Runs all 3 pipelines in parallel, aggregates results, writes to sheets |
| `config/configReader.js` | Reads Config sheet (Features, Slack Channels, Run State tabs) |
| `pipelines/slackPipeline.js` | Slack fetch → keyword filter → Claude classify |
| `pipelines/prdPipeline.js` | Confluence fetch → Claude extract → snapshot diff |
| `pipelines/uatPipeline.js` | Google Sheet read → rules engine → disposition |
| `slack/slackClient.js` | Slack API wrapper (`conversations.history`, `conversations.replies`) |
| `slack/keywordFilter.js` | Keyword substring matching for pre-filtering |
| `ai/classifier.js` | Anthropic Claude API — Slack thread classification |
| `ai/prdExtractor.js` | Anthropic Claude API — PRD feature extraction |
| `ai/taskReconciler.js` | Claude-based task name grouping across sources |
| `uat/uatSheetReader.js` | Google Sheets API wrapper |
| `uat/rulesEngine.js` | Disposition rules: Failed+Blocker→ACTIVE_BLOCKER, Failed→PUSHED, etc. |
| `uat/versionInference.js` | V1→V2 increment logic |
| `utils/ist.js` | IST timestamp helper + task name normalisation |
| `utils/diffEngine.js` | PRD snapshot comparison (added/removed/modified) |
| `utils/confluenceClient.js` | Confluence page fetcher + HTML stripper |
| `writer/sheetWriter.js` | All sheet writes: append changelog, upsert scope registry, rollup |
| `state/runState.json` | Persistent state: Slack timestamps + PRD snapshots per feature |
