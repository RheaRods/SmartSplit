import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Expense } from './models.js';
import { requireAuth, requireMember, requireAdmin } from './auth.js';
import { appendEntry, inTransaction } from './ledger.js';
import { computeSplits, SplitError, rupees } from './splitEngine.js';

// Mounted at /api/groups/:groupId/expenses
// All amounts are WHOLE PAISE (₹12.50 = 1250). The frontend converts for display.

const ID = /^[a-f0-9]{24}$/i;
const toId = (s) => new mongoose.Types.ObjectId(s);
const CATEGORIES = ['food', 'travel', 'rent', 'utilities', 'groceries', 'fun', 'other'];
const SPLIT_TYPES = ['equal', 'exact', 'percent', 'shares'];

const parse = (schema, data, res) => {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    res.status(400).json({ error: msg });
    return null;
  }
  return result.data;
};

// ---------------- validation schemas ----------------
const participant = z.object({
  userId: z.string().regex(ID, 'Invalid user id'),
  value: z.number().optional(),
});
const amountField = z.number().int('Amount must be whole paise').min(1).max(10_000_000_000);
const dateField = z.coerce.date().refine((d) => d <= new Date(Date.now() + 24 * 60 * 60 * 1000), 'Date cannot be in the future');
const descField = z.string().trim().max(120);

const createSchema = z.object({
  description: descField.default(''),
  amount: amountField,
  category: z.enum(CATEGORIES).default('other'),
  date: dateField.optional(),
  paidBy: z.string().regex(ID).optional(), // defaults to you
  splitType: z.enum(SPLIT_TYPES).default('equal'),
  participants: z.array(participant).min(1).max(50).optional(), // defaults to everyone (equal split)
  clientRequestId: z.string().trim().min(1).max(64).optional(), // stops double-submit duplicates
});

const patchSchema = z.object({
  description: descField.optional(),
  amount: amountField.optional(),
  category: z.enum(CATEGORIES).optional(),
  date: dateField.optional(),
  paidBy: z.string().regex(ID).optional(),
  splitType: z.enum(SPLIT_TYPES).optional(),
  participants: z.array(participant).min(1).max(50).optional(),
});

const importSchema = z.object({ csv: z.string().min(1).max(60000) });

// ---------------- helpers ----------------
const nameOf = (group, id) => group.members.find((m) => String(m.userId) === String(id))?.name ?? 'Former member';

// Adds readable names next to the ids (names come from the group's member list).
const decorate = (e, group) => ({
  ...e,
  paidByName: nameOf(group, e.paidBy),
  splits: e.splits.map((s) => ({ ...s, name: nameOf(group, s.userId) })),
});

// Sends a 400 and returns false if any id is not in the group.
const checkMembers = (res, group, ids) => {
  const ok = new Set(group.members.map((m) => String(m.userId)));
  const bad = ids.find((id) => !ok.has(String(id).toLowerCase()));
  if (bad) {
    res.status(400).json({ error: 'Everyone in the expense must be a member of this group' });
    return false;
  }
  return true;
};

// computeSplits, but turns SplitError into a 400 response (returns null).
const trySplit = (res, type, amount, participants) => {
  try {
    return computeSplits(type, amount, participants);
  } catch (err) {
    if (err instanceof SplitError) {
      res.status(400).json({ error: err.message });
      return null;
    }
    throw err;
  }
};

const loadExpense = async (req, res) => {
  const eid = req.params.eid.toLowerCase();
  if (!ID.test(eid)) {
    res.status(400).json({ error: 'Invalid expense id' });
    return null;
  }
  const expense = await Expense.findOne({ _id: eid, groupId: req.group._id, isDeleted: false }).lean();
  if (!expense) {
    res.status(404).json({ error: 'Expense not found' });
    return null;
  }
  return expense;
};

// ---- Smart feature S4: anomaly flag ----
// Compares the new amount with this group's usual spend in the same category
// (needs at least 5 past expenses). Returns a warning text, or null.
async function checkAnomaly(groupId, category, amount, excludeId) {
  const match = { groupId, category, isDeleted: false };
  if (excludeId) match._id = { $ne: excludeId };

  const [stats] = await Expense.aggregate([
    { $match: match },
    { $group: { _id: null, count: { $sum: 1 }, avg: { $avg: '$amount' }, sd: { $stdDevPop: '$amount' } } },
  ]);
  if (!stats || stats.count < 5) return null;

  const limit = Math.max(stats.avg + 2 * stats.sd, stats.avg * 1.5);
  if (amount <= limit) return null;
  return `₹${rupees(amount)} is much higher than the usual ₹${rupees(Math.round(stats.avg))} for ${category} in this group`;
}

// Normalised copy of splits, used only to compare old vs new.
const plainSplits = (splits) => splits.map((s) => ({ userId: String(s.userId), share: s.share }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- tiny CSV parser (handles quotes) ----
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.some((x) => x.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else cell += c;
  }
  endRow();
  return rows;
}

// =====================================================================
const router = Router({ mergeParams: true });
router.use(requireAuth, requireMember);

// GET /  -> list with filters + pagination
// ?q=pizza &category=food,travel &from=2026-10-01 &to=2026-10-31 &paidBy=<id>
// &min=10000 &max=500000 (paise) &flagged=true &page=1 &limit=20
router.get('/', async (req, res) => {
  const str = (v) => (typeof v === 'string' ? v.trim() : undefined);
  const filter = { groupId: req.group._id, isDeleted: false };

  const q = str(req.query.q);
  if (q) filter.$text = { $search: q };

  const cats = str(req.query.category)?.split(',').filter((c) => CATEGORIES.includes(c));
  if (cats?.length) filter.category = { $in: cats };

  const from = str(req.query.from);
  const to = str(req.query.to);
  if (from && !Number.isNaN(Date.parse(from))) filter.date = { ...filter.date, $gte: new Date(from) };
  if (to && !Number.isNaN(Date.parse(to))) {
    const end = new Date(to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      end.setUTCDate(end.getUTCDate() + 1); // date-only "to" means the whole day
      filter.date = { ...filter.date, $lt: end };
    } else filter.date = { ...filter.date, $lte: end };
  }

  const paidBy = str(req.query.paidBy);
  if (paidBy && ID.test(paidBy)) filter.paidBy = toId(paidBy);

  const min = Number(req.query.min);
  const max = Number(req.query.max);
  if (Number.isFinite(min)) filter.amount = { ...filter.amount, $gte: min };
  if (Number.isFinite(max)) filter.amount = { ...filter.amount, $lte: max };

  if (str(req.query.flagged) === 'true') {
    filter['flags.anomaly'] = true;
    filter['flags.confirmedBy'] = null;
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);

  const [expenses, total] = await Promise.all([
    Expense.find(filter)
      .sort({ date: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Expense.countDocuments(filter),
  ]);

  res.json({
    expenses: expenses.map((e) => decorate(e, req.group)),
    page,
    limit,
    total,
    hasMore: page * limit < total,
  });
});

// POST /  -> add expense
router.post('/', async (req, res) => {
  const data = parse(createSchema, req.body, res);
  if (!data) return;
  const group = req.group;

  // Double-click / retry protection.
  if (data.clientRequestId) {
    const dup = await Expense.findOne({ groupId: group._id, clientRequestId: data.clientRequestId }).lean();
    if (dup) return res.json({ expense: decorate(dup, group), duplicate: true });
  }

  const paidBy = data.paidBy ?? String(req.user._id);
  if (!data.participants && data.splitType !== 'equal') {
    return res.status(400).json({ error: 'Choose who is in the split and their values' });
  }
  const participants = data.participants ?? group.members.map((m) => ({ userId: String(m.userId) }));
  if (!checkMembers(res, group, [paidBy, ...participants.map((p) => p.userId)])) return;

  const splits = trySplit(res, data.splitType, data.amount, participants);
  if (!splits) return;

  const warning = await checkAnomaly(group._id, data.category, data.amount);

  const doc = {
    groupId: group._id,
    paidBy: toId(paidBy),
    description: data.description,
    amount: data.amount,
    currency: group.currency,
    category: data.category,
    date: data.date ?? new Date(),
    splitType: data.splitType,
    splits: splits.map((s) => ({ userId: toId(s.userId), share: s.share })),
    flags: { anomaly: Boolean(warning), reason: warning, confirmedBy: null },
    clientRequestId: data.clientRequestId,
  };

  let expense;
  try {
    // Expense + its ledger entry are saved together or not at all.
    expense = await inTransaction(async (session) => {
      const [created] = await Expense.create([doc], { session });
      await appendEntry(
        {
          groupId: group._id,
          type: 'expense.create',
          refId: created._id,
          actor: req.user._id,
          payload: {
            description: doc.description,
            amount: doc.amount,
            category: doc.category,
            paidBy: doc.paidBy,
            splitType: doc.splitType,
            splits: plainSplits(doc.splits),
            date: doc.date,
          },
        },
        session
      );
      return created;
    });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.clientRequestId) {
      const dup = await Expense.findOne({ groupId: group._id, clientRequestId: data.clientRequestId }).lean();
      return res.json({ expense: decorate(dup, group), duplicate: true });
    }
    throw err;
  }

  res.status(201).json({ expense: decorate(expense.toObject(), group), warning });
});

// POST /import  -> bulk add from CSV text (insertMany). Equal splits only.
// Columns: description,amount,paid_by  (+ optional: date,category,participants)
// amount is in RUPEES here, paid_by / participants are member names (participants separated by ;)
router.post('/import', async (req, res) => {
  const data = parse(importSchema, req.body, res);
  if (!data) return;
  const group = req.group;

  const table = parseCsv(data.csv);
  if (table.length < 2) return res.status(400).json({ error: 'CSV needs a header row and at least one data row' });
  if (table.length - 1 > 200) return res.status(400).json({ error: 'At most 200 rows per import' });

  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  for (const required of ['description', 'amount', 'paid_by']) {
    if (col(required) === -1) return res.status(400).json({ error: `CSV is missing the "${required}" column` });
  }

  // name -> member id (names that appear twice are ambiguous)
  const byName = new Map();
  const dupNames = new Set();
  for (const m of group.members) {
    const key = m.name.trim().toLowerCase();
    if (byName.has(key)) dupNames.add(key);
    byName.set(key, String(m.userId));
  }
  const lookup = (name) => {
    const key = name.trim().toLowerCase();
    if (dupNames.has(key)) return { error: `"${name}" matches more than one member` };
    return byName.has(key) ? { id: byName.get(key) } : { error: `"${name}" is not a member` };
  };

  const errors = [];
  const docs = [];
  table.slice(1).forEach((cells, idx) => {
    const rowNo = idx + 2;
    const get = (name) => (col(name) === -1 ? '' : (cells[col(name)] ?? '').trim());
    const fail = (msg) => errors.push(`Row ${rowNo}: ${msg}`);

    const amountText = get('amount');
    if (!/^\d+(\.\d{1,2})?$/.test(amountText)) return fail('amount must be a number like 450 or 450.50');
    const amount = Math.round(parseFloat(amountText) * 100);
    if (amount < 1 || amount > 10_000_000_000) return fail('amount is out of range');

    const payer = lookup(get('paid_by'));
    if (payer.error) return fail(payer.error);

    const category = get('category').toLowerCase() || 'other';
    if (!CATEGORIES.includes(category)) return fail(`category "${category}" is not valid`);

    let date = new Date();
    if (get('date')) {
      date = new Date(get('date'));
      if (Number.isNaN(date.getTime())) return fail('date must look like 2026-10-02');
    }

    let ids = group.members.map((m) => String(m.userId));
    if (get('participants')) {
      ids = [];
      for (const name of get('participants').split(/[;|]/).filter((n) => n.trim())) {
        const found = lookup(name);
        if (found.error) return fail(found.error);
        ids.push(found.id);
      }
    }

    let splits;
    try {
      splits = computeSplits('equal', amount, ids.map((userId) => ({ userId })));
    } catch (err) {
      return fail(err.message);
    }

    docs.push({
      groupId: group._id,
      paidBy: toId(payer.id),
      description: get('description').slice(0, 120),
      amount,
      currency: group.currency,
      category,
      date,
      splitType: 'equal',
      splits: splits.map((s) => ({ userId: toId(s.userId), share: s.share })),
      flags: { anomaly: false, reason: null, confirmedBy: null },
    });
  });

  // All-or-nothing: if any row is bad, nothing is saved.
  if (errors.length) return res.status(400).json({ error: 'Fix these rows and try again', rows: errors.slice(0, 20) });

  const imported = await inTransaction(async (session) => {
    const created = await Expense.insertMany(docs, { session });
    for (const e of created) {
      await appendEntry(
        {
          groupId: group._id,
          type: 'expense.create',
          refId: e._id,
          actor: req.user._id,
          payload: {
            description: e.description,
            amount: e.amount,
            category: e.category,
            paidBy: e.paidBy,
            splitType: e.splitType,
            splits: plainSplits(e.splits),
            date: e.date,
            imported: true,
          },
        },
        session
      );
    }
    return created.length;
  });

  res.status(201).json({ imported });
});

// PATCH /anomalies/confirm  (admin) -> mark every flagged expense as checked (updateMany)
router.patch('/anomalies/confirm', requireAdmin, async (req, res) => {
  const confirmed = await inTransaction(async (session) => {
    const result = await Expense.updateMany(
      { groupId: req.group._id, isDeleted: false, 'flags.anomaly': true, 'flags.confirmedBy': null },
      { $set: { 'flags.confirmedBy': req.user._id } },
      { session }
    );
    if (result.modifiedCount) {
      await appendEntry(
        {
          groupId: req.group._id,
          type: 'expense.update',
          refId: req.group._id,
          actor: req.user._id,
          payload: { anomaliesConfirmed: result.modifiedCount },
        },
        session
      );
    }
    return result.modifiedCount;
  });
  res.json({ confirmed });
});

// GET /:eid
router.get('/:eid', async (req, res) => {
  const expense = await loadExpense(req, res);
  if (expense) res.json({ expense: decorate(expense, req.group) });
});

// PATCH /:eid  -> edit (any member can; every change is kept in history + ledger)
router.patch('/:eid', async (req, res) => {
  const existing = await loadExpense(req, res);
  if (!existing) return;
  const data = parse(patchSchema, req.body, res);
  if (!data) return;
  const group = req.group;

  const next = {
    description: data.description ?? existing.description,
    amount: data.amount ?? existing.amount,
    category: data.category ?? existing.category,
    date: data.date ?? existing.date,
    paidBy: data.paidBy ? toId(data.paidBy) : existing.paidBy,
    splitType: data.splitType ?? existing.splitType,
    splits: existing.splits,
  };

  const recompute =
    (data.amount !== undefined && data.amount !== existing.amount) ||
    data.splitType !== undefined ||
    data.participants !== undefined;

  if (recompute) {
    let participants = data.participants;
    if (!participants) {
      if (next.splitType !== 'equal') {
        return res.status(400).json({ error: 'Send participants again when changing the amount or type of a non-equal split' });
      }
      participants = existing.splits.map((s) => ({ userId: String(s.userId) }));
    }
    if (!checkMembers(res, group, [String(next.paidBy), ...participants.map((p) => p.userId)])) return;
    const splits = trySplit(res, next.splitType, next.amount, participants);
    if (!splits) return;
    next.splits = splits.map((s) => ({ userId: toId(s.userId), share: s.share }));
  } else if (data.paidBy && !checkMembers(res, group, [data.paidBy])) {
    return;
  }

  // What actually changed (old -> new)?
  const changes = {};
  for (const key of ['description', 'amount', 'category', 'date', 'paidBy', 'splitType']) {
    if (!same(existing[key], next[key])) changes[key] = [existing[key], next[key]];
  }
  if (!same(plainSplits(existing.splits), plainSplits(next.splits))) {
    changes.splits = [plainSplits(existing.splits), plainSplits(next.splits)];
  }
  if (!Object.keys(changes).length) return res.json({ expense: decorate(existing, group), unchanged: true });

  const set = {};
  for (const key of Object.keys(changes)) set[key] = next[key];

  // Re-run the anomaly check only if amount or category changed.
  if (changes.amount || changes.category) {
    const warning = await checkAnomaly(group._id, next.category, next.amount, existing._id);
    set['flags.anomaly'] = Boolean(warning);
    set['flags.reason'] = warning;
    set['flags.confirmedBy'] = null;
  }

  const updated = await inTransaction(async (session) => {
    const doc = await Expense.findOneAndUpdate(
      { _id: existing._id, groupId: group._id, isDeleted: false },
      {
        $set: set,
        $push: { history: { $each: [{ at: new Date(), by: req.user._id, changes }], $slice: -20 } },
      },
      { new: true, session }
    ).lean();
    if (!doc) return null;
    await appendEntry(
      { groupId: group._id, type: 'expense.update', refId: doc._id, actor: req.user._id, payload: { changes } },
      session
    );
    return doc;
  });

  if (!updated) return res.status(404).json({ error: 'Expense not found' });
  res.json({ expense: decorate(updated, group) });
});

// PATCH /:eid/confirm-anomaly  -> "yes, this amount is correct"
router.patch('/:eid/confirm-anomaly', async (req, res) => {
  const existing = await loadExpense(req, res);
  if (!existing) return;
  if (!existing.flags?.anomaly) return res.status(400).json({ error: 'This expense is not flagged' });

  const updated = await inTransaction(async (session) => {
    const doc = await Expense.findOneAndUpdate(
      { _id: existing._id, groupId: req.group._id, isDeleted: false },
      { $set: { 'flags.confirmedBy': req.user._id } },
      { new: true, session }
    ).lean();
    if (!doc) return null;
    await appendEntry(
      {
        groupId: req.group._id,
        type: 'expense.update',
        refId: doc._id,
        actor: req.user._id,
        payload: { anomalyConfirmed: true },
      },
      session
    );
    return doc;
  });

  if (!updated) return res.status(404).json({ error: 'Expense not found' });
  res.json({ expense: decorate(updated, req.group) });
});

// DELETE /:eid  -> soft delete (stays in the database for the ledger/history)
router.delete('/:eid', async (req, res) => {
  const existing = await loadExpense(req, res);
  if (!existing) return;

  const ok = await inTransaction(async (session) => {
    const doc = await Expense.findOneAndUpdate(
      { _id: existing._id, groupId: req.group._id, isDeleted: false },
      {
        $set: { isDeleted: true },
        $push: { history: { $each: [{ at: new Date(), by: req.user._id, changes: { isDeleted: [false, true] } }], $slice: -20 } },
      },
      { new: true, session }
    ).lean();
    if (!doc) return false;
    await appendEntry(
      {
        groupId: req.group._id,
        type: 'expense.delete',
        refId: doc._id,
        actor: req.user._id,
        payload: { description: doc.description, amount: doc.amount },
      },
      session
    );
    return true;
  });

  if (!ok) return res.status(404).json({ error: 'Expense not found' });
  res.json({ ok: true });
});

export default router;
