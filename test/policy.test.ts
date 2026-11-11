import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, raw, seen, startStack, token } from './helpers.ts';

let s: Awaited<ReturnType<typeof startStack>>;
before(async () => void (s = await startStack()));
after(() => s.close());

const call = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) => raw(s.port, path, headers, method, body);

test('protected routes need a valid token', async () => {
  const bad: Record<string, string>[] = [
    {},
    { authorization: 'Bearer nope' },
    { authorization: 'Basic abc' },
    { authorization: 'Bearer' },
    { authorization: `Bearer ${token()} extra` },
    { authorization: `Bearer ${token({}, {}, 'some-other-secret-some-other-secret')}` },
    { authorization: `Bearer ${token({}, { expiresIn: -10 })}` },
    { authorization: `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"u-1"}').toString('base64url')}.` },
  ];
  for (const h of bad) {
    const r = await call('/orders', h);
    assert.equal(r.status, 401, JSON.stringify(h).slice(0, 60));
    assert.equal(r.headers['www-authenticate'], 'Bearer');
  }
  assert.equal((await call('/orders', bearer())).status, 200);
});

test('a token without a subject is rejected', async () => {
  const noSub = token({ sub: undefined });
  assert.equal((await call('/orders', { authorization: `Bearer ${noSub}` })).status, 401);
});

test('catalog reads are public, writes need a token', async () => {
  assert.equal((await call('/products')).status, 200);
  assert.equal((await call('/search?q=x')).status, 200);
  assert.equal((await call('/categories')).status, 200);
  assert.equal((await call('/products', {}, 'POST', '{}')).status, 401);
  assert.equal((await call('/products/p-1', {}, 'DELETE')).status, 401);
  assert.equal((await call('/products', bearer({ role: 'staff' }), 'POST', '{}')).status, 200);
});

test('a bad token on a public read is still rejected, so clients learn to refresh', async () => {
  assert.equal((await call('/products', { authorization: 'Bearer nope' })).status, 401);
});

test('iam: login, register and refresh are public; the user profile is not', async () => {
  for (const p of ['/auth/login', '/auth/register', '/auth/refresh']) assert.equal((await call(p, {}, 'POST', '{}')).status, 200, p);
  assert.equal((await call('/users/u-1')).status, 401);
  assert.equal((await call('/users/u-1', bearer())).status, 200);
});

test('cart accepts guests, but a token that is sent must be valid', async () => {
  assert.equal((await call('/cart', { 'x-cart-id': 'guest-1' })).status, 200);
  assert.equal(seen(await call('/cart', { 'x-cart-id': 'guest-1' })).headers['x-cart-id'], 'guest-1');
  assert.equal((await call('/cart', { authorization: 'Bearer nope' })).status, 401);
  assert.equal((await call('/cart', bearer())).status, 200);
});

test('invoices: any signed-in user reads, only staff or admin write, and the internal key is added', async () => {
  assert.equal((await call('/invoices')).status, 401);
  const read = await call('/invoices', bearer());
  assert.equal(read.status, 200);
  assert.equal(seen(read).headers['x-internal-key'], 'internal-secret');
  assert.equal((await call('/invoices/credit-notes', bearer(), 'POST', '{}')).status, 403);
  assert.equal((await call('/invoices/credit-notes', bearer({ role: 'staff' }), 'POST', '{}')).status, 200);
  assert.equal((await call('/invoices/credit-notes', bearer({ role: 'admin' }), 'POST', '{}')).status, 200);
});

test('the internal key is only sent to invoices and a client-supplied one is never forwarded', async () => {
  for (const path of ['/orders', '/products', '/cart', '/payments/webhook']) {
    const got = seen(await call(path, { ...bearer(), 'x-internal-key': 'guessed' }, path === '/payments/webhook' ? 'POST' : 'GET', path === '/payments/webhook' ? '{}' : undefined));
    assert.equal(got.headers['x-internal-key'], undefined, path);
  }
  assert.equal(seen(await call('/invoices', { ...bearer(), 'x-internal-key': 'guessed' })).headers['x-internal-key'], 'internal-secret');
});

test('x-tenant comes from the token, never from the client', async () => {
  assert.equal(seen(await call('/orders', { ...bearer({ tenant: 'acme' }), 'x-tenant': 'victim' })).headers['x-tenant'], 'acme');
  assert.equal(seen(await call('/products', { 'x-tenant': 'victim' })).headers['x-tenant'], 'default');
  assert.equal(seen(await call('/orders', bearer({ tenant: undefined }))).headers['x-tenant'], 'default');
});

test('x-request-id is generated, kept when well formed, and replaced when not', async () => {
  const gen = await call('/products');
  const id = gen.headers['x-request-id'] as string;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(seen(gen).headers['x-request-id'], id);
  const kept = await call('/products', { 'x-request-id': 'trace-abc_123.x' });
  assert.equal(kept.headers['x-request-id'], 'trace-abc_123.x');
  assert.equal(seen(kept).headers['x-request-id'], 'trace-abc_123.x');
  for (const bad of ['short', 'has spaces in it!!', 'x'.repeat(65)]) {
    const r = await call('/products', { 'x-request-id': bad });
    assert.notEqual(r.headers['x-request-id'], bad);
    assert.equal(seen(r).headers['x-request-id'], r.headers['x-request-id']);
  }
});

test('x-forwarded-for from the client is ignored unless the gateway trusts its proxy', async () => {
  const got = seen(await call('/products', { 'x-forwarded-for': '6.6.6.6' }));
  assert.equal(got.headers['x-forwarded-for'], '127.0.0.1');
  assert.equal(got.headers['x-forwarded-proto'], 'http');
  assert.ok(got.headers['x-forwarded-host']);
});

test('every request is logged with its id, status and route path', async () => {
  const r = await call('/products?secret=1');
  const line = s.logs.find((l) => l.requestId === r.headers['x-request-id'])!;
  assert.equal(line.method, 'GET');
  assert.equal(line.path, '/products');
  assert.equal(line.status, 200);
  assert.equal(typeof line.ms, 'number');
});
