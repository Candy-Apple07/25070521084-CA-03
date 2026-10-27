// Connects to MongoDB, then starts listening.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { createApp } from './app.ts';
import { config } from './config.ts';

try {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
} catch (e) {
  console.error(`Could not connect to MongoDB at ${config.mongoUri.replace(/\/\/[^@]*@/, '//***@')}.`);
  console.error((e as Error).message);
  process.exit(1);
}

const server = createApp().listen(config.port, () => {
  console.log(`Obsidian API listening on http://localhost:${config.port}`);
  if (existsSync(join(config.clientDist, 'index.html'))) console.log(`Serving the game from ${config.clientDist}`);
  else console.log('No client build found, so only the API is served. Run `npm run build` to serve the game too.');
});

const shutdown = async () => {
  server.close();
  await mongoose.disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
