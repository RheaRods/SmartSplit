import { Router } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Group, User, Expense, Settlement, LedgerEntry, Invite } from './models.js';
import { requireAuth, requireMember, requireAdmin } from './auth.js';
import { appendEntry, inTransaction } from './ledger.js';

const ID = /^[a-f0-9]{24}$/i;
const TOKEN = /^[a-f0-9]{48}$/i;
const toId = (s) => new mongoose.Types.ObjectId(s);
const appUrl = () => process.env.APP_URL || 'http://localhost:5173';

const parse = (schema, data, res) => {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    res.status(400).json({ error: msg });
    return null;
  }
  return result.data;
};

const CATEGORIES = ['food', 'travel', 'rent', 'utilities', 'groceries', 'fun', 'other'];
const emailField = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email'));

const createSchema = z.object({
  name: z.string().trim().min(1, 'Group name is required').max(80),
  type: z.enum(['flatmates', 'trip', 'friends', 'other']).default('friends'),
  currency: z.string().trim().toUpperCase().length(3).default('INR'),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  type: z.enum(['flatmates', 'trip', 'friends', 'other']).optional(),
  budgets: z
    .array(
      z.object({
        category: z.enum(CATEGORIES),
        limitPaise: z.number().int().min(1),
        period: z.enum(['month', 'trip']).default('month'),
      })
    )
    .max(20)
    .optional(),
  tripBudget: z
    .object({
      startDate: z.coerce.date(),
      endDate: z.coerce.date(),
      totalPaise: z.number().int().min(1),
    })
    .refine((t) => t.endDate >= t.startDate, 'endDate must be on or after startDate')
    .optional(),
});

const roleSchema = z.object({ role: z.enum(['admin', 'member']) });
const inviteSchema = z.object({ email: emailField });

// A member's net balance in paise: positive = is owed money, negative = owes money.
// (Step 8 will add the full group-wide version as report R1.)
async function netBalance(groupId, userId) {
  const total = (rows) => rows[0]?.total ?? 0;
  const sum = (field) => ({ $group: { _id: null, total: { $sum: field } } });

  const [paid, owed, sent, received] = await Promise.all([
    Expense.aggregate([{ $match: { groupId, paidBy: userId, isDeleted: false } }, sum('$amount')]),
    Expense.aggregate([
      { $match: { groupId, isDeleted: false, 'splits.userId': userId } },
      { $unwind: '$splits' },
      { $match: { 'splits.userId': userId } },
      sum('$splits.share'),
    ]),
    Settlement.aggregate([{ $match: { groupId, from: userId, status: 'confirmed' } }, sum('$amount')]),
    Settlement.aggregate([{ $match: { groupId, to: userId, status: 'confirmed' } }, sum('$amount')]),
  ]);

  return total(paid) - total(owed) + total(sent) - total(received);
}

const rupees = (paise) => (Math.abs(paise) / 100).toFixed(2);

// =====================================================================
// /api/groups
// =====================================================================
const router = Router();
router.use(requireAuth);

// GET /api/groups  -> my groups
router.get('/', async (req, res) => {
  const groups = await Group.find({ 'members.userId': req.user._id })
    .sort({ createdAt: -1 })
    .select('name type currency members createdAt')
    .lean();

  res.json({
    groups: groups.map((g) => ({
      id: g._id,
      name: g.name,
      type: g.type,
      currency: g.currency,
      memberCount: g.members.length,
      createdAt: g.createdAt,
    })),
  });
});

// POST /api/groups  -> create (creator becomes admin)
router.post('/', async (req, res) => {
  const data = parse(createSchema, req.body, res);
  if (!data) return;

  const group = await inTransaction(async (session) => {
    const [g] = await Group.create(
      [
        {
          name: data.name,
          type: data.type,
          currency: data.currency,
          createdBy: req.user._id,
          members: [{ userId: req.user._id, name: req.user.name, role: 'admin' }],
        },
      ],
      { session }
    );
    await appendEntry(
      {
        groupId: g._id,
        type: 'member.add',
        refId: req.user._id,
        actor: req.user._id,
        payload: { userId: req.user._id, name: req.user.name, role: 'admin' },
      },
      session
    );
    return g;
  });

  res.status(201).json({ group });
});

// GET /api/groups/:id
router.get('/:id', requireMember, (req, res) => {
  res.json({ group: req.group, myRole: req.member.role });
});

// PATCH /api/groups/:id  (admin) -> name, type, budgets, trip budget
router.patch('/:id', requireMember, requireAdmin, async (req, res) => {
  const data = parse(patchSchema, req.body, res);
  if (!data) return;

  const set = {};
  for (const key of ['name', 'type', 'budgets', 'tripBudget']) {
    if (data[key] !== undefined) set[key] = data[key];
  }
  if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to update' });

  const group = await Group.findByIdAndUpdate(req.group._id, { $set: set }, { new: true, runValidators: true }).lean();
  res.json({ group });
});

// DELETE /api/groups/:id  (admin) -> cascade delete everything in the group.
// Body must contain { "confirmName": "<exact group name>" }.
router.delete('/:id', requireMember, requireAdmin, async (req, res) => {
  if (req.body?.confirmName !== req.group.name) {
    return res.status(400).json({ error: 'Type the exact group name in confirmName to delete it' });
  }

  const groupId = req.group._id;
  const deleted = await inTransaction(async (session) => {
    const expenses = await Expense.deleteMany({ groupId }, { session });
    const settlements = await Settlement.deleteMany({ groupId }, { session });
    const ledger = await LedgerEntry.deleteMany({ groupId }, { session });
    await Invite.deleteMany({ groupId }, { session });
    await Group.deleteOne({ _id: groupId }, { session });
    return { expenses: expenses.deletedCount, settlements: settlements.deletedCount, ledgerEntries: ledger.deletedCount };
  });

  res.json({ ok: true, deleted });
});

// PATCH /api/groups/:id/members/:userId  (admin) -> change one member's role
router.patch('/:id/members/:userId', requireMember, requireAdmin, async (req, res) => {
  const userId = req.params.userId.toLowerCase();
  if (!ID.test(userId)) return res.status(400).json({ error: 'Invalid user id' });
  const data = parse(roleSchema, req.body, res);
  if (!data) return;

  const members = req.group.members;
  const target = members.find((m) => String(m.userId) === userId);
  if (!target) return res.status(404).json({ error: 'That user is not in this group' });

  const admins = members.filter((m) => m.role === 'admin');
  if (target.role === 'admin' && data.role === 'member' && admins.length === 1) {
    return res.status(400).json({ error: 'A group needs at least one admin' });
  }

  // arrayFilters: update only the one matching element inside members[]
  await Group.updateOne(
    { _id: req.group._id },
    { $set: { 'members.$[m].role': data.role } },
    { arrayFilters: [{ 'm.userId': toId(userId) }] }
  );

  res.json({ ok: true, userId, role: data.role });
});

// DELETE /api/groups/:id/members/:userId  -> admin removes someone, or you leave.
// Only allowed when that member's balance is exactly 0.
router.delete('/:id/members/:userId', requireMember, async (req, res) => {
  const userId = req.params.userId.toLowerCase();
  if (!ID.test(userId)) return res.status(400).json({ error: 'Invalid user id' });

  const isSelf = String(req.user._id) === userId;
  if (!isSelf && req.member.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can remove other members' });
  }

  const members = req.group.members;
  const target = members.find((m) => String(m.userId) === userId);
  if (!target) return res.status(404).json({ error: 'That user is not in this group' });

  if (members.length === 1) {
    return res.status(400).json({ error: 'You are the only member. Delete the group instead.' });
  }
  const admins = members.filter((m) => m.role === 'admin');
  if (target.role === 'admin' && admins.length === 1) {
    return res.status(400).json({ error: 'Make another member an admin first' });
  }

  const net = await netBalance(req.group._id, toId(userId));
  if (net !== 0) {
    const dir = net > 0 ? 'is owed' : 'owes';
    return res.status(400).json({ error: `Settle up first: ${target.name} ${dir} ₹${rupees(net)}` });
  }

  await inTransaction(async (session) => {
    await Group.updateOne({ _id: req.group._id }, { $pull: { members: { userId: toId(userId) } } }, { session });
    await appendEntry(
      {
        groupId: req.group._id,
        type: 'member.remove',
        refId: toId(userId),
        actor: req.user._id,
        payload: { userId, name: target.name },
      },
      session
    );
  });

  res.json({ ok: true });
});

// POST /api/groups/:id/invites  (admin) -> creates a 7-day invite link.
// No email is sent: share the returned link with your friend.
router.post('/:id/invites', requireMember, requireAdmin, async (req, res) => {
  const data = parse(inviteSchema, req.body, res);
  if (!data) return;

  const existing = await User.findOne({ email: data.email }).select('_id').lean();
  if (existing && req.group.members.some((m) => String(m.userId) === String(existing._id))) {
    return res.status(409).json({ error: 'That person is already in this group' });
  }

  await Invite.deleteMany({ groupId: req.group._id, email: data.email }); // replace any older invite

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await Invite.create({ groupId: req.group._id, email: data.email, token, invitedBy: req.user._id, expiresAt });

  res.status(201).json({ invite: { email: data.email, token, link: `${appUrl()}/join/${token}`, expiresAt } });
});

// =====================================================================
// /api/invites
// =====================================================================
export const invitesRouter = Router();
invitesRouter.use(requireAuth);

const findValidInvite = async (token) => {
  if (!TOKEN.test(token)) return null;
  const invite = await Invite.findOne({ token }).lean();
  // The TTL index deletes expired invites with a small delay, so check the date too.
  return invite && invite.expiresAt > new Date() ? invite : null;
};

// GET /api/invites/:token -> preview for the "join group" page
invitesRouter.get('/:token', async (req, res) => {
  const invite = await findValidInvite(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found or expired' });

  const group = await Group.findById(invite.groupId).select('name').lean();
  res.json({ email: invite.email, groupName: group?.name ?? 'Group', expiresAt: invite.expiresAt });
});

// POST /api/invites/:token/accept -> join the group
invitesRouter.post('/:token/accept', async (req, res) => {
  const invite = await findValidInvite(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found or expired' });
  if (invite.email !== req.user.email) {
    return res.status(403).json({ error: 'This invite was sent to a different email address' });
  }

  await inTransaction(async (session) => {
    // The $ne filter + $addToSet means a user can never be added twice.
    const result = await Group.updateOne(
      { _id: invite.groupId, 'members.userId': { $ne: req.user._id } },
      { $addToSet: { members: { userId: req.user._id, name: req.user.name, role: 'member', joinedAt: new Date() } } },
      { session }
    );
    if (result.modifiedCount) {
      await appendEntry(
        {
          groupId: invite.groupId,
          type: 'member.add',
          refId: req.user._id,
          actor: req.user._id,
          payload: { userId: req.user._id, name: req.user.name, role: 'member' },
        },
        session
      );
    }
    await Invite.deleteOne({ _id: invite._id }, { session });
  });

  res.json({ groupId: invite.groupId });
});

export default router;
