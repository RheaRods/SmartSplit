import { useRef, useState } from 'react';
import { api, money, toPaise } from '../api.js';
import { ErrorBox, Modal } from '../components.jsx';
import { useAuth } from '../auth.jsx';
import { CATEGORIES, SPLIT_LABELS, istDay, newId, today } from '../lib.js';

const AMOUNT = /^\d+(\.\d{1,2})?$/;

export default function ExpenseForm({ group, expense, onClose, onSaved }) {
  const { user } = useAuth();
  const editing = Boolean(expense);
  const reqId = useRef(newId());

  const [description, setDescription] = useState(expense?.description ?? '');
  const [amount, setAmount] = useState(expense ? (expense.amount / 100).toFixed(2) : '');
  const [category, setCategory] = useState(expense?.category ?? 'other');
  const [date, setDate] = useState(expense ? istDay(expense.date) : today());
  const [dateTouched, setDateTouched] = useState(false);
  const [paidBy, setPaidBy] = useState(expense ? String(expense.paidBy) : user.id);
  const [splitType, setSplitType] = useState(expense?.splitType ?? 'equal');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // one row per member: ticked or not + a value (used by exact / percent / shares)
  const [rows, setRows] = useState(() =>
    Object.fromEntries(
      group.members.map((m) => {
        const s = expense?.splits.find((x) => String(x.userId) === String(m.userId));
        let value = '';
        if (s && expense.splitType === 'exact') value = (s.share / 100).toFixed(2);
        if (s && expense.splitType === 'percent') value = ((s.share * 100) / expense.amount).toFixed(2);
        if (s && expense.splitType === 'shares') value = '1';
        return [String(m.userId), { on: expense ? Boolean(s) : true, value }];
      })
    )
  );

  const setRow = (id, patch) => setRows({ ...rows, [id]: { ...rows[id], ...patch } });
  const changeType = (t) => {
    setSplitType(t);
    setRows(Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, { ...r, value: t === 'shares' ? '1' : '' }])));
  };

  const chosen = group.members.filter((m) => rows[String(m.userId)].on);
  const total = AMOUNT.test(amount) ? toPaise(amount) : NaN;
  const numbers = chosen.map((m) => parseFloat(rows[String(m.userId)].value));
  const sum = numbers.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

  // live hint under the list
  let hint = '';
  if (splitType === 'exact' && Number.isFinite(total)) {
    const left = total - Math.round(sum * 100);
    hint = left === 0 ? 'Adds up to the total' : left > 0 ? `${money(left)} still to assign` : `${money(-left)} too much`;
  }
  if (splitType === 'percent') hint = Math.abs(sum - 100) < 0.005 ? 'Adds up to 100%' : `Total is ${sum.toFixed(2)}%, needs to be 100%`;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!Number.isFinite(total) || total < 1) return setError('Enter a valid amount, like 450 or 450.50');
    if (!chosen.length) return setError('Pick at least one person to split with');

    const participants = chosen.map((m, i) => {
      const p = { userId: String(m.userId) };
      if (splitType === 'exact') p.value = Math.round(numbers[i] * 100);
      if (splitType === 'percent' || splitType === 'shares') p.value = numbers[i];
      return p;
    });
    if (splitType !== 'equal' && participants.some((p) => !Number.isFinite(p.value))) return setError('Fill in a value for everyone who is ticked');
    if (splitType === 'exact' && participants.reduce((s, p) => s + p.value, 0) !== total) return setError('The amounts must add up to the total');
    if (splitType === 'percent' && Math.abs(sum - 100) >= 0.005) return setError('The percentages must add up to 100');
    if (splitType === 'shares' && participants.some((p) => p.value <= 0)) return setError('Shares must be more than 0');

    const body = { description, amount: total, category, paidBy, splitType, participants };
    if (editing ? dateTouched : date !== today()) body.date = date;

    setBusy(true);
    try {
      const base = `/groups/${group._id}/expenses`;
      const out = editing
        ? await api(`${base}/${expense._id}`, { method: 'PATCH', body })
        : await api(base, { method: 'POST', body: { ...body, clientRequestId: reqId.current } });
      onSaved(out);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? 'Edit expense' : 'Add expense'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">What for<input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Dinner" maxLength={120} autoFocus /></label>
        <div className="formgrid">
          <label className="field">Amount (₹)<input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1200" required /></label>
          <label className="field">Category
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
          </label>
          <label className="field">Date<input className="input" type="date" max={today()} value={date} onChange={(e) => { setDate(e.target.value); setDateTouched(true); }} required /></label>
          <label className="field">Paid by
            <select className="input" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>{group.members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select>
          </label>
        </div>

        <label className="field">Split
          <select className="input" value={splitType} onChange={(e) => changeType(e.target.value)}>
            {Object.entries(SPLIT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>

        <div className="stack tight">
          {group.members.map((m) => {
            const id = String(m.userId);
            return (
              <div key={id} className="row between">
                <label className="row"><input type="checkbox" checked={rows[id].on} onChange={(e) => setRow(id, { on: e.target.checked })} /> {m.name}</label>
                {splitType !== 'equal' && rows[id].on && (
                  <input className="input narrow" inputMode="decimal" value={rows[id].value} onChange={(e) => setRow(id, { value: e.target.value })}
                    placeholder={splitType === 'exact' ? '₹' : splitType === 'percent' ? '%' : 'shares'} />
                )}
              </div>
            );
          })}
          {hint && <span className="muted small">{hint}</span>}
        </div>

        <ErrorBox error={error} />
        <button className="btn" disabled={busy}>{busy ? 'Saving...' : editing ? 'Save changes' : 'Add expense'}</button>
      </form>
    </Modal>
  );
}
