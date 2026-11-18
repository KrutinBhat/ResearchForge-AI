import express from 'express';
import path from 'node:path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { createApiRouter } from './server/routes.ts';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const FASTAPI_URL = process.env.FASTAPI_URL?.replace(/\/+$/, '');

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

  if (FASTAPI_URL) {
    // Transparently proxy /api/* to the canonical Python FastAPI backend (preserving multipart/binary bodies)
    app.use('/api', createFastApiProxyMiddleware(FASTAPI_URL));
  } else {
    // Cloud SQL PostgreSQL + Drizzle ORM V1.1 runtime adapter when running in Node-only environments
    app.use(express.json({ limit: '15mb' }));
    app.use(express.urlencoded({ extended: true, limit: '15mb' }));
    app.use('/api', createApiRouter());
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `ResearchForge AI server running on http://localhost:${PORT} (${
        FASTAPI_URL ? `proxying /api to ${FASTAPI_URL}` : 'Cloud SQL PostgreSQL runtime adapter'
      })`
    );
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
