import http from 'node:http';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, raw, seen, startStack } from './helpers.ts';

let s: Awaited<ReturnType<typeof startStack>>;
before(async () => void (s = await startStack({ UPSTREAM_TIMEOUT_MS: '150', MAX_BODY_BYTES: '1000' })));
after(() => s.close());

test('a slow upstream is a 504 and a dead one is a 502', async () => {
  const slow = await raw(s.port, '/products/slow', {});
  assert.equal(slow.status, 504);
  assert.deepEqual(JSON.parse(slow.body), { error: 'upstream_timeout' });
  await s.ups.cart.close();
  const dead = await raw(s.port, '/cart', {});
  assert.equal(dead.status, 502);
  assert.deepEqual(JSON.parse(dead.body), { error: 'bad_gateway' });
  assert.equal((await raw(s.port, '/products', {})).status, 200); // other routes are unaffected
});

test('oversized bodies are refused: by content-length, and while streaming', async () => {
  const big = 'x'.repeat(1500);
  const declared = await raw(s.port, '/orders', { ...bearer(), 'content-type': 'text/plain' }, 'POST', big);
  assert.equal(declared.status, 413);
  assert.deepEqual(JSON.parse(declared.body), { error: 'payload_too_large' });

  // chunked: no content-length to check up front
  const streamed = await new Promise<number>((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: s.port, path: '/orders', method: 'POST', headers: { ...bearer(), 'transfer-encoding': 'chunked' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on('error', () => resolve(-1));
    r.write('y'.repeat(600));
    setTimeout(() => (r.write('y'.repeat(600)), r.end()), 20);
  });
  assert.equal(streamed, 413);
  assert.equal(seen(await raw(s.port, '/orders', { ...bearer(), 'content-type': 'text/plain' }, 'POST', 'x'.repeat(900))).body.length, 900); // under the limit still works
});

test('CORS: only listed origins get headers; preflight is answered without calling the upstream', async () => {
  let calls = 0;
  s.ups.orders.server.on('request', () => calls++);
  const pre = await raw(s.port, '/orders', { origin: 'http://localhost:5000', 'access-control-request-method': 'POST' }, 'OPTIONS');
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'http://localhost:5000');
  assert.match(String(pre.headers['access-control-allow-headers']), /authorization/);
  assert.match(String(pre.headers['access-control-allow-headers']), /x-cart-id/);
  assert.equal(calls, 0);
  const ok = await raw(s.port, '/products', { origin: 'http://localhost:5000' });
  assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:5000');
  assert.match(String(ok.headers['access-control-expose-headers']), /x-request-id/);
  const evil = await raw(s.port, '/products', { origin: 'https://evil.example' });
  assert.equal(evil.status, 200);
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const evilPre = await raw(s.port, '/orders', { origin: 'https://evil.example' }, 'OPTIONS');
  assert.equal(evilPre.headers['access-control-allow-origin'], undefined);
});

test('healthz is local; readyz reports every upstream and goes 503 when one is down', async () => {
  assert.deepEqual(JSON.parse((await raw(s.port, '/healthz', {})).body), { ok: true });
  const r = await raw(s.port, '/readyz', {});
  assert.equal(r.status, 503); // cart was closed in the first test
  const body = JSON.parse(r.body) as { status: string; upstreams: Record<string, string> };
  assert.equal(body.status, 'degraded');
  assert.equal(body.upstreams.cart, 'down');
  assert.equal(body.upstreams.iam, 'up');
  assert.equal(Object.keys(body.upstreams).length, 6);
});
