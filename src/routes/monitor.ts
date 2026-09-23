import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireSession } from '../plugins/require-session.js';
import { DhanMarketDataService } from '../services/dhan/dhan-market-data.service.js';
import { DhanAuthService } from '../services/auth/dhan-auth.service.js';
import { BriefStore } from '../services/ai/brief-store.js';
import { PlanHistory } from '../services/ai/plan-history.js';
import { evaluateSetup, marketSnapshot } from '../services/monitor/condition-evaluator.js';
import { AppError, NotAuthenticatedError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const MonitorQuerySchema = z.object({ briefId: z.string().optional() });

/**
 * Evaluates the accepted plan's entry conditions against live intraday data.
 *
 * Every condition is checked against what the market is actually doing now —
 * 5-minute closes, session VWAP, per-bar volume, live index levels, live
 * sector moves. A condition whose data is missing reports UNKNOWN and never
 * counts toward a valid entry.
 */
export const monitorRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/monitor', { preHandler: requireSession }, async (request, reply) => {
    const { briefId } = MonitorQuerySchema.parse(request.query);

    // The saved plan outlives its brief, so the monitor works all session.
    const rec = briefId ? PlanHistory.get(briefId) : PlanHistory.latest();
    const brief = rec ? null : briefId ? BriefStore.get(briefId) : BriefStore.latestWithPlan();
    const plan = rec?.plan ?? brief?.plan;
    if (!plan) {
      throw new AppError(
        404,
        'NO_PLAN',
        briefId
          ? 'That brief has no accepted plan yet. Submit the analyst\'s reply first.'
          : 'No accepted plan to monitor. Generate a brief and submit an analyst reply first.'
      );
    }

    const auth = DhanAuthService.getInstance();
    const sessionId = request.sessionId as string;
    const accessToken = auth.getAccessToken(sessionId);
    const clientId = auth.getClientId(sessionId);
    if (!accessToken || !clientId) throw new NotAuthenticatedError();

    const market = new DhanMarketDataService(accessToken, clientId);

    // Previous closes captured when the brief was built, so the monitor can
    // compute today's sector moves without re-fetching daily history.
    const previousCloses = new Map<string, number>(
      Object.entries(rec?.context?.previousCloses ?? brief?.input.previousCloses ?? {})
    );

    const snapshot = await marketSnapshot(market, previousCloses);

    const setups = [];
    // Only setups with exchange data and usable levels can be watched; the
    // rest are still in the plan, just not monitorable.
    for (const setup of plan.setups.filter((s) => s.monitorable)) {
      setups.push(await evaluateSetup(market, setup, snapshot));
    }

    logger.info(
      { briefId: plan.briefId, setups: setups.length, valid: setups.filter((s) => s.entryValid).length },
      'Monitor evaluated'
    );

    return reply.send({
      success: true,
      data: {
        briefId: plan.briefId,
        planAcceptedAt: plan.acceptedAt,
        evaluatedAt: new Date().toISOString(),
        indexLevels: Object.fromEntries(snapshot.indexLevels),
        sectorChanges: Object.fromEntries(snapshot.sectorChanges),
        setups,
      },
    });
  });
};
