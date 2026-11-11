import jwt from 'jsonwebtoken';

export interface Principal {
  sub: string;
  role: string;
  tenant: string;
}

export type TokenResult = { ok: true; principal: Principal | null } | { ok: false };

/** Reads the iam access token (claims `sub`, `role`, `tenant`; HS256 with the shared `JWT_SECRET`). */
export function readToken(authorization: string | undefined, secret: string): TokenResult {
  if (authorization === undefined || authorization === '') return { ok: true, principal: null };
  const [scheme, token, ...rest] = authorization.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length) return { ok: false };
  try {
    const c = jwt.verify(token, secret, { algorithms: ['HS256'] }) as Record<string, unknown>;
    if (typeof c.sub !== 'string') return { ok: false };
    return { ok: true, principal: { sub: c.sub, role: typeof c.role === 'string' ? c.role : 'customer', tenant: typeof c.tenant === 'string' ? c.tenant : 'default' } };
  } catch {
    return { ok: false };
  }
}

export const isStaff = (p: Principal) => p.role === 'staff' || p.role === 'admin';
