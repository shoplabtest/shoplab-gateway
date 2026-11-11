import type { UpstreamName } from './config.ts';

/** none: no token needed. optional: a token is not required but must be valid if sent. required: valid token. */
export type Auth = 'none' | 'optional' | 'required';
export type LimitClass = 'auth' | 'default' | 'webhook';

export interface Route {
  /** Matches the path itself and everything below it, on whole path segments. */
  prefix: string;
  upstream: UpstreamName;
  /** Policy for GET and HEAD. */
  read: Auth;
  /** Policy for every other method. */
  write: Auth;
  /** Every request needs the `staff` or `admin` role. */
  staffOnly?: boolean;
  limit: LimitClass;
  /** Adds the shared `x-internal-key` header for services that sit behind the gateway only. */
  internalKey?: boolean;
}

/**
 * The public API surface. Paths are forwarded unchanged, so each upstream sees the URL the browser called.
 * Anything not listed here is a 404 at the gateway.
 */
export const ROUTES: Route[] = [
  { prefix: '/auth', upstream: 'iam', read: 'none', write: 'none', limit: 'auth' },
  { prefix: '/users', upstream: 'iam', read: 'required', write: 'required', limit: 'default' },
  { prefix: '/products', upstream: 'catalog', read: 'none', write: 'required', limit: 'default' },
  { prefix: '/search', upstream: 'catalog', read: 'none', write: 'required', limit: 'default' },
  { prefix: '/categories', upstream: 'catalog', read: 'none', write: 'required', limit: 'default' },
  // Guest carts are identified by the x-cart-id header, so no token is needed; a signed-in user sends one.
  { prefix: '/cart', upstream: 'cart', read: 'optional', write: 'optional', limit: 'default' },
  { prefix: '/orders', upstream: 'orders', read: 'required', write: 'required', limit: 'default' },
  // The provider calls this without a token; the payments service checks the body signature itself.
  { prefix: '/payments/webhook', upstream: 'payments', read: 'none', write: 'none', limit: 'webhook' },
  { prefix: '/payments', upstream: 'payments', read: 'required', write: 'required', limit: 'default' },
  // Internal API: it lists every customer's invoices, so the gateway only lets staff reach it.
  { prefix: '/invoices', upstream: 'invoices', read: 'required', write: 'required', staffOnly: true, limit: 'default', internalKey: true },
];

const bySpecificity = [...ROUTES].sort((a, b) => b.prefix.length - a.prefix.length);

export function matchRoute(pathname: string): Route | undefined {
  return bySpecificity.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`));
}

export const isRead = (method: string) => method === 'GET' || method === 'HEAD';

export const authFor = (route: Route, method: string): Auth => (isRead(method) ? route.read : route.write);
