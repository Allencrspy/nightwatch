import { describe, it, expect } from 'vitest';
import { CONTRACT_EXAMPLE, outputContract } from '../src/services/ai/output-contract.js';
import { IntradaySetupSchema, MIN_RISK_REWARD } from '../src/schemas/analysis-response.schema.js';

/**
 * The contract in the brief and the validator on the server must never
 * disagree. If the example the analyst is shown would itself be rejected,
 * every reply modelled on it fails — which is how the paste bridge spent a
 * day bouncing replies one rule at a time.
 */
describe('output contract', () => {
  it('its worked example passes the real setup validator', () => {
    for (const s of CONTRACT_EXAMPLE.setups) {
      const risk = Math.abs(s.entryTrigger - s.stopLoss);
      // The fields the server adds before validating.
      const asServerBuildsIt = {
        ...s,
        stages: [{ stage: 'priceMovement', part: 'Part 2', outcome: 'PASS', note: 'example' }],
        close: s.entryTrigger,
        riskRewardRatio: Number((Math.abs(s.targets[0] - s.entryTrigger) / risk).toFixed(2)),
        positionSizing: { recommendedShares: 10, positionValue: 10 * s.entryTrigger, riskAmount: 10 * risk },
      };
      const res = IntradaySetupSchema.safeParse(asServerBuildsIt);
      if (!res.success) throw new Error(res.error.issues.map((i) => i.message).join('; '));
      expect(res.success).toBe(true);
    }
  });

  it('states the same minimum risk-reward the validator enforces', () => {
    expect(outputContract()).toContain(`at least ${MIN_RISK_REWARD}:1`);
  });

  it('keeps noHighQualitySetup consistent with the example tiers', () => {
    const hasHigh = CONTRACT_EXAMPLE.setups.some((s) => s.tier === 'HIGH');
    expect(CONTRACT_EXAMPLE.noHighQualitySetup).toBe(!hasHigh);
  });
});
