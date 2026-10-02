import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { ErrorBox, Spinner } from '../components.jsx';

export default function Join() {
  const { token } = useParams();
  const nav = useNavigate();
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/invites/${token}`).then(setInvite).catch((e) => setError(e.message));
  }, [token]);

  const accept = async () => {
    setBusy(true);
    setError('');
    try {
      const { groupId } = await api(`/invites/${token}/accept`, { method: 'POST' });
      nav(`/groups/${groupId}`, { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (!invite && !error) return <Spinner />;
  return (
    <div className="card stack auth" style={{ margin: '40px auto' }}>
      {invite ? (
        <>
          <h2>Join {invite.groupName}?</h2>
          <p className="muted">This invite was sent to {invite.email}.</p>
        </>
      ) : (
        <h2>Invite problem</h2>
      )}
      <ErrorBox error={error} />
      {invite && <button className="btn" onClick={accept} disabled={busy}>{busy ? 'Joining...' : 'Join group'}</button>}
      <Link to="/groups" className="muted small center-text">Back to my groups</Link>
    </div>
  );
}
