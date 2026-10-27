// The Express app, without a database connection or a port, so tests can mount it directly.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { config } from './config.ts';
import { authRouter } from './routes/auth.ts';
import { usersRouter } from './routes/users.ts';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        // Google Fonts for Inter; PeerJS's broker and WebRTC for online tables.
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'", 'https:', 'wss:'],
        'worker-src': ["'self'", 'blob:'],
      },
    },
  }));
  if (config.clientOrigin) app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, db: mongoose.connection.readyState === 1 ? 'up' : 'down' });
  });
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  // The React client, when it has been built: one server, one port, same-origin cookies.
  const index = join(config.clientDist, 'index.html');
  if (existsSync(index)) {
    // Vite fingerprints everything under /assets, so it can be cached for good.
    app.use('/assets', express.static(join(config.clientDist, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
    app.use(express.static(config.clientDist, { index: false }));
    // Any other page (/, /login, /t/ABC123) is the single-page app.
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(index));
  }

  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.parse.failed') return void res.status(400).json({ error: 'The request body is not valid JSON.' });
    if (err.status && err.status < 500) return void res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
  });

  return app;
}
