import mongoose from 'mongoose';

const { Schema } = mongoose;

const ref = (model) => ({ type: Schema.Types.ObjectId, ref: model });

// Money is ALWAYS whole paise (integer). 1200 rupees = 120000.
const paise = {
  type: Number,
  min: 1,
  validate: { validator: Number.isInteger, message: 'Amount must be whole paise' },
};

// Collections + indexes are created by scripts/setup-db.js (with validators),
// so Mongoose must not create or index anything on its own.
const options = (collection) => ({
  collection,
  versionKey: false,
  autoIndex: false,
  autoCreate: false,
});

// ---------- users ----------
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    upiId: { type: String, trim: true },
    createdAt: { type: Date, default: Date.now },
  },
  options('users')
);

// ---------- groups (members + budgets are EMBEDDED) ----------
const memberSchema = new Schema(
  {
    userId: { ...ref('User'), required: true },
    name: { type: String, required: true },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const budgetSchema = new Schema(
  {
    category: { type: String, required: true },
    limitPaise: paise,
    period: { type: String, enum: ['month', 'trip'], default: 'month' },
  },
  { _id: false }
);

const groupSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['flatmates', 'trip', 'friends', 'other'], default: 'friends' },
    currency: { type: String, default: 'INR' },
    createdBy: ref('User'),
    members: { type: [memberSchema], default: [] },
    budgets: { type: [budgetSchema], default: [] },
    tripBudget: {
      startDate: Date,
      endDate: Date,
      totalPaise: Number,
    },
    createdAt: { type: Date, default: Date.now },
  },
  options('groups')
);

// ---------- expenses (splits + history are EMBEDDED, groupId/paidBy are REFERENCES) ----------
const splitSchema = new Schema(
  {
    userId: { ...ref('User'), required: true },
    share: { type: Number, min: 0, validate: { validator: Number.isInteger, message: 'Share must be whole paise' } },
  },
  { _id: false }
);

const expenseSchema = new Schema(
  {
    groupId: { ...ref('Group'), required: true },
    paidBy: { ...ref('User'), required: true },
    description: { type: String, trim: true, default: '' },
    amount: { ...paise, required: true },
    currency: { type: String, default: 'INR' },
    category: {
      type: String,
      enum: ['food', 'travel', 'rent', 'utilities', 'groceries', 'fun', 'other'],
      default: 'other',
    },
    date: { type: Date, default: Date.now },
    splitType: { type: String, enum: ['equal', 'exact', 'percent', 'shares'], required: true },
    splits: { type: [splitSchema], required: true },
    flags: {
      anomaly: { type: Boolean, default: false },
      reason: { type: String, default: null },
      confirmedBy: { ...ref('User'), default: null },
    },
    history: { type: [Schema.Types.Mixed], default: [] },
    isDeleted: { type: Boolean, default: false },
    clientRequestId: { type: String, default: undefined },
    createdAt: { type: Date, default: Date.now },
  },
  options('expenses')
);

// ---------- settlements ----------
const settlementSchema = new Schema(
  {
    groupId: { ...ref('Group'), required: true },
    from: { ...ref('User'), required: true },
    to: { ...ref('User'), required: true },
    amount: { ...paise, required: true },
    method: { type: String, enum: ['upi', 'cash', 'other'], default: 'upi' },
    status: { type: String, enum: ['pending', 'confirmed'], default: 'pending' },
    note: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    confirmedAt: { type: Date, default: null },
  },
  options('settlements')
);

// ---------- ledger_entries (append-only, hash-chained) ----------
const ledgerSchema = new Schema(
  {
    groupId: { ...ref('Group'), required: true },
    seq: { type: Number, required: true, min: 1 },
    type: { type: String, required: true },
    refId: Schema.Types.ObjectId,
    actor: ref('User'),
    payload: { type: Schema.Types.Mixed, default: {} },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
    ts: { type: Date, default: Date.now },
  },
  { ...options('ledger_entries'), minimize: false }
);

// ---------- invites (TTL index removes them after expiresAt) ----------
const inviteSchema = new Schema(
  {
    groupId: { ...ref('Group'), required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    token: { type: String, required: true },
    invitedBy: ref('User'),
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  options('invites')
);

export const User = mongoose.model('User', userSchema);
export const Group = mongoose.model('Group', groupSchema);
export const Expense = mongoose.model('Expense', expenseSchema);
export const Settlement = mongoose.model('Settlement', settlementSchema);
export const LedgerEntry = mongoose.model('LedgerEntry', ledgerSchema);
export const Invite = mongoose.model('Invite', inviteSchema);
