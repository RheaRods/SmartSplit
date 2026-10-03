import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, downloadCsv, fmtDate, money } from '../api.js';
import { ErrorBox, Spinner } from '../components.jsx';
import { CATEGORY_COLORS } from '../lib.js';

const axis = { fill: 'var(--muted)', fontSize: 12 };
const rs = (paise) => Math.round(paise) / 100;
const tip = (v) => `₹${Number(v).toLocaleString('en-IN')}`;

function Section({ title, hint, csv, children }) {
  const [err, setErr] = useState('');
  return (
    <div className="card stack">
      <div className="row between wrap">
        <div>
          <h3>{title}</h3>
          {hint && <span className="muted small">{hint}</span>}
        </div>
        {csv && <button className="btn secondary small" onClick={() => downloadCsv(csv.path, csv.name).catch((e) => setErr(e.message))}>Download CSV</button>}
      </div>
      <ErrorBox error={err} />
      {children}
    </div>
  );
}

const Chart = ({ children }) => <div className="chart"><ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer></div>;

export default function Reports({ group }) {
  const base = `/groups/${group._id}/reports`;
  const [month, setMonth] = useState('');
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const q = month ? `?month=${month}` : '';

  useEffect(() => {
    let live = true;
    setD(null);
    Promise.all([
      api(`${base}/summary${q}`),
      api(`${base}/balances`),
      api(`${base}/monthly-category${q}`),
      api(`${base}/paid-vs-consumed${q}`),
      api(`${base}/top-expenses${q}`),
      api(`${base}/burn-rate${q}`),
    ])
      .then(([summary, balances, monthly, pvc, top, burn]) => live && setD({ summary, balances, monthly, pvc, top, burn }))
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [base, q]);

  // R2: one row per month, one column per category (for the stacked bars)
  const months = d ? [...new Set(d.monthly.rows.map((r) => r.month))] : [];
  const cats = d ? [...new Set(d.monthly.rows.map((r) => r.category))] : [];
  const monthlyData = months.map((m) => ({
    month: m,
    ...Object.fromEntries(cats.map((c) => [c, rs(d.monthly.rows.find((r) => r.month === m && r.category === c)?.total ?? 0)])),
  }));
  const maxCount = d ? Math.max(1, ...d.top.categories.map((c) => c.count)) : 1;
  const f = d?.burn.forecast;

  return (
    <div className="stack">
      <div className="row between wrap">
        <h2>Reports</h2>
        <div className="row">
          <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          {month && <button className="btn secondary small" onClick={() => setMonth('')}>All time</button>}
        </div>
      </div>
      <ErrorBox error={error} />
      {!d && !error && <Spinner />}
      {d && (
        <>
          <div className="stats">
            <div className="card stat"><span className="muted small">Total spent</span><strong>{money(d.summary.totalSpent)}</strong></div>
            <div className="card stat"><span className="muted small">Expenses</span><strong>{d.summary.expenseCount}</strong></div>
            <div className="card stat"><span className="muted small">Average</span><strong>{money(d.summary.averageExpense)}</strong></div>
            <div className="card stat"><span className="muted small">Top category</span><strong>{d.summary.topCategory?.category ?? '-'}</strong></div>
          </div>

          <Section title="1. Who owes whom" hint="Net balance per member (all time). Green is owed money, red owes money." csv={{ path: `${base}/balances`, name: 'balances.csv' }}>
            <Chart>
              <BarChart data={d.balances.balances.map((b) => ({ name: b.name, net: rs(b.net) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="name" tick={axis} /><YAxis tick={axis} /><Tooltip formatter={tip} />
                <ReferenceLine y={0} stroke="var(--muted)" />
                <Bar dataKey="net" name="Net balance">
                  {d.balances.balances.map((b) => <Cell key={b.userId} fill={b.net >= 0 ? '#10b981' : '#ef4444'} />)}
                </Bar>
              </BarChart>
            </Chart>
          </Section>

          <Section title="2. Spending by month and category" csv={{ path: `${base}/monthly-category${q}`, name: 'monthly-category.csv' }}>
            {monthlyData.length === 0 ? <span className="muted">No expenses in this period.</span> : (
              <Chart>
                <BarChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="month" tick={axis} /><YAxis tick={axis} /><Tooltip formatter={tip} /><Legend />
                  {cats.map((c) => <Bar key={c} dataKey={c} stackId="a" fill={CATEGORY_COLORS[c] ?? '#94a3b8'} />)}
                </BarChart>
              </Chart>
            )}
          </Section>

          <Section title="3. Paid vs share consumed" hint="Who has paid more than their share, and who less." csv={{ path: `${base}/paid-vs-consumed${q}`, name: 'paid-vs-consumed.csv' }}>
            <Chart>
              <BarChart data={d.pvc.members.map((m) => ({ name: m.name, Paid: rs(m.paid), Share: rs(m.consumed) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="name" tick={axis} /><YAxis tick={axis} /><Tooltip formatter={tip} /><Legend />
                <Bar dataKey="Paid" fill="#6366f1" /><Bar dataKey="Share" fill="#f59e0b" />
              </BarChart>
            </Chart>
          </Section>

          <Section title="4. Biggest expenses and busiest categories" csv={{ path: `${base}/top-expenses${q}`, name: 'top-expenses.csv' }}>
            <div className="two">
              <div>
                {d.top.top.map((e) => (
                  <div key={e._id} className="row between line">
                    <span>{e.description || 'Expense'} <span className="muted small">{e.paidByName} · {fmtDate(e.date)}</span></span>
                    <strong>{money(e.amount)}</strong>
                  </div>
                ))}
                {d.top.top.length === 0 && <span className="muted">No expenses in this period.</span>}
              </div>
              <div className="stack tight">
                {d.top.categories.map((c) => (
                  <div key={c.category} className="small">
                    <div className="row between"><span>{c.category}</span><span className="muted">{c.count}</span></div>
                    <div className="bar"><div className="fill" style={{ width: `${(c.count / maxCount) * 100}%`, background: CATEGORY_COLORS[c.category] }} /></div>
                  </div>
                ))}
              </div>
            </div>
          </Section>

          <Section title="5. Spending over time" hint={f?.message ?? 'Running total by day. Set a trip budget in Members to get a forecast.'} csv={{ path: `${base}/burn-rate${q}`, name: 'burn-rate.csv' }}>
            {d.burn.days.length === 0 ? <span className="muted">No expenses in this period.</span> : (
              <Chart>
                <LineChart data={d.burn.days.map((x) => ({ day: x.day.slice(5), Daily: rs(x.daily), Total: rs(x.cumulative) }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="day" tick={axis} /><YAxis tick={axis} /><Tooltip formatter={tip} /><Legend />
                  {f && <ReferenceLine y={rs(f.budgetPaise)} stroke="#ef4444" strokeDasharray="4 4" label={{ value: 'Budget', fill: '#ef4444', fontSize: 12 }} />}
                  <Line type="monotone" dataKey="Total" stroke="#6366f1" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="Daily" stroke="#f59e0b" strokeWidth={2} dot={false} />
                </LineChart>
              </Chart>
            )}
          </Section>

          <Section title="Expense sizes">
            {d.summary.sizeBuckets.map((b) => (
              <div key={b.range} className="row between line"><span>{b.range}</span><span>{b.count} · {money(b.total)}</span></div>
            ))}
            {d.summary.sizeBuckets.length === 0 && <span className="muted">No expenses in this period.</span>}
          </Section>
        </>
      )}
    </div>
  );
}
