import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { ErrorBox, Spinner } from '../components.jsx';
import Overview from '../tabs/Overview.jsx';
import Expenses from '../tabs/Expenses.jsx';
import Settle from '../tabs/Settle.jsx';
import Reports from '../tabs/Reports.jsx';
import Ledger from '../tabs/Ledger.jsx';
import Members from '../tabs/Members.jsx';

const TABS = [
  ['overview', 'Overview'], ['expenses', 'Expenses'], ['settle', 'Settle up'],
  ['reports', 'Reports'], ['ledger', 'Ledger'], ['members', 'Members'],
];

export default function Group() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => api(`/groups/${id}`).then(setData).catch((e) => setError(e.message)), [id]);
  useEffect(() => { setData(null); setError(''); load(); }, [load]);

  if (error) return <><Link to="/groups">← Groups</Link><ErrorBox error={error} /></>;
  if (!data) return <Spinner />;

  const { group, myRole } = data;
  const props = { group, myRole, reload: load };

  return (
    <>
      <Link to="/groups" className="muted small">← Groups</Link>
      <div className="row between page-head">
        <h1>{group.name}</h1>
        <span className="chip">{group.type} · {group.members.length} members</span>
      </div>
      <nav className="tabs">
        {TABS.map(([k, label]) => <Link key={k} to={`?tab=${k}`} className={k === tab ? 'tab active' : 'tab'}>{label}</Link>)}
      </nav>
      {tab === 'overview' && <Overview {...props} />}
      {tab === 'expenses' && <Expenses {...props} />}
      {tab === 'settle' && <Settle {...props} />}
      {tab === 'reports' && <Reports {...props} />}
      {tab === 'ledger' && <Ledger {...props} />}
      {tab === 'members' && <Members {...props} />}
    </>
  );
}
