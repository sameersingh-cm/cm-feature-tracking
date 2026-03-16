# Scope Tracker

Automated system that tracks product scope decisions across Confluence PRDs, Slack channels, and UAT Google Sheets, writing structured output to a master Google Sheet.

## Architecture

```
Trigger (cron / manual POST /run)
  └── Orchestrator
        ├── Config Sheet Reader  (Google Sheets API)
        ├── PRD Pipeline         (Confluence → Claude API)
        ├── UAT Pipeline         (Google Sheets → rules engine)
        └── Slack Pipeline       (Slack API → Claude API)
              └── Sheet Writer   (Google Sheets API — output)
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (claude-sonnet-4-20250514) |
| `CONFLUENCE_API_TOKEN` | Atlassian API token |
| `CONFLUENCE_EMAIL` | Email associated with Atlassian account |
| `CONFLUENCE_BASE_URL` | e.g. `https://mintcapbrokers.atlassian.net` |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` field from service account JSON key file |
| `GOOGLE_PRIVATE_KEY` | `private_key` field from service account JSON key file (include newlines as `\n`) |
| `CONFIG_SHEET_ID` | Google Sheet ID for the Config sheet |
| `PORT` | HTTP server port (default: 3000) |

### 3. Set up Config Google Sheet

**Tab 1 — Features**

| Feature ID | Feature Name | Active | PRD Page ID | UAT Sheet URL | Output Sheet ID | Target Version | Current Status | Start Date | Notes |
|---|---|---|---|---|---|---|---|---|---|
| FEAT-001 | Scalper | Y | `<confluence_page_id>` | `<gsheet_url>` | `<gsheet_id>` | V1 | In Scope | 2026-03-01 | |

**Tab 2 — Slack Channels**

| Feature ID | Channel Name | Channel ID | Keywords |
|---|---|---|---|
| FEAT-001 | #scalper-dev | C0XXXXXXXX | scalper, scalper flow |

**Tab 3 — Run State** (managed by the system automatically)

### 4. Grant permissions

- Share both Config and Output Google Sheets with the service account email (Editor access)
- Add the Slack bot to each channel it needs to monitor

## Running

### Start the server

```bash
npm start
```

### Manual trigger

```bash
curl -X POST http://localhost:3000/run
```

### Health check

```bash
curl http://localhost:3000/health
```

### Sample run response

```json
{
  "runId": "run_20260316_1430",
  "triggeredBy": "manual",
  "duration": 42,
  "featuresProcessed": 1,
  "changelogEntriesAdded": 3,
  "prdStatus": "success",
  "uatStatus": "success",
  "slackStatus": "success",
  "errors": []
}
```

## Testing endpoints

Once the server is running (`npm start`), verify all endpoints work:

```bash
# Health check — should return status ok + uptime
curl http://localhost:3000/health

# Trigger a full pipeline run
curl -X POST http://localhost:3000/run

# Retrieve a specific run by ID (replace <runId> with value from /run response)
curl http://localhost:3000/run/<runId>
```

Expected `/health` response:

```json
{
  "status": "ok",
  "uptime": 12,
  "lastRun": null
}
```

Expected `/run` response:

```json
{
  "runId": "run_20260316_1800",
  "triggeredBy": "manual",
  "duration": 38,
  "featuresProcessed": 1,
  "changelogEntriesAdded": 3,
  "prdStatus": "success",
  "uatStatus": "success",
  "slackStatus": "success",
  "errors": []
}
```

## Running tests

```bash
npm test
```

## Deployment (Railway / Render / Fly.io)

1. Push this repo to GitHub
2. Connect to Railway / Render and deploy
3. Set all environment variables in the platform dashboard
4. Note the public URL (e.g. `https://scope-tracker.railway.app`)
5. Set up cron-job.org:
   - URL: `https://scope-tracker.railway.app/run` — Method: `POST`
   - Schedule: `0 18 * * 1-5` (6pm every weekday)
   - Enable "Save responses" for audit trail

## Project structure

```
scope-tracker/
├── index.js              # HTTP server + entry point
├── orchestrator.js       # Main run loop
├── config/
│   └── configReader.js   # Reads Config Google Sheet
├── pipelines/
│   ├── prdPipeline.js
│   ├── uatPipeline.js
│   └── slackPipeline.js
├── ai/
│   ├── classifier.js     # Claude API — Slack thread classification
│   └── prdExtractor.js   # Claude API — PRD feature extraction
├── writer/
│   └── sheetWriter.js    # All Google Sheet write operations
├── utils/
│   ├── logger.js
│   ├── deduplicator.js
│   └── diffEngine.js     # PRD snapshot diff logic
├── state/
│   └── runState.json     # Last-run timestamps + PRD snapshots
├── .env.example
└── README.md
```

## UAT disposition rules

| Latest UAT Status | Blocker? | Disposition | Target Version |
|---|---|---|---|
| Failed | No | Pushed to next release | Current + 1 (e.g. V1 → V2) |
| Failed | Yes | Active Blocker | Current (do not park) |
| Parked for later | Any | Parked | Unversioned |
| Passed | Any | No action | — |
| Passed with iteration | Any | No action | Current |
| To be tested | Any | No action | — |
