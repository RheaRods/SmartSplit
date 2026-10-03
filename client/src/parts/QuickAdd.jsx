import { useRef, useState } from 'react';
import { api, money } from '../api.js';
import { ErrorBox } from '../components.jsx';
import { SPLIT_LABELS, newId } from '../lib.js';

// Type a sentence -> see a preview -> confirm. Nothing is saved until you press "Add expense".
export default function QuickAdd({ group, onAdded }) {
  const [text, setText] = useState('');
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const reqId = useRef(newId());
  const base = `/groups/${group._id}/expenses`;

  const preview = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    setDone('');
    try {
      setRes(await api(`${base}/parse`, { method: 'POST', body: { text } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const out = await api(base, { method: 'POST', body: { ...res.payload, clientRequestId: reqId.current } });
      reqId.current = newId();
      setDone(out.warning ? `Added. Heads up: ${out.warning}` : 'Added');
      setRes(null);
      setText('');
      onAdded(out);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const p = res?.preview;
  return (
    <div className="card stack">
      <div>
        <h3>Quick add</h3>
        <p className="muted small">Type it like you would say it, e.g. <em>Dinner 1200 with Aman, Riya, I paid, Aman double</em></p>
      </div>
      <form className="row" onSubmit={preview}>
        <input className="input" value={text} onChange={(e) => { setText(e.target.value); setRes(null); setDone(''); }} placeholder="Uber 450 yesterday with Karan" />
        <button className="btn" disabled={busy || !text.trim()}>Preview</button>
      </form>
      <ErrorBox error={error} />
      {done && <div className="alert good">{done}</div>}
      {res && !res.ok && <ErrorBox error={res.errors[0]} />}
      {p && (
        <div className="preview stack">
          <div className="row between">
            <strong>{p.description}</strong>
            <strong>{money(p.amount)}</strong>
          </div>
          <div className="muted small">{p.category} · {p.dateLabel} · paid by {p.paidBy.name} · split {SPLIT_LABELS[p.splitType].toLowerCase()}</div>
          <div className="splits">
            {p.splits.map((s) => (
              <span key={s.userId} className="chip">{s.name} {money(s.share)}</span>
            ))}
          </div>
          {res.notes.map((n) => <div key={n} className="muted small">• {n}</div>)}
          <div className="row">
            <button className="btn" onClick={add} disabled={busy}>Add expense</button>
            <button className="btn secondary" onClick={() => setRes(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
