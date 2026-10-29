/* ============================================================================
   AssertPro — cross-check the database

   Read-only. Prints every document the portal has written to MongoDB, plus the
   Company -> Admin -> User -> Item chain, so you can compare it side by side
   with what the pages show.

   Usage:
     node check-db.js          # full dump
     node check-db.js --counts # counts only
   ============================================================================ */
'use strict';

const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'assertpro';
const COLLECTIONS = ['companies', 'admins', 'users', 'items', 'movements', 'activity'];
const countsOnly = process.argv.includes('--counts');

const line = '='.repeat(64);
const mask = doc => {
  const d = Object.assign({}, doc);
  delete d._id;
  if (typeof d.image === 'string') d.image = '<' + d.image.length + ' chars of image data>';
  return d;
};
(async () => {
  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 4000 });
  await client.connect();
  const db = client.db(DB_NAME);

  console.log(line);
  console.log('MongoDB  ' + MONGO_URL + '/' + DB_NAME);
  console.log(line);

  console.log('\n-- document counts --');
  for (const name of COLLECTIONS) {
    console.log('   ' + name.padEnd(12) + await db.collection(name).countDocuments({}));
  }
  const total = (await Promise.all(COLLECTIONS.map(c => db.collection(c).countDocuments({}))))
    .reduce((a, b) => a + b, 0);

  if (total === 0) {
    console.log('\nThe database is completely empty — this is the expected state before');
    console.log('you register your first account at http://localhost:3000/panda-login.html');
  } else if (!countsOnly) {
    console.log('\n-- companies --');
    (await db.collection('companies').find({}).toArray()).forEach(d => console.log('   ' + JSON.stringify(mask(d))));
    console.log('\n-- admins --');
    (await db.collection('admins').find({}).toArray()).forEach(d => console.log('   ' + JSON.stringify(mask(d))));
    console.log('\n-- users --');
    (await db.collection('users').find({}).toArray()).forEach(d => console.log('   ' + JSON.stringify(mask(d))));
    console.log('\n-- items --');
    (await db.collection('items').find({}).sort({ sku: 1 }).toArray())
      .forEach(d => console.log('   ' + JSON.stringify(mask(d))));
    console.log('\n-- movements --');
    (await db.collection('movements').find({}).sort({ at: -1 }).toArray())
      .forEach(d => console.log('   ' + JSON.stringify(mask(d))));
    console.log('\n-- activity --');
    (await db.collection('activity').find({}).sort({ at: -1 }).limit(40).toArray())
      .forEach(d => console.log('   ' + JSON.stringify(mask(d))));
    console.log('\n-- passphrases (plain text, shown so you can verify) --');
    (await db.collection('admins').find({}).toArray()).forEach(a => console.log('   admin  ' + a.username + ' / ' + a.password));
    (await db.collection('users').find({}).toArray()).forEach(u => console.log('   staff  ' + u.username + ' / ' + u.password));
  }

  console.log('\n-- company > admin > user > item chain --');
  const companies = await db.collection('companies').find({}).toArray();
  if (!companies.length) console.log('   (no company yet)');
  for (const co of companies) {
    console.log('   ' + co.name);
    const admins = await db.collection('admins').find({ company: co.name }).toArray();
    if (!admins.length) console.log('     (no admin yet)');
    for (const a of admins) {
      const users = await db.collection('users').find({ adminUsername: a.username }).toArray();
      console.log('     +-- ' + a.username + ' (admin) -> ' + users.length + ' user(s)');
      for (const u of users) {
        const items = await db.collection('items').find({ ownerUsername: u.username }).toArray();
        console.log('         +-- ' + u.username + ' -> ' + items.length + ' item(s)');
        items.forEach(i => console.log('             - ' + i.sku + '  ' + i.product +
          '  qty=' + i.qty + '  bin=' + i.bin + (i.image ? '  [photo]' : '')));
      }
    }
  }
  const orphans = await db.collection('users').countDocuments({ $or: [{ adminUsername: null }, { adminUsername: { $exists: false } }] });
  if (orphans) console.log('     +-- (No admin yet) -> ' + orphans + ' user(s)');

  console.log('\n' + line);
  console.log('total documents: ' + total);
  console.log(line + '\n');

  await client.close();
})().catch(err => {
  console.error('\nCould not connect to MongoDB: ' + err.message);
  console.error('Make sure MongoDB is running at ' + MONGO_URL + '\n');
  process.exit(1);
});
