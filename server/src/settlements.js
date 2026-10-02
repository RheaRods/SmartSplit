import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Settlement, User } from './models.js';
import { requireAuth, requireMember } from './auth.js';
import { appendEntry, inTransaction } from './ledger.js';
import { getBalances, getPaidVsConsumed } from './reports.js';
import { rupees } from './splitEngine.js';

const ID = /^[a-f0-9]{24}$/i;
const toId = (s) => new mongoose.Types.ObjectId(s);

const parse = (schema, data, res) => {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    res.status(400).json({ error: msg });
    return null;
  }
  return result.data;
};

const createSchema = z.object({
  to: z.string().regex(ID, 'Invalid user id'),
  amount: z.number().int('Amount must be whole paise').min(1).max(10_000_000_000),
  method: z.enum(['upi', 'cash', 'other']).default('upi'),
  note: z.string().trim().max(200).default(''),
});

const nameOf = (group, id) => group.members.find((m) => String(m.userId) === String(id))?.name ?? 'Former member';
const decorate = (s, group) => ({ ...s, fromName: nameOf(group, s.from), toName: nameOf(group, s.to) });

// Returns the settlement in :sid for this group, or sends 400/404 and returns null.
const loadSettlement = async (req, res) => {
  const sid = req.params.sid.toLowerCase();
  if (!ID.test(sid)) {
    res.status(400).json({ error: 'Invalid settlement id' });
    return null;
  }
  const s = await Settlement.findOne({ _id: sid, groupId: req.group._id }).lean();
  if (!s) {
    res.status(404).json({ error: 'Settlement not found' });
    return null;
  }
  return s;
};

// ---- Smart feature S2: fewest payments that settle everyone ----
// Repeatedly matches the person who owes the most with the person owed the most.
// Everyone ends at zero, using at most (people - 1) payments.
function minimizeTransfers(balances) {
  const debtors = balances.filter((b) => b.net < 0).map((b) => ({ ...b, left: -b.net }));
  const creditors = balances.filter((b) => b.net > 0).map((b) => ({ ...b, left: b.net }));
  const transfers = [];

  while (debtors.length && creditors.length) {
    debtors.sort((a, b) => b.left - a.left);
    creditors.sort((a, b) => b.left - a.left);
    const amount = Math.min(debtors[0].left, creditors[0].left);
    transfers.push({ from: debtors[0], to: creditors[0], amount });
    debtors[0].left -= amount;
    creditors[0].left -= amount;
    if (debtors[0].left === 0) debtors.shift();
    if (creditors[0].left === 0) creditors.shift();
  }
  return transfers;
}

// =====================================================================
// /api/groups/:groupId/settlements
// =====================================================================
const router = Router({ mergeParams: true });
router.use(requireAuth, requireMember);

// GET /  -> ?status=pending|confirmed &page=1 &limit=20
router.get('/', async (req, res) => {
  const filter = { groupId: req.group._id };
  if (['pending', 'confirmed'].includes(req.query.status)) filter.status = req.query.status;

  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);

  const [rows, total] = await Promise.all([
    Settlement.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Settlement.countDocuments(filter),
  ]);

  res.json({ settlements: rows.map((s) => decorate(s, req.group)), page, limit, total, hasMore: page * limit < total });
});

// POST /  -> "I paid <to> this much". Starts as pending until the receiver confirms.
router.post('/', async (req, res) => {
  const data = parse(createSchema, req.body, res);
  if (!data) return;

  if (!req.group.members.some((m) => String(m.userId) === data.to.toLowerCase())) {
    return res.status(400).json({ error: 'You can only settle with someone in this group' });
  }
  if (data.to.toLowerCase() === String(req.user._id)) {
    return res.status(400).json({ error: 'You cannot pay yourself' });
  }

  const doc = {
    groupId: req.group._id,
    from: req.user._id,
    to: toId(data.to),
    amount: data.amount,
    method: data.method,
    note: data.note,
    status: 'pending',
  };

  const settlement = await inTransaction(async (session) => {
    const [created] = await Settlement.create([doc], { session });
    await appendEntry(
      {
        groupId: req.group._id,
        type: 'settlement.create',
        refId: created._id,
        actor: req.user._id,
        payload: { from: doc.from, to: doc.to, amount: doc.amount, method: doc.method, note: doc.note },
      },
      session
    );
    return created;
  });

  res.status(201).json({ settlement: decorate(settlement.toObject(), req.group) });
});

// PATCH /:sid/confirm  -> only the person who RECEIVED the money can confirm.
// Confirmed settlements are what change the balances.
router.patch('/:sid/confirm', async (req, res) => {
  const existing = await loadSettlement(req, res);
  if (!existing) return;
  if (String(existing.to) !== String(req.user._id)) {
    return res.status(403).json({ error: 'Only the person who received the money can confirm it' });
  }
  if (existing.status === 'confirmed') return res.status(409).json({ error: 'Already confirmed' });

  const updated = await inTransaction(async (session) => {
    const doc = await Settlement.findOneAndUpdate(
      { _id: existing._id, groupId: req.group._id, to: req.user._id, status: 'pending' },
      { $set: { status: 'confirmed', confirmedAt: new Date() } },
      { new: true, session }
    ).lean();
    if (!doc) return null; // someone confirmed it a moment earlier
    await appendEntry(
      {
        groupId: req.group._id,
        type: 'settlement.confirm',
        refId: doc._id,
        actor: req.user._id,
        payload: { from: doc.from, to: doc.to, amount: doc.amount },
      },
      session
    );
    return doc;
  });

  if (!updated) return res.status(409).json({ error: 'Already confirmed' });
  res.json({ settlement: decorate(updated, req.group) });
});

// DELETE /:sid  -> cancel (sender) or reject (receiver) a PENDING settlement.
// Confirmed settlements can never be deleted.
router.delete('/:sid', async (req, res) => {
  const existing = await loadSettlement(req, res);
  if (!existing) return;
  if (existing.status !== 'pending') return res.status(409).json({ error: 'Confirmed settlements cannot be removed' });

  const me = req.user._id;
  const removed = await inTransaction(async (session) => {
    const result = await Settlement.deleteOne(
      { _id: existing._id, groupId: req.group._id, status: 'pending', $or: [{ from: me }, { to: me }] },
      { session }
    );
    if (!result.deletedCount) return false;
    await appendEntry(
      {
        groupId: req.group._id,
        type: 'settlement.cancel',
        refId: existing._id,
        actor: me,
        payload: {
          from: existing.from,
          to: existing.to,
          amount: existing.amount,
          by: String(existing.from) === String(me) ? 'sender' : 'receiver',
        },
      },
      session
    );
    return true;
  });

  if (!removed) return res.status(403).json({ error: 'Only the sender or receiver can remove this settlement' });
  res.json({ ok: true });
});

export default router;

// =====================================================================
// Smart routes, mounted at /api/groups/:groupId
//   GET /settle-plan   fewest payments to clear all debts (+ UPI pay links)
//   GET /next-payer    who is most "behind" on paying
// =====================================================================
export const smartRouter = Router({ mergeParams: true });
const guard = [requireAuth, requireMember];

smartRouter.get('/settle-plan', ...guard, async (req, res) => {
  const group = req.group;
  const [balances, pending] = await Promise.all([
    getBalances(group),
    Settlement.countDocuments({ groupId: group._id, status: 'pending' }),
  ]);

  const plan = minimizeTransfers(balances);

  const receivers = [...new Set(plan.map((t) => String(t.to.userId)))];
  const users = await User.find({ _id: { $in: receivers } })
    .select('upiId')
    .lean();
  const upiOf = new Map(users.map((u) => [String(u._id), u.upiId]));

  const transfers = plan.map((t) => {
    const upiId = upiOf.get(String(t.to.userId)) ?? null;
    const upiLink =
      upiId && group.currency === 'INR'
        ? `upi://pay?pa=${upiId}&pn=${encodeURIComponent(t.to.name)}&am=${rupees(t.amount)}&cu=INR&tn=${encodeURIComponent(`SplitSmart ${group.name}`)}`
        : null;
    return {
      from: { userId: t.from.userId, name: t.from.name },
      to: { userId: t.to.userId, name: t.to.name, upiId },
      amount: t.amount,
      upiLink,
      isMine: String(t.from.userId) === String(req.user._id),
    };
  });

  res.json({
    currency: group.currency,
    transfers,
    count: transfers.length,
    allSettled: transfers.length === 0,
    pendingSettlements: pending, // confirm these first, they are not counted in the balances yet
  });
});

// Smart feature S3: who should pay next?
// Looks at paid vs share consumed over all expenses. The person who has paid the
// least compared with what they consumed is "behind" and should pay next.
smartRouter.get('/next-payer', ...guard, async (req, res) => {
  const ranking = await getPaidVsConsumed(req.group);
  ranking.sort((a, b) => a.net - b.net || a.paid - b.paid || a.name.localeCompare(b.name));

  const hasData = ranking.some((r) => r.paid > 0 || r.consumed > 0);
  if (!hasData) return res.json({ nextPayer: null, ranking, message: 'No expenses yet' });

  const next = ranking[0];
  const message =
    next.net < 0
      ? `${next.name} has paid ₹${rupees(-next.net)} less than their share so far`
      : 'Everyone is about even, so it is anyone\'s turn';

  res.json({ nextPayer: next, ranking, message });
});
