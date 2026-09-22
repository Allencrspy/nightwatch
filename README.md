# Nightwatch — NSE intraday analysis

A night-before intraday watchlist for NSE F&O stocks: a Fastify/TypeScript API
that pulls real market data from Dhan and runs it through the Night-Before NSE
Intraday Stock Selection framework, plus a dashboard that reads the result.

**One rule governs this codebase: nothing is invented.** When a source cannot
supply data, the request fails with a typed error naming it. Fields the
provider does not return are `null` and listed as unavailable. A factor that
cannot be assessed is excluded from the score rather than given a middling
default. There are no mock generators, no sandbox fallbacks, and no synthetic
prices anywhere — a trading setup built on fabricated inputs is
indistinguishable from a real one, which is the most dangerous thing this
service could produce.

---

## Running it

Two processes. Both are needed for the dashboard to do anything.

```bash
npm install
cp .env.example .env     # then fill in the Dhan values
npm run dev              # API on http://localhost:3000
npm run web              # dashboard on http://localhost:5273
```

Open http://localhost:5273 and use **Connect** in the sidebar to log in.

The dashboard is served from a real origin rather than opened from disk
because the Dhan login popup hands the session back via `postMessage`, and a
`file://` page has origin `null`, which cannot be a `postMessage` target.

| Script | What it does |
|---|---|
| `npm run dev` | API with reload |
| `npm run web` | Dashboard dev server |
| `npm test` | Test suite |
| `npm run typecheck` | Types only |
| `npm run verify:feed` | Asserts a Dhan close matches NSE exactly |

## Connecting to Dhan

Access is granted when you log in — no token is ever read from config.

**Primary route — browser login.** Every Dhan account can do this; it is not
a partner programme. At web.dhan.co go to *My Profile → Access DhanHQ APIs*,
toggle to **API key**, enter an app name, and set the Redirect URL to
`http://localhost:3000/auth/dhan/callback` exactly. Put the key, secret and
your client id in `.env` as `DHAN_API_KEY`, `DHAN_API_SECRET` and
`DHAN_CLIENT_ID`.

Pressing **Log in with Dhan** then opens Dhan's own login page in a popup,
where you authenticate however you prefer — **QR scan**, PIN or OTP. None of
that is handled here: it is Dhan's page, and your credentials never reach
this app. Dhan redirects back with a `tokenId`, the server exchanges it for a
24-hour access token, and encrypts it immediately.

Without those three values `/auth/dhan/login` returns 503 and the dashboard
says exactly what is missing.

**Fallback route.** You can also generate a 24-hour access token directly at
*My Profile → Access DhanHQ APIs* and paste it into the Connect screen. It is
verified against Dhan before any session is created, then encrypted. Same
session plumbing, different front door.

Tokens last 24 hours either way, so expect to log in once a day.

Either way your browser holds only an opaque session id, sent as a bearer
token. The access token stays encrypted server-side.

## Verifying the feed

**The Dhan endpoint shapes in this repo are unverified against a live
account.** They follow the published v2 API but have never run with real
credentials. Once you can log in:

```bash
npm run verify:feed -- --session <id> --symbol SUNPHARMA --close 1868.90
```

It asserts the latest daily close matches a figure you have checked against
NSE, to the paisa. Until that passes, treat every number this service
produces as unconfirmed. That single assertion is what separates a real feed
from a plausible one.

## Selection: the framework, in order

Thirteen stages run per symbol, in the framework's own order. Each returns
PASS, DEMOTE (watchlist-only) or REJECT; a run stops at the first rejection
and records which stage fired, so every excluded name carries a reason.

| Part | Stage | Rule it enforces |
|---|---|---|
| 2 | `priceMovement` | ±1.5% — identification only, never feeds the ranking |
| 2 | `volume` | RVOL, plus what the volume accompanied |
| 3 | `priceStructure` | swing range and a usable support/resistance pair |
| 3 | `trend` | EMA position — never an automatic buy/sell signal |
| 4 | `setup` | must engage a prior level, not merely have risen |
| 5 | `closingStrength` | where the candle finished in its range |
| 6 | `relativeStrength` | vs NIFTY 50 and vs sector |
| 7 | `sector` | confirms, conflicts, or cannot be read |
| 8 | `newsCatalyst` | absence stated, never invented, never penalised |
| 9 | `fnoPositioning` | supporting evidence only, never standalone |
| 10 | `liquidity` | turnover and 20-day average volume |
| 13 | `riskReward` | room to reach T1 at 2R |
| 19 | `extension` | too extended to chase |

Ranking uses the framework's Part 11 eight-factor model (price structure 20,
volume 20, relative strength 15, breakout quality 15, trend 10, sector 10,
liquidity 5, news 5). Unassessable factors are excluded and reported in
`unknownFactors`, with `assessableMax` as the real denominator.

When nothing clears every stage, `noHighQualitySetup` is true and the
response says so. The framework's instruction not to force a trade is
enforced by the schema, which rejects a response claiming both.

## Validation

The response schema checks geometry, not just shape: stop on the correct side
of entry, targets ordered outward, stated risk-reward matching its own levels,
factors summing to the stated total, position value within capital, daily loss
within 2%. A plan that fails is withheld rather than served.

## Debugging

The dashboard has a **Logs** view recording every request and response with
status and timing, auth events, scan results, data notes, and uncaught errors.
Copy or download it for a bug report — access tokens, session ids and client
ids are masked to a prefix and length before they are stored.

---

## Architecture Overview

```
                      Client Request
                    POST /api/v1/intraday-analysis
                                 │
                                 ▼
                          Fastify API Server
                                 │
          ┌──────────────────────┴──────────────────────┐
          │                                             │
          ▼                                             ▼
     Dhan Auth                                    Analysis Pipeline
  (Encrypted Token Store)                              │
                                                       ▼
                                            NSE F&O Candidate Scanner
                                     (13 framework stages, in framework order)
                                                       │
                                                       ▼
                                          Deterministic Technical Engine
                                        (EMAs, RVOL, S/R, RelStrength, OI)
                                                       │
                                                       ▼
                                           100-Point Scoring Engine
                                        (20+20+15+15+10+10+5+5 Model)
                                                       │
                                                       ▼
                                               AI Analyst Layer
                                        (OpenAI LLM + Strict Zod Schema)
                                                       │
                                                       ▼
                                           Structured JSON Response
```

---

## 🚀 Getting Started

### 1. Requirements & Workspace
Open `/Users/allenbinuthomas/.gemini/antigravity-ide/scratch/dhan-trading-analysis-api` as your workspace directory.

### 2. Environment Setup
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Environment variables:
- `PORT`: HTTP server port (Default: `3000`)
- `DHAN_CLIENT_ID`: (Optional) Your Dhan Client ID
- `DHAN_ACCESS_TOKEN`: (Optional) Pre-generated Dhan Access Token
- `OPENAI_API_KEY`: (Optional) OpenAI API Key for AI Analyst layer (includes deterministic fallback)
- `TOKEN_ENCRYPTION_SECRET`: 32-character AES encryption key

### 3. Installation & Running
```bash
# Install dependencies
npm install

# Run dev server with auto-reload
npm run dev

# Run unit and integration tests
npm test

# Build TypeScript production bundle
npm run build
```

---

## 📡 API Endpoints

### 1. Health Check
`GET /health`

**Response:**
```json
{
  "status": "OK",
  "timestamp": "2026-09-22T16:35:00.000Z",
  "service": "dhan-trading-analysis-api",
  "version": "1.0.0"
}
```

### 2. Dhan OAuth Authentication

- `GET /auth/dhan/login` -> Generates Dhan consent OAuth login URL.
- `GET /auth/dhan/callback` -> Receives callback `tokenId`, exchanges it for `accessToken`, encrypts it using AES-256-GCM, and stores it server-side.
- `GET /auth/dhan/status` -> Checks current token connection status.
- `POST /auth/dhan/disconnect` -> Clears active session.

### 3. Intraday Analysis API
`POST /api/v1/intraday-analysis`

**Request Body:**
```json
{
  "capital": 500000,
  "riskPercent": 0.5,
  "maxTrades": 3
}
```

**Response Overview:**
```json
{
  "success": true,
  "data": {
    "market": {
      "bias": "BULLISH",
      "nifty": { "lastPrice": 24500, "changePercent": 0.65 },
      "bankNifty": { "lastPrice": 52000, "changePercent": 0.82 },
      "strongestSectors": ["NIFTY BANK", "NIFTY ENERGY"],
      "weakestSectors": ["NIFTY IT"],
      "noTradeConditions": [
        "First 15 minutes extreme volatility (9:15 - 9:30 AM)",
        "Gap up / Gap down larger than 1.5% without 5-min consolidation"
      ]
    },
    "setups": [
      {
        "symbol": "RELIANCE",
        "bias": "LONG",
        "setupType": "BREAKOUT",
        "score": 87,
        "scoreBreakdown": {
          "priceStructure": 20,
          "volume": 20,
          "relativeStrength": 15,
          "breakoutQuality": 15,
          "trend": 10,
          "sector": 10,
          "liquidity": 5,
          "news": 5,
          "totalScore": 87
        },
        "close": 3000,
        "entryTrigger": 3006,
        "stopLoss": 2940,
        "targets": [3138, 3237],
        "riskRewardRatio": 2.0,
        "invalidation": "Sustained trade below stop loss price of 2940",
        "bullishScenario": "Price breaks above 3006 with RVOL > 1.5 reaching T1 (3138) and T2 (3237).",
        "bearishScenario": "Rejection at 3006 pushing price back towards support 2880.",
        "positionSizing": {
          "recommendedShares": 37,
          "positionValue": 111222,
          "riskAmount": 2442
        }
      }
    ],
    "top3BestSetups": ["RELIANCE", "TATAMOTORS", "JINDALSTEL"],
    "topLongCandidates": ["RELIANCE", "TATAMOTORS", "JINDALSTEL"],
    "topShortCandidates": ["SBIN", "SUNPHARMA"],
    "stocksToAvoid": [
      { "symbol": "WIPRO", "reason": "Consolidating in tight chop zone without volume expansion" }
    ],
    "checklist900to915": [
      "Verify SGX/Gift Nifty pre-market direction & opening gap size",
      "Confirm shortlisted stock opening price relative to Entry Trigger",
      "Check early 9:15 AM volume surge vs 5-day average 15-min volume"
    ],
    "riskManagement": {
      "capital": 500000,
      "riskPerTradePercent": 0.5,
      "maxRiskPerTradeAmount": 2500,
      "maxTrades": 3,
      "dailyLossLimit": 11250,
      "stopTradingConditions": [
        "Consecutive 2 losing trades reached",
        "Total daily loss limit of Rs. 11250 breached"
      ]
    }
  }
}
```

---

## 📊 Deterministic 100-Point Scoring Breakdown

| Factor | Weight |
|---|---|
| Price structure | 20 |
| Volume / RVOL | 20 |
| Relative strength | 15 |
| Breakout/breakdown quality | 15 |
| Trend alignment | 10 |
| Sector confirmation | 10 |
| Liquidity | 5 |
| News / Catalyst | 5 |
| **Total** | **100** |

---

## 🧪 Testing & Verification

Run the complete test suite:
```bash
npm test
```

Build production bundle:
```bash
npm run build
```
