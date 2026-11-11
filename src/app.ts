import { randomUUID } from 'node:crypto';
import http from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { isStaff, readToken, type Principal } from './auth.ts';
import type { Config, UpstreamName } from './config.ts';
import { forward } from './proxy.ts';
import { RateLimiter } from './ratelimit.ts';
import { authFor, matchRoute } from './routes.ts';

export type Logger = (line: Record<string, unknown>) => void;

export interface Deps {
  cfg: Config;
  limiter?: RateLimiter;
  log?: Logger;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const CORS_HEADERS = 'authorization, content-type, x-cart-id, x-request-id';

/**
 * Headers the gateway sets itself. Whatever the client sent under these names is discarded,
 * so a caller can never choose its own tenant, request id or internal key.
 */
const GATEWAY_OWNED = new Set(['x-request-id', 'x-tenant', 'x-internal-key', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
  }
}

/** Resolves dot segments the way a URL parser does, so `/auth/../users/1` is matched as `/users/1`. */
function normalize(rawUrl: string): { pathname: string; search: string } | null {
  if (/%2f|%5c|%00/i.test(rawUrl.split('?')[0])) return null;
  try {
    const u = new URL(rawUrl, 'http://gateway');
    return { pathname: u.pathname, search: u.search };
  } catch {
    return null;
  }
}

export function createApp({ cfg, limiter = new RateLimiter(), log = () => {} }: Deps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);

  app.use((req, res, next) => {
    const inbound = req.headers['x-request-id'];
    req.id = typeof inbound === 'string' && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    res.setHeader('x-request-id', req.id);
    const started = Date.now();
    res.on('finish', () => log({ requestId: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started }));
    next();
  });

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && cfg.corsOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-expose-headers', 'x-request-id, retry-after, x-ratelimit-limit, x-ratelimit-remaining');
      if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE');
        res.setHeader('access-control-allow-headers', CORS_HEADERS);
        res.setHeader('access-control-max-age', '600');
        return void res.status(204).end();
      }
    }
    next();
  });

  app.get('/healthz', (_req, res) => void res.json({ ok: true }));

  app.get('/readyz', async (_req, res) => {
    const names = Object.keys(cfg.upstreams) as UpstreamName[];
    const up = await Promise.all(names.map((n) => probe(`${cfg.upstreams[n]}/healthz`)));
    const upstreams = Object.fromEntries(names.map((n, i) => [n, up[i] ? 'up' : 'down']));
    res.status(up.every(Boolean) ? 200 : 503).json({ status: up.every(Boolean) ? 'ok' : 'degraded', upstreams });
  });

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const url = normalize(req.originalUrl);
      if (!url) return void res.status(400).json({ error: 'bad_request' });
      const route = matchRoute(url.pathname);
      if (!route) return void res.status(404).json({ error: 'not_found' });

      const token = readToken(req.headers.authorization, cfg.jwtSecret);
      const policy = authFor(route, req.method);
      if (!token.ok || (policy === 'required' && !token.principal)) {
        res.setHeader('www-authenticate', 'Bearer');
        return void res.status(401).json({ error: 'unauthorized' });
      }
      const who: Principal | null = token.principal;
      if (route.staffOnly && (!who || !isStaff(who))) return void res.status(403).json({ error: 'forbidden' });

      const perMinute = cfg.rateLimits[route.limit];
      const client = route.limit === 'auth' || !who ? `ip:${req.ip}` : `user:${who.sub}`;
      const d = limiter.take(`${route.limit}:${client}`, perMinute);
      res.setHeader('x-ratelimit-limit', String(d.limit));
      res.setHeader('x-ratelimit-remaining', String(d.remaining));
      if (!d.allowed) {
        res.setHeader('retry-after', String(d.retryAfter));
        return void res.status(429).json({ error: 'rate_limited' });
      }

      const set: Record<string, string> = {
        'x-request-id': req.id,
        'x-tenant': who?.tenant ?? 'default',
        'x-forwarded-for': [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', '),
        'x-forwarded-proto': req.protocol,
      };
      if (req.headers.host) set['x-forwarded-host'] = req.headers.host;
      if (route.internalKey && cfg.invoicesInternalKey) set['x-internal-key'] = cfg.invoicesInternalKey;
      // A client-supplied x-forwarded-for is only believed when the gateway sits behind a trusted proxy.
      if (!cfg.trustProxy) set['x-forwarded-for'] = req.socket.remoteAddress ?? '';

      await forward(req, res, {
        base: cfg.upstreams[route.upstream],
        target: url.pathname + url.search,
        set,
        drop: GATEWAY_OWNED,
        timeoutMs: cfg.upstreamTimeoutMs,
        maxBodyBytes: cfg.maxBodyBytes,
      });
    } catch (e) {
      next(e);
    }
  });

  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

function probe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const r = http.get(url, { timeout: 1000 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 400);
    });
    r.on('timeout', () => (r.destroy(), resolve(false)));
    r.on('error', () => resolve(false));
  });
}
