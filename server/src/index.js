import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import authRouter from './auth.js';
import groupsRouter, { invitesRouter } from './groups.js';
import { ledgerRouter } from './ledger.js';
import expensesRouter from './expenses.js';
import { quickAddRouter } from './quickAdd.js';
import settlementsRouter, { smartRouter } from './settlements.js';
import { reportsRouter } from './reports.js';

const { MONGO_URI, JWT_SECRET, PORT = 5000 } = process.env;

if (!MONGO_URI || !MONGO_URI.startsWith('mongodb')) {
  console.error('\nMONGO_URI is missing or invalid in server/.env');
  console.error('It must start with mongodb+srv:// (copy it from Atlas > Connect > Drivers)\n');
  process.exit(1);
}
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('\nJWT_SECRET is missing or too short in server/.env (use 16+ random characters)\n');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // needed on Cloud Run so rate limiting sees the real client IP

// ---- security + parsing ----
app.use(helmet());
app.use(cors()); // tighten to your frontend domain when deploying
app.use(express.json({ limit: '100kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 }));

// NoSQL-injection guard: strips keys like "$gt" or "a.b" from body and params.
// (Custom on purpose: express-mongo-sanitize breaks on Express 5.)
const clean = (obj) => {
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      if (key.startsWith('$') || key.includes('.')) delete obj[key];
      else clean(obj[key]);
    }
  }
  return obj;
};
app.use((req, _res, next) => {
  clean(req.body);
  clean(req.params);
  next();
});

// ---- routes ----
app.get('/health', (_req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState === 1 });
});

app.use('/api/auth', authRouter);
app.use('/api/groups/:groupId/ledger', ledgerRouter);
app.use('/api/groups/:groupId/expenses/parse', quickAddRouter); // S1: sentence -> preview
app.use('/api/groups/:groupId/expenses', expensesRouter);
app.use('/api/groups/:groupId/settlements', settlementsRouter);
app.use('/api/groups/:groupId/reports', reportsRouter);
app.use('/api/groups/:groupId', smartRouter); // /settle-plan and /next-payer
app.use('/api/groups', groupsRouter);
app.use('/api/invites', invitesRouter);

// ---- 404 + error handling ----
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

// ---- start ----
try {
  await mongoose.connect(MONGO_URI, { dbName: 'splitsmart' });
  console.log('MongoDB connected');
  app.listen(PORT, () => console.log(`API up on http://localhost:${PORT}`));
} catch (err) {
  console.error('Could not connect to MongoDB:', err.message);
  process.exit(1);
}
