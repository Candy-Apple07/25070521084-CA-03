// A player account. The password is only ever stored as a bcrypt hash, and is left out of
// queries unless asked for explicitly.

import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

export const USERNAME = /^[a-z0-9_]{3,20}$/;

const profileSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 20 },
  avatar: { type: String, default: '🦊', maxlength: 16 },
  cue: { type: String, default: 'maple', maxlength: 24 },
}, { _id: false });

const userSchema = new Schema({
  /** Lower-case handle used to sign in. Unique. */
  username: { type: String, required: true, unique: true, lowercase: true, trim: true, match: USERNAME },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
  passwordHash: { type: String, required: true, select: false },
  /** What other players see at the table. */
  profile: { type: profileSchema, required: true },
  lastLoginAt: { type: Date },
}, { timestamps: true });

export type UserFields = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserFields>;

export const User = model('User', userSchema);

/** The shape the API sends back. Never includes the password hash. */
export function publicUser(u: UserDoc) {
  return {
    id: u.id as string,
    username: u.username,
    email: u.email,
    profile: { name: u.profile.name, avatar: u.profile.avatar, cue: u.profile.cue },
    createdAt: u.createdAt,
  };
}
