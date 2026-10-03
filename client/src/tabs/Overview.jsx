import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api.js';
import { ErrorBox, Spinner } from '../components.jsx';
import QuickAdd from '../parts/QuickAdd.jsx';

export default function Overview({ group }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const base = `/groups/${group._id}`;
  const hasTrip = Boolean(group.tripBudget?.totalPaise);

  useEffect(() => {
    let live = true;
    Promise.all([
      api(`${base}/reports/summary`),
      api(`${base}/reports/balances`),
      api(`${base}/next-payer`),
      hasTrip ? api(`${base}/reports/burn-rate`) : null,
    ])
      .then(([summary, bal, next, burn]) => live && setD({ summary, balances: bal.balances, next, forecast: burn?.forecast }))
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [base, tick, hasTrip]);

  const net = d?.summary.yourNet ?? 0;
  const f = d?.forecast;

  return (
    <div className="stack">
      <QuickAdd group={group} onAdded={() => setTick((t) => t + 1)} />
      <ErrorBox error={error} />
      {!d && !error && <Spinner />}
      {d && (
        <>
          {d.summary.flaggedCount > 0 && (
            <div className="alert warn row between">
              <span>{d.summary.flaggedCount} {d.summary.flaggedCount === 1 ? 'expense looks' : 'expenses look'} unusually high for its category.</span>
              <Link to="?tab=expenses&flagged=1">Review</Link>
            </div>
          )}

          <div className="stats">
            <div className="card stat"><span className="muted small">Total spent</span><strong>{money(d.summary.totalSpent)}</strong></div>
            <div className="card stat"><span className="muted small">Expenses</span><strong>{d.summary.expenseCount}</strong></div>
            <div className="card stat"><span className="muted small">Average</span><strong>{money(d.summary.averageExpense)}</strong></div>
            <div className="card stat">
              <span className="muted small">{net > 0 ? 'You are owed' : net < 0 ? 'You owe' : 'Your balance'}</span>
              <strong className={net > 0 ? 'pos' : net < 0 ? 'neg' : ''}>{net === 0 ? 'All settled' : money(Math.abs(net))}</strong>
            </div>
          </div>

          <div className="two">
            <div className="card stack tight">
              <h3>Balances</h3>
              {d.balances.map((b) => (
                <div key={b.userId} className="row between line">
                  <span>{b.name}</span>
                  <span className={b.net > 0 ? 'pos' : b.net < 0 ? 'neg' : 'muted'}>
                    {b.net > 0 ? `gets back ${money(b.net)}` : b.net < 0 ? `owes ${money(-b.net)}` : 'settled'}
                  </span>
                </div>
              ))}
              <Link to="?tab=settle" className="small">Settle up →</Link>
            </div>

            <div className="stack">
              <div className="card stack tight">
                <h3>Who should pay next?</h3>
                {d.next.nextPayer ? (
                  <>
                    <strong className="big-amount">{d.next.nextPayer.name}</strong>
                    <span className="muted small">{d.next.message}</span>
                  </>
                ) : (
                  <span className="muted small">{d.next.message}</span>
                )}
              </div>

              {f && (
                <div className="card stack tight">
                  <h3>Trip budget</h3>
                  <div className="row between small"><span>{money(f.spentPaise)} spent</span><span className="muted">of {money(f.budgetPaise)}</span></div>
                  <div className="bar"><div className={f.willExceed ? 'fill bad' : 'fill'} style={{ width: `${Math.min(100, (f.spentPaise / f.budgetPaise) * 100)}%` }} /></div>
                  <span className={f.willExceed ? 'small neg' : 'small muted'}>{f.message}</span>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
