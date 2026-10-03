import { useState } from 'react';
import { api, fmtDate, fmtDateTime, money } from '../api.js';
import { ErrorBox, Modal } from '../components.jsx';
import { SPLIT_LABELS, memberName } from '../lib.js';

// Turns one history entry into readable text.
function describeChanges(changes, group) {
  return Object.entries(changes)
    .map(([key, [from, to]]) => {
      if (key === 'amount') return `amount ${money(from)} → ${money(to)}`;
      if (key === 'date') return `date ${fmtDate(from)} → ${fmtDate(to)}`;
      if (key === 'paidBy') return `paid by ${memberName(group, from)} → ${memberName(group, to)}`;
      if (key === 'splits') return 'split changed';
      if (key === 'isDeleted') return 'deleted';
      return `${key} "${from}" → "${to}"`;
    })
    .join(', ');
}

export default function ExpenseDetail({ group, expense, onClose, onEdit, onChanged }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/groups/${group._id}/expenses/${expense._id}`;
  const flagged = expense.flags?.anomaly && !expense.flags?.confirmedBy;

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      onChanged();
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const remove = () => window.confirm('Delete this expense? It stays in the ledger history.') && run(() => api(base, { method: 'DELETE' }));
  const confirm = () => run(() => api(`${base}/confirm-anomaly`, { method: 'PATCH' }));

  return (
    <Modal title={expense.description || 'Expense'} onClose={onClose}>
      <div className="stack">
        <div className="row between">
          <span className="big-amount">{money(expense.amount)}</span>
          <span className="chip">{expense.category}</span>
        </div>
        <div className="muted small">{expense.paidByName} paid · {fmtDate(expense.date)} · split {SPLIT_LABELS[expense.splitType].toLowerCase()}</div>

        {flagged && (
          <div className="alert warn stack tight">
            <span>{expense.flags.reason}</span>
            <button className="btn small" onClick={confirm} disabled={busy}>Yes, this amount is correct</button>
          </div>
        )}

        <div>
          <h3>Who owes what</h3>
          {expense.splits.map((s) => (
            <div key={s.userId} className="row between line"><span>{s.name}</span><span>{money(s.share)}</span></div>
          ))}
        </div>

        {expense.history?.length > 0 && (
          <div>
            <h3>History</h3>
            {[...expense.history].reverse().map((h, i) => (
              <div key={i} className="line small">
                <span className="muted">{fmtDateTime(h.at)} · {memberName(group, h.by)}</span>
                <div>{describeChanges(h.changes, group)}</div>
              </div>
            ))}
          </div>
        )}

        <ErrorBox error={error} />
        <div className="row">
          <button className="btn" onClick={onEdit} disabled={busy}>Edit</button>
          <button className="btn secondary danger" onClick={remove} disabled={busy}>Delete</button>
        </div>
      </div>
    </Modal>
  );
}
