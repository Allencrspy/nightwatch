# Nightwatch — night-before NSE intraday planning

Nightwatch runs your own **Night-Before NSE Intraday Stock Selection** prompt
(in [`prompts/night-before.md`](prompts/night-before.md), verbatim) on exact
exchange data from Dhan, reads ChatGPT's answer back into a dashboard, watches
the setups live during the session, and keeps a record of how every plan
actually played out.

The method is the prompt's. The app supplies data, reads the answer, does
arithmetic (risk-reward, Part 18 position size) and flags things worth a second
look — it never filters, re-scores or overrides what the analyst said.

---

## Running it

```bash
npm install
cp .env.example .env     # fill in DHAN_API_KEY, DHAN_API_SECRET, DHAN_CLIENT_ID, TOKEN_ENCRYPTION_SECRET
npm run start:all        # API on :3000 and dashboard on :5273
```

Open **http://localhost:5273** and log in on the **Connect** page (Dhan's own
QR / PIN / OTP page — the app never sees your credentials).

You need Dhan's **Data APIs** subscription (₹499/month) for historical and
intraday data. The API key and secret come from web.dhan.co → My Profile →
Access DhanHQ APIs → API key, with the redirect URL set to
`http://localhost:3000/auth/dhan/callback`.

## The nightly routine

| When | Page | What you do |
|---|---|---|
| Evening, after 15:30 | **Analyst** | Choose F&O or F&O + 100 most liquid non-F&O, then *Generate brief* (≈20 s / ≈1 min). |
| | ChatGPT | Paste the brief into a **Temporary Chat** with **web search on**. It replies with only `nightwatch-reply-<id>.json`. |
| | **Analyst** | Upload the file. |
| | **All setups** | Read the plan: top 3, trade plans (click a row for everything), watchlist, stocks to avoid, checklist. |
| | **Compare** | Several runs side by side, with a consensus column. |
| | **Market** | The exchange data the plan was written from. |
| Next morning 9:00–15:30 | **Live desk** | Checks every setup's conditions each minute: 5-min closes, VWAP, volume, NIFTY, sectors. |
| After that session | **Track record** | *Review* replays each setup bar by bar and records the result in R. |

Run the brief several times if you like — every uploaded plan is kept, shows
as a tab on All setups, and can be compared.

## Pages

- **Analyst** — generates the brief and accepts the reply (upload or paste).
- **All setups** — the plan. Tabs for past runs; warnings (⚠) flag stops on the
  wrong side, a level that matches another stock's row, a trigger 1.5× ATR
  from the close, a Part 18 size larger than capital, a setup also on the
  avoid list. Nothing is removed.
- **Compare** — pick runs; overview, then every stock with trade / watch /
  avoid per run, entry and stop spread, and results once reviewed.
- **Market** — indices, sector moves, top gainers and losers, and the exact
  figures for every stock the plan names.
- **Live desk** — live only on the session the plan is for.
- **Track record** — trigger rate, win rate, total and average R, top-3 only.
- **Risk & sizing** — capital, risk per trade, max trades; sent with each brief.
- **Data health** — API, Dhan session and token expiry, scan stats, skipped symbols.
- **Logs** — every request and error, secrets masked; copy or save for debugging.

## How results are counted

Each setup is replayed on the session's 5-minute bars in order. Entry fills at
the trigger, or at the open when price gaps through it. Where one bar touches
both the stop and a target, the stop is assumed first. A trade still open at
15:30 is marked to the close. R is the result divided by the planned
entry-to-stop risk.

Dhan's intraday bars for a session can stop around 15:10–15:14 on the evening
of that day; a review marks itself *bars end HH:MM* and can be updated later.
A session with no bars on a weekday is treated as a holiday and the next
weekday is used.

## Scripts

| Script | What it does |
|---|---|
| `npm run start:all` | API and dashboard together |
| `npm run dev` / `npm run web` | Each on its own |
| `npm test` | Test suite |
| `npm run typecheck` | Types only |
| `npm run check:universe` | Checks every F&O symbol resolves in Dhan's instrument master |
| `npm run verify:feed` | Spot-checks Dhan data against known closes |
| `npm run mock:plans` / `mock:clear` | Adds / removes three labelled mock runs (for trying Compare) |

## Local data files (all gitignored)

| File | Holds |
|---|---|
| `.sessions.json` | Dhan sessions, tokens AES-256-GCM encrypted |
| `.briefs.json` | Briefs and their scans, for 18 hours |
| `.plan-history.json` | Every accepted plan, its market context and review (newest 500) |
| `.instrument-master.json` | Cached Dhan symbol → security id map |

## API

| Method | Path | |
|---|---|---|
| GET | `/auth/dhan/status` · `/auth/dhan/login` · `/auth/dhan/callback` | Login |
| POST | `/api/v1/analyst/brief` | Scan and build the brief (`capital`, `riskPercent`, `maxTrades`, `universe: fno \| all`) |
| POST | `/api/v1/analyst/response` | Accept a reply (`response`, optional `briefId`) |
| GET | `/api/v1/analyst/latest` · `/api/v1/analyst/plans` · `/api/v1/analyst/plans/:id` | Plans |
| POST | `/api/v1/analyst/plans/:id/review` | Replay a plan's session |
| GET | `/api/v1/track-record` | Totals |
| GET | `/api/v1/monitor?briefId=` | Live condition check |
| POST | `/api/v1/intraday-analysis` | Same prompt through a model API (needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) |

All `/api/v1` routes need the session bearer token the dashboard holds.

## Limits worth knowing

- Nothing here places orders.
- Holidays are detected from missing data, not a calendar.
- Dhan allows one active token per client; logging in elsewhere ends this session.
- The analysis is only as good as the prompt and ChatGPT's reading of it — the
  warnings exist because it does occasionally read the wrong row.
