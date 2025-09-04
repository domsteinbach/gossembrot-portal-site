/* helpers */
async function signalDbReady() {
    const list = await self.clients.matchAll({ type: 'window' });
    for (const c of list) c.postMessage({ type: 'DB_READY' });
}

/* scope helpers */
const SCOPE  = (self.registration && self.registration.scope) || new URL('./', self.location.href).toString();
const scoped = (p) => new URL(p, SCOPE).toString();

/* bump this when you republish DB */
const DB_URL = 'assets/db/app.sqlite?v=2';

/* load sql.js at parse/install */
importScripts(scoped('assets/sqljs/sql-wasm.js'));
const SQL_READY = initSqlJs({ locateFile: (f) => scoped(`assets/sqljs/${f}`) });

/* install/activate */
self.addEventListener('install', (e) => {
    e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
        await self.clients.claim();
        try {
            await initDb();          // warm once
            await signalDbReady();   // tell controlled pages
        } catch (e) {
            // also tell pages it failed so the initializer can decide
            const list = await self.clients.matchAll({ type: 'window' });
            for (const c of list) c.postMessage({ type: 'DB_ERROR', error: String(e?.message || e) });
        }
    })());
});

/* lazy-open DB */
let dbPromise;
async function initDb() {
    if (dbPromise) return dbPromise;
    const SQL  = await SQL_READY;
    const resp = await fetch(scoped(DB_URL), { cache: 'force-cache' });
    if (!resp.ok) throw new Error(`DB fetch failed: ${resp.status} ${resp.statusText}`);
    const buf  = await resp.arrayBuffer();
    const db   = new SQL.Database(new Uint8Array(buf));
    dbPromise  = Promise.resolve(db);
    return dbPromise;
}

/* message handshake */
self.addEventListener('message', async (event) => {
    if (event?.data?.type === 'PING_DB') {
        try {
            await initDb();
            event.source?.postMessage?.({ type: 'DB_READY' });
        } catch (e) {
            event.source?.postMessage?.({ type: 'DB_ERROR', error: String(e?.message || e) });
        }
    }
});

/* paths */
const apiPath    = new URL('api', SCOPE).pathname;
const loginPath  = new URL('login', SCOPE).pathname;
const updatePath = new URL('update', SCOPE).pathname;

/* fetch handler */
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    if (url.origin !== location.origin) return;

    // readiness GET (handy for diagnostics)
    if (request.method === 'GET' && (url.pathname === apiPath || url.pathname === apiPath + '/')) {
        event.respondWith((async () => {
            try { await initDb(); } catch {}
            return new Response(JSON.stringify({ ready: !!dbPromise }), {
                headers: { 'Content-Type': 'application/json' }
            });
        })());
        return;
    }

    // forbid auth/writes
    const isLogin  = request.method === 'POST' && url.pathname === loginPath;
    const isUpdate = (request.method === 'PUT' || request.method === 'POST') && url.pathname === updatePath;
    if (isLogin || isUpdate) {
        event.respondWith(new Response(JSON.stringify({ error: 'Forbidden in static build' }), {
            status: 403, headers: { 'Content-Type': 'application/json' }
        }));
        return;
    }

    // SQL POSTs
    const isSqlPost = request.method === 'POST' && (url.pathname === apiPath || url.pathname === apiPath + '/');
    if (!isSqlPost) return;

    event.respondWith((async () => {
        try {
            const { query, data } = await request.clone().json();
            if (typeof query !== 'string' || !query.trim()) {
                return new Response(JSON.stringify({ error: 'Bad Request' }), {
                    status: 400, headers: { 'Content-Type': 'application/json' }
                });
            }
            if (/(^|\W)users(\W|$)/i.test(query)) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403, headers: { 'Content-Type': 'application/json' }
                });
            }

            const db = await initDb();
            const rows = [];
            const stmt = db.prepare(query);
            try {
                stmt.bind(Array.isArray(data) ? data : []);
                while (stmt.step()) rows.push(stmt.getAsObject());
            } finally { stmt.free(); }

            return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } });
        } catch (e) {
            return new Response(JSON.stringify({ error: 'Internal Server Error', details: String(e?.message || e) }), {
                status: 500, headers: { 'Content-Type': 'application/json' }
            });
        }
    })());
});
