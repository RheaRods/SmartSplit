import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { ErrorBox } from '../components.jsx';

export default function AuthPage({ mode }) {
  const isRegister = mode === 'register';
  const { user, login, register } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // only follow internal links after login (for invite links)
  const next = params.get('next');
  const dest = next && next.startsWith('/') && !next.startsWith('//') ? next : '/groups';
  const other = `${isRegister ? '/login' : '/register'}${next ? `?next=${encodeURIComponent(next)}` : ''}`;

  if (user) return <Navigate to={dest} replace />;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (isRegister) await register(form.name, form.email, form.password);
      else await login(form.email, form.password);
      nav(dest, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <form className="card auth stack" onSubmit={submit}>
        <div className="brand big">Split<span>Smart</span></div>
        <p className="muted">Split expenses with friends. Settle up with fewer payments.</p>
        {isRegister && <label className="field">Name<input className="input" value={form.name} onChange={set('name')} required autoFocus /></label>}
        <label className="field">Email<input className="input" type="email" value={form.email} onChange={set('email')} required autoFocus={!isRegister} /></label>
        <label className="field">
          Password
          <input className="input" type="password" value={form.password} onChange={set('password')} required minLength={isRegister ? 8 : 1} />
          {isRegister && <span className="muted small">At least 8 characters</span>}
        </label>
        <ErrorBox error={error} />
        <button className="btn" disabled={busy}>{busy ? 'Please wait...' : isRegister ? 'Create account' : 'Log in'}</button>
        <p className="muted small center-text">
          {isRegister ? 'Already have an account?' : 'New here?'} <Link to={other}>{isRegister ? 'Log in' : 'Create an account'}</Link>
        </p>
      </form>
    </div>
  );
}
