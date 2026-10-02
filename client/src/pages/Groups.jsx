import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { ErrorBox, Modal, Spinner } from '../components.jsx';

const TYPES = { flatmates: 'Flatmates', trip: 'Trip', friends: 'Friends', other: 'Other' };

function NewGroup({ onClose }) {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [type, setType] = useState('friends');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { group } = await api('/groups', { method: 'POST', body: { name, type } });
      nav(`/groups/${group._id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New group" onClose={onClose}>
      <form onSubmit={create} className="stack">
        <label className="field">Group name<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Goa trip, Flat 302..." required autoFocus /></label>
        <label className="field">
          Type
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <ErrorBox error={error} />
        <button className="btn" disabled={busy}>{busy ? 'Creating...' : 'Create group'}</button>
      </form>
    </Modal>
  );
}

export default function Groups() {
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api('/groups').then((d) => setGroups(d.groups)).catch((e) => setError(e.message));
  }, []);

  return (
    <>
      <div className="row between page-head">
        <h1>Your groups</h1>
        <button className="btn" onClick={() => setOpen(true)}>New group</button>
      </div>
      <ErrorBox error={error} />
      {!groups && !error && <Spinner />}
      {groups?.length === 0 && (
        <div className="card empty">
          <h3>No groups yet</h3>
          <p className="muted">Create one for your flat, a trip or a group of friends. You can invite people with a link.</p>
        </div>
      )}
      <div className="grid">
        {groups?.map((g) => (
          <Link key={g.id} to={`/groups/${g.id}`} className="card tile">
            <div className="row between">
              <strong>{g.name}</strong>
              <span className="chip">{TYPES[g.type] || g.type}</span>
            </div>
            <span className="muted small">{g.memberCount} {g.memberCount === 1 ? 'member' : 'members'} · created {fmtDate(g.createdAt)}</span>
          </Link>
        ))}
      </div>
      {open && <NewGroup onClose={() => setOpen(false)} />}
    </>
  );
}
