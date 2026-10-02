// Basic group page (members + invites). Batch B replaces this with the full dashboard.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { ErrorBox, Spinner } from '../components.jsx';

export default function Group() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api(`/groups/${id}`).then(setData).catch((e) => setError(e.message));
  }, [id]);

  const invite = async (e) => {
    e.preventDefault();
    setInviteError('');
    setLink('');
    try {
      const { invite } = await api(`/groups/${id}/invites`, { method: 'POST', body: { email } });
      setLink(invite.link);
    } catch (err) {
      setInviteError(err.message);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (error) return <><Link to="/groups">← Groups</Link><ErrorBox error={error} /></>;
  if (!data) return <Spinner />;
  const { group, myRole } = data;

  return (
    <>
      <Link to="/groups" className="muted small">← Groups</Link>
      <div className="row between page-head">
        <h1>{group.name}</h1>
        <span className="chip">{group.type}</span>
      </div>

      <div className="card stack">
        <h3>Members</h3>
        {group.members.map((m) => (
          <div key={m.userId} className="row between line">
            <span>{m.name}</span>
            <span className="muted small">{m.role} · joined {fmtDate(m.joinedAt)}</span>
          </div>
        ))}
      </div>

      {myRole === 'admin' && (
        <form className="card stack" onSubmit={invite} style={{ marginTop: 16 }}>
          <h3>Invite someone</h3>
          <p className="muted small">Enter their email. You get a link to send them (no email is sent). It works for 7 days and only for that email address.</p>
          <div className="row">
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="friend@example.com" required />
            <button className="btn">Create link</button>
          </div>
          <ErrorBox error={inviteError} />
          {link && (
            <div className="row">
              <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          )}
        </form>
      )}
    </>
  );
}
