/* ============================================================================
   AssertPro — empty the database

   Deletes every document from every AssertPro collection so the portal starts
   from a clean slate. Nothing is created to replace it: the next account you
   make is registered from the Log In page.

   Usage:
     node reset-db.js          # shows what would be deleted (dry run)
     node reset-db.js --yes    # actually empties the collections
   ============================================================================ */
'use strict';

const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'assertpro';
const COLLECTIONS = ['companies', 'admins', 'users', 'items', 'movements', 'activity'];
const confirmed = process.argv.includes('--yes');

(async () => {
  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 4000 });
  await client.connect();
  const db = client.db(DB_NAME);

  console.log('Database: ' + MONGO_URL + '/' + DB_NAME);
  console.log(confirmed ? 'Mode: DELETE' : 'Mode: dry run (add --yes to delete)\n');

  let removed = 0;
  for (const name of COLLECTIONS) {
    const before = await db.collection(name).countDocuments({});
    if (confirmed && before) await db.collection(name).deleteMany({});
    removed += before;
    console.log('  ' + name.padEnd(11) + before + ' document(s)' + (confirmed && before ? '  -> deleted' : ''));
  }

  console.log('\n' + (confirmed
    ? 'Done — ' + removed + ' document(s) removed. The portal is now empty.'
    : 'Dry run only. Nothing was deleted.'));

  await client.close();
})().catch(err => {
  console.error('\nCould not connect to MongoDB: ' + err.message);
  console.error('Make sure MongoDB is running at ' + MONGO_URL + '\n');
  process.exit(1);
});
