import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, raw, seen, startStack } from './helpers.ts';

let s: Awaited<ReturnType<typeof startStack>>;
before(async () => void (s = await startStack()));
after(() => s.close());

const get = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) => raw(s.port, path, headers, method, body);

test('every public prefix reaches its upstream with the path and query unchanged', async () => {
  const table: [string, string, string][] = [
    ['GET', '/auth/login', 'iam'],
    ['GET', '/users/u-1', 'iam'],
    ['GET', '/products?category=audio&page=2', 'catalog'],
    ['GET', '/products/p-1', 'catalog'],
    ['GET', '/search?q=chef%20knife&sort=price_asc', 'catalog'],
    ['GET', '/categories', 'catalog'],
    ['GET', '/cart', 'cart'],
    ['GET', '/cart/items/p-1', 'cart'],
    ['GET', '/orders', 'orders'],
    ['GET', '/payments/abc', 'payments'],
    ['GET', '/invoices', 'invoices'],
  ];
  for (const [method, path, upstream] of table) {
    const r = await get(path, bearer(), method);
    assert.equal(r.status, 200, path);
    const got = seen(r);
    assert.equal(got.upstream, upstream, path);
    assert.equal(got.url, path, path);
  }
});

test('unknown paths and look-alike prefixes are 404 at the gateway', async () => {
  for (const path of ['/', '/admin', '/productsx', '/product', '/cartography', '/healthz/../admin', '/internal/anything']) {
    assert.equal((await get(path, bearer())).status, 404, path);
  }
});

test('the webhook route wins over /payments and needs no token', async () => {
  const hook = await get('/payments/webhook', {}, 'POST', '{}');
  assert.equal(hook.status, 200);
  assert.equal(seen(hook).upstream, 'payments');
  assert.equal((await get('/payments/abc')).status, 401);
  assert.equal((await get('/payments/webhook/extra', {}, 'POST', '{}')).status, 200); // same rule, whole subtree
});

test('webhook bodies arrive byte for byte so the signature still verifies', async () => {
  const body = '{ "paymentId":"p-1",\n\t"outcome" : "captured" ,"reason":"café ✓" }  ';
  const r = await get('/payments/webhook', { 'content-type': 'application/json', 'x-provider-signature': 'abc123' }, 'POST', body);
  const got = seen(r);
  assert.equal(got.body, body);
  assert.equal(got.headers['x-provider-signature'], 'abc123');
});

test('POST bodies and the caller token are forwarded', async () => {
  const headers = { ...bearer(), 'content-type': 'application/json' };
  const r = await get('/orders', headers, 'POST', '{"a":1}');
  const got = seen(r);
  assert.equal(got.method, 'POST');
  assert.equal(got.body, '{"a":1}');
  assert.equal(got.headers.authorization, headers.authorization); // services verify the JWT themselves
  assert.equal(got.headers['content-type'], 'application/json');
});

test('path tricks cannot reach a protected route through a public one', async () => {
  for (const path of ['/auth/../orders/o-1', '/auth/%2e%2e/orders/o-1', '/auth/./../orders', '/products/../orders']) {
    const r = await get(path);
    assert.equal(r.status, 401, path); // matched as /orders and rejected for the missing token
  }
  for (const path of ['/auth%2f..%2forders', '/products%5c..%5corders', '/auth/%00']) {
    assert.equal((await get(path)).status, 400, path);
  }
  const r = await get('/auth/../products/p-1');
  assert.equal(seen(r).url, '/products/p-1'); // what is forwarded is the normalized path
});

test('upstream status codes and headers pass through, hop-by-hop headers do not', async () => {
  assert.equal((await get('/products/status/404')).status, 404);
  assert.deepEqual(JSON.parse((await get('/products/status/404')).body), { error: 'from_upstream' });
  assert.equal((await get('/products/status/204')).status, 204);
  assert.equal((await get('/products/status/500')).status, 500);
  const c = await get('/products/cookie');
  assert.deepEqual(c.headers['set-cookie'], ['a=1; HttpOnly', 'b=2']);
  assert.equal(c.headers['x-upstream'], 'catalog');
  assert.equal(c.headers['x-powered-by'], undefined);
});
