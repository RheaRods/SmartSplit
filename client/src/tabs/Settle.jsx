import { useEffect, useState } from 'react';
import { api, fmtDate, money, toPaise } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ErrorBox, Spinner } from '../components.jsx';

export default function Settle({ group }) {
  const { user } = useAuth();
  const base = `/groups/${group._id}`;
  const [plan, setPlan] = useState(null);
  const [pending, setPending] = useState([]);
  const [recent, setRecent] = useState([]);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ to: '', amount: '', method: 'cash', note: '' });

  useEffect(() => {
    let live = true;
    Promise.all([
      api(`${base}/settle-plan`),
      api(`${base}/settlements?status=pending&limit=50`),
      api(`${base}/settlements?status=confirmed&limit=10`),
    ])
      .then(([p, pe, re]) => {
        if (!live) return;
        setPlan(p);
        setPending(pe.settlements);
        setRecent(re.settlements);
      })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [base, tick]);

  const act = async (key, fn) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      setTick((t) => t + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const iPaid = (t) => act(`pay-${t.to.userId}`, () => api(`${base}/settlements`, { method: 'POST', body: { to: String(t.to.userId), amount: t.amount, method: 'upi' } }));
  const confirm = (s) => act(s._id, () => api(`${base}/settlements/${s._id}/confirm`, { method: 'PATCH' }));
  const remove = (s) => act(s._id, () => api(`${base}/settlements/${s._id}`, { method: 'DELETE' }));

  const record = (e) => {
    e.preventDefault();
    const amount = /^\d+(\.\d{1,2})?$/.test(form.amount) ? toPaise(form.amount) : NaN;
    if (!form.to || !(amount >= 1)) return setError('Pick who you paid and enter a valid amount');
    act('record', async () => {
      await api(`${base}/settlements`, { method: 'POST', body: { to: form.to, amount, method: form.method, note: form.note } });
      setForm({ to: '', amount: '', method: 'cash', note: '' });
    });
  };

  if (!plan && !error) return <Spinner />;
  const others = group.members.filter((m) => String(m.userId) !== user.id);

  return (
    <div className="stack">
      <ErrorBox error={error} />

      <div className="card stack tight">
        <h3>Settle up</h3>
        <p className="muted small">The fewest payments that clear everyone's balance.</p>
        {plan?.pendingSettlements > 0 && <div className="alert warn small">{plan.pendingSettlements} payment(s) are waiting for confirmation below. This plan does not count them yet.</div>}
        {plan?.allSettled && <div className="alert good">Everyone is settled up.</div>}
        {plan?.transfers.map((t) => (
          <div key={`${t.from.userId}-${t.to.userId}`} className="row between line wrap">
            <span><strong>{t.from.name}</strong> pays <strong>{t.to.name}</strong></span>
            <div className="row">
              <strong>{money(t.amount)}</strong>
              {t.isMine && (
                <>
                  {t.upiLink ? <a className="btn small" href={t.upiLink}>Pay via UPI</a> : <span className="muted small">{t.to.name} has no UPI id</span>}
                  <button className="btn secondary small" onClick={() => iPaid(t)} disabled={busy === `pay-${t.to.userId}`}>I've paid</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {pending.length > 0 && (
        <div className="card stack tight">
          <h3>Waiting for confirmation</h3>
          {pending.map((s) => {
            const toMe = String(s.to) === user.id;
            const fromMe = String(s.from) === user.id;
            return (
              <div key={s._id} className="row between line wrap">
                <span>{s.fromName} → {s.toName} · {s.method}{s.note ? ` · ${s.note}` : ''}</span>
                <div className="row">
                  <strong>{money(s.amount)}</strong>
                  {toMe && <button className="btn small" onClick={() => confirm(s)} disabled={busy === s._id}>Confirm received</button>}
                  {(toMe || fromMe) && <button className="btn secondary small" onClick={() => remove(s)} disabled={busy === s._id}>{toMe ? 'Reject' : 'Cancel'}</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <form className="card stack" onSubmit={record}>
        <h3>Record a payment you made</h3>
        <div className="formgrid">
          <label className="field">Paid to
            <select className="input" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })}>
              <option value="">Choose...</option>
              {others.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
            </select>
          </label>
          <label className="field">Amount (₹)<input className="input" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
          <label className="field">How
            <select className="input" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              <option value="cash">Cash</option><option value="upi">UPI</option><option value="other">Other</option>
            </select>
          </label>
          <label className="field">Note<input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={200} /></label>
        </div>
        <button className="btn" disabled={busy === 'record'}>Record payment</button>
        <p className="muted small">The other person has to confirm it before balances change.</p>
      </form>

      {recent.length > 0 && (
        <div className="card stack tight">
          <h3>Recent confirmed payments</h3>
          {recent.map((s) => (
            <div key={s._id} className="row between line"><span>{s.fromName} → {s.toName} <span className="muted small">{fmtDate(s.confirmedAt || s.createdAt)}</span></span><strong>{money(s.amount)}</strong></div>
          ))}
        </div>
      )}
    </div>
  );
}
