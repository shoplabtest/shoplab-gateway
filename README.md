# shoplab-gateway

The one public API surface. Node, Express, TypeScript, no database. It replaces the dev proxy in `shoplab-host`: the browser calls one origin and the gateway routes by path prefix.

| Prefix | Upstream (env) | GET / HEAD | Other methods |
| --- | --- | --- | --- |
| `/auth` | iam (`IAM_URL`) | public | public, strict rate limit |
| `/users` | iam | token | token |
| `/products`, `/search`, `/categories` | catalog-api (`CATALOG_API_URL`) | public | token |
| `/cart` | cart-api (`CART_API_URL`) | optional token | optional token |
| `/orders` | orders (`ORDERS_URL`) | token | token |
| `/payments/webhook` | payments (`PAYMENTS_URL`) | public | public (the provider signs the body) |
| `/payments` | payments | token | token |
| `/invoices` | invoices (`INVOICES_URL`) | token | staff or admin token |

The table lives in [src/routes.ts](src/routes.ts); the longest matching prefix wins and anything not listed is `404`. Paths and query strings are forwarded unchanged.

**What it does on every request**
- **Token check.** Verifies the iam JWT (HS256, shared `JWT_SECRET`, claims `sub`, `role`, `tenant`). A token that is sent must be valid even on a public route, so clients learn to refresh. The `Authorization` header is passed on: every service still verifies the token itself.
- **Headers it owns.** Sets `x-request-id` (a well-formed inbound id is kept, anything else replaced; echoed in the response) and `x-tenant` (from the token, `default` when anonymous). Whatever a client sends under `x-request-id`, `x-tenant`, `x-internal-key` or `x-forwarded-*` is discarded. For `/invoices` it adds `x-internal-key` from `INVOICES_INTERNAL_KEY`, so the browser never holds it.
- **Rate limit.** Token bucket per minute: `RATE_LIMIT_DEFAULT` (120) per user, or per IP when anonymous; `RATE_LIMIT_AUTH` (10) per IP for `/auth`; `RATE_LIMIT_WEBHOOK` (600) per IP. Answers `429` with `retry-after` and `x-ratelimit-*` headers. State is in memory, so it is per gateway instance.
- **Path safety.** The path is normalized before matching (`/auth/../orders` is treated as `/orders`), and encoded slashes or NUL bytes are `400`.
- **Streaming proxy.** Bodies are never parsed, so signed webhooks arrive byte for byte. `413` over `MAX_BODY_BYTES` (1 MB), `504` after `UPSTREAM_TIMEOUT_MS` (10 s), `502` when an upstream is down.
- **CORS.** Origins listed in `CORS_ORIGINS` (default `http://localhost:5000`); preflight is answered locally. Allowed request headers include `x-cart-id`.

`GET /healthz` is local. `GET /readyz` calls every upstream's `/healthz` and answers `503` with the per-service state if any is down.

Other env: `PORT` (8080), `TRUST_PROXY=true` when behind a load balancer (only then is a client `x-forwarded-for` believed).

```
npm test          # 27 tests against stub upstreams over real sockets
npm run dev
```
