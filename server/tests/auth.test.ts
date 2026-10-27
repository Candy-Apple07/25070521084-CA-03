// End-to-end tests of the accounts API against a throwaway in-memory MongoDB.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-anything';

// A stand-in for client/dist, so the tests don't depend on a real client build.
const dist = mkdtempSync(join(tmpdir(), 'obsidian-dist-'));
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="app"></div>');
writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
process.env.CLIENT_DIST = dist;

let mongo: MongoMemoryServer;
let server: Server;
let base = '';

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const { createApp } = await import('../src/app.ts');
  const { User } = await import('../src/models/User.ts');
  await User.init(); // build the unique indexes before the duplicate tests run
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await mongoose.disconnect();
  await mongo?.stop();
  rmSync(dist, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown, cookie?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

describe('accounts', () => {
  let session = '';

  test('signs up, stores a hash rather than the password, and starts a session', async () => {
    const r = await call('POST', '/api/auth/register', { username: 'Ronnie_147', email: 'Ronnie@Example.com', password: 'rocket-147', avatar: '🐯' });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.username, 'ronnie_147');
    assert.equal(r.body.user.email, 'ronnie@example.com');
    assert.deepEqual(r.body.user.profile, { name: 'Ronnie_147', avatar: '🐯', cue: 'maple' });
    assert.equal(r.body.user.passwordHash, undefined);
    assert.match(r.cookie, /^obsidian_session=/);
    session = r.cookie;

    const stored = await mongoose.connection.collection('users').findOne({ username: 'ronnie_147' });
    assert.ok(stored);
    assert.notEqual(stored.passwordHash, 'rocket-147');
    assert.match(stored.passwordHash, /^\$2[aby]\$12\$/);
  });

  test('rejects bad input with per-field messages', async () => {
    const r = await call('POST', '/api/auth/register', { username: 'a!', email: 'nope', password: 'short' });
    assert.equal(r.status, 400);
    assert.deepEqual(Object.keys(r.body.fields).sort(), ['email', 'password', 'username']);
  });

  test('refuses a taken username or email, whatever the case', async () => {
    const u = await call('POST', '/api/auth/register', { username: 'RONNIE_147', email: 'other@example.com', password: 'rocket-147' });
    assert.equal(u.status, 409);
    assert.ok(u.body.fields.username);
    const e = await call('POST', '/api/auth/register', { username: 'someone', email: 'ronnie@example.COM', password: 'rocket-147' });
    assert.equal(e.status, 409);
    assert.ok(e.body.fields.email);
  });

  test('knows who is signed in', async () => {
    const r = await call('GET', '/api/auth/me', undefined, session);
    assert.equal(r.status, 200);
    assert.equal(r.body.user.username, 'ronnie_147');
    assert.equal((await call('GET', '/api/auth/me')).status, 401);
    assert.equal((await call('GET', '/api/auth/me', undefined, 'obsidian_session=forged.token.here')).status, 401);
  });

  test('signs in with username or email, and gives the same answer for a wrong user or password', async () => {
    const byName = await call('POST', '/api/auth/login', { identifier: 'Ronnie_147', password: 'rocket-147' });
    assert.equal(byName.status, 200);
    assert.match(byName.cookie, /^obsidian_session=/);
    const byEmail = await call('POST', '/api/auth/login', { identifier: 'RONNIE@example.com', password: 'rocket-147' });
    assert.equal(byEmail.status, 200);

    const wrongPw = await call('POST', '/api/auth/login', { identifier: 'ronnie_147', password: 'nope-nope' });
    const noUser = await call('POST', '/api/auth/login', { identifier: 'nobody', password: 'nope-nope' });
    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.equal(wrongPw.body.error, noUser.body.error);
  });

  test('saves profile changes', async () => {
    const r = await call('PATCH', '/api/users/me', { name: 'The Rocket', avatar: '🦉', cue: 'ebony' }, session);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.user.profile, { name: 'The Rocket', avatar: '🦉', cue: 'ebony' });
    assert.equal((await call('PATCH', '/api/users/me', { name: '' }, session)).status, 400);
    assert.equal((await call('PATCH', '/api/users/me', { name: 'x' })).status, 401);
    const me = await call('GET', '/api/auth/me', undefined, session);
    assert.equal(me.body.user.profile.name, 'The Rocket');
  });

  test('signs out by clearing the cookie', async () => {
    const r = await call('POST', '/api/auth/logout', undefined, session);
    assert.equal(r.status, 204);
    assert.match(r.cookie, /^obsidian_session=$/);
  });
});

describe('serving the client', () => {
  test('serves the single-page app for every page route', async () => {
    for (const path of ['/', '/login', '/t/ABC123']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.match(await res.text(), /<div id="app">/, path);
    }
  });

  test('caches fingerprinted assets for good, and 404s missing ones instead of sending the page', async () => {
    const hit = await fetch(`${base}/assets/index-abc123.js`);
    assert.equal(hit.status, 200);
    assert.match(hit.headers.get('cache-control') ?? '', /immutable/);
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
  });

  test('keeps unknown API routes as JSON 404s', async () => {
    const r = await call('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'Not found.');
  });
});
