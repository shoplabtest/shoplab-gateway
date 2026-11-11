import http from 'node:http';
import https from 'node:https';
import type { Request, Response } from 'express';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export interface ForwardOptions {
  /** Upstream base URL, e.g. http://localhost:3002 */
  base: string;
  /** Normalized path plus query, sent as-is. */
  target: string;
  /** Headers to set on the upstream request; they replace any inbound header of the same name. */
  set: Record<string, string>;
  /** Inbound headers that must not reach the upstream. */
  drop: Set<string>;
  timeoutMs: number;
  maxBodyBytes: number;
}


/**
 * Streams the request to the upstream and the response back. The body is never parsed, so signed payloads
 * (the payment webhook) reach the service byte for byte.
 */
export function forward(req: Request, res: Response, o: ForwardOptions): Promise<void> {
  return new Promise((resolve) => {
    const url = new URL(o.base);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || o.drop.has(k) || k === 'host') continue;
      headers[k] = v;
    }
    Object.assign(headers, o.set, { host: url.host });

    // The gateway answers itself (413, 502, 504) at most once. If the upstream already started its
    // response, the only honest thing left is to cut the connection.
    let answered = false;
    const fail = (status: number, error: string) => {
      if (answered) return;
      answered = true;
      if (!res.headersSent) res.status(status).json({ error });
      else res.destroy();
    };

    if (Number(req.headers['content-length'] ?? 0) > o.maxBodyBytes) {
      fail(413, 'payload_too_large');
      return resolve();
    }

    const lib = url.protocol === 'https:' ? https : http;
    const up = lib.request({ protocol: url.protocol, hostname: url.hostname, port: url.port, method: req.method, path: o.target, headers }, (upRes) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
      res.writeHead(upRes.statusCode ?? 502, out);
      upRes.pipe(res);
      upRes.on('end', resolve);
      upRes.on('error', () => (res.destroy(), resolve()));
    });

    up.setTimeout(o.timeoutMs, () => {
      up.destroy(new Error('timeout'));
    });
    up.on('error', (e) => {
      if (e.message === 'timeout') fail(504, 'upstream_timeout');
      else fail(502, 'bad_gateway');
      resolve();
    });
    res.on('close', () => {
      if (!res.writableEnded) up.destroy();
      resolve();
    });

    let seen = 0;
    req.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > o.maxBodyBytes) {
        fail(413, 'payload_too_large');
        up.destroy();
      }
    });
    req.pipe(up);
  });
}
