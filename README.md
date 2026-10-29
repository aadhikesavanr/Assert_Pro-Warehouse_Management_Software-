# AssertPro — Warehouse Management Portal

Node + Express + **MongoDB** (`mongodb://localhost:27017/assertpro`).
The database starts **completely empty** — there is no built-in/sample data anywhere.
Everything you create in the portal is written to MongoDB and read back from it.

## Run it

```bash
# 1. make sure MongoDB is running on localhost:27017
# 2. install once
npm install
# 3. start the web + API server (leave this terminal open)
npm start
```

Then open **http://localhost:3000** and click **Open the Portal** (or go straight to
**http://localhost:3000/panda-login.html**).

### First run — create your own login

There are **no accounts** at first, so:

1. On the login page click **Register**.
2. Pick the **Admin** role, fill in name / username / password (6+ chars).
3. Press **Create account** — the record is inserted into the MongoDB `admins`
   collection and you are signed in.

Staff accounts work the same way: register with the **User** role (or create them from
the admin console's *Users* tab) and they are filed under your admin account in the
`users` collection.

### Cross-check MongoDB

The fastest way — one command that dumps everything the portal wrote, straight
from the database:

```bash
npm run db          # full dump + the Company > Admin > User > Item chain
npm run db:counts   # counts only
```

Or query MongoDB by hand:

```bash
mongosh assertpro --eval 'db.admins.find({}, {username:1, role:1}).pretty()'
mongosh assertpro --eval 'db.users.find({}, {username:1, adminUsername:1}).pretty()'
mongosh assertpro --eval 'db.items.find({}, {sku:1, product:1, qty:1, bin:1}).pretty()'
mongosh assertpro --eval 'db.movements.find({}, {type:1, sku:1, qty:1, eta:1}).pretty()'
```

### Start over / clear everything

```bash
npm run reset:check   # dry run — shows the document count per collection
npm run reset         # deletes every document
```

Environment overrides: `MONGO_URL`, `DB_NAME`, `COMPANY_NAME`, `PORT` (default 3000).

## Pages

| File | Purpose |
|------|---------|
| `panda-warehouse.html` | Public landing page — its counters are read live from MongoDB |
| `panda-login.html` | Log in / register (new accounts are written to MongoDB) |
| `panda-user.html` | Staff portal — inventory, add/edit/delete, photos, stock in/out |
| `panda-admin.html` | Admin console — users, inventory, stock in/out, company tree |
| `assertpro-db.js` | Shared browser data layer (API bridge + read-only localStorage cache) |
| `server.js` | Express API + MongoDB connection |
| `reset-db.js` | Empties every collection (`npm run reset`) |
| `check-db.js` | Read-only dump of everything in MongoDB (`npm run db`) |

## Database model (`assertpro`)

```
companies  { name }                                     e.g. "AssertPro"
admins     { company, username, password, displayName }  belongs to a company
users      { company, adminUsername, username, password, displayName }
items      { company, sku, product, description, category, supplier, bin, qty,
             reorder, image, ownerUsername, adminUsername, inspection, warranty }
movements  { company, type: 'in' | 'out', sku, qty, party, bin, status,
             eta, vehicle, driver, ref, by, at }
activity   { company, at, by, src, type, sku, field, from, to, text }
```

Hierarchy: **Company → Admins → Users → Items**. In the admin console open the
**Company** tab and click *AssertPro* → an admin → a user to drill down to the items
that user stores in the warehouse. Staff who register before any admin exists are
listed under a *No admin yet* node instead of disappearing, and stock an admin adds
themselves is listed under that admin (*added by the admin*) rather than being lost.

## API

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/health` | Server + MongoDB status |
| GET | `/api/state` | Full snapshot (accounts, inventory, movements, activity, tree) |
| POST | `/api/login` / `/api/register` | Auth — credentials are checked/stored in MongoDB |
| GET/POST/PUT/DELETE | `/api/users[/:username]` | Account management |
| GET/POST/PUT/DELETE | `/api/items[/:sku]` | Stock records incl. base64 photos |
| GET/POST/PUT/DELETE | `/api/movements[/:id]` | Stock in (with truck ETA) and stock out |
| GET/POST | `/api/activity` | Audit trail |

## Feature notes

- **Delete** — every inventory row has a *Delete* button (plus one in the record view).
  It removes the document from the `items` collection.
- **Photos** — add / replace / remove a stock image from the create modal, the record
  view or the side drawer. The image is downscaled in the browser to a JPEG data URL
  and stored on the item document itself.
- **Profile menu** — the avatar (top right) opens a menu with your name, role, company,
  stock shortcuts and a **Log Out** key.
- **Icon rail** — the leftmost buttons under the clock work: collections, activity,
  stock in/out, add item and the account menu.
- **Stock in / stock out** — incoming rows show the **truck ETA** as a live countdown
  ("In 4h 23m — Truck arrives Oct 12, 4:11 PM") with vehicle and driver; outgoing rows
  go to a store and **deduct inventory automatically**.
- **Offline fallback** — if the server is stopped the pages still render from the last
  cached snapshot, but nothing is saved to MongoDB. Always use `npm start`.

> **Before real use:** passwords are stored in plain text (admin console shows them so
> you can cross-check the database). Hash them with bcrypt and stop returning passwords
> from `/api/state` before this touches real accounts, and note that a stale session is
> rejected once its account no longer exists.
