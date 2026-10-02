import { pathToFileURL } from 'url';

// =====================================================================
// Split engine
// Turns "amount + who + how" into exact integer shares (paise) that
// ALWAYS add up to the amount. No floats are ever stored.
//
// Run the self-test (no database needed):   node src/splitEngine.js
// =====================================================================

export class SplitError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export const rupees = (paise) => (paise / 100).toFixed(2);

// Largest-remainder method: splits `amount` in proportion to `weights`
// (non-negative integers) so the shares sum to exactly `amount`.
// Leftover paise go to the people with the biggest fractional remainders
// (ties: the earlier person in the list).
export function allocate(amount, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new SplitError('Nothing to split between');

  const rows = weights.map((w, i) => {
    const exact = amount * w;
    return { i, share: Math.floor(exact / total), rem: exact % total };
  });

  const left = amount - rows.reduce((sum, r) => sum + r.share, 0);
  [...rows]
    .sort((a, b) => b.rem - a.rem || a.i - b.i)
    .slice(0, left)
    .forEach((r) => {
      r.share += 1;
    });

  return rows.map((r) => r.share);
}

// type:         'equal' | 'exact' | 'percent' | 'shares'
// amount:       whole paise
// participants: [{ userId, value }]
//   equal   -> value ignored
//   exact   -> value = that person's amount in paise
//   percent -> value = percentage (up to 2 decimals), must total 100
//   shares  -> value = weight, e.g. 1 and 2 means the second pays double
// Returns [{ userId, share }] (people with a 0 share are left out).
export function computeSplits(type, amount, participants) {
  if (!Number.isInteger(amount) || amount < 1) throw new SplitError('Amount must be whole paise, at least 1');
  if (!participants?.length) throw new SplitError('Pick at least one person to split with');

  const ids = participants.map((p) => String(p.userId));
  if (new Set(ids).size !== ids.length) throw new SplitError('The same person is listed twice');

  let shares;
  switch (type) {
    case 'equal':
      shares = allocate(amount, ids.map(() => 1));
      break;

    case 'exact': {
      const values = participants.map((p) => p.value);
      if (values.some((v) => !Number.isInteger(v) || v < 0)) {
        throw new SplitError('Exact amounts must be whole paise (0 or more)');
      }
      const sum = values.reduce((a, b) => a + b, 0);
      if (sum !== amount) {
        throw new SplitError(`Exact amounts add up to ₹${rupees(sum)} but the expense is ₹${rupees(amount)}`);
      }
      shares = values;
      break;
    }

    case 'percent': {
      const bps = participants.map((p) => Math.round(Number(p.value) * 100)); // basis points: 33.33% = 3333
      if (bps.some((b) => !Number.isFinite(b) || b < 0)) throw new SplitError('Percentages must be 0 or more');
      const sum = bps.reduce((a, b) => a + b, 0);
      if (sum !== 10000) throw new SplitError(`Percentages add up to ${sum / 100}% instead of 100%`);
      shares = allocate(amount, bps);
      break;
    }

    case 'shares': {
      const weights = participants.map((p) => Math.round(Number(p.value) * 100));
      if (weights.some((w) => !(w >= 1))) throw new SplitError('Shares must be positive numbers');
      if (weights.some((w) => w > 10000)) throw new SplitError('Shares can be at most 100 per person');
      shares = allocate(amount, weights);
      break;
    }

    default:
      throw new SplitError('Unknown split type');
  }

  const result = participants.map((p, i) => ({ userId: p.userId, share: shares[i] })).filter((s) => s.share > 0);

  // Safety net for the project's main rule: shares must add up exactly.
  if (result.reduce((sum, s) => sum + s.share, 0) !== amount) throw new Error('Split does not add up (bug)');
  return result;
}

// ---------------- self-test (only runs when this file is executed directly) ----------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const p = (...values) => values.map((value, i) => ({ userId: `u${i + 1}`, value }));
  const show = (label, fn) => {
    try {
      console.log(label.padEnd(36), JSON.stringify(fn().map((s) => s.share)));
    } catch (e) {
      console.log(label.padEnd(36), `rejected -> ${e.message}`);
    }
  };

  show('equal   ₹1.00 between 3', () => computeSplits('equal', 100, p(0, 0, 0)));
  show('equal   ₹1200 between 3', () => computeSplits('equal', 120000, p(0, 0, 0)));
  show('equal   ₹100.01 between 4', () => computeSplits('equal', 10001, p(0, 0, 0, 0)));
  show('percent 33.33/33.33/33.34 of ₹1.00', () => computeSplits('percent', 100, p(33.33, 33.33, 33.34)));
  show('percent 50/50 of ₹0.01', () => computeSplits('percent', 1, p(50, 50)));
  show('shares  1:2 of ₹1.00', () => computeSplits('shares', 100, p(1, 2)));
  show('shares  1:1:2 of ₹1200', () => computeSplits('shares', 120000, p(1, 1, 2)));
  show('exact   300+700 of ₹10.00', () => computeSplits('exact', 1000, p(300, 700)));
  show('exact   300+600 of ₹10.00 (wrong)', () => computeSplits('exact', 1000, p(300, 600)));
  show('percent 60/30 (wrong)', () => computeSplits('percent', 1000, p(60, 30)));

  // Brute-force: shares must ALWAYS add up exactly.
  let checked = 0;
  for (let amount = 1; amount <= 2000; amount++) {
    for (let n = 1; n <= 7; n++) {
      const total = computeSplits('equal', amount, p(...Array(n).fill(0))).reduce((s, x) => s + x.share, 0);
      if (total !== amount) throw new Error(`FAILED: ${amount} between ${n} gave ${total}`);
      checked++;
    }
  }
  console.log(`\nAll ${checked} equal-split cases add up exactly. Self-test passed.`);
}
