import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User, Group } from './models.js';

const ID = /^[a-f0-9]{24}$/i;
const secret = () => process.env.JWT_SECRET;

// Used so login takes the same time whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const publicUser = (u) => ({ id: u._id, name: u.name, email: u.email, upiId: u.upiId ?? null });
const signToken = (id) => jwt.sign({ sub: String(id) }, secret(), { expiresIn: '7d' });

// Validates data with a zod schema. On failure sends a 400 and returns null.
const parse = (schema, data, res) => {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    res.status(400).json({ error: msg });
    return null;
  }
  return result.data;
};

// ================= middleware (exported for other routers) =================

// Requires a valid "Authorization: Bearer <token>" header. Sets req.user.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });

  let payload;
  try {
    payload = jwt.verify(token, secret());
  } catch {
    return res.status(401).json({ error: 'Session expired or invalid, please log in again' });
  }

  const user = await User.findById(payload.sub).select('name email upiId');
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });

  req.user = user;
  next();
}

// Requires the logged-in user to be a member of the group in :groupId (or :id).
// Sets req.group (plain object) and req.member (this user's member entry).
export async function requireMember(req, res, next) {
  const gid = req.params.groupId ?? req.params.id;
  if (!ID.test(gid)) return res.status(400).json({ error: 'Invalid group id' });

  const group = await Group.findById(gid).lean();
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const member = group.members.find((m) => String(m.userId) === String(req.user._id));
  if (!member) return res.status(403).json({ error: 'You are not a member of this group' });

  req.group = group;
  req.member = member;
  next();
}

// Use after requireMember on admin-only actions.
export function requireAdmin(req, res, next) {
  if (req.member?.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

// ================= routes =================

const router = Router();

// Brute-force protection on register/login (per IP).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: { error: 'Too many attempts, try again in a few minutes' },
});

const emailField = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email'));

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(60),
  email: emailField,
  password: z.string().min(8, 'Password must be at least 8 characters').max(72),
});

const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'Password is required').max(72),
});

const profileSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  // UPI id looks like name@bank. Empty string clears it.
  upiId: z
    .union([z.literal(''), z.string().trim().regex(/^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/, 'Enter a valid UPI id like name@bank')])
    .optional(),
});

// POST /api/auth/register
router.post('/register', authLimiter, async (req, res) => {
  const data = parse(registerSchema, req.body, res);
  if (!data) return;

  if (await User.exists({ email: data.email })) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(data.password, 10);
  let user;
  try {
    user = await User.create({ name: data.name, email: data.email, passwordHash });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'An account with this email already exists' });
    throw err;
  }

  res.status(201).json({ token: signToken(user._id), user: publicUser(user) });
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  const data = parse(loginSchema, req.body, res);
  if (!data) return;

  const user = await User.findOne({ email: data.email });
  const ok = await bcrypt.compare(data.password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid email or password' });

  res.json({ token: signToken(user._id), user: publicUser(user) });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// PATCH /api/auth/me  (update name / UPI id; UPI id powers the "Pay via UPI" button)
router.patch('/me', requireAuth, async (req, res) => {
  const data = parse(profileSchema, req.body, res);
  if (!data) return;

  const update = {};
  if (data.name !== undefined) update.$set = { name: data.name };
  if (data.upiId === '') update.$unset = { upiId: '' };
  else if (data.upiId !== undefined) update.$set = { ...update.$set, upiId: data.upiId };

  if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update' });

  const user = await User.findByIdAndUpdate(req.user._id, update, { new: true });
  res.json({ user: publicUser(user) });
});

export default router;
