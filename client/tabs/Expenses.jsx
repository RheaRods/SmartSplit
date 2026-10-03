import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmtDate, money } from '../api.js';
import { ErrorBox, Modal, Spinner } from '../components.jsx';
import ExpenseForm from '../parts/ExpenseForm.jsx';
import ExpenseDetail from '../parts/ExpenseDetail.jsx';
import { CATEGORIES } from '../lib.js';

function ImportModal({ group, onClose, onDone }) {
  const [csv, setCsv] = useState('');
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);

  const readFile = async (e) => {
    const file = e.target.files[0];
    if (file) setCsv(await file.text());
  };
  const send = async () => {
    setBusy(true);
    setError('');
    setRows([]);
    try {
      const out = await api(`/groups/${group._id}/expenses/import`, { method: 'POST', body: { csv } });
      onDone(out.imported);
    } catch (err) {
      setError(err.message);
      setRows(err.data?.rows ?? []);
      setBusy(false);
    }
  };

  return (
    <Modal title="Import from CSV" onClose={onClose}>
      <div className="stack">
        <p className="muted small">
          Columns: <code>description, amount, paid_by</code> and optionally <code>date, category, participants</code>.
          Amount is in rupees, names are group members (separate participants with ;). Everything is split equally. If any row has a problem, nothing is imported.
        </p>
        <input type="file" accept=".csv,text/csv" onChange={readFile} />
        <textarea className="input" rows={7} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'description,amount,paid_by,date,category\nDinner,1200,Aman,2026-10-01,food'} />
        <ErrorBox error={error} />
        {rows.map((r) => <div key={r} className="small neg">{r}</div>)}
        <button className="btn" onClick={send} disabled={busy || !csv.trim()}>{busy ? 'Importing...' : 'Import'}</button>
      </div>
    </Modal>
  );
}

export default function Expenses({ group }) {
  const [params] = useSearchParams();
  const base = `/groups/${group._id}`;
  const [filters, setFilters] = useState({ q: '', category: '', month: '', paidBy: '', flagged: params.get('flagged') === '1' });
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // { type: 'add' | 'view' | 'edit' | 'import', expense }
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setQ(filters.q), 300);
    return () => clearTimeout(t);
  }, [filters.q]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (filters.category) p.set('category', filters.category);
    if (filters.paidBy) p.set('paidBy', filters.paidBy);
    if (filters.flagged) p.set('flagged', 'true');
    if (filters.month) {
      const [y, m] = filters.month.split('-').map(Number);
      p.set('from', `${filters.month}-01`);
      p.set('to', `${filters.month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`);
    }
    return p.toString();
  }, [q, filters.category, filters.paidBy, filters.flagged, filters.month]);

  const load = useCallback(
    async (pg, replace) => {
      setLoading(true);
      setError('');
      try {
        const d = await api(`${base}/expenses?${query}&page=${pg}&limit=20`);
        setItems((prev) => (replace ? d.expenses : [...prev, ...d.expenses]));
        setPage(pg);
        setTotal(d.total);
        setHasMore(d.hasMore);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [base, query]
  );

  useEffect(() => { load(1, true); }, [load]);

  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });
  const saved = (out) => {
    setModal(null);
    setNotice(out?.warning ? `Saved. Heads up: ${out.warning}` : out?.duplicate ? 'That expense was already saved.' : 'Saved');
    load(1, true);
  };
  const changed = () => { setNotice(''); load(1, true); };

  return (
    <div className="stack">
      <div className="row between wrap">
        <h2>Expenses <span className="muted small">{total}</span></h2>
        <div className="row">
          <button className="btn secondary small" onClick={() => setModal({ type: 'import' })}>Import CSV</button>
          <button className="btn" onClick={() => setModal({ type: 'add' })}>Add expense</button>
        </div>
      </div>

      <div className="card filters">
        <input className="input" placeholder="Search..." value={filters.q} onChange={set('q')} />
        <select className="input" value={filters.category} onChange={set('category')}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className="input" value={filters.paidBy} onChange={set('paidBy')}>
          <option value="">Anyone paid</option>
          {group.members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
        </select>
        <input className="input" type="month" value={filters.month} onChange={set('month')} />
        <label className="row small"><input type="checkbox" checked={filters.flagged} onChange={(e) => setFilters({ ...filters, flagged: e.target.checked })} /> Flagged only</label>
      </div>

      {notice && <div className="alert good">{notice}</div>}
      <ErrorBox error={error} />

      <div className="card list">
        {items.map((e) => (
          <button key={e._id} className="item" onClick={() => setModal({ type: 'view', expense: e })}>
            <div>
              <strong>{e.description || 'Expense'}</strong> {e.flags?.anomaly && !e.flags?.confirmedBy && <span className="chip warn">check</span>}
              <div className="muted small">{e.paidByName} paid · {fmtDate(e.date)} · {e.category}</div>
            </div>
            <strong>{money(e.amount)}</strong>
          </button>
        ))}
        {!loading && items.length === 0 && <div className="empty-row muted">No expenses found.</div>}
        {loading && <Spinner />}
      </div>
      {hasMore && !loading && <button className="btn secondary" onClick={() => load(page + 1, false)}>Load more</button>}

      {modal?.type === 'add' && <ExpenseForm group={group} onClose={() => setModal(null)} onSaved={saved} />}
      {modal?.type === 'edit' && <ExpenseForm group={group} expense={modal.expense} onClose={() => setModal(null)} onSaved={saved} />}
      {modal?.type === 'view' && (
        <ExpenseDetail group={group} expense={modal.expense} onClose={() => setModal(null)} onEdit={() => setModal({ type: 'edit', expense: modal.expense })} onChanged={changed} />
      )}
      {modal?.type === 'import' && <ImportModal group={group} onClose={() => setModal(null)} onDone={(n) => { setModal(null); setNotice(`Imported ${n} expenses`); load(1, true); }} />}
    </div>
  );
}
