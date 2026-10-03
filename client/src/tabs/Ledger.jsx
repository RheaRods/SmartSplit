import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateTime, money } from '../api.js';
import { ErrorBox, Spinner } from '../components.jsx';
import { memberName } from '../lib.js';

const LABEL = {
  'expense.create': 'Expense added', 'expense.update': 'Expense edited', 'expense.delete': 'Expense deleted',
  'settlement.create': 'Payment recorded', 'settlement.confirm': 'Payment confirmed', 'settlement.cancel': 'Payment cancelled',
  'member.add': 'Member joined', 'member.remove': 'Member left',
};

function summary(e) {
  const p = e.payload ?? {};
  if (e.type.startsWith('expense.') && p.amount) return `${p.description || 'Expense'} · ${money(p.amount)}`;
  if (e.type === 'expense.update' && p.changes) return Object.keys(p.changes).join(', ') + ' changed';
  if (e.type === 'expense.update' && p.anomalyConfirmed) return 'flag confirmed as correct';
  if (e.type.startsWith('settlement.') && p.amount) return money(p.amount);
  if (e.type.startsWith('member.')) return p.name ?? '';
  return '';
}

export default function Ledger({ group }) {
  const base = `/groups/${group._id}/ledger`;
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async (before) => {
    setLoading(true);
    try {
      const d = await api(`${base}?limit=30${before ? `&beforeSeq=${before}` : ''}`);
      setEntries((prev) => (before ? [...prev, ...d.entries] : d.entries));
      setMore(d.entries.length === 30);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { load(); }, [load]);

  const verify = async () => {
    setChecking(true);
    setError('');
    try {
      setCheck(await api(`${base}/verify`));
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="stack">
      <div className="card stack">
        <h3>Tamper-proof ledger</h3>
        <p className="muted small">
          Every change in this group is recorded here. Each entry contains a fingerprint (hash) of the entry before it,
          so changing or deleting anything in the past breaks the chain, and verifying shows exactly where.
        </p>
        <div className="row"><button className="btn" onClick={verify} disabled={checking}>{checking ? 'Checking...' : 'Verify ledger'}</button></div>
        {check && (
          <div className={check.valid ? 'alert good' : 'alert bad'}>
            {check.valid ? `Ledger is intact: all ${check.count} entries check out.` : `Ledger was tampered with at entry #${check.brokenAt}: ${check.reason}.`}
          </div>
        )}
      </div>

      <ErrorBox error={error} />
      <div className="card list">
        {entries.map((e) => (
          <div key={e.seq} className="item static">
            <div>
              <strong>#{e.seq} {LABEL[e.type] ?? e.type}</strong>
              <div className="muted small">{summary(e)} · by {memberName(group, e.actor)} · {fmtDateTime(e.ts)}</div>
            </div>
            <code className="muted small" title={e.hash}>{e.hash.slice(0, 10)}</code>
          </div>
        ))}
        {loading && <Spinner />}
      </div>
      {more && !loading && <button className="btn secondary" onClick={() => load(entries[entries.length - 1].seq)}>Load older entries</button>}
    </div>
  );
}
