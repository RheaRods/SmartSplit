// Creates the 6 collections with $jsonSchema validators + all indexes.
// Safe to run more than once. Run with:  npm run setup-db
import 'dotenv/config';
import mongoose from 'mongoose';

const { MONGO_URI } = process.env;
if (!MONGO_URI || !MONGO_URI.startsWith('mongodb')) {
  console.error('MONGO_URI is missing or invalid in server/.env');
  process.exit(1);
}

await mongoose.connect(MONGO_URI, { dbName: 'splitsmart' });
const db = mongoose.connection.db;

const oid = { bsonType: 'objectId' };
const paise = { bsonType: 'number', minimum: 1, multipleOf: 1 }; // whole paise only

const validators = {
  users: {
    bsonType: 'object',
    required: ['name', 'email', 'passwordHash'],
    properties: {
      name: { bsonType: 'string' },
      email: { bsonType: 'string' },
      passwordHash: { bsonType: 'string' },
    },
  },
  groups: {
    bsonType: 'object',
    required: ['name', 'members', 'currency'],
    properties: {
      name: { bsonType: 'string' },
      currency: { bsonType: 'string' },
      members: {
        bsonType: 'array',
        minItems: 1,
        items: {
          bsonType: 'object',
          required: ['userId', 'role'],
          properties: { userId: oid, role: { enum: ['admin', 'member'] } },
        },
      },
    },
  },
  expenses: {
    bsonType: 'object',
    required: ['groupId', 'paidBy', 'amount', 'splitType', 'splits', 'date'],
    properties: {
      groupId: oid,
      paidBy: oid,
      amount: paise,
      splitType: { enum: ['equal', 'exact', 'percent', 'shares'] },
      category: { enum: ['food', 'travel', 'rent', 'utilities', 'groceries', 'fun', 'other'] },
      splits: {
        bsonType: 'array',
        minItems: 1,
        items: {
          bsonType: 'object',
          required: ['userId', 'share'],
          properties: { userId: oid, share: { bsonType: 'number', minimum: 0, multipleOf: 1 } },
        },
      },
    },
  },
  settlements: {
    bsonType: 'object',
    required: ['groupId', 'from', 'to', 'amount', 'status'],
    properties: {
      groupId: oid,
      from: oid,
      to: oid,
      amount: paise,
      status: { enum: ['pending', 'confirmed'] },
    },
  },
  ledger_entries: {
    bsonType: 'object',
    required: ['groupId', 'seq', 'type', 'hash', 'prevHash'],
    properties: {
      groupId: oid,
      seq: { bsonType: 'number', minimum: 1 },
      type: { bsonType: 'string' },
      hash: { bsonType: 'string' },
      prevHash: { bsonType: 'string' },
    },
  },
  invites: {
    bsonType: 'object',
    required: ['groupId', 'email', 'token', 'expiresAt'],
    properties: {
      groupId: oid,
      email: { bsonType: 'string' },
      token: { bsonType: 'string' },
      expiresAt: { bsonType: 'date' },
    },
  },
};

const indexes = {
  users: [[{ email: 1 }, { unique: true, name: 'email_unique' }]],
  groups: [[{ 'members.userId': 1 }, { name: 'members_userId' }]],
  expenses: [
    [{ groupId: 1, date: -1 }, { name: 'group_date' }],
    [{ groupId: 1, category: 1, date: -1 }, { name: 'group_category_date' }],
    [{ 'splits.userId': 1 }, { name: 'splits_userId' }],
    [{ description: 'text' }, { name: 'description_text' }],
    [
      { groupId: 1, clientRequestId: 1 },
      {
        unique: true,
        name: 'group_clientRequest_unique',
        partialFilterExpression: { clientRequestId: { $exists: true } },
      },
    ],
  ],
  settlements: [[{ groupId: 1, status: 1 }, { name: 'group_status' }]],
  ledger_entries: [[{ groupId: 1, seq: 1 }, { unique: true, name: 'group_seq_unique' }]],
  invites: [
    [{ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'invite_ttl' }],
    [{ token: 1 }, { unique: true, name: 'token_unique' }],
  ],
};

// ---- collections + validators ----
const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
for (const [name, schema] of Object.entries(validators)) {
  const validator = { $jsonSchema: schema };
  if (existing.has(name)) {
    await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
    console.log(`updated validator : ${name}`);
  } else {
    await db.createCollection(name, { validator });
    console.log(`created collection: ${name}`);
  }
}

// ---- indexes ----
for (const [name, list] of Object.entries(indexes)) {
  for (const [keys, options] of list) await db.collection(name).createIndex(keys, options);
}
console.log('\nIndexes:');
for (const name of Object.keys(indexes)) {
  const idx = await db.collection(name).indexes();
  console.log(`  ${name}: ${idx.map((i) => i.name).join(', ')}`);
}

// ---- validator test (screenshot this for the journal) ----
try {
  await db.collection('expenses').insertOne({
    groupId: new mongoose.Types.ObjectId(),
    paidBy: new mongoose.Types.ObjectId(),
    amount: -5,
    splitType: 'equal',
    splits: [{ userId: new mongoose.Types.ObjectId(), share: 1 }],
    date: new Date(),
  });
  console.log('\nWARNING: invalid expense was accepted - validator is not working!');
} catch (err) {
  console.log(`\nValidator test passed: invalid expense (amount -5) rejected -> "${err.message}"`);
}

await mongoose.disconnect();