// Settings read from the environment once at startup. Missing required values stop the server.

import { fileURLToPath } from 'node:url';

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set. Copy server/.env.example to server/.env and fill it in.`);
  return v;
}

const production = process.env.NODE_ENV === 'production';
const jwtSecret = required('JWT_SECRET');
if (production && (jwtSecret === 'change-me' || jwtSecret.length < 32)) {
  throw new Error('JWT_SECRET must be a long random string in production.');
}

export const config = {
  production,
  port: Number(process.env.PORT) || 4000,
  mongoUri: process.env.MONGODB_URI?.trim() || 'mongodb://127.0.0.1:27017/obsidian',
  jwtSecret,
  /** How long a sign-in lasts before the player has to sign in again. */
  sessionDays: 30,
  /** Set when the client lives on another origin; enables CORS with credentials for it. */
  clientOrigin: process.env.CLIENT_ORIGIN?.trim() || '',
  /** The built React client (`npm run build` in client/). Served when it exists. */
  clientDist: process.env.CLIENT_DIST?.trim() || fileURLToPath(new URL('../../client/dist', import.meta.url)),
};
