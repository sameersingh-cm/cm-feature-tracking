# Scope Tracker — User Instructions

> This document explains how to configure and use the Scope Tracker system. You never touch the code. Everything is controlled through a single Google Sheet.

---

## The Config Sheet is your control panel

All source links — PRD, UAT sheet, Slack channels — are entered in one place: the **Config Google Sheet**. The system reads this sheet at the start of every run and picks up whatever you've configured.

There are three tabs you need to know about:

| Tab | What it's for | Who fills it |
|-----|--------------|--------------|
| Tab 1 — Features | Register features and link their sources | You |
| Tab 2 — Slack Channels | List Slack channels per feature | You |
| Tab 3 — Run State | Tracks last-run timestamps per pipeline | System (do not edit) |

---

## Tab 1 — Features

One row per feature. This is where you connect the PRD, UAT sheet, and output sheet to a feature.

| Column | What to enter | Example |
|--------|--------------|---------|
| Feature ID | Any unique code you choose | `FEAT-001` |
| Feature Name | Human-readable name | `Scalper` |
| Active | `Y` to track, `N` to pause | `Y` |
| PRD Page ID | Copied from your Confluence URL | `123456789` |
| UAT Sheet URL | Full Google Sheets URL | `https://docs.google.com/spreadsheets/d/...` |
| Output Sheet ID | ID of the sheet where results are written | `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms` |
| Target Version | Current scope target | `V1` |
| Current Status | Current state of the feature | `In Scope` |
| Start Date | Project kickoff date | `2026-03-01` |
| Notes | Any free-text notes | optional |

### How to find the Confluence Page ID

Open the PRD page in Confluence and look at the URL:

```
https://mintcapbrokers.atlassian.net/wiki/spaces/CashMint/pages/123456789
```

The number at the end (`123456789`) is your Page ID. Copy that into the **PRD Page ID** column.

### How to find the Google Sheet ID

Open the Google Sheet and look at the URL:

```
https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit
```

The long string between `/d/` and `/edit` is your Sheet ID.

---

## Tab 2 — Slack Channels

One row per channel per feature. A single feature can have multiple channels — just add multiple rows with the same Feature ID.

| Column | What to enter | Example |
|--------|--------------|---------|
| Feature ID | Must match a Feature ID from Tab 1 | `FEAT-001` |
| Channel Name | For your reference only | `#scalper-dev` |
| Channel ID | Slack's internal channel ID | `C01234ABC` |
| Keywords | Comma-separated words used to filter messages | `scalper, parked, pushed, v2` |

### How to find the Slack Channel ID

1. Open the channel in Slack
2. Click the channel name at the top of the screen
3. Scroll to the bottom of the popup that appears
4. You will see the Channel ID listed there (e.g. `C01234ABC`)

### Tips for keywords

- Keep keywords specific to the feature to reduce noise
- Include common decision words like `parked`, `pushed`, `v2`, `next release`
- Separate with commas — no need for quotes

---

## Tab 3 — Run State

**Do not edit this tab.** The system writes here automatically after each run to record when each pipeline last ran for each feature. This is how it knows which Slack messages are new since the last run.

---

## Adding a new feature

1. Add one row to **Tab 1** with the feature's details and source links
2. Add one or more rows to **Tab 2** for its Slack channels
3. Set `Active = Y`

The next scheduled run (or manual trigger) will automatically pick it up.

---

## Pausing a feature

Set `Active = N` in Tab 1 for that feature. The system will skip it entirely on every run — no API calls, no processing. Change it back to `Y` whenever you want to resume tracking.

---

## Triggering a run

### Scheduled run
The system runs automatically every weekday at 6pm via cron-job.org. No action needed.

### Manual run
If you need an immediate run at any time, open a browser or terminal and call:

```
POST https://your-server-url/run
```

Or from a terminal:

```bash
curl -X POST https://your-server-url/run
```

You will get back a JSON summary like this:

```json
{
  "runId": "run_20260316_1430",
  "triggeredBy": "manual",
  "duration": 42,
  "featuresProcessed": 1,
  "changelogEntriesAdded": 3,
  "prdStatus": "success",
  "uatStatus": "success",
  "slackStatus": "skipped",
  "errors": []
}
```

---

## Reading the output

All results are written to the **Output Google Sheet** configured in Tab 1. It has four tabs:

| Tab | What it shows |
|-----|--------------|
| Features | Current status of every tracked feature. Updated on every run. |
| Scope Registry | All tasks/sub-features with their version assignment and status. |
| Changelog | Full history of every scope decision detected, with source and confidence score. |
| Run Log | A record of every run — what succeeded, what failed, how many entries were added. |

### Understanding the Changelog

Each row in the Changelog represents one detected scope decision. Key columns to look at:

- **Source** — where the decision was detected: `prd`, `slack`, or `uat`
- **Decision Type** — what kind of decision: `parking`, `scope_change`, `fast_follower`, `blocker`, `discussion`
- **Confidence Score** — how confident the AI was (only applies to Slack entries). `1.0` means it came from a deterministic rule (UAT or PRD). Lower scores mean review is recommended.
- **Evidence** — a link to the Slack thread or a snippet from the PRD diff

---

## What to do when a run partially fails

The system is designed so that if one pipeline fails (e.g. Confluence is down), the other two still run. Check the **Run Log tab** in the Output Sheet after any run to see the status of each pipeline and any errors.

Common errors and what they mean:

| Error | Likely cause |
|-------|-------------|
| `confluence_api_timeout` | Confluence was slow or unreachable. Will retry next run. |
| `channel_not_found` | Slack bot is not added to that channel. Add the bot and retry. |
| `sheets_permission_denied` | The service account doesn't have access to the UAT sheet. Share the sheet with the service account email. |

---

## Version labels used in the system

| Label | Meaning |
|-------|---------|
| V1 / MVP | First production release |
| V2 | Second release — fast followers from V1 |
| V3 | Third release — further iterations |
| Parked | Deferred indefinitely, no version assigned |
| Dropped | Explicitly removed from roadmap |
| Fast Follower Vn | Follow-up scoped specifically for version n |
