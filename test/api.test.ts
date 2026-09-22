import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('API surface', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves health without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('OK');
  });

  it('reports a disconnected Dhan session rather than inventing one', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/dhan/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.connected).toBe(false);
    // There is no SANDBOX_MOCK source any more.
    expect(JSON.stringify(body)).not.toMatch(/SANDBOX/i);
  });

  it('refuses the analysis endpoint without a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/intraday-analysis',
      payload: { capital: 500000, riskPercent: 0.5, maxTrades: 3 },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('NOT_AUTHENTICATED');
  });

  it('refuses the analysis endpoint with a bogus bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/intraday-analysis',
      headers: { authorization: 'Bearer not-a-real-session' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 503 from login when Dhan OAuth is not configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/dhan/login' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('NOT_CONFIGURED');
  });

  it('rejects a callback with no tokenId, without contacting Dhan', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/dhan/callback' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/did not return a tokenId/);
  });

  it('rejects a callback when no login is pending on this server', async () => {
    // Dhan's redirect carries only ?tokenId=, so a callback is honoured only
    // when this server started a login that is still unconsumed. A forged one
    // must not reach Dhan's token exchange.
    const res = await app.inject({ method: 'GET', url: '/auth/dhan/callback?tokenId=forged' });
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatch(/No login is pending/);
  });

  it('rejects an invalid analysis request body before touching Dhan', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/intraday-analysis',
      headers: { authorization: 'Bearer nope' },
      payload: { capital: -1 },
    });
    // Auth is checked first, so this is still 401 — the point is it never 500s.
    expect([400, 401]).toContain(res.statusCode);
  });
});
