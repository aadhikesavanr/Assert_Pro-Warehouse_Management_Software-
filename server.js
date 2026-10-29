/* ============================================================================
   AssertPro — warehouse management API
   Node + Express + MongoDB (mongodb://localhost:27017/assertpro)

   Data model
     companies  : one document per company (name)
     admins     : admin accounts, belong to a company
     users      : staff accounts, belong to a company AND to an admin
     items      : stock records stored by a user (image + quantities)
     movements  : stock IN (with truck ETA) and stock OUT (to stores)
     activity   : audit trail of every change

   Hierarchy in the database:  Company -> Admins -> Users -> Items
   ============================================================================ */
'use strict';

const path = require('path');
const express = require('express');
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'assertpro';
const envPort = Number(process.env.PORT);
const PORT = Number.isFinite(envPort) && envPort > 0 ? envPort : 3000;

const app = express();
app.use(express.json({ limit: '12mb' })); // stock photos travel as base64 data URLs

let db = null;
let client = null;

/* ---------------------------------------------------------------- helpers */
const nowISO = () => new Date().toISOString();
const clean = (v) => String(v == null ? '' : v).trim();
const lower = (v) => clean(v).toLowerCase();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function publicUser(u) {
  return {
    username: u.username,
    displayName: u.displayName || u.username,
    role: u.role,
    company: u.company,
    adminUsername: u.adminUsername || null,
    joined: u.joined || null,
    lastUpdated: u.lastUpdated || null
  };
}

async function logActivity(entry) {
  try {
    await db.collection('activity').insertOne(Object.assign({
      company: DEFAULT_COMPANY, at: nowISO(), src: 'Manual / Web', type: 'edit'
    }, entry));
  } catch (err) { console.error('[activity]', err.message); }
}/* ------------------------------------------------------------------ config
   The database starts EMPTY. Nothing is inserted automatically: every
   company, admin, user, item and movement is created by you through the
   portal, and lands in MongoDB.                                          */
const DEFAULT_COMPANY = process.env.COMPANY_NAME || 'AssertPro';
const COLLECTIONS = ['companies', 'admins', 'users', 'items', 'movements', 'activity'];

/* ---------------------------------------------------------------- routes */

app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try { await db.command({ ping: 1 }); dbOk = true; } catch (_) {}
  res.json({ ok: true, db: dbOk, database: DB_NAME, company: DEFAULT_COMPANY, time: nowISO() });
});

/* full snapshot used by every page to hydrate its local cache */
app.get('/api/state', async (req, res) => {
  try {
    const [companies, admins, users, items, movements, activity] = await Promise.all([
      db.collection('companies').find({}).toArray(),
      db.collection('admins').find({}).toArray(),
      db.collection('users').find({}).toArray(),
      db.collection('items').find({}).toArray(),
      db.collection('movements').find({}).sort({ at: -1 }).limit(500).toArray(),
      db.collection('activity').find({}).sort({ at: -1 }).limit(500).toArray()
    ]);
    const company = (companies[0] || {}).name || DEFAULT_COMPANY;
    const accounts = [
      ...admins.map(a => Object.assign({ role:'admin' }, a)),
      ...users.map(u => Object.assign({ role:'user' }, u))
    ].map(publicUser);

    res.json({
      company,
      companies: companies.map(c => c.name),
      accounts,
      inventory: items.map(i => Object.assign({}, i, { _id: String(i._id) })),
      movements: movements.map(m => Object.assign({}, m, { _id: String(m._id) })),
      activity: activity.map(a => Object.assign({}, a, { _id: String(a._id) })),
      tree: buildTree(company, admins, users, items)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Company -> Admins (with user counts) -> Users -> Items */
function buildTree(company, admins, users, items) {
  const known = new Set(admins.map(a => lower(a.username)));
  const bag = i => ({ sku:i.sku, product:i.product, qty:i.qty, reorder:i.reorder,
                      bin:i.bin, category:i.category, image:!!i.image });
  const ownedBy = who => items.filter(i => lower(i.ownerUsername) === lower(who));
  const nodes = admins.map(a => ({
    username: a.username, displayName: a.displayName, password: a.password,
    joined: a.joined, lastUpdated: a.lastUpdated,
    userCount: 0, users: [],
    /* an admin can add stock themselves; those records are owned by the admin
       account (which is not in the users collection) so list them here instead
       of letting them disappear from the company view */
    itemCount: ownedBy(a.username).length,
    items: ownedBy(a.username).map(bag)
  }));

  // staff whose admin account does not exist yet still belong to the company,
  // so they are listed under a synthetic "no admin yet" node instead of vanishing
  const orphans = [];
  users.forEach(u => {
    const parent = lower(u.adminUsername);
    let node = parent && known.has(parent) ? nodes.find(n => lower(n.username) === parent) : null;
    if (!node) node = orphans.find(n => n.username === null) || (orphans.push({
      username: null, displayName: 'No admin yet', password: null, userCount: 0, users: []
    }) && orphans[orphans.length - 1]);
    node.users.push({
      username: u.username, displayName: u.displayName, password: u.password,
      joined: u.joined, lastUpdated: u.lastUpdated,
      itemCount: ownedBy(u.username).length,
      items: ownedBy(u.username).map(bag)
    });
    node.userCount = node.users.length;
  });

  return { company, admins: nodes.concat(orphans) };
}

app.get('/api/company/tree', async (req, res) => {
  try {
    const company = ((await db.collection('companies').findOne({})) || {}).name || DEFAULT_COMPANY;
    const [admins, users, items] = await Promise.all([
      db.collection('admins').find({}).toArray(),
      db.collection('users').find({}).toArray(),
      db.collection('items').find({}).toArray()
    ]);
    res.json(buildTree(company, admins, users, items));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ------------------------------------------------------------------ auth */
app.post('/api/login', async (req, res) => {
  try {
    const username = lower(req.body.username);
    const password = String(req.body.password == null ? '' : req.body.password);
    const wantedRole = clean(req.body.role || 'user');

    const admin = await db.collection('admins').findOne({ username });
    const staff = admin ? null : await db.collection('users').findOne({ username });
    const found = admin ? Object.assign({ role:'admin' }, admin) : (staff ? Object.assign({ role:'user' }, staff) : null);

    if (!found || found.password !== password) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    if (wantedRole && found.role !== wantedRole) {
      return res.status(403).json({ error: 'That account is registered as ' + found.role + '.' });
    }
    await logActivity({ type:'auto', by: found.displayName || found.username, src:'Login / Web',
      text: (found.displayName || found.username) + ' signed in as ' + found.role });
    res.json(Object.assign(publicUser(found), { loginAt: nowISO() }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/register', async (req, res) => {
  try {
    const displayName = clean(req.body.displayName);
    const username = lower(req.body.username);
    const password = String(req.body.password == null ? '' : req.body.password);
    const role = clean(req.body.role || 'user') === 'admin' ? 'admin' : 'user';
    const company = clean(req.body.company) || DEFAULT_COMPANY;

    if (!displayName || !username || password.length < 6) {
      return res.status(400).json({ error: 'Full name, username and a 6+ character password are required.' });
    }
    const dup = (await db.collection('admins').findOne({ username })) ||
                (await db.collection('users').findOne({ username }));
    if (dup) return res.status(409).json({ error: 'That username is already taken.' });

    if (await db.collection('companies').countDocuments({ name: company }) === 0) {
      await db.collection('companies').insertOne({ name: company, createdAt: nowISO() });
    }

    const rec = {
      company, username, password, displayName, role,
      joined: nowISO(), lastUpdated: nowISO()
    };

    if (role === 'admin') {
      await db.collection('admins').insertOne(rec);
      await logActivity({ type:'create', by:displayName, src:'Register / Web',
        text: displayName + ' registered as admin in [' + company + ']' });
      return res.status(201).json(Object.assign(publicUser(rec), { loginAt: nowISO() }));
    }

    // a new staff user is filed under an existing admin of the company
    const parent = await db.collection('admins').findOne({ company }) ||
                   await db.collection('admins').findOne({});
    rec.adminUsername = parent ? parent.username : null;
    await db.collection('users').insertOne(rec);
    await logActivity({ type:'create', by:displayName, src:'Register / Web',
      text: displayName + ' registered' + (rec.adminUsername ? ' under admin [' + rec.adminUsername + ']' : ' with no admin yet') });
    res.status(201).json(Object.assign(publicUser(rec), { loginAt: nowISO() }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ----------------------------------------------------------------- users */
app.get('/api/users', async (req, res) => {
  try {
    const [admins, users] = await Promise.all([
      db.collection('admins').find({}).toArray(),
      db.collection('users').find({}).toArray()
    ]);
    res.json([
      ...admins.map(a => Object.assign(publicUser(a), { role:'admin' })),
      ...users.map(u => Object.assign(publicUser(u), { role:'user' }))
    ]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', async (req, res) => {
  try {
    const role = clean(req.body.role) === 'admin' ? 'admin' : 'user';
    const username = lower(req.body.username);
    const password = String(req.body.password == null ? '' : req.body.password);
    const displayName = clean(req.body.displayName);
    const company = clean(req.body.company) || DEFAULT_COMPANY;
    if (!username || !displayName || password.length < 6) {
      return res.status(400).json({ error: 'Name, username and a 6+ character password are required.' });
    }
    const dup = (await db.collection('admins').findOne({ username })) ||
                (await db.collection('users').findOne({ username }));
    if (dup) return res.status(409).json({ error: 'That username is already taken.' });

    const rec = { company, username, password, displayName, role, joined: nowISO(), lastUpdated: nowISO() };
    if (role === 'admin') {
      await db.collection('admins').insertOne(rec);
    } else {
      const parent = await db.collection('admins').findOne({ company }) || await db.collection('admins').findOne({});
      rec.adminUsername = clean(req.body.adminUsername) || (parent ? parent.username : null);
      await db.collection('users').insertOne(rec);
    }
    await logActivity({ type:'create', by:'Admin Console', src:'Manual / Web',
      text: displayName + ' (' + role + ') created in [' + company + ']' });
    res.status(201).json(publicUser(rec));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/:username', async (req, res) => {
  try {
    const target = lower(req.params.username);
    const role = clean(req.body.role);
    const set = { lastUpdated: nowISO() };
    if (req.body.displayName != null) set.displayName = clean(req.body.displayName);
    if (req.body.username != null && lower(req.body.username) !== target) set.username = lower(req.body.username);
    if (req.body.password) set.password = String(req.body.password);

    const coll = role === 'admin' ? 'admins' : (role === 'user' ? 'users' : null);
    let updated = null;
    if (coll) {
      const r = await db.collection(coll).findOneAndUpdate({ username: target }, { $set: set }, { returnDocument: 'after' });
      updated = r && (r.value || r);
    } else {
      updated = await db.collection('admins').findOneAndUpdate({ username: target }, { $set: set }, { returnDocument:'after' });
      if (!updated) updated = await db.collection('users').findOneAndUpdate({ username: target }, { $set: set }, { returnDocument:'after' });
    }
    if (!updated) return res.status(404).json({ error: 'User not found.' });
    await logActivity({ type:'edit', by:'Admin Console', src:'Manual / Web',
      text: '[' + target + '] account updated' });
    res.json(publicUser(updated));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:username', async (req, res) => {
  try {
    const target = lower(req.params.username);
    const a = await db.collection('admins').deleteOne({ username: target });
    const u = await db.collection('users').deleteOne({ username: target });
    if (a.deletedCount + u.deletedCount === 0) return res.status(404).json({ error: 'User not found.' });
    await logActivity({ type:'delete', by:'Admin Console', src:'Manual / Web',
      text: '[' + target + '] account deleted' });
    res.json({ ok: true, deleted: target });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ----------------------------------------------------------------- items */
app.get('/api/items', async (req, res) => {
  try {
    const items = await db.collection('items').find({}).sort({ sku: 1 }).toArray();
    res.json(items.map(i => Object.assign({}, i, { _id: String(i._id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function nextSku() {
  const items = await db.collection('items').find({}, { projection: { sku: 1 } }).toArray();
  let max = 1000;
  items.forEach(i => { const m = /^SKU-(\d+)$/.exec(String(i.sku || '')); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  return 'SKU-' + (max + 1);
}

app.post('/api/items', async (req, res) => {
  try {
    const b = req.body || {};
    const product = clean(b.product);
    if (!product) return res.status(400).json({ error: 'Product name is required.' });
    const sku = clean(b.sku) || await nextSku();
    if (await db.collection('items').findOne({ sku })) {
      return res.status(409).json({ error: 'SKU ' + sku + ' already exists.' });
    }
    // keep the Company -> Admin -> User -> Item chain intact: the item is filed
    // under whoever owns it and under that user's admin
    const ownerUsername = clean(b.ownerUsername) || null;
    let adminUsername = clean(b.adminUsername) || null;
    if (ownerUsername && !adminUsername) {
      const owner = await db.collection('users').findOne({ username: lower(ownerUsername) });
      adminUsername = (owner && owner.adminUsername) || null;
    }

    const rec = {
      company: clean(b.company) || DEFAULT_COMPANY,
      sku, product,
      description: clean(b.description) || null,
      category: clean(b.category) || 'Other',
      supplier: clean(b.supplier) || 'Unassigned',
      bin: clean(b.bin) || 'A-12',
      qty: num(b.qty), reorder: num(b.reorder),
      image: b.image || null,
      inspection: b.inspection || null,
      warranty: b.warranty || null,
      ownerUsername,
      adminUsername,
      createdAt: nowISO(), updatedAt: nowISO()
    };
    await db.collection('items').insertOne(rec);
    await logActivity({ type:'create', by: clean(b.by) || 'Warehouse Staff', src:'Manual / Web', sku,
      text: '[' + sku + '] record added in [Inventory]' });
    res.status(201).json(Object.assign({}, rec, { _id: String(rec._id) }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/items/:sku', async (req, res) => {
  try {
    const sku = clean(req.params.sku);
    const b = req.body || {};
    const set = { updatedAt: nowISO() };
    ['product','description','category','supplier','bin','inspection','warranty','ownerUsername','adminUsername'].forEach(k => {
      if (b[k] !== undefined) set[k] = b[k] === null ? null : clean(b[k]);
    });
    if (b.qty !== undefined) set.qty = num(b.qty);
    if (b.reorder !== undefined) set.reorder = num(b.reorder);
    if (b.image !== undefined) set.image = b.image || null;

    const updated = await db.collection('items').findOneAndUpdate({ sku }, { $set: set }, { returnDocument: 'after' });
    if (!updated) return res.status(404).json({ error: 'Item not found.' });
    res.json(Object.assign({}, updated, { _id: String(updated._id) }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/items/:sku', async (req, res) => {
  try {
    const sku = clean(req.params.sku);
    const r = await db.collection('items').deleteOne({ sku });
    if (r.deletedCount === 0) return res.status(404).json({ error: 'Item not found.' });
    await logActivity({ type:'delete', by: clean(req.query.by) || 'Warehouse Staff', src:'Manual / Web', sku,
      text: '[' + sku + '] record deleted in [Inventory]' });
    res.json({ ok: true, deleted: sku });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ------------------------------------------------------------- movements */
app.get('/api/movements', async (req, res) => {
  try {
    const q = {};
    if (req.query.type) q.type = clean(req.query.type);
    const list = await db.collection('movements').find(q).sort({ at: -1 }).limit(500).toArray();
    res.json(list.map(m => Object.assign({}, m, { _id: String(m._id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/movements', async (req, res) => {
  try {
    const b = req.body || {};
    const type = clean(b.type) === 'out' ? 'out' : 'in';
    const sku = clean(b.sku);
    const qty = num(b.qty);
    if (!sku) return res.status(400).json({ error: 'Select a SKU.' });
    if (qty <= 0) return res.status(400).json({ error: 'Quantity must be greater than zero.' });
    if (type === 'in' && !b.eta) return res.status(400).json({ error: 'An incoming delivery needs a truck ETA.' });

    const item = await db.collection('items').findOne({ sku });
    const rec = {
      company: clean(b.company) || DEFAULT_COMPANY,
      type, sku,
      product: item ? item.product : clean(b.product) || sku,
      qty,
      party: clean(b.party) || (type === 'in' ? (item && item.supplier) || 'Supplier' : 'Store'),
      bin: clean(b.bin) || (item ? item.bin : ''),
      status: clean(b.status) || (type === 'in' ? 'In Transit' : 'Dispatched'),
      eta: type === 'in' ? new Date(b.eta).toISOString() : null,
      vehicle: clean(b.vehicle) || null,
      driver: clean(b.driver) || null,
      ref: clean(b.ref) || null,
      notes: clean(b.notes) || null,
      by: clean(b.by) || 'Warehouse Staff',
      at: nowISO()
    };
    // an outgoing movement is recorded against stock immediately
    if (type === 'out' && item) {
      const newQty = Math.max(0, num(item.qty) - qty);
      await db.collection('items').updateOne({ sku }, { $set: { qty: newQty, updatedAt: nowISO() } });
      await logActivity({ type:'edit', by:rec.by, src:'Form / Web', sku, field:'Quantity',
        from:String(item.qty), to:String(newQty),
        text:'[' + sku + '] stock out ' + qty + ' to ' + rec.party });
    } else {
      await logActivity({ type:'edit', by:rec.by, src:'Form / Web', sku, field:'Incoming',
        to:String(qty), text:'[' + sku + '] incoming ' + qty + ' from ' + rec.party + ' (ETA ' + rec.eta + ')' });
    }

    const r = await db.collection('movements').insertOne(rec);
    res.status(201).json(Object.assign({}, rec, { _id: String(r.insertedId) }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/movements/:id', async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const _id = new ObjectId(req.params.id);
    const set = {};
    ['status','eta','vehicle','driver','ref','notes'].forEach(k => { if (req.body[k] !== undefined) set[k] = req.body[k]; });
    if (set.eta) set.eta = new Date(set.eta).toISOString();
    const updated = await db.collection('movements').findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
    if (!updated) return res.status(404).json({ error: 'Movement not found.' });
    res.json(Object.assign({}, updated, { _id: String(updated._id) }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/movements/:id', async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const r = await db.collection('movements').deleteOne({ _id: new ObjectId(req.params.id) });
    if (r.deletedCount === 0) return res.status(404).json({ error: 'Movement not found.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/movements', async (req, res) => {
  try {
    await db.collection('movements').deleteMany({});
    res.json({ ok: true, cleared: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* -------------------------------------------------------------- activity */
app.get('/api/activity', async (req, res) => {
  try {
    const list = await db.collection('activity').find({}).sort({ at: -1 }).limit(500).toArray();
    res.json(list.map(a => Object.assign({}, a, { _id: String(a._id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/activity', async (req, res) => {
  try {
    await logActivity(Object.assign({ by:'System' }, req.body || {}));
    res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ---------------------------------------------------- static front end */
app.use((req, res, next) => {
  if(req.path.startsWith('/node_modules') || req.path.startsWith('/.')) return res.status(404).end();
  next();
});
app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'panda-warehouse.html')));

/* ------------------------------------------------------------------ boot */
async function boot() {
  client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 4000 });
  await client.connect();
  db = client.db(DB_NAME);
  await db.command({ ping: 1 });
  console.log('Collections  ->  ' + COLLECTIONS.join(', '));
  console.log('Start empty  ->  register your first admin at /panda-login.html');
  app.listen(PORT, () => {
    console.log('AssertPro server  ->  http://localhost:' + PORT);
    console.log('MongoDB           ->  ' + MONGO_URL + '/' + DB_NAME);
  });
}

boot().catch(err => {
  console.error('\nCould not start AssertPro server.');
  console.error('MongoDB error: ' + err.message);
  console.error('Make sure MongoDB is running and reachable at ' + MONGO_URL + '\n');
  process.exit(1);
});
