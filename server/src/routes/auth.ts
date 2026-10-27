// Sign up, sign in, sign out, and "who am I".

import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { endSession, requireAuth, startSession } from '../middleware/auth.ts';
import { publicUser, User, USERNAME } from '../models/User.ts';

const BCRYPT_COST = 12;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Compared against when the account doesn't exist, so a wrong username takes as long as a
// wrong password and response times don't reveal which usernames are taken.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

export const authRouter = Router();

// Slow down password guessing: 20 attempts per IP per 15 minutes across sign-in and sign-up.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});

const str = (v: unknown) => (typeof v === 'string' ? v : '');

authRouter.post('/register', limiter, async (req, res) => {
  const username = str(req.body?.username).trim().toLowerCase();
  const email = str(req.body?.email).trim().toLowerCase();
  const password = str(req.body?.password);
  const avatar = str(req.body?.avatar).slice(0, 16) || undefined;

  const errors: Record<string, string> = {};
  if (!USERNAME.test(username)) errors.username = 'Use 3 to 20 letters, numbers or underscores.';
  if (!EMAIL.test(email) || email.length > 254) errors.email = 'Enter a valid email address.';
  if (password.length < 8) errors.password = 'Use at least 8 characters.';
  else if (Buffer.byteLength(password) > 72) errors.password = 'Use 72 characters or fewer.';
  if (Object.keys(errors).length) return void res.status(400).json({ error: 'Check the highlighted fields.', fields: errors });

  const taken = await User.findOne({ $or: [{ username }, { email }] }).lean();
  if (taken) {
    const fields = taken.username === username ? { username: 'That username is taken.' } : { email: 'An account already uses this email.' };
    return void res.status(409).json({ error: 'Check the highlighted fields.', fields });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const user = await User.create({
    username,
    email,
    passwordHash,
    profile: { name: str(req.body?.username).trim().slice(0, 20), avatar },
    lastLoginAt: new Date(),
  });
  startSession(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

authRouter.post('/login', limiter, async (req, res) => {
  const id = str(req.body?.identifier).trim().toLowerCase();
  const password = str(req.body?.password);
  if (!id || !password) return void res.status(400).json({ error: 'Enter your username or email and your password.' });

  const user = await User.findOne(id.includes('@') ? { email: id } : { username: id }).select('+passwordHash');
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) return void res.status(401).json({ error: 'That username or password is not right.' });

  user.lastLoginAt = new Date();
  await user.save();
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', (_req, res) => {
  endSession(res);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) {
    endSession(res);
    return void res.status(401).json({ error: 'Not signed in.' });
  }
  res.json({ user: publicUser(user) });
});
