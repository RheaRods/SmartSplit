import { Router } from 'express';
import { z } from 'zod';
import { pathToFileURL } from 'url';
import { requireAuth, requireMember } from './auth.js';
import { computeSplits, allocate, rupees, SplitError } from './splitEngine.js';

// =====================================================================
// Smart feature S1: natural-language quick add
//
//   "Dinner 1200 with Aman, Riya, I paid, Aman double"
//
// POST /api/groups/:groupId/expenses/parse   { "text": "..." }
// Returns a PREVIEW only (never saves). If it looks right, the frontend sends
// `payload` to the normal POST /expenses endpoint.
//
// What it understands
//   amount       first number: 1200, 1,200, 1847.50, 1.2k, ₹500, rs 500
//   description  the words before the amount (or after "for")
//   people       member first names, "I"/"me", "everyone". You and the payer are
//                always included unless you say "except".
//   payer        "I paid", "Aman paid", "paid by Aman"  (default: you)
//   uneven       "Aman double", "Aman 2x", "Aman half"  -> shares
//                "Aman 300"                              -> exact amount, rest split equally
//                "Aman 60%, me 40%"                      -> percentages
//   leave out    "except Karan", "without Riya and Karan"
//   date         today (default), yesterday, day before yesterday, "3 days ago"
//   category     guessed from keywords (dinner -> food, uber -> travel, ...)
//
// Run the self-test (no database needed):   node src/quickAdd.js
// =====================================================================

const CATEGORY_KEYWORDS = [
  ['food', ['dinner', 'lunch', 'breakfast', 'brunch', 'pizza', 'burger', 'biryani', 'cafe', 'coffee', 'tea', 'snack', 'drink', 'restaurant', 'meal', 'swiggy', 'zomato', 'takeout', 'thali', 'momo', 'food', 'beer', 'ice']],
  ['groceries', ['grocery', 'groceries', 'vegetable', 'fruit', 'milk', 'supermarket', 'bigbasket', 'blinkit', 'zepto', 'staple']],
  ['travel', ['uber', 'ola', 'cab', 'taxi', 'auto', 'petrol', 'fuel', 'diesel', 'train', 'flight', 'bus', 'metro', 'toll', 'scooter', 'bike', 'ferry', 'parking']],
  ['rent', ['rent', 'deposit']],
  ['utilities', ['wifi', 'internet', 'broadband', 'electricity', 'recharge', 'gas', 'cylinder', 'utility', 'maintenance']],
  ['fun', ['movie', 'cinema', 'concert', 'party', 'bowling', 'game', 'netflix', 'club', 'trek', 'arcade', 'show', 'sports', 'kayaking', 'parasailing']],
];

const PAY_WORDS = new Set(['paid', 'pays', 'covered', 'treated']);
const EXCEPT_WORDS = new Set(['except', 'without', 'excluding', 'minus', 'but']);
const WITH_WORDS = new Set(['with', 'between', 'among']);
const GROUP_WORDS = new Set(['everyone', 'everybody', 'friends', 'team', 'roommates', 'flatmates', 'guys', 'folks', 'family', 'colleagues', 'group']);
const ME_WORDS = new Set(['i', 'me', 'my', 'myself']);
const MODS = new Set(['double', 'twice', 'triple', 'half']);
const FILL = new Set(['and', '&', 'the', 'a', 'an', 'to', 'of', 'also', 'plus', 'tonight', 'morning', 'afternoon', 'evening', 'night']);
const REGION_END = new Set([...PAY_WORDS, ...EXCEPT_WORDS, 'for', 'on', 'at', 'split', 'equally', 'equal', 'evenly', 'each']);
const DESC_TRIM = new Set(['for', 'on', 'at', 'the', 'a', 'an', 'and', 'with', 'of', 'to', '&']);

const addDays = (day, n) => new Date((Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000) + n) * 86400000).toISOString().slice(0, 10);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// members: [{ _id, name }]   meId: the person typing   today: 'YYYY-MM-DD' (IST)
export function parseSentence(input, { members, meId, today }) {
  const notes = [];
  const fail = (msg) => ({ ok: false, errors: [msg], notes, preview: null, payload: null });
  const names = members.map((m) => m.name).join(', ');

  let text = String(input ?? '').trim().slice(0, 300);
  if (!text) return fail('Type something like "Dinner 1200 with Aman, Riya, I paid"');

  const me = members.find((m) => String(m._id) === String(meId));
  if (!me) return fail('You are not a member of this group');

  // ---- 1. date words (removed from the text once read) ----
  let dateStr = null;
  let dateLabel = 'today';
  const dateRules = [
    { re: /\bday before yesterday\b/i, off: () => -2, label: () => 'day before yesterday' },
    { re: /\byesterday\b/i, off: () => -1, label: () => 'yesterday' },
    { re: /\b(\d{1,3})\s+days?\s+ago\b/i, off: (m) => -Number(m[1]), label: (m) => `${m[1]} days ago` },
    { re: /\btoday\b/i, off: () => 0, label: () => 'today' },
  ];
  for (const rule of dateRules) {
    const m = text.match(rule.re);
    if (!m) continue;
    const off = rule.off(m);
    if (off < -365) return fail('That date is too far back');
    text = text.replace(rule.re, ' ');
    if (off < 0) {
      dateStr = addDays(today, off);
      dateLabel = rule.label(m);
    }
    break;
  }

  // ---- 2. tidy money formats ----
  text = text
    .replace(/(\d),(?=\d{3}\b)/g, '$1') // 1,200 -> 1200
    .replace(/(?:₹|\brs\.?|\binr)\s*(?=\d)/gi, '') // ₹1200, rs 500, inr 300
    .replace(/(\d)\s*(?:rupees?|rs\.?|inr|\/-)(?![a-z])/gi, '$1'); // 500 rupees, 500/-

  // ---- 3. tokens ----
  const orig = text
    .split(/[\s,;]+/)
    .map((t) => t.replace(/^[("']+|[)"'.!?:]+$/g, ''))
    .filter(Boolean);
  const low = orig.map((t) => t.toLowerCase());
  const n = orig.length;

  const first = (m) => m.name.trim().split(/\s+/)[0].toLowerCase();
  const nameMap = new Map();
  const ambiguous = new Set();
  for (const m of members) {
    const k = first(m);
    if (nameMap.has(k)) ambiguous.add(k);
    nameMap.set(k, m);
  }
  const memberOf = (t) => (ME_WORDS.has(t) ? me : nameMap.get(t));

  const dup = low.find((t) => ambiguous.has(t));
  if (dup) return fail(`"${dup}" matches more than one member of this group`);

  const kind = low.map((t) =>
    /^\d+(\.\d+)?k?$/.test(t) ? 'num' : /^\d+(\.\d+)?%$/.test(t) ? 'pct' : /^\d+(\.\d+)?x$/.test(t) ? 'mult' : memberOf(t) ? 'name' : 'word'
  );
  const consumed = new Array(n).fill(false);
  const val = (t) => parseFloat(t) * (t.endsWith('k') ? 1000 : 1);

  // ---- 4. amount: the first plain number that is not "<name> <number>" ----
  const amountIdx = kind.findIndex((k, i) => k === 'num' && kind[i - 1] !== 'name');
  if (amountIdx === -1) return fail('I could not find an amount. Try "Dinner 1200 with Aman"');
  const amount = Math.round(val(low[amountIdx]) * 100);
  if (!Number.isFinite(amount) || amount < 1 || amount > 10_000_000_000) return fail('That amount is out of range');
  consumed[amountIdx] = true;

  // ---- 5. who paid ----
  let payer = null;
  const knownWords = new Set(CATEGORY_KEYWORDS.flatMap(([, words]) => words));
  for (let i = 0; i < n; i++) {
    if (!PAY_WORDS.has(low[i])) continue;
    consumed[i] = true;
    let who = null;
    if (low[i + 1] === 'by') {
      consumed[i + 1] = true;
      if (kind[i + 2] === 'name') {
        who = memberOf(low[i + 2]);
        consumed[i + 2] = true;
      } else if (i + 2 < n && kind[i + 2] === 'word') {
        return fail(`I don't know "${orig[i + 2]}" in this group. Members: ${names}`);
      }
    } else if (i > 0 && kind[i - 1] === 'name' && !consumed[i - 1]) {
      who = memberOf(low[i - 1]);
      consumed[i - 1] = true;
    } else if (i > 0 && kind[i - 1] === 'word' && /^[A-Z]/.test(orig[i - 1]) && !knownWords.has(low[i - 1]) && !FILL.has(low[i - 1])) {
      return fail(`I don't know "${orig[i - 1]}" in this group. Members: ${names}`);
    }
    if (who) {
      if (payer && payer !== who) return fail('Only one person can be the payer in a quick add');
      payer = who;
    }
  }

  // ---- 6. "except ...", "everyone" ----
  const excluded = new Set();
  let all = false;
  let excluding = false;
  for (let i = 0; i < n; i++) {
    if (consumed[i]) continue;
    const w = low[i];
    if (EXCEPT_WORDS.has(w)) {
      consumed[i] = true;
      excluding = true;
      continue;
    }
    if (excluding) {
      if (kind[i] === 'name') {
        excluded.add(memberOf(w));
        consumed[i] = true;
        continue;
      }
      if (w === 'and' || w === '&') {
        consumed[i] = true;
        continue;
      }
      excluding = false;
    }
    if (GROUP_WORDS.has(w) || ((w === 'all' || w === 'us') && ['with', 'between', 'among', 'for', 'split'].includes(low[i - 1]))) {
      all = true;
      consumed[i] = true;
    }
  }

  // ---- 7. catch names we do not know (typos) after "with" ----
  for (let i = 0; i < n; i++) {
    if (!WITH_WORDS.has(low[i]) || consumed[i]) continue;
    consumed[i] = true;
    for (let j = i + 1; j < n; j++) {
      if (consumed[j]) continue;
      if (REGION_END.has(low[j])) break;
      if (kind[j] === 'word' && !FILL.has(low[j]) && !MODS.has(low[j])) {
        return fail(`I don't know "${orig[j]}" in this group. Members: ${names}`);
      }
    }
  }

  // ---- 8. people + their modifiers ----
  const entries = new Map();
  for (let i = 0; i < n; i++) {
    if (consumed[i] || kind[i] !== 'name') continue;
    const m = memberOf(low[i]);
    const e = entries.get(String(m._id)) ?? { member: m };
    consumed[i] = true;
    if (i + 1 < n && !consumed[i + 1]) {
      const nxt = low[i + 1];
      const nk = kind[i + 1];
      const take = () => {
        consumed[i + 1] = true;
      };
      if (nxt === 'double' || nxt === 'twice') (e.weight = 2), take();
      else if (nxt === 'triple') (e.weight = 3), take();
      else if (nxt === 'half') (e.weight = 0.5), take();
      else if (nk === 'mult') (e.weight = parseFloat(nxt)), take();
      else if (nk === 'num') (e.exact = Math.round(val(nxt) * 100)), take();
      else if (nk === 'pct') (e.pct = parseFloat(nxt)), take();
    }
    entries.set(String(m._id), e);
  }

  // ---- 9. who is in the split ----
  const payerMember = payer ?? me;
  let base;
  if (all) {
    base = members.map((m) => entries.get(String(m._id)) ?? { member: m });
  } else if (entries.size === 0) {
    base = members.map((m) => ({ member: m }));
    if (excluded.size === 0) notes.push('No names given, so this is split between everyone in the group');
  } else {
    const picked = new Map(entries);
    for (const extra of [me, payerMember]) {
      if (!picked.has(String(extra._id)) && !excluded.has(extra)) {
        picked.set(String(extra._id), { member: extra });
        if (extra === me) notes.push('You are included in the split (say "except me" to leave yourself out)');
      }
    }
    base = [...picked.values()];
  }
  base = base.filter((b) => !excluded.has(b.member));
  if (!base.length) return fail('Nobody is left in the split');

  // ---- 10. split style ----
  const anyExact = base.some((b) => b.exact !== undefined);
  const anyPct = base.some((b) => b.pct !== undefined);
  const anyWeight = base.some((b) => b.weight !== undefined && b.weight !== 1);
  if ([anyExact, anyPct, anyWeight].filter(Boolean).length > 1) {
    return fail('Pick one style: exact amounts, percentages, or "double"/"2x". They cannot be mixed');
  }

  let splitType = 'equal';
  let participants = base.map((b) => ({ userId: b.member._id }));

  if (anyExact) {
    splitType = 'exact';
    const given = base.filter((b) => b.exact !== undefined);
    const rest = base.filter((b) => b.exact === undefined);
    const sum = given.reduce((s, b) => s + b.exact, 0);
    const left = amount - sum;
    if (left < 0) return fail(`Those amounts add up to ₹${rupees(sum)}, more than the total ₹${rupees(amount)}`);
    if (rest.length) {
      if (left === 0) return fail(`Those amounts already add up to the total, so there is nothing left for ${rest.map((b) => b.member.name).join(', ')}`);
      const parts = allocate(left, rest.map(() => 1));
      rest.forEach((b, i) => (b.exact = parts[i]));
      notes.push(`The remaining ₹${rupees(left)} is split equally between ${rest.map((b) => b.member.name).join(', ')}`);
    } else if (left !== 0) {
      return fail(`Those amounts add up to ₹${rupees(sum)} but the total is ₹${rupees(amount)}`);
    }
    participants = base.map((b) => ({ userId: b.member._id, value: b.exact }));
  } else if (anyPct) {
    splitType = 'percent';
    const given = base.filter((b) => b.pct !== undefined);
    const rest = base.filter((b) => b.pct === undefined);
    const bps = Math.round(given.reduce((s, b) => s + b.pct, 0) * 100);
    const left = 10000 - bps;
    if (left < 0) return fail('Those percentages add up to more than 100%');
    if (rest.length) {
      if (left === 0) return fail(`Those percentages already add up to 100%, so there is nothing left for ${rest.map((b) => b.member.name).join(', ')}`);
      const parts = allocate(left, rest.map(() => 1));
      rest.forEach((b, i) => (b.pct = parts[i] / 100));
    } else if (left !== 0) {
      return fail(`Those percentages add up to ${bps / 100}%, not 100%`);
    }
    participants = base.map((b) => ({ userId: b.member._id, value: b.pct }));
  } else if (anyWeight) {
    splitType = 'shares';
    participants = base.map((b) => ({ userId: b.member._id, value: b.weight ?? 1 }));
  }

  let splits;
  try {
    splits = computeSplits(splitType, amount, participants);
  } catch (err) {
    if (err instanceof SplitError) return fail(err.message);
    throw err;
  }

  // ---- 11. category ----
  const words = new Set(low.flatMap((t) => [t, t.replace(/s$/, '')]));
  const category = CATEGORY_KEYWORDS.find(([, list]) => list.some((k) => words.has(k)))?.[0] ?? 'other';
  if (category === 'other') notes.push('Could not guess a category, so it is "other"');

  // ---- 12. description ----
  const trim = (arr) => {
    while (arr.length && DESC_TRIM.has(arr[0].low)) arr.shift();
    while (arr.length && DESC_TRIM.has(arr[arr.length - 1].low)) arr.pop();
    return arr;
  };
  let desc = trim(orig.map((o, i) => ({ o, low: low[i], i })).filter((x) => x.i < amountIdx && !consumed[x.i] && kind[x.i] === 'word'));
  if (!desc.length) {
    const after = [];
    for (let i = amountIdx + 1; i < n; i++) {
      if (consumed[i] || kind[i] !== 'word') {
        if (after.length) break;
        continue;
      }
      after.push({ o: orig[i], low: low[i], i });
    }
    desc = trim(after);
  }
  let description = cap(desc.map((x) => x.o).join(' ').slice(0, 120));
  if (!description) {
    description = 'Expense';
    notes.push('No description found, so it is called "Expense"');
  }

  // ---- 13. result ----
  const nameOf = (id) => members.find((m) => String(m._id) === String(id)).name;
  const payload = {
    description,
    amount,
    category,
    paidBy: String(payerMember._id),
    splitType,
    participants: participants.map((p) => ({ userId: String(p.userId), ...(p.value !== undefined && splitType !== 'equal' ? { value: p.value } : {}) })),
    ...(dateStr ? { date: dateStr } : {}),
  };

  return {
    ok: true,
    errors: [],
    notes,
    preview: {
      description,
      amount,
      amountRupees: rupees(amount),
      category,
      date: dateStr ?? today,
      dateLabel,
      paidBy: { userId: String(payerMember._id), name: payerMember.name },
      splitType,
      splits: splits.map((s) => ({
        userId: String(s.userId),
        name: nameOf(s.userId),
        share: s.share,
        value: participants.find((p) => String(p.userId) === String(s.userId))?.value,
      })),
    },
    payload,
  };
}

// ================= route: POST /api/groups/:groupId/expenses/parse =================
export const quickAddRouter = Router({ mergeParams: true });
quickAddRouter.use(requireAuth, requireMember);

const bodySchema = z.object({ text: z.string().max(300) });
const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

quickAddRouter.post('/', (req, res) => {
  const body = bodySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'text is required (max 300 characters)' });

  const members = req.group.members.map((m) => ({ _id: m.userId, name: m.name }));
  res.json(parseSentence(body.data.text, { members, meId: req.user._id, today: istToday() }));
});

// ---------------- self-test (only runs when this file is executed directly) ----------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const members = ['Rhea', 'Aman', 'Riya', 'Karan', 'Meera'].map((name) => ({ _id: name.toLowerCase(), name }));
  const ctx = { members, meId: 'rhea', today: '2026-10-02' };
  let failures = 0;

  const run = (text, expect) => {
    const r = parseSentence(text, ctx);
    let line;
    if (!r.ok) line = `ERROR: ${r.errors[0]}`;
    else {
      const p = r.preview;
      line = `${p.description} | ₹${p.amountRupees} | ${p.category} | ${p.dateLabel} | paid by ${p.paidBy.name} | ${p.splitType}: ${p.splits.map((s) => `${s.name} ${rupees(s.share)}`).join(', ')}`;
    }
    const good = expect(r);
    if (!good) failures++;
    console.log(`${good ? 'PASS' : 'FAIL'}  "${text}"\n      -> ${line}`);
  };
  const shares = (r) => Object.fromEntries((r.preview?.splits ?? []).map((s) => [s.name, s.share]));

  run('Dinner 1200 with Aman, Riya, I paid, Aman double', (r) => r.ok && r.preview.splitType === 'shares' && r.preview.category === 'food' && r.preview.paidBy.name === 'Rhea' && shares(r).Aman === 60000 && shares(r).Riya === 30000 && shares(r).Rhea === 30000);
  run('Uber 450 yesterday with Karan', (r) => r.ok && r.preview.category === 'travel' && r.preview.date === '2026-10-01' && r.preview.splits.length === 2);
  run('Aman paid 900 for movie tickets with Riya', (r) => r.ok && r.preview.paidBy.name === 'Aman' && r.preview.description === 'Movie tickets' && r.preview.category === 'fun' && r.preview.splits.length === 3);
  run('Groceries ₹1,847.50', (r) => r.ok && r.preview.amount === 184750 && r.preview.category === 'groceries' && r.preview.splits.length === 5);
  run('Pizza 800 with Aman 300, Riya', (r) => r.ok && r.preview.splitType === 'exact' && shares(r).Aman === 30000 && shares(r).Riya === 25000 && shares(r).Rhea === 25000);
  run('Rent 36000 everyone except Karan', (r) => r.ok && r.preview.category === 'rent' && r.preview.splits.length === 4 && !shares(r).Karan);
  run('Lunch 1.2k Aman 60%, me 40%', (r) => r.ok && r.preview.splitType === 'percent' && shares(r).Aman === 72000 && shares(r).Rhea === 48000);
  run('Dinner 1200 with Aman 2x and Riya', (r) => r.ok && r.preview.splitType === 'shares' && shares(r).Aman === 60000);
  run('2 days ago petrol 500 I paid', (r) => r.ok && r.preview.date === '2026-09-30' && r.preview.category === 'travel' && r.preview.paidBy.name === 'Rhea');
  run('Movie night 2000 paid by Meera with Karan, Riya', (r) => r.ok && r.preview.paidBy.name === 'Meera' && r.preview.splits.length === 4);
  run('Wifi bill rs 1179 without me', (r) => r.ok && r.preview.category === 'utilities' && !shares(r).Rhea && r.preview.splits.length === 4);
  run('Cab 300 with Amna', (r) => !r.ok && /Amna/.test(r.errors[0]));
  run('Amna paid 500 for lunch', (r) => !r.ok && /Amna/.test(r.errors[0]));
  run('Dinner 1200 Aman 700 Riya 700', (r) => !r.ok && /add up/.test(r.errors[0]));
  run('Dinner 1200 Aman 60% Riya 2x', (r) => !r.ok && /one style/.test(r.errors[0]));
  run('hello there', (r) => !r.ok && /amount/.test(r.errors[0]));
  run('', (r) => !r.ok);

  // The preview must always add up exactly
  let checked = 0;
  for (const amt of [1, 7, 100, 333, 1001, 99999]) {
    const r = parseSentence(`Snacks ${amt} with Aman, Riya, Karan`, ctx);
    if (!r.ok || r.preview.splits.reduce((s, x) => s + x.share, 0) !== r.preview.amount) failures++;
    checked++;
  }
  console.log(`\n${failures ? `${failures} FAILED` : `All checks passed (${checked} sum checks included)`}`);
  process.exitCode = failures ? 1 : 0;
}
