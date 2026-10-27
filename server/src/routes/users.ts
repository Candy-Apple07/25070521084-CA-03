// The signed-in player's saved profile: display name, picture and cue.

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import { publicUser, User } from '../models/User.ts';

export const usersRouter = Router();

usersRouter.patch('/me', requireAuth, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const set: Record<string, string> = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 20) return void res.status(400).json({ error: 'Names are 1 to 20 characters.', fields: { name: 'Names are 1 to 20 characters.' } });
    set['profile.name'] = name;
  }
  if (body.avatar !== undefined) {
    if (typeof body.avatar !== 'string' || !body.avatar || body.avatar.length > 16) return void res.status(400).json({ error: 'Pick a picture.' });
    set['profile.avatar'] = body.avatar;
  }
  if (body.cue !== undefined) {
    if (typeof body.cue !== 'string' || !/^[a-z0-9-]{1,24}$/.test(body.cue)) return void res.status(400).json({ error: 'Pick a cue.' });
    set['profile.cue'] = body.cue;
  }

  const user = await User.findByIdAndUpdate(req.userId, { $set: set }, { returnDocument: 'after', runValidators: true });
  if (!user) return void res.status(401).json({ error: 'Not signed in.' });
  res.json({ user: publicUser(user) });
});
