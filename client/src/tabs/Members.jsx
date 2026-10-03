import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate, toPaise } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ErrorBox } from '../components.jsx';
import { istDay } from '../lib.js';

export default function Members({ group, myRole, reload }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const admin = myRole === 'admin';
  const base = `/groups/${group._id}`;
  const tb = group.tripBudget;

  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(group.name);
  const [trip, setTrip] = useState({
    start: tb?.startDate ? istDay(tb.startDate) : '',
    end: tb?.endDate ? istDay(tb.endDate) : '',
    total: tb?.totalPaise ? (tb.totalPaise / 100).toFixed(0) : '',
  });
  const [confirmName, setConfirmName] = useState('');

  const run = async (fn, ok) => {
    setError('');
    setMsg('');
    try {
      await fn();
      if (ok) setMsg(ok);
    } catch (err) {
      setError(err.message);
    }
  };

  const setRole = (m, role) => run(async () => { await api(`${base}/members/${m.userId}`, { method: 'PATCH', body: { role } }); await reload(); });
  const remove = (m) => {
    const self = String(m.userId) === user.id;
    if (!window.confirm(self ? 'Leave this group?' : `Remove ${m.name} from the group?`)) return;
    run(async () => {
      await api(`${base}/members/${m.userId}`, { method: 'DELETE' });
      if (self) nav('/groups');
      else await reload();
    });
  };
  const invite = (e) => {
    e.preventDefault();
    setLink('');
    run(async () => setLink((await api(`${base}/invites`, { method: 'POST', body: { email } })).invite.link));
  };
  const copy = async () => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const rename = (e) => { e.preventDefault(); run(async () => { await api(base, { method: 'PATCH', body: { name } }); await reload(); }, 'Name saved'); };
  const saveTrip = (e) => {
    e.preventDefault();
    const totalPaise = /^\d+(\.\d{1,2})?$/.test(trip.total) ? toPaise(trip.total) : NaN;
    if (!trip.start || !trip.end || !(totalPaise >= 1)) return setError('Fill in the start date, end date and a budget');
    run(async () => {
      await api(base, { method: 'PATCH', body: { tripBudget: { startDate: trip.start, endDate: trip.end, totalPaise } } });
      await reload();
    }, 'Trip budget saved');
  };
  const deleteGroup = (e) => {
    e.preventDefault();
    run(async () => {
      await api(base, { method: 'DELETE', body: { confirmName } });
      nav('/groups');
    });
  };

  return (
    <div className="stack">
      <ErrorBox error={error} />
      {msg && <div className="alert good">{msg}</div>}

      <div className="card stack tight">
        <h3>Members</h3>
        {group.members.map((m) => {
          const self = String(m.userId) === user.id;
          return (
            <div key={m.userId} className="row between line wrap">
              <span>{m.name}{self && <span className="muted small"> (you)</span>} <span className="muted small">joined {fmtDate(m.joinedAt)}</span></span>
              <div className="row">
                {admin ? (
                  <select className="input compact" value={m.role} onChange={(e) => setRole(m, e.target.value)}>
                    <option value="member">member</option><option value="admin">admin</option>
                  </select>
                ) : <span className="chip">{m.role}</span>}
                {(admin || self) && <button className="btn secondary small" onClick={() => remove(m)}>{self ? 'Leave' : 'Remove'}</button>}
              </div>
            </div>
          );
        })}
        <p className="muted small">Someone can only leave or be removed once their balance is zero.</p>
      </div>

      {admin && (
        <>
          <form className="card stack" onSubmit={invite}>
            <h3>Invite someone</h3>
            <p className="muted small">Enter their email to get a link to send them (no email is sent). It works for 7 days and only for that email address.</p>
            <div className="row">
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="friend@example.com" required />
              <button className="btn">Create link</button>
            </div>
            {link && (
              <div className="row">
                <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} />
                <button type="button" className="btn secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
            )}
          </form>

          <form className="card stack" onSubmit={saveTrip}>
            <h3>Trip budget</h3>
            <p className="muted small">Set dates and a budget to see "at this pace you'll cross the budget on day N" on the Overview and Reports.</p>
            <div className="formgrid">
              <label className="field">Start<input className="input" type="date" value={trip.start} onChange={(e) => setTrip({ ...trip, start: e.target.value })} /></label>
              <label className="field">End<input className="input" type="date" value={trip.end} onChange={(e) => setTrip({ ...trip, end: e.target.value })} /></label>
              <label className="field">Budget (₹)<input className="input" inputMode="decimal" value={trip.total} onChange={(e) => setTrip({ ...trip, total: e.target.value })} /></label>
            </div>
            <div className="row"><button className="btn">Save budget</button></div>
          </form>

          <form className="card stack" onSubmit={rename}>
            <h3>Group name</h3>
            <div className="row"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /><button className="btn secondary">Rename</button></div>
          </form>

          <form className="card stack danger-zone" onSubmit={deleteGroup}>
            <h3>Delete group</h3>
            <p className="muted small">This permanently deletes the group with all its expenses, payments and ledger. Type the group name to confirm.</p>
            <div className="row"><input className="input" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={group.name} /><button className="btn danger" disabled={confirmName !== group.name}>Delete</button></div>
          </form>
        </>
      )}
    </div>
  );
}
