import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.ts';
import { loadConfig, type Config, type UpstreamName } from '../src/config.ts';
import { RateLimiter } from '../src/ratelimit.ts';

export const SECRET = 'test-secret-test-secret-test-secret';
export const NAMES: UpstreamName[] = ['iam', 'catalog', 'cart', 'orders', 'payments', 'invoices'];

export interface Seen {
  upstream: string;
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** An upstream that echoes what it received. Special paths (anywhere in the URL): /slow (waits 400 ms), /status/<n>, /cookie; exact /healthz. */
export function startUpstream(name: string): Promise<{ url: string; server: http.Server; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      if (url === '/healthz') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      if (url.includes('/slow')) return void setTimeout(() => res.writeHead(200).end('late'), 400);
      const status = /\/status\/(\d+)/.exec(url);
      if (status) return void res.writeHead(Number(status[1])).end(Number(status[1]) === 204 ? undefined : '{"error":"from_upstream"}');
      if (url.includes('/cookie')) return void res.writeHead(200, { 'set-cookie': ['a=1; HttpOnly', 'b=2'], 'x-upstream': name }).end('{}');
      const seen: Seen = { upstream: name, method: req.method ?? '', url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(seen));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        server,
        close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
      }),
    ),
  );
}

export async function startStack(over: Record<string, string> = {}, clock?: () => number) {
  const ups = Object.fromEntries(await Promise.all(NAMES.map(async (n) => [n, await startUpstream(n)] as const)));
  const env: Record<string, string> = {
    JWT_SECRET: SECRET,
    IAM_URL: ups.iam.url,
    CATALOG_API_URL: ups.catalog.url,
    CART_API_URL: ups.cart.url,
    ORDERS_URL: ups.orders.url,
    PAYMENTS_URL: ups.payments.url,
    INVOICES_URL: ups.invoices.url,
    INVOICES_INTERNAL_KEY: 'internal-secret',
    CORS_ORIGINS: 'http://localhost:5000',
    ...over,
  };
  const cfg: Config = loadConfig(env as NodeJS.ProcessEnv);
  const logs: Record<string, unknown>[] = [];
  const server = createApp({ cfg, limiter: new RateLimiter(clock), log: (l) => logs.push(l) }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  return {
    cfg,
    ups,
    logs,
    port,
    base: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      server.close();
      await Promise.all(Object.values(ups).map((u) => u.close()));
    },
  };
}

export const token = (claims: Record<string, unknown> = {}, opts: jwt.SignOptions = {}, secret = SECRET) =>
  jwt.sign({ sub: 'u-1', role: 'customer', tenant: 'acme', ...claims }, secret, { expiresIn: 600, ...opts });

export const bearer = (claims?: Record<string, unknown>) => ({ authorization: `Bearer ${token(claims)}` });

/** Sends the request path exactly as given; fetch would normalize `..` and `%2e%2e` before sending. */
export function raw(port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string | Buffer): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

export const seen = (r: { body: string }) => JSON.parse(r.body) as Seen;
