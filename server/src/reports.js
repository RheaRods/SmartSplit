import { Router } from 'express';
import { Expense } from './models.js';
import { requireAuth, requireMember } from './auth.js';
import { rupees } from './splitEngine.js';

// =====================================================================
// REPORTS  (mounted at /api/groups/:groupId/reports)
//
//   R1  GET /balances           who owes whom (net balance per member)
//   R2  GET /monthly-category   spend per month per category
//   R3  GET /paid-vs-consumed   what each person paid vs their share
//   R4  GET /top-expenses       5 biggest expenses + most frequent categories
//   R5  GET /burn-rate          cumulative daily spend (+ trip budget forecast)
//       GET /summary            dashboard numbers ($facet + $bucket)
//
// Optional filters for R2-R5 and summary:  ?month=2026-10  or  ?from=2026-10-01&to=2026-10-31
// Add ?format=csv to download any report as CSV.
// All amounts are WHOLE PAISE unless a field name says otherwise.
// =====================================================================

const TZ = 'Asia/Kolkata';
const IST = '+05:30';

// ---------------- helpers ----------------

// ?month=YYYY-MM  or  ?from=YYYY-MM-DD&to=YYYY-MM-DD  ->  { date: { $gte, $lt } } (in IST)
function dateFilter(req) {
  const q = (k) => (typeof req.query[k] === 'string' ? req.query[k].trim() : undefined);
  const valid = (d) => !Number.isNaN(d.getTime());
  let gte;
  let lt;

  const month = q('month');
  if (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    gte = new Date(`${month}-01T00:00:00${IST}`);
    lt = new Date(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00${IST}`);
  } else {
    const from = q('from');
    const to = q('to');
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) gte = new Date(`${from}T00:00:00${IST}`);
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      const end = new Date(`${to}T00:00:00${IST}`);
      if (valid(end)) lt = new Date(end.getTime() + 24 * 60 * 60 * 1000); // "to" includes the whole day
    }
  }

  const date = {};
  if (gte && valid(gte)) date.$gte = gte;
  if (lt && valid(lt)) date.$lt = lt;
  return Object.keys(date).length ? { date } : {};
}

const activeMatch = (req) => ({ groupId: req.group._id, isDeleted: false, ...dateFilter(req) });

// CSV cell with protection against spreadsheet formula injection (=, +, -, @).
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Sends JSON, or a CSV download when ?format=csv.
// csv = { name, columns: [{ key, label, money? }], rows }   (money columns are paise -> rupees)
function reply(req, res, json, csv) {
  if (req.query.format === 'csv' && csv) {
    const lines = [csv.columns.map((c) => csvCell(c.label)).join(',')];
    for (const row of csv.rows) {
      lines.push(csv.columns.map((c) => csvCell(c.money ? rupees(row[c.key] ?? 0) : row[c.key])).join(','));
    }
    res
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${csv.name}.csv"`)
      .send(`\ufeff${lines.join('\r\n')}`);
    return;
  }
  res.json(json);
}

// ---------------- R1: balances ----------------
// Each paid expense adds +amount to the payer, each split subtracts -share from the
// person who consumed it, confirmed settlements move money from sender to receiver.
// Everything is unioned into (user, amt) rows and summed per user. The total is always 0.
const balancesPipeline = (groupId) => [
  { $match: { groupId, isDeleted: false } },
  { $project: { _id: 0, user: '$paidBy', amt: '$amount' } },
  {
    $unionWith: {
      coll: 'expenses',
      pipeline: [
        { $match: { groupId, isDeleted: false } },
        { $unwind: '$splits' },
        { $project: { _id: 0, user: '$splits.userId', amt: { $multiply: ['$splits.share', -1] } } },
      ],
    },
  },
  {
    $unionWith: {
      coll: 'settlements',
      pipeline: [
        { $match: { groupId, status: 'confirmed' } },
        {
          $project: {
            _id: 0,
            rows: [
              { user: '$from', amt: '$amount' },
              { user: '$to', amt: { $multiply: ['$amount', -1] } },
            ],
          },
        },
        { $unwind: '$rows' },
        { $replaceRoot: { newRoot: '$rows' } },
      ],
    },
  },
  { $group: { _id: '$user', net: { $sum: '$amt' } } },
  { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
  {
    $project: {
      _id: 0,
      userId: '$_id',
      name: { $ifNull: [{ $arrayElemAt: ['$u.name', 0] }, 'Former member'] },
      net: 1,
    },
  },
  { $sort: { net: -1 } },
];

// ---------------- R3: paid vs consumed ----------------
const paidVsConsumedPipeline = (match) => [
  { $match: match },
  { $project: { _id: 0, user: '$paidBy', paid: '$amount', consumed: { $literal: 0 } } },
  {
    $unionWith: {
      coll: 'expenses',
      pipeline: [
        { $match: match },
        { $unwind: '$splits' },
        { $project: { _id: 0, user: '$splits.userId', paid: { $literal: 0 }, consumed: '$splits.share' } },
      ],
    },
  },
  { $group: { _id: '$user', paid: { $sum: '$paid' }, consumed: { $sum: '$consumed' } } },
  { $addFields: { net: { $subtract: ['$paid', '$consumed'] } } },
  { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
  {
    $project: {
      _id: 0,
      userId: '$_id',
      name: { $ifNull: [{ $arrayElemAt: ['$u.name', 0] }, 'Former member'] },
      paid: 1,
      consumed: 1,
      net: 1,
    },
  },
  { $sort: { net: 1 } },
];

// Makes sure every current member appears (members with no activity get zeros).
function withMembers(rows, group, zero) {
  const byId = new Map(rows.map((r) => [String(r.userId), r]));
  const isMember = (id) => group.members.some((m) => String(m.userId) === String(id));
  const out = group.members.map((m) => {
    const r = byId.get(String(m.userId));
    return r ? { ...r, name: r.name === 'Former member' ? m.name : r.name } : { userId: m.userId, name: m.name, ...zero };
  });
  for (const r of rows) if (!isMember(r.userId) && r.net !== 0) out.push(r);
  return out;
}

// Shared with settlements.js (settle plan) and groups.js-style checks.
export async function getBalances(group) {
  const rows = await Expense.aggregate(balancesPipeline(group._id));
  return withMembers(rows, group, { net: 0 }).sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
}

// Shared with settlements.js (who should pay next). Expenses only, all time.
export async function getPaidVsConsumed(group, match) {
  const rows = await Expense.aggregate(paidVsConsumedPipeline(match ?? { groupId: group._id, isDeleted: false }));
  return withMembers(rows, group, { paid: 0, consumed: 0, net: 0 });
}

// ---------------- R5 helpers: trip budget forecast ----------------
const istDay = (d) => new Date(d.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
const dayNum = (s) => Math.floor(Date.parse(`${s}T00:00:00Z`) / 86400000);
const addDays = (s, n) => new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10);

function tripForecast(group, days) {
  const tb = group.tripBudget;
  if (!tb?.totalPaise || !tb.startDate || !tb.endDate) return null;

  const start = istDay(new Date(tb.startDate));
  const end = istDay(new Date(tb.endDate));
  const today = istDay(new Date());
  const tripDays = dayNum(end) - dayNum(start) + 1;
  const budget = tb.totalPaise;
  const spent = days.filter((d) => d.day >= start && d.day <= end).reduce((s, d) => s + d.daily, 0);

  const base = { budgetPaise: budget, spentPaise: spent, tripDays, startDay: start, endDay: end };
  if (today < start) return { ...base, started: false, message: `Trip starts on ${start}` };

  const elapsed = Math.min(Math.max(dayNum(today) - dayNum(start) + 1, 1), tripDays);
  const avgDaily = Math.round(spent / elapsed);
  const projected = avgDaily * tripDays;
  const out = { ...base, started: true, daysElapsed: elapsed, avgDailyPaise: avgDaily, projectedTotalPaise: projected };

  if (spent >= budget) {
    return { ...out, willExceed: true, exhaustionDay: null, message: `Budget of ₹${rupees(budget)} is already used up` };
  }
  const crossDayNo = avgDaily > 0 ? Math.floor(budget / avgDaily) + 1 : Infinity;
  if (crossDayNo <= tripDays) {
    return {
      ...out,
      willExceed: true,
      exhaustionDay: addDays(start, crossDayNo - 1),
      message: `At this pace you'll cross the budget on Day ${crossDayNo} (${addDays(start, crossDayNo - 1)})`,
    };
  }
  return {
    ...out,
    willExceed: false,
    exhaustionDay: null,
    message: `On track: projected ₹${rupees(projected)} of ₹${rupees(budget)}`,
  };
}

// =====================================================================
export const reportsRouter = Router({ mergeParams: true });
reportsRouter.use(requireAuth, requireMember);

// R1 - GET /balances  (all-time, ignores date filters)
reportsRouter.get('/balances', async (req, res) => {
  const balances = await getBalances(req.group);
  const total = balances.reduce((s, b) => s + b.net, 0); // must be 0
  reply(req, res, { balances, total }, {
    name: 'balances',
    columns: [
      { key: 'name', label: 'Member' },
      { key: 'net', label: 'Net balance (INR, + is owed money)', money: true },
    ],
    rows: balances,
  });
});

// R2 - GET /monthly-category
reportsRouter.get('/monthly-category', async (req, res) => {
  const rows = await Expense.aggregate([
    { $match: activeMatch(req) },
    {
      $group: {
        _id: { month: { $dateToString: { format: '%Y-%m', date: '$date', timezone: TZ } }, category: '$category' },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.month': 1, total: -1 } },
    { $project: { _id: 0, month: '$_id.month', category: '$_id.category', total: 1, count: 1 } },
  ]);
  reply(req, res, { rows }, {
    name: 'monthly-category',
    columns: [
      { key: 'month', label: 'Month' },
      { key: 'category', label: 'Category' },
      { key: 'total', label: 'Total (INR)', money: true },
      { key: 'count', label: 'Expenses' },
    ],
    rows,
  });
});

// R3 - GET /paid-vs-consumed
reportsRouter.get('/paid-vs-consumed', async (req, res) => {
  const members = await getPaidVsConsumed(req.group, activeMatch(req));
  members.sort((a, b) => a.net - b.net);
  reply(req, res, { members }, {
    name: 'paid-vs-consumed',
    columns: [
      { key: 'name', label: 'Member' },
      { key: 'paid', label: 'Paid (INR)', money: true },
      { key: 'consumed', label: 'Share consumed (INR)', money: true },
      { key: 'net', label: 'Paid minus share (INR)', money: true },
    ],
    rows: members,
  });
});

// R4 - GET /top-expenses
reportsRouter.get('/top-expenses', async (req, res) => {
  const match = activeMatch(req);
  const [top, freq] = await Promise.all([
    Expense.aggregate([
      { $match: match },
      { $sort: { amount: -1, _id: 1 } },
      { $limit: 5 },
      { $lookup: { from: 'users', localField: 'paidBy', foreignField: '_id', as: 'p' } },
      {
        $project: {
          description: 1,
          amount: 1,
          category: 1,
          date: 1,
          paidByName: { $ifNull: [{ $arrayElemAt: ['$p.name', 0] }, 'Former member'] },
        },
      },
    ]),
    Expense.aggregate([{ $match: match }, { $sortByCount: '$category' }]),
  ]);

  const categories = freq.map((f) => ({ category: f._id, count: f.count }));
  reply(req, res, { top, categories }, {
    name: 'top-expenses',
    columns: [
      { key: 'description', label: 'Description' },
      { key: 'amount', label: 'Amount (INR)', money: true },
      { key: 'category', label: 'Category' },
      { key: 'date', label: 'Date' },
      { key: 'paidByName', label: 'Paid by' },
    ],
    rows: top,
  });
});

// R5 - GET /burn-rate
reportsRouter.get('/burn-rate', async (req, res) => {
  const days = await Expense.aggregate([
    { $match: activeMatch(req) },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: TZ } },
        daily: { $sum: '$amount' },
      },
    },
    {
      $setWindowFields: {
        sortBy: { _id: 1 },
        output: { cumulative: { $sum: '$daily', window: { documents: ['unbounded', 'current'] } } },
      },
    },
    { $project: { _id: 0, day: '$_id', daily: 1, cumulative: 1 } },
  ]);

  reply(req, res, { days, forecast: tripForecast(req.group, days) }, {
    name: 'burn-rate',
    columns: [
      { key: 'day', label: 'Day' },
      { key: 'daily', label: 'Spent that day (INR)', money: true },
      { key: 'cumulative', label: 'Cumulative (INR)', money: true },
    ],
    rows: days,
  });
});

// Dashboard - GET /summary  ($facet runs 4 sub-pipelines in one pass, $bucket groups by size)
const BUCKET_LABELS = {
  0: 'Under ₹500',
  50000: '₹500 - ₹2,000',
  200000: '₹2,000 - ₹5,000',
  500000: '₹5,000 - ₹20,000',
  above: '₹20,000 and above',
};

reportsRouter.get('/summary', async (req, res) => {
  const [facet] = await Expense.aggregate([
    { $match: activeMatch(req) },
    {
      $facet: {
        totals: [{ $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 }, avg: { $avg: '$amount' } } }],
        topCategory: [
          { $group: { _id: '$category', total: { $sum: '$amount' } } },
          { $sort: { total: -1 } },
          { $limit: 1 },
        ],
        sizeBuckets: [
          {
            $bucket: {
              groupBy: '$amount',
              boundaries: [0, 50000, 200000, 500000, 2000000],
              default: 'above',
              output: { count: { $sum: 1 }, total: { $sum: '$amount' } },
            },
          },
        ],
        flagged: [{ $match: { 'flags.anomaly': true, 'flags.confirmedBy': null } }, { $count: 'n' }],
      },
    },
  ]);

  const totals = facet?.totals?.[0] ?? { total: 0, count: 0, avg: 0 };
  const top = facet?.topCategory?.[0];
  const balances = await getBalances(req.group);
  const mine = balances.find((b) => String(b.userId) === String(req.user._id));

  res.json({
    totalSpent: totals.total,
    expenseCount: totals.count,
    averageExpense: Math.round(totals.avg ?? 0),
    topCategory: top ? { category: top._id, total: top.total } : null,
    sizeBuckets: (facet?.sizeBuckets ?? []).map((b) => ({ range: BUCKET_LABELS[b._id] ?? String(b._id), count: b.count, total: b.total })),
    flaggedCount: facet?.flagged?.[0]?.n ?? 0,
    memberCount: req.group.members.length,
    yourNet: mine?.net ?? 0,
  });
});
