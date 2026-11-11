export type UpstreamName = 'iam' | 'catalog' | 'cart' | 'orders' | 'payments' | 'invoices';

export interface Config {
  port: number;
  jwtSecret: string;
  upstreams: Record<UpstreamName, string>;
  /** Sent to invoices as `x-internal-key`; the browser never sees it. */
  invoicesInternalKey: string | undefined;
  corsOrigins: string[];
  trustProxy: boolean;
  upstreamTimeoutMs: number;
  maxBodyBytes: number;
  /** Requests per minute per client (user id when signed in, else IP address). */
  rateLimits: { auth: number; default: number; webhook: number };
}

const url = (v: string | undefined, fallback: string) => (v ?? fallback).replace(/\/+$/, '');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    jwtSecret: env.JWT_SECRET ?? 'dev-only-secret',
    upstreams: {
      iam: url(env.IAM_URL, 'http://localhost:3001'),
      catalog: url(env.CATALOG_API_URL, 'http://localhost:3002'),
      cart: url(env.CART_API_URL, 'http://localhost:3003'),
      orders: url(env.ORDERS_URL, 'http://localhost:3004'),
      payments: url(env.PAYMENTS_URL, 'http://localhost:3005'),
      invoices: url(env.INVOICES_URL, 'http://localhost:3006'),
    },
    invoicesInternalKey: env.INVOICES_INTERNAL_KEY,
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5000').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === 'true',
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS ?? 10_000),
    maxBodyBytes: Number(env.MAX_BODY_BYTES ?? 1_000_000),
    rateLimits: {
      auth: Number(env.RATE_LIMIT_AUTH ?? 10),
      default: Number(env.RATE_LIMIT_DEFAULT ?? 120),
      webhook: Number(env.RATE_LIMIT_WEBHOOK ?? 600),
    },
  };
}
