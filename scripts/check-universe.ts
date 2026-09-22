/**
 * Checks every configured symbol against Dhan's live scrip master.
 *
 * Symbols rot: a demerger turned TATAMOTORS into TMPV and TMCV, a rename
 * turned OBEROIRAL into OBEROIRLTY, and both were only discovered when a scan
 * failed. Run this after any corporate action.
 *
 *   npm run check:universe
 */
import { InstrumentMaster } from '../src/services/dhan/instrument-master.js';
import { FNO_STOCK_UNIVERSE, SECTOR_MAPPINGS } from '../src/config/constants.js';

async function main() {
  const map = await InstrumentMaster.load();
  const configured = new Set<string>([
    ...FNO_STOCK_UNIVERSE,
    ...SECTOR_MAPPINGS.flatMap((s) => s.symbols),
  ]);

  const missing: string[] = [];
  for (const symbol of configured) if (!map.has(symbol)) missing.push(symbol);

  console.log(`scrip master: ${map.size} NSE equity symbols`);
  console.log(`configured:   ${configured.size} (universe + sector constituents)`);
  console.log(`resolved:     ${configured.size - missing.length}`);

  if (!missing.length) {
    console.log('\nAll configured symbols resolve.');
    return;
  }

  console.log(`\n${missing.length} symbol(s) do not resolve:`);
  for (const sym of missing.sort()) {
    const stem = sym.slice(0, 5);
    const near = [...map.keys()].filter((k) => k.startsWith(stem)).slice(0, 5);
    console.log(`  ${sym.padEnd(14)} ${near.length ? `did you mean: ${near.join(', ')}` : 'no near match'}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(`FAIL: ${err?.message ?? err}`);
  process.exit(1);
});
