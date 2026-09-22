import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

describe('Fastify API Routes Integration Test', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health should return 200 OK', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('OK');
  });

  it('GET /auth/dhan/status should return current token connection status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/dhan/status',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.data.connected).toBeDefined();
  });

  it('GET /auth/dhan/login should generate Dhan consent login URL', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/dhan/login',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.loginUrl).toContain('/auth/consent');
  });

  it('POST /api/v1/intraday-analysis should run deterministic stock selection and return structured plan', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/intraday-analysis',
      payload: {
        capital: 500000,
        riskPercent: 0.5,
        maxTrades: 3,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.data.market.bias).toBeDefined();
    expect(body.data.setups.length).toBeGreaterThan(0);
    expect(body.data.riskManagement.capital).toBe(500000);
    expect(body.data.riskManagement.maxRiskPerTradeAmount).toBe(2500);

    const firstSetup = body.data.setups[0];
    expect(firstSetup.symbol).toBeDefined();
    expect(firstSetup.score).toBeGreaterThan(0);
    expect(firstSetup.entryTrigger).toBeGreaterThan(0);
    expect(firstSetup.stopLoss).toBeGreaterThan(0);
    expect(firstSetup.targets.length).toBe(2);
  });
});
