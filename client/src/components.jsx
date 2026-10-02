import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from './auth.jsx';

export function Spinner({ full }) {
  return (
    <div className={full ? 'center-screen' : 'center'}>
      <div className="spinner" />
    </div>
  );
}

export const ErrorBox = ({ error }) => (error ? <div className="error">{error}</div> : null);

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="row between">
          <h3>{title}</h3>
          <button className="icon" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ProfileModal({ onClose }) {
  const { user, updateProfile } = useAuth();
  const [name, setName] = useState(user.name);
  const [upi, setUpi] = useState(user.upiId || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await updateProfile({ name, upiId: upi.trim() });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Your profile" onClose={onClose}>
      <form onSubmit={save} className="stack">
        <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label className="field">
          UPI id
          <input className="input" value={upi} onChange={(e) => setUpi(e.target.value)} placeholder="name@bank" />
          <span className="muted small">Friends use this for the "Pay via UPI" button. Leave empty to remove it.</span>
        </label>
        <ErrorBox error={error} />
        <button className="btn" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
      </form>
    </Modal>
  );
}

export function Layout({ children }) {
  const { user, logout } = useAuth();
  const [profile, setProfile] = useState(false);
  return (
    <>
      <header className="topbar">
        <Link to="/groups" className="brand">Split<span>Smart</span></Link>
        <div className="row">
          <button className="link" onClick={() => setProfile(true)}>{user.name}</button>
          <button className="btn secondary small" onClick={logout}>Log out</button>
        </div>
      </header>
      <main className="container">{children}</main>
      {profile && <ProfileModal onClose={() => setProfile(false)} />}
    </>
  );
}
