/**
 * The shape of the summary the app reads back.
 *
 * This is a format, not a set of trading rules. It mirrors the prompt's own
 * Part 12 (the 5-10 name watchlist), Part 13 (trade plans for the top 3-5)
 * and Part 19 (top 3, stocks to avoid, bias, best long and short, no-trade
 * conditions), so the file is the prompt's own output in machine-readable
 * form. Nothing here tells the analyst what a good trade is: that is the
 * prompt's job, and it has a month of real use behind it.
 *
 * CONTRACT_EXAMPLE is parsed by the test suite with the same reader the app
 * uses, so the example can never describe a file the app would fail to read.
 */

export const CONTRACT_EXAMPLE = {
  briefId: 'EXAMPLE123',
  dataAsOf: '2026-09-23 15:30 IST',
  marketBias: 'BULLISH',
  marketStrength: 'Moderately bullish',
  marketRead: 'NIFTY rose 0.6% with metals leading and IT lagging.',
  strongestSectors: ['METAL', 'ENERGY'],
  weakestSectors: ['IT'],
  noHighQualitySetup: false,
  watchlist: [
    { rank: 1, symbol: 'ABC', bias: 'LONG', setup: 'Breakout', score: 88, keyLevel: 505,
      note: 'Crossed 505 on 2.4x volume, closed near the high.' },
    { rank: 2, symbol: 'XYZ', bias: 'SHORT', setup: 'Breakdown', score: 84, keyLevel: 820,
      note: 'Lost 820 support with heavy selling.' },
  ],
  setups: [
    {
      symbol: 'ABC',
      bias: 'LONG',
      setup: 'Breakout',
      score: 88,
      entryTrigger: 505,
      stopLoss: 495,
      targets: [515, 525],
      riskReward: '1:1 to T1, 2:1 to T2',
      why: 'Breakout + high volume + strong sector + relative strength.',
      catalyst: 'Order win announced after market hours (source: exchange filing).',
      invalidation: 'Falls back below 500 and loses 490 with strong selling.',
      bullishScenario: 'Opens near 500 and breaks 505 with strong volume while NIFTY stays supportive.',
      bearishScenario: 'Fails to hold 500 and breaks 490 with strong selling.',
      gapPlan: [
        { condition: 'Opens near yesterday\'s close', action: 'Wait for a 5-minute close above 505.' },
        { condition: 'Gaps up 1-2%', action: 'Do not chase; wait for a pullback that holds 505.' },
        { condition: 'Gaps up >3-5%', action: 'Avoid; risk-reward to 515 no longer works.' },
        { condition: 'Gaps down 1-2%', action: 'Wait for 500 to be reclaimed.' },
        { condition: 'Gaps down >3-5%', action: 'Cancel the long.' },
      ],
      conditions: [
        { text: '5-minute close above 505', required: true,
          check: { type: 'price_close_above', value: 505, timeframe: '5m' } },
        { text: 'Price above VWAP', required: true, check: { type: 'above_vwap' } },
        { text: 'Breakout candle volume 1.5x recent bars', required: true,
          check: { type: 'volume_expansion', multiple: 1.5 } },
        { text: 'NIFTY supportive', required: false,
          check: { type: 'index_above', index: 'NIFTY 50', value: 23300 } },
      ],
    },
  ],
  top3: ['ABC'],
  stocksToAvoid: [{ symbol: 'PQR', reason: 'Too extended after a 14% four-day run.' }],
  bestLong: 'ABC — clean breakout with volume and sector support.',
  bestShort: 'XYZ — breakdown below 820 on heavy selling.',
  noTradeConditions: ['NIFTY gaps more than 1% against the trade.'],
  checklist900to915: ['Check GIFT Nifty and the opening gap against 505.'],
  selfCritique: 'The breakout is one session old; a gap-up could make it a chase.',
};

export function outputContract(briefId: string, mode: 'file' | 'json-only'): string {
  const delivery = mode === 'file'
    ? `First, write your full analysis in this chat exactly as the prompt above asks — every part, in plain language. That is the analysis I read.

Then, at the very end, save a summary of it as a downloadable file named \`nightwatch-reply-${briefId}.json\`, containing only the JSON below — no commentary inside the file. If you cannot produce a file, print the JSON as the last thing in your reply, using straight double quotes (") only.`
    : 'Return only the JSON object below — no other text.';

  return `## SUMMARY FILE FOR THE APP

${delivery}

The file is a machine-readable copy of your Part 12 watchlist, Part 13 trade plans and Part 19 final output. It does not change how you analyse anything.

- briefId: "${briefId}"
- watchlist: your Part 12 list (approximately 5-10), each with rank, symbol, bias ("LONG" or "SHORT"), setup, score, keyLevel, note
- setups: your Part 13 trade plans for the top 3-5, each with entryTrigger, stopLoss, targets (one or two), riskReward as you calculated it, why, catalyst, invalidation, bullishScenario, bearishScenario, and gapPlan (Part 15)
- conditions (optional, per setup): the confirmations from Part 17 you would wait for. Where a confirmation can be checked from market data, add a check so the app can watch it live during the session. Available checks: price_close_above / price_close_below {value, timeframe: "5m"}, above_vwap, below_vwap, volume_expansion {multiple}, index_above / index_below {index, value}, sector_positive / sector_negative {sector}, manual {note}.
- top3, stocksToAvoid, marketBias, marketStrength, bestLong, bestShort, noTradeConditions, checklist900to915, selfCritique: from Part 19
- If there is no high-quality setup, set noHighQualitySetup to true and say so, as the prompt instructs. The watchlist can still list names worth watching.

Use exact NSE symbols as they appear in the market data table. Prices are plain numbers, not strings.

Example of the shape (illustrative symbols and prices):
${JSON.stringify({ ...CONTRACT_EXAMPLE, briefId }, null, 2)}`;
}
