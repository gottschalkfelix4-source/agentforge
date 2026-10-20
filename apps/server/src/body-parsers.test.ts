import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tolerateEmptyBodies } from './body-parsers.js';

describe('tolerateEmptyBodies', () => {
  const app = Fastify();
  tolerateEmptyBodies(app);
  app.post('/x', async (req) => ({ body: req.body ?? null }));

  beforeAll(() => app.ready());
  afterAll(() => app.close());

  const post = (headers: Record<string, string>, payload?: string) => app.inject({ method: 'POST', url: '/x', headers, payload });

  it('accepts empty bodies whatever Content-Type a proxy added', async () => {
    for (const type of [undefined, 'application/json', 'application/octet-stream', 'application/x-www-form-urlencoded']) {
      const r = await post(type ? { 'content-type': type } : {});
      expect(r.statusCode, String(type)).toBe(200);
      expect(r.json()).toEqual({ body: null });
    }
  });

  it('keeps parsing JSON and rejecting bad JSON or unknown types with a body', async () => {
    expect((await post({ 'content-type': 'application/json' }, '{"a":1}')).json()).toEqual({ body: { a: 1 } });
    expect((await post({ 'content-type': 'application/json' }, '{bad')).statusCode).toBe(400);
    expect((await post({ 'content-type': 'application/json' }, '{"__proto__":{"x":1}}')).statusCode).toBe(400);
    expect((await post({ 'content-type': 'application/octet-stream' }, 'abc')).statusCode).toBe(415);
  });
});
