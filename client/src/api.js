// All talking to the backend goes through api(). Amounts are WHOLE PAISE everywhere.
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';

let token = localStorage.getItem('ss_token');
export const getToken = () => token;
export function setToken(t) {
  token = t;
  if (t) localStorage.setItem('ss_token', t);
  else localStorage.removeItem('ss_token');
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    setToken(null); // session expired
    window.dispatchEvent(new Event('ss-logout'));
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// ---- money + dates ----
export const rupees = (paise) =>
  (Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (paise) => `${paise < 0 ? '-' : ''}₹${rupees(paise)}`;
export const toPaise = (text) => Math.round(parseFloat(text) * 100);
export const fmtDate = (d) =>
  new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
