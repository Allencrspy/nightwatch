# Dhan Automated NSE Intraday Trading Analysis Backend API

A high-performance, deterministic + AI backend API built with **Node.js, TypeScript, Fastify, Zod, and OpenAI**.

It connects to **Dhan** as the broker/data provider, collects market/F&O data across the NSE F&O stock universe, performs deterministic technical analysis (EMA 20/50/200, RVOL, Support/Resistance, Relative Strength vs NIFTY and Sectors, F&O positioning), runs a **100-point weighted setup scoring model**, and uses an **AI analyst layer** to generate structured intraday trading plans with exact levels, scenarios, and risk management guidelines.

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
                                          (|change| >= 1.5%, RVOL >= 1.5)
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
