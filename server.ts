import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { createApiRouter } from './server/routes.ts';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const RAW_FASTAPI_URL = (process.env.FASTAPI_URL || '').trim().replace(/\/+$/, '');
const FASTAPI_URL = /^https?:\/\/[a-z0-9._-]+(?::\d+)?(?:\/.*)?$/i.test(RAW_FASTAPI_URL)
  ? RAW_FASTAPI_URL
  : undefined;

function createFastApiProxyMiddleware(targetBaseUrl: string) {
  return async (req: express.Request, res: express.Response) => {
    try {
      const targetUrl = `${targetBaseUrl}${req.originalUrl}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() === 'host' || k.toLowerCase() === 'content-length') continue;
        if (Array.isArray(v)) headers.set(k, v.join(', '));
        else if (typeof v === 'string') headers.set(k, v);
      }
      const reqId = (req as any).requestId;
      if (reqId && !headers.has('x-request-id')) {
        headers.set('x-request-id', reqId);
      }

      const hasBody = !['GET', 'HEAD'].includes(req.method.toUpperCase());
      const chunks: Buffer[] = [];
      if (hasBody) {
        await new Promise<void>((resolve, reject) => {
          req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          req.on('end', () => resolve());
          req.on('error', reject);
        });
      }

      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });

      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'transfer-encoding') return;
        res.setHeader(key, value);
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch (err) {
      console.error('FastAPI upstream proxy error:', err);
      res.status(502).json({ error: 'Unable to reach canonical FastAPI backend service.' });
    }
  };
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const reqId = (req.headers['x-request-id'] as string) || `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    (req as any).requestId = reqId;
    res.setHeader('X-Request-ID', reqId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const started = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api')) {
        console.log(
          JSON.stringify({
            event: 'http_request',
            requestId: reqId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            latencyMs: Date.now() - started,
          })
        );
      }
    });
    next();
  });

  if (FASTAPI_URL) {
    // Transparently proxy /api/* and /api/v1/* to the canonical Python FastAPI backend
    const proxy = createFastApiProxyMiddleware(FASTAPI_URL);
    app.use('/api/v1', proxy);
    app.use('/api', proxy);
  } else {
    // Cloud SQL PostgreSQL + Drizzle ORM preview runtime adapter when running in Node-only environments
    app.use(express.json({ limit: '15mb' }));
    app.use(express.urlencoded({ extended: true, limit: '15mb' }));
    const apiRouter = createApiRouter();
    app.use('/api/v1', apiRouter);
    app.use('/api', apiRouter);
  }

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const reqId = (req as any).requestId || 'unknown';
    console.error(JSON.stringify({ event: 'unhandled_exception', requestId: reqId, message: err?.message || 'Error' }));
    if (!res.headersSent) {
      res.status(500).json({ error: 'An unexpected internal error occurred.', requestId: reqId });
    }
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `ResearchForge AI server running on http://localhost:${PORT} (${
        FASTAPI_URL ? `proxying /api to ${FASTAPI_URL}` : 'Cloud SQL PostgreSQL preview runtime adapter'
      })`
    );
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
