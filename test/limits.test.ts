import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, raw, startStack } from './helpers.ts';
import { RateLimiter } from '../src/ratelimit.ts';

test('token bucket: spends, refuses, refills evenly and reports retry-after', () => {
  let t = 0;
  const l = new RateLimiter(() => t);
  assert.deepEqual(l.take('k', 3), { allowed: true, limit: 3, remaining: 2, retryAfter: 0 });
  l.take('k', 3);
  assert.equal(l.take('k', 3).remaining, 0);
  const denied = l.take('k', 3);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfter, 20); // 3 per minute is one every 20 s
  t = 19_000;
  assert.equal(l.take('k', 3).allowed, false);
  t = 20_000;
  assert.equal(l.take('k', 3).allowed, true);
  t = 10 * 60_000;
  assert.equal(l.take('k', 3).remaining, 2); // never banks more than the limit
  assert.equal(l.take('other', 3).allowed, true); // keys are independent
});

test('gateway answers 429 with retry-after, per user, and recovers with time', async () => {
  let t = 1_000_000;
  const s = await startStack({ RATE_LIMIT_DEFAULT: '3' }, () => t);
  try {
    const as = (sub: string) => bearer({ sub });
    const hit = (h: Record<string, string>) => raw(s.port, '/orders', h);
    assert.equal((await hit(as('a'))).headers['x-ratelimit-limit'], '3');
    assert.equal((await hit(as('a'))).headers['x-ratelimit-remaining'], '1');
    assert.equal((await hit(as('a'))).status, 200);
    const limited = await hit(as('a'));
    assert.equal(limited.status, 429);
    assert.deepEqual(JSON.parse(limited.body), { error: 'rate_limited' });
    assert.equal(limited.headers['retry-after'], '20');
    assert.equal((await hit(as('b'))).status, 200); // another user is unaffected
    t += 20_000;
    assert.equal((await hit(as('a'))).status, 200);
  } finally {
    await s.close();
  }
});

test('anonymous traffic is limited per IP, and login is limited much harder', async () => {
  const s = await startStack({ RATE_LIMIT_DEFAULT: '5', RATE_LIMIT_AUTH: '2', RATE_LIMIT_WEBHOOK: '4' });
  try {
    const codes = async (path: string, n: number, method = 'GET') => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await raw(s.port, path, {}, method, method === 'POST' ? '{}' : undefined)).status);
      return out;
    };
    assert.deepEqual(await codes('/auth/login', 4, 'POST'), [200, 200, 429, 429]);
    assert.deepEqual(await codes('/products', 6), [200, 200, 200, 200, 200, 429]);
    assert.deepEqual(await codes('/payments/webhook', 5, 'POST'), [200, 200, 200, 200, 429]);
    assert.equal((await raw(s.port, '/auth/register', {}, 'POST', '{}')).status, 429); // same /auth bucket
    // a signed-in user spends their own bucket, not the anonymous one
    assert.equal((await raw(s.port, '/products', bearer())).status, 200);
  } finally {
    await s.close();
  }
});

test('a failed token check is not forwarded and costs no upstream call', async () => {
  const s = await startStack();
  try {
    let calls = 0;
    s.ups.orders.server.on('request', () => calls++);
    for (let i = 0; i < 3; i++) assert.equal((await raw(s.port, '/orders', { authorization: 'Bearer x' })).status, 401);
    assert.equal(calls, 0);
  } finally {
    await s.close();
  }
});
