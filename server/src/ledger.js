import crypto from 'crypto';
import mongoose from 'mongoose';
import { Router } from 'express';
import { LedgerEntry } from './models.js';
import { requireAuth, requireMember } from './auth.js';

// =====================================================================
// Tamper-evident ledger (smart feature S5)
// Every change in a group is appended as an entry. Each entry stores the
// hash of the previous entry, so editing or deleting an old entry in the
// database breaks the chain and /verify will point to the exact entry.
// =====================================================================

export const GENESIS = '0'.repeat(64);

// JSON with sorted keys, so the same data always gives the same hash.
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

// ObjectIds and Dates become plain strings first (same on write and on verify).
const canonical = (payload) => stable(JSON.parse(JSON.stringify(payload ?? {})));

export const computeHash = ({ prevHash, seq, type, refId, payload, ts }) =>
  crypto
    .createHash('sha256')
    .update([prevHash, seq, type, refId ? String(refId) : '', canonical(payload), new Date(ts).toISOString()].join('|'))
    .digest('hex');

// Adds the next entry to a group's chain. Call it INSIDE inTransaction()
// so the change and its ledger entry are saved together or not at all.
export async function appendEntry({ groupId, type, refId, actor, payload = {} }, session) {
  const last = await LedgerEntry.findOne({ groupId }).sort({ seq: -1 }).session(session).lean();
  const seq = last ? last.seq + 1 : 1;
  const prevHash = last ? last.hash : GENESIS;
  const ts = new Date();
  const hash = computeHash({ prevHash, seq, type, refId, payload, ts });

  await LedgerEntry.create([{ groupId, seq, type, refId, actor, payload, prevHash, hash, ts }], { session });
}

// Runs work(session) as a MongoDB multi-document transaction.
// If two requests grab the same ledger seq at once, the unique index
// rejects one and we simply retry it.
export async function inTransaction(work) {
  let result;
  for (let attempt = 1; ; attempt++) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result;
    } catch (err) {
      if (err?.keyPattern?.seq && attempt < 3) continue;
      throw err;
    } finally {
      await session.endSession();
    }
  }
}

// Walks the whole chain and reports the first broken entry (if any).
export async function verifyChain(groupId) {
  let expectedSeq = 1;
  let prevHash = GENESIS;
  let count = 0;

  const cursor = LedgerEntry.find({ groupId }).sort({ seq: 1 }).lean().cursor();
  for await (const entry of cursor) {
    count++;
    if (entry.seq !== expectedSeq) {
      return { valid: false, count, brokenAt: expectedSeq, reason: `Entry #${expectedSeq} is missing (found #${entry.seq} instead)` };
    }
    if (entry.prevHash !== prevHash) {
      return { valid: false, count, brokenAt: entry.seq, reason: 'Link to the previous entry does not match' };
    }
    if (computeHash(entry) !== entry.hash) {
      return { valid: false, count, brokenAt: entry.seq, reason: 'Entry contents were changed after it was recorded' };
    }
    prevHash = entry.hash;
    expectedSeq++;
  }
  return { valid: true, count, brokenAt: null, reason: null };
}

// ================= routes: /api/groups/:groupId/ledger =================

export const ledgerRouter = Router({ mergeParams: true });
ledgerRouter.use(requireAuth, requireMember);

// GET /  -> newest first. Optional ?limit=50&beforeSeq=120 for paging.
ledgerRouter.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const beforeSeq = Number(req.query.beforeSeq);
  const filter = { groupId: req.group._id };
  if (Number.isFinite(beforeSeq)) filter.seq = { $lt: beforeSeq };

  const entries = await LedgerEntry.find(filter).sort({ seq: -1 }).limit(limit).lean();
  res.json({ entries });
});

// GET /verify  -> is the chain intact?
ledgerRouter.get('/verify', async (req, res) => {
  res.json(await verifyChain(req.group._id));
});
