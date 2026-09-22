/**
 * Proves the Dhan feed is real.
 *
 *   npm run verify:feed -- --session <id> --symbol SUNPHARMA --close 1868.90
 *
 * Fetches the most recent daily candle and asserts its close matches a figure
 * you have checked against NSE yourself. This is the single test that would
 * have caught the whole class of bug in the handed-over code: a generator
 * producing plausible prices passes every shape check ever written, and fails
 * this one immediately.
 */
import { DhanMarketDataService } from '../src/services/dhan/dhan-market-data.service.js';
import { DhanAuthService } from '../src/services/auth/dhan-auth.service.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const sessionId = arg('session');
  const symbol = (arg('symbol') ?? 'SUNPHARMA').toUpperCase();
  const expected = arg('close') ? Number(arg('close')) : undefined;

  if (!sessionId) {
    console.error('Missing --session. Log in first, then pass the session id the popup returned.');
    process.exit(2);
  }

  const auth = DhanAuthService.getInstance();
  const token = auth.getAccessToken(sessionId);
  const clientId = auth.getClientId(sessionId);
  if (!token || !clientId) {
    console.error('That session is unknown or expired. Log in again.');
    process.exit(2);
  }

  const market = new DhanMarketDataService(token, clientId);

  const candles = await market.getDailyCandles(symbol, 60);
  const last = candles[candles.length - 1];
  console.log(`${symbol} latest daily candle from Dhan:`);
  console.log(`  date   ${last.timestamp}`);
  console.log(`  ohlc   ${last.open} / ${last.high} / ${last.low} / ${last.close}`);
  console.log(`  volume ${last.volume.toLocaleString('en-IN')}`);

  const vwap = await market.getVwap(symbol);
  console.log(`  vwap   ${vwap ?? 'no intraday volume yet'}`);

  if (expected === undefined) {
    console.log('\nNo --close given, so nothing was asserted. Re-run with the NSE close to verify.');
    return;
  }

  // Exact to the paisa. A feed that is "close enough" is not a feed.
  if (Math.abs(last.close - expected) > 0.005) {
    console.error(`\nFAIL: Dhan reports ${last.close}, NSE close given as ${expected}.`);
    process.exit(1);
  }
  console.log(`\nPASS: close matches NSE exactly (${expected}).`);
}

main().catch((err) => {
  console.error(`\nFAIL: ${err?.message ?? err}`);
  process.exit(1);
});
