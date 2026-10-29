/* ============================================================================
   AssertPro — shared browser data layer
   Loaded by every page BEFORE the page script.

   • On boot it asks the Node server (/api/health) whether MongoDB is reachable.
   • When online it pulls the whole database snapshot into localStorage, so the
     existing synchronous page code keeps working unchanged.
   • Every write helper persists to MongoDB and refreshes the local cache.
   • When the server is down the pages quietly fall back to localStorage.

   Hierarchy stored in MongoDB:  Company -> Admins -> Users -> Items
   ============================================================================ */
(function () {
  'use strict';

  const KEYS = {
    users:   'assertpro_users_v1',
    inv:     'assertpro_items_v1',
    mov:     'assertpro_movements_v1',
    act:     'assertpro_activity_v1',
    session: 'assertpro_session',
    company: 'assertpro_company',
    theme:   'assertpro_theme'
  };

  const readCache = (k, fb) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch (_) { return fb; } };
  const writeCache = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  async function api(path, options) {
    const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {}));
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((body && body.error) || ('Request failed (' + res.status + ')'));
    return body;
  }

  const AP = {
    online: false,
    ready: null,
    company: 'AssertPro',
    KEYS,

    /* ------------------------------------------------------------- caching */
    cache: {
      get users()     { return readCache(KEYS.users, []); },
      get inventory() { return readCache(KEYS.inv, []); },
      get movements() { return readCache(KEYS.mov, []); },
      get activity()  { return readCache(KEYS.act, []); }
    },
    companyName() { return readCache(KEYS.company, 'AssertPro'); },

    /* ---------------------------------------------------------------- boot */
    async boot() {
      /* drop caches written by the old pre-MongoDB demo build so no demo
         record can ever flash on screen again */
      ['panda_users_v1', 'panda_inventory_v1', 'panda_activity_v1', 'panda_session', 'panda_seeded_v1', 'panda_theme']
        .forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
      try {
        const h = await api('/api/health');
        this.online = !!(h && h.ok && h.db);
        if (this.online) await this.pull();
      } catch (_) {
        this.online = false;
      }
      /* no demo data is ever planted here: an empty database stays empty */
      document.dispatchEvent(new CustomEvent('assertpro:ready', { detail: { online: this.online } }));
      return this.online;
    },

    async pull() {
      const s = await api('/api/state');
      this.company = s.company || 'AssertPro';
      writeCache(KEYS.users, s.accounts || []);
      writeCache(KEYS.inv, s.inventory || []);
      writeCache(KEYS.mov, s.movements || []);
      writeCache(KEYS.act, s.activity || []);
      writeCache(KEYS.company, this.company);
      this.tree = s.tree || null;
      return s;
    },

    async refresh() { if (this.online) { try { await this.pull(); } catch (_) {} } },

    /* -------------------------------------------------------------- writes */
    createItem(item) {
      return api('/api/items', { method: 'POST', body: JSON.stringify(item) });
    },
    updateItem(sku, patch) {
      return api('/api/items/' + encodeURIComponent(sku), { method: 'PUT', body: JSON.stringify(patch) });
    },
    deleteItem(sku, by) {
      return api('/api/items/' + encodeURIComponent(sku) + '?by=' + encodeURIComponent(by || ''), { method: 'DELETE' });
    },
    createAccount(rec) {
      return api('/api/users', { method: 'POST', body: JSON.stringify(rec) });
    },
    updateAccount(username, patch) {
      return api('/api/users/' + encodeURIComponent(username), { method: 'PUT', body: JSON.stringify(patch) });
    },
    deleteAccount(username) {
      return api('/api/users/' + encodeURIComponent(username), { method: 'DELETE' });
    },
    addMovement(m) {
      return api('/api/movements', { method: 'POST', body: JSON.stringify(m) });
    },
    deleteMovement(id) {
      return api('/api/movements/' + encodeURIComponent(id), { method: 'DELETE' });
    },
    login(payload) {
      return api('/api/login', { method: 'POST', body: JSON.stringify(payload) });
    },
    register(payload) {
      return api('/api/register', { method: 'POST', body: JSON.stringify(payload) });
    },
    pushActivity(entry) {
      return api('/api/activity', { method: 'POST', body: JSON.stringify(entry) });
    },

    /* --------------------------------------------------------------- images
       Stock photos are downscaled in the browser and stored as a data URL,
       so a whole product image travels in the MongoDB document itself.      */
    readImage(file, maxWidth) {
      const max = maxWidth || 640;
      return new Promise((resolve, reject) => {
        if (!file || !/^image\//.test(file.type)) { reject(new Error('Please choose an image file.')); return; }
        const fr = new FileReader();
        fr.onerror = () => reject(new Error('Could not read that file.'));
        fr.onload = () => {
          const img = new Image();
          img.onerror = () => reject(new Error('That image could not be decoded.'));
          img.onload = () => {
            const scale = Math.min(1, max / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.72));
          };
          img.src = fr.result;
        };
        fr.readAsDataURL(file);
      });
    },

    /* ------------------------------------------------------------------ ETA
       Truck arrival countdown for incoming stock.                          */
    etaText(eta) {
      if (!eta) return '—';
      const t = new Date(eta).getTime();
      if (Number.isNaN(t)) return '—';
      let mins = Math.round((t - Date.now()) / 60000);
      if (mins < 0) {
        const late = Math.abs(mins);
        if (late < 60) return 'Arrived ' + late + 'm ago';
        if (late < 60 * 24) return 'Arrived ' + Math.round(late / 60) + 'h ago';
        return 'Arrived ' + Math.round(late / 1440) + 'd ago';
      }
      if (mins < 5) return 'Arriving now';
      if (mins < 60) return 'In ' + mins + 'm';
      const h = Math.floor(mins / 60), m = mins % 60;
      if (h < 24) return 'In ' + h + 'h' + (m ? ' ' + m + 'm' : '');
      const d = Math.floor(h / 24), rh = h % 24;
      return 'In ' + d + 'd' + (rh ? ' ' + rh + 'h' : '');
    },
    etaClock(eta) {
      if (!eta) return '—';
      const d = new Date(eta);
      if (Number.isNaN(d.getTime())) return '—';
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    },
    etaBadgeClass(eta) {
      if (!eta) return 'st-info';
      const mins = (new Date(eta).getTime() - Date.now()) / 60000;
      if (mins < 0) return 'st-ok';        // already arrived
      if (mins < 8 * 60) return 'st-warn'; // under 8 hours away
      return 'st-info';
    },
    escape(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    }
  };

  window.AP = AP;
  AP.ready = AP.boot();
})();
