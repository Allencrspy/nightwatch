# Frontend API Documentation - NSE Intraday Trading Analysis API

This document provides full technical specifications, data architecture explanations, TypeScript interfaces, sample JSON responses, React integration hooks, and UI component mapping guidelines for building frontend web or mobile apps consuming the **NSE Intraday Trading Analysis Backend API**.

---

## 🏗️ How Data is Fetched & Processed (Architecture & Pipeline)

The backend follows a **Data → Deterministic Calculations → Scoring → AI Reasoning** pipeline. The AI model is never allowed to invent or guess technical indicators; it acts purely as a reasoning analyst over verified market facts.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. DATA INGESTION (Dhan REST API / Sandbox Engine)                                     │
│    - Historical OHLCV Candles (200 daily bars) for ~180 NSE F&O Stocks + Indices      │
│    - Market Quotes, Open Interest (OI), Change in OI, and Traded Value Turnover (Cr) │
└────────────────────────────────────────────────────────┬───────────────────────────────┘
                                                         │
                                                         ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 2. CANDIDATE SCANNER & FILTERING                                                       │
│    - Filters ~180 F&O universe down to active movers                                  │
│    - Conditions: |Price Change| >= 1.5% OR RVOL >= 1.5 AND Traded Value >= 10 Cr      │
└────────────────────────────────────────────────────────┬───────────────────────────────┘
                                                         │
                                                         ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 3. DETERMINISTIC TECHNICAL CALCULATIONS                                               │
│    - EMAs: EMA 20, EMA 50, EMA 200                                                     │
│    - RVOL: Today's Volume / 20-Day Average Volume                                      │
│    - Support / Resistance: 20-Day Swing Highs & Swing Lows                             │
│    - Closing Strength: (Close - Low) / (High - Low)                                    │
│    - Relative Strength: (Stock Return - NIFTY Return) & (Stock Return - Sector Return) │
│    - F&O OI Matrix: Long Buildup, Short Buildup, Short Covering, Long Unwinding        │
└────────────────────────────────────────────────────────┬───────────────────────────────┘
                                                         │
                                                         ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 4. DETERMINISTIC 100-POINT SCORING ENGINE                                             │
│    - Price Structure (20 pts) + Volume/RVOL (20 pts) + Relative Strength (15 pts)     │
│    - Breakout Quality (15 pts) + Trend (10 pts) + Sector (10 pts)                     │
│    - Liquidity (5 pts) + News (5 pts) = TOTAL 100 PTS                                  │
└────────────────────────────────────────────────────────┬───────────────────────────────┘
                                                         │
                                                         ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 5. AI ANALYST REASONING LAYER (OpenAI + Strict Zod Schema)                              │
│    - Receives verified math facts + "Night-Before Stock Selection" prompt framework    │
│    - Synthesizes setups, entry triggers, stop loss, targets (T1, T2), R:R >= 2.0       │
│    - Computes exact position sizing (Shares = Risk Amount / Risk Per Share)            │
│    - Outputs structured JSON response                                                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### Step-by-Step Data Processing Breakdown

#### Step 1: Market Data Ingestion
- **Source**: Dhan REST API (`https://api.dhan.co`) or Sandbox Market Engine.
- **Payload Fetched**:
  - `Historical OHLCV`: Array of 200 daily candles (`open`, `high`, `low`, `close`, `volume`).
  - `Quote Data`: `lastPrice`, `open`, `high`, `low`, `close`, `volume`, `openInterest`, `oiChangePercent`, `totalTradedValueCr`.
  - `Indices`: NIFTY 50 and BANK NIFTY benchmarks.

#### Step 2: F&O Candidate Scanning
Instead of sending 200 stocks to an AI blindly, the deterministic candidate scanner filters the universe:
- **Price Change Threshold**: $|changePercent| \ge 1.5\%$
- **Volume Expansion Threshold**: $RVOL \ge 1.5$ (Volume at least 50% higher than 20-day average)
- **Liquidity Guard**: Total daily turnover $\ge 10\text{ Cr}$

#### Step 3: Mathematical Technical Calculations
- **Exponential Moving Average (EMA)**:
  $$k = \frac{2}{\text{Period} + 1}, \quad \text{EMA}_{\text{today}} = (\text{Close}_{\text{today}} - \text{EMA}_{\text{prev}}) \cdot k + \text{EMA}_{\text{prev}}$$
- **Relative Volume (RVOL)**:
  $$\text{RVOL} = \frac{\text{Volume}_{\text{today}}}{\frac{1}{20}\sum_{i=1}^{20}\text{Volume}_{\text{today}-i}}$$
- **Closing Strength Ratio**:
  $$\text{Strength} = \frac{\text{Close} - \text{Low}}{\text{High} - \text{Low}}$$
  *(1.0 = Closed at high of day, 0.0 = Closed at low of day)*
- **F&O Price + Open Interest Matrix**:
  - `Price ↑` + `OI ↑` = **LONG BUILDUP** (Strong buying interest)
  - `Price ↓` + `OI ↑` = **SHORT BUILDUP** (Aggressive shorting)
  - `Price ↑` + `OI ↓` = **SHORT COVERING** (Short sellers exiting)
  - `Price ↓` + `OI ↓` = **LONG UNWINDING** (Long holders exiting)

#### Step 4: 100-Point Weighted Setup Scoring Model
Each candidate stock is assigned a score from **0 to 100** based on verified parameters:
- **Price Structure (20 pts)**: Trend direction & closing strength alignment.
- **Volume / RVOL (20 pts)**: Maximum 20 pts when $RVOL \ge 2.0$.
- **Relative Strength (15 pts)**: Outperformance vs NIFTY 50 and Sector Index.
- **Breakout Quality (15 pts)**: Clean price breakout above 20-day swing high/low.
- **Trend Alignment (10 pts)**: EMA 20 > EMA 50 > EMA 200 alignment.
- **Sector Confirmation (10 pts)**: Sector direction matching stock bias.
- **Liquidity (5 pts)**: Daily turnover $> 50\text{ Cr}$.
- **News / Catalyst (5 pts)**: Corporate actions or news sentiment.

#### Step 5: AI Analyst Synthesis & Position Sizing
Verified facts and top-scored candidates are passed to OpenAI with a strict Zod response schema.
The AI layer:
1. Formulates trade setups where **Risk-Reward Ratio** $\ge 2.0$:
   $$\text{Risk Per Share} = |\text{Entry Trigger} - \text{Stop Loss}|$$
   $$\text{Target 1} = \text{Entry Trigger} \pm (2.0 \times \text{Risk Per Share})$$
   $$\text{Target 2} = \text{Entry Trigger} \pm (3.5 \times \text{Risk Per Share})$$
2. Computes exact **Position Sizing**:
   $$\text{Max Risk Amount} = \text{Capital} \times \left(\frac{\text{Risk Percent}}{100}\right)$$
   $$\text{Recommended Shares} = \left\lfloor \frac{\text{Max Risk Amount}}{\text{Risk Per Share}} \right\rfloor$$
   $$\text{Position Value} = \text{Recommended Shares} \times \text{Entry Trigger}$$

---

## 🌐 Base URL & Server Configuration

- **Development Base URL**: `http://localhost:3000`
- **Content Type**: `application/json`
- **CORS**: Enabled (`Access-Control-Allow-Origin: *`)

---

## 📐 TypeScript Interfaces (Copy-Paste for Frontend Codebase)

```typescript
// --- Request Interface ---
export interface IntradayAnalysisRequest {
  capital?: number;       // Default: 500000 (Rs.)
  riskPercent?: number;   // Default: 0.5 (%)
  maxTrades?: number;     // Default: 3
  forceRefresh?: boolean; // Default: false
}

// --- Response Interfaces ---
export interface ScoreBreakdown {
  priceStructure: number;   // Max 20
  volume: number;           // Max 20
  relativeStrength: number; // Max 15
  breakoutQuality: number;  // Max 15
  trend: number;            // Max 10
  sector: number;           // Max 10
  liquidity: number;        // Max 5
  news: number;             // Max 5
  totalScore: number;       // Max 100
}

export interface PositionSizing {
  recommendedShares: number;
  positionValue: number;
  riskAmount: number;
}

export interface IntradaySetup {
  symbol: string;
  bias: 'LONG' | 'SHORT';
  setupType: 'BREAKOUT' | 'BREAKDOWN' | 'CONTINUATION' | 'PULLBACK' | 'SUPPORT_REVERSAL' | 'RESISTANCE_REJECTION';
  score: number;
  scoreBreakdown: ScoreBreakdown;
  close: number;
  entryTrigger: number;
  stopLoss: number;
  targets: [number, number]; // [Target 1, Target 2]
  riskRewardRatio: number;
  invalidation: string;
  bullishScenario: string;
  bearishScenario: string;
  positionSizing: PositionSizing;
}

export interface MarketOverview {
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  nifty: {
    lastPrice: number;
    changePercent: number;
  };
  bankNifty: {
    lastPrice: number;
    changePercent: number;
  };
  strongestSectors: string[];
  weakestSectors: string[];
  noTradeConditions: string[];
}

export interface StockToAvoid {
  symbol: string;
  reason: string;
}

export interface RiskManagementRules {
  capital: number;
  riskPerTradePercent: number;
  maxRiskPerTradeAmount: number;
  maxTrades: number;
  dailyLossLimit: number;
  stopTradingConditions: string[];
}

export interface IntradayAnalysisResponseData {
  market: MarketOverview;
  setups: IntradaySetup[];
  top3BestSetups: string[];
  topLongCandidates: string[];
  topShortCandidates: string[];
  stocksToAvoid: StockToAvoid[];
  checklist900to915: string[];
  riskManagement: RiskManagementRules;
}

export interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
```

---

## 📡 API Endpoints Specification

### 1. Run Intraday Stock Selection & Analysis

- **Endpoint**: `POST /api/v1/intraday-analysis`
- **Description**: Executes market scanner, calculates technical metrics, computes 100-pt setup scores, and returns AI analyst recommendations.

#### Request Body Example
```json
{
  "capital": 500000,
  "riskPercent": 0.5,
  "maxTrades": 3
}
```

#### Response Body Example (200 OK)
```json
{
  "success": true,
  "data": {
    "market": {
      "bias": "BULLISH",
      "nifty": {
        "lastPrice": 24500,
        "changePercent": 0.65
      },
      "bankNifty": {
        "lastPrice": 52000,
        "changePercent": 0.82
      },
      "strongestSectors": ["NIFTY BANK", "NIFTY ENERGY"],
      "weakestSectors": ["NIFTY IT"],
      "noTradeConditions": [
        "First 15 minutes extreme volatility (9:15 - 9:30 AM)",
        "Gap up / Gap down larger than 1.5% without 5-min consolidation",
        "RVOL dropping below 1.0 during trigger window"
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
        "bullishScenario": "Price breaks above 3006 with RVOL > 1.5, reaching T1 (3138) and T2 (3237).",
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
      {
        "symbol": "WIPRO",
        "reason": "Consolidating in tight chop zone without volume expansion"
      }
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

### 2. Dhan Connection Status

- **Endpoint**: `GET /auth/dhan/status`
- **Description**: Returns status of Dhan access token authentication.

#### Response Body Example
```json
{
  "success": true,
  "data": {
    "connected": true,
    "clientId": "DHAN_CLIENT_123",
    "connectedAt": "2026-09-22T15:30:00.000Z",
    "source": "ENV"
  }
}
```

---

### 3. Generate Dhan OAuth Login URL

- **Endpoint**: `GET /auth/dhan/login`
- **Description**: Returns URL for user redirection to Dhan OAuth portal.

#### Response Body Example
```json
{
  "success": true,
  "loginUrl": "https://api.dhan.co/auth/consent?clientId=XYZ&redirectUri=...",
  "state": "abc123state"
}
```

---

## 💻 React Integration Code Examples

### 1. Custom React Hook (`useIntradayAnalysis.ts`)

```typescript
import { useState } from 'react';
import type { IntradayAnalysisRequest, IntradayAnalysisResponseData } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export function useIntradayAnalysis() {
  const [data, setData] = useState<IntradayAnalysisResponseData | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalysis = async (params: IntradayAnalysisRequest = {}) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/intraday-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      const resJson = await response.json();
      if (!resJson.success) {
        throw new Error(resJson.message || 'Failed to fetch intraday analysis');
      }

      setData(resJson.data);
    } catch (err: any) {
      setError(err.message || 'Network error connecting to API');
    } finally {
      setLoading(false);
    }
  };

  return { data, loading, error, fetchAnalysis };
}
```

---

### 2. Sample Component (`IntradayDashboard.tsx`)

```tsx
import React, { useEffect } from 'react';
import { useIntradayAnalysis } from './useIntradayAnalysis';

export const IntradayDashboard: React.FC = () => {
  const { data, loading, error, fetchAnalysis } = useIntradayAnalysis();

  useEffect(() => {
    fetchAnalysis({ capital: 500000, riskPercent: 0.5, maxTrades: 3 });
  }, []);

  if (loading) return <div className="p-8 text-center text-lg">Running NSE Market Scan & AI Analysis...</div>;
  if (error) return <div className="p-4 text-red-500 bg-red-50 rounded">Error: {error}</div>;
  if (!data) return null;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-8">
      {/* Header & Market Bias */}
      <header className="flex justify-between items-center border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold">NSE Intraday Stock Selection</h1>
          <p className="text-sm text-gray-500">Powered by Dhan API & AI Analyst</p>
        </div>
        <div className={`px-4 py-2 rounded-full font-bold text-white ${
          data.market.bias === 'BULLISH' ? 'bg-green-600' : data.market.bias === 'BEARISH' ? 'bg-red-600' : 'bg-gray-600'
        }`}>
          Market Bias: {data.market.bias}
        </div>
      </header>

      {/* Top 3 Setups Grid */}
      <section>
        <h2 className="text-xl font-bold mb-4">⭐ Top 3 Recommended Setups</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {data.setups.slice(0, 3).map((setup) => (
            <div key={setup.symbol} className="border rounded-xl p-5 shadow-sm bg-white space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-lg font-extrabold">{setup.symbol}</span>
                <span className={`text-xs px-2 py-1 rounded font-bold ${
                  setup.bias === 'LONG' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                }`}>
                  {setup.bias} ({setup.setupType})
                </span>
              </div>
              <div className="text-2xl font-bold text-blue-600">{setup.score} / 100 Score</div>
              <div className="text-sm space-y-1">
                <div><strong>Entry:</strong> ₹{setup.entryTrigger}</div>
                <div><strong>Stop Loss:</strong> ₹{setup.stopLoss}</div>
                <div><strong>Targets:</strong> ₹{setup.targets[0]} / ₹{setup.targets[1]}</div>
                <div><strong>Risk/Reward:</strong> {setup.riskRewardRatio}x</div>
                <div><strong>Shares:</strong> {setup.positionSizing.recommendedShares} units</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Risk Management Footer Card */}
      <section className="bg-slate-900 text-white rounded-xl p-6">
        <h3 className="text-lg font-bold mb-2">🛡️ Risk Management Parameters</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>Capital: ₹{data.riskManagement.capital.toLocaleString()}</div>
          <div>Risk / Trade: {data.riskManagement.riskPerTradePercent}% (₹{data.riskManagement.maxRiskPerTradeAmount})</div>
          <div>Max Trades: {data.riskManagement.maxTrades}</div>
          <div>Daily Loss Limit: ₹{data.riskManagement.dailyLossLimit}</div>
        </div>
      </section>
    </div>
  );
};
```

---

## 🎨 UI Component Mapping Recommendations

| UI Card / Widget | Response Field | Rendering Suggestion |
|---|---|---|
| **Market Bias Badge** | `data.market.bias` | Green badge for `BULLISH`, Red for `BEARISH`, Gray for `NEUTRAL` |
| **Index Tickers** | `data.market.nifty`, `data.market.bankNifty` | Display price and green/red `%` pill |
| **Top Setups Cards** | `data.setups` | Card showing symbol, setup type, Score progress bar, Entry, SL, T1, T2 |
| **Setup Score Meter** | `setup.scoreBreakdown` | Circular gauge or stacked bar chart out of 100 |
| **Position Sizing Calculator** | `setup.positionSizing` | Show recommended quantity & capital allocation |
| **Stocks to Avoid** | `data.stocksToAvoid` | Red warning list showing symbol and reason |
| **Pre-market Checklist** | `data.checklist900to915` | Interactive checkbox list for 9:00 AM - 9:15 AM preparation |
