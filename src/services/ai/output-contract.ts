import { MIN_RISK_REWARD } from '../../schemas/analysis-response.schema.js';
import { SCORING_WEIGHTS } from '../../config/constants.js';

/**
 * The complete output contract, stated once, in the brief.
 *
 * Every rule the server enforces on an analyst's reply is written here, and
 * every number comes from the same constants the validator uses. Before this
 * existed the rules were scattered: some in the framework prompt, several only
 * in the server and never told to the analyst — so each one surfaced as a
 * rejected reply and a patch, one at a time. An analyst can only satisfy the
 * rules it is given.
 *
 * CONTRACT_EXAMPLE is checked against the real schema by the test suite, so
 * the example can never describe something the validator would refuse.
 */

const w = SCORING_WEIGHTS;

export const CONTRACT_EXAMPLE = {
  briefId: 'EXAMPLE123',
  marketBias: 'NEUTRAL',
  marketRead: 'FACT: NIFTY closed down 0.36%. INTERPRETATION: a mildly weak session with no broad selling.',
  strongestSectors: ['NIFTY ENERGY'],
  weakestSectors: ['NIFTY IT'],
  noHighQualitySetup: false,
  setups: [
    {
      symbol: 'EXAMPLE',
      bias: 'LONG',
      setupType: 'BREAKOUT',
      tier: 'HIGH',
      score: 73,
      scoreBreakdown: {
        priceStructure: 16, volume: 15, relativeStrength: 12, breakoutQuality: 11,
        trend: 8, sector: 7, liquidity: 4, news: null,
        totalScore: 73, assessableMax: 95, unknownFactors: ['news'],
      },
      entryTrigger: 100,
      stopLoss: 98,
      targets: [104, 107],
      why: 'FACT: closed 99.60, cleared the 20-day high of 99.40 on 1.8x volume. INTERPRETATION: a genuine breakout with participation.',
      volumeCharacter: 'Breakout: 1.8x the 20-day average while clearing the prior high.',
      invalidation: 'A 5-minute close back below 98.',
      bullishScenario: 'Holds 100 after the open on rising volume and reaches 104, then 107.',
      bearishScenario: 'Rejected at 100 and loses 98 — the breakout has failed.',
      conditions: [
        { text: '5-minute close above 100', required: true,
          check: { type: 'price_close_above', value: 100, timeframe: '5m' } },
        { text: 'Price above session VWAP', required: true, check: { type: 'above_vwap' } },
        { text: 'Breakout candle volume at least 1.5x recent bars', required: true,
          check: { type: 'volume_expansion', multiple: 1.5 } },
        { text: 'NIFTY holding above 23300', required: false,
          check: { type: 'index_above', index: 'NIFTY 50', value: 23300 } },
        { text: 'Energy sector positive', required: false,
          check: { type: 'sector_positive', sector: 'NIFTY ENERGY' } },
        { text: 'Retest of 100 holds', required: false,
          check: { type: 'manual', note: 'Judgement after the open.' } },
      ],
      gapPlan: [
        { condition: 'flat (within 0.5%)', action: 'Wait for a 5-minute close above 100.' },
        { condition: 'gaps up 1-2%', action: 'Do not chase; wait for a pullback that holds 100.' },
        { condition: 'gaps up beyond 3%', action: 'Cancel — risk-reward to 104 no longer works.' },
        { condition: 'gaps down 1-2%', action: 'Wait for 100 to be reclaimed before considering it.' },
        { condition: 'gaps down beyond 3%', action: 'Cancel the long.' },
      ],
    },
  ],
  top3BestSetups: ['EXAMPLE'],
  stocksToAvoid: [{ symbol: 'OTHER', reason: 'Too extended: 14% over four sessions.' }],
  checklist900to915: ['Check the opening gap against 100.'],
  noTradeConditions: ['NIFTY gaps more than 1% against the trade.'],
  bestLong: 'EXAMPLE — clean breakout with volume.',
  bestShort: null,
  selfCritique: 'The breakout is one session old and the sector confirmation is modest.',
};

export function outputContract(): string {
  return `## OUTPUT CONTRACT — every rule here is checked, and a setup that breaks one is rejected

Return ONE JSON object. Numbers are JSON numbers, never strings. Use straight double quotes only.

### Top level (all required)
- briefId: string — the id of the brief you were given
- marketBias: "BULLISH" | "BEARISH" | "NEUTRAL"
- marketRead: string — FACT then INTERPRETATION
- strongestSectors, weakestSectors: arrays of sector names from the fact sheet
- noHighQualitySetup: boolean — MUST be true if no setup has tier "HIGH", and false if at least one does
- setups: array (may be empty)
- top3BestSetups: at most 3 symbols, and ONLY symbols of setups with tier "HIGH"
- stocksToAvoid: [{ "symbol", "reason" }]
- checklist900to915, noTradeConditions: arrays of strings
- bestLong, bestShort: string or null
- selfCritique: string

### Each setup (all fields required)
- symbol: MUST be one of the candidates in the fact sheet. Any other symbol is rejected.
- bias: "LONG" | "SHORT"
- tier: "HIGH" | "WATCHLIST"
- setupType: "BREAKOUT" | "BREAKDOWN" | "CONTINUATION" | "PULLBACK" | "SUPPORT_REVERSAL" | "RESISTANCE_REJECTION"
- entryTrigger, stopLoss: positive numbers taken from the fact sheet's levels
- targets: EXACTLY two positive numbers [T1, T2]
- why, volumeCharacter, invalidation, bullishScenario, bearishScenario: non-empty strings
- conditions: array, at least one required condition (shape below)
- gapPlan: five entries — flat, gap up 1-2%, gap up >3%, gap down 1-2%, gap down >3%

### Geometry — the most common reason for rejection
- LONG:  stopLoss < entryTrigger < T1 < T2
- SHORT: stopLoss > entryTrigger > T1 > T2
- Risk-reward to T1 MUST be at least ${MIN_RISK_REWARD}:1, where
    LONG:  (T1 - entryTrigger) / (entryTrigger - stopLoss) >= ${MIN_RISK_REWARD}
    SHORT: (entryTrigger - T1) / (stopLoss - entryTrigger) >= ${MIN_RISK_REWARD}
  Calculate this for every setup. A wide stop with a near target fails: risking 95.90 to make 12.20 is 0.13:1.
  If no combination of the fact sheet's levels reaches ${MIN_RISK_REWARD}:1, do NOT propose the setup — list it in stocksToAvoid with the reason "poor risk-reward".
- T1 and T2 must be different numbers. Where structure gives only one level beyond the trigger, take the other from the one- or two-ATR projection.
- Do not state risk-reward or position size: the server computes both from your levels.

### Score
- score MUST equal scoreBreakdown.totalScore.
- Factor maximums: priceStructure ${w.priceStructure}, volume ${w.volume}, relativeStrength ${w.relativeStrength}, breakoutQuality ${w.breakoutQuality}, trend ${w.trend}, sector ${w.sector}, liquidity ${w.liquidity}, news ${w.news}.
- Catalysts are UNKNOWN unless the fact sheet says otherwise, so set news to null, include "news" in unknownFactors, and set assessableMax to ${100 - w.news}.
- totalScore MUST equal the sum of the factors (news counting as 0 when null), and MUST NOT exceed assessableMax.

### Conditions
Each is { "text": string, "required": boolean, "check": <one of> }:
  { "type": "price_close_above", "value": n, "timeframe": "5m" }
  { "type": "price_close_below", "value": n, "timeframe": "5m" }
  { "type": "above_vwap" }  |  { "type": "below_vwap" }
  { "type": "volume_expansion", "multiple": 1.5 }
  { "type": "index_above", "index": "NIFTY 50", "value": n }  |  { "type": "index_below", ... }
  { "type": "sector_positive", "sector": "<name from fact sheet>" }  |  { "type": "sector_negative", ... }
  { "type": "manual", "note": string }   — for what genuinely needs a human
Include the trigger, volume expansion and VWAP as required; market and sector as preferences if they are not decisive.

### Before you save — check every setup against this list
1. Is the symbol in the fact sheet?
2. Is the order of stop, entry, T1, T2 correct for the bias?
3. Is (T1 - entry) / (entry - stop) at least ${MIN_RISK_REWARD}?
4. Are T1 and T2 different?
5. Does score equal totalScore, and does totalScore equal the sum of the factors?
6. Is noHighQualitySetup consistent with the tiers?
7. Is every top3BestSetups entry a HIGH-tier setup?
Remove or fix any setup that fails before saving.

### A complete, valid example (illustrative symbol and prices — use the fact sheet's)
${JSON.stringify(CONTRACT_EXAMPLE, null, 2)}`;
}
