// Local audit harness. Not a Pages route and never deploy this server to production.
// Uses real auth handlers/SQLite and the real shared client; does not render the Astro application.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { SQLiteD1 } from '../../tests/support/d1-sqlite.mjs';
import { hashPassword, ensureTables } from '../../functions/_shared/helpers.ts';
import { onRequest } from '../../functions/_middleware.ts';
import { onRequestPost as login } from '../../functions/api/auth/login.ts';
import { onRequestPost as session } from '../../functions/api/auth/session.ts';
import { onRequestPost as logout } from '../../functions/api/auth/logout.ts';
const db = new SQLiteD1();
await ensureTables(db);
await db.prepare(`INSERT INTO system_users(id,name,username,password_hash,role,active,created_at) VALUES('browser-user','Browser Test','browser-user',?,'admin',1,?)`).bind(await hashPassword('Test-Only-Password-97!'), new Date().toISOString()).run();
const functions = { '/api/auth/login': login, '/api/auth/session': session, '/api/auth/logout': logout };
const fixture = `<!doctype html><html><head><meta charset="UTF-8"><title>V97 local session fixture</title><script src="/system-session.js"></script></head><body><h1>Local session fixture (not Astro UI)</h1><textarea id="unsaved">unsaved draft</textarea><button data-logout>Logout</button><script>window.initialReady=window.MilgyoSession.ready();</script></body></html>`;
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const url = `http://${incoming.headers.host}${incoming.url}`;
    const path = new URL(url).pathname;
    if (path === '/__test/expire') { await db.prepare('DELETE FROM system_sessions').run(); outgoing.end('expired'); return; }
    if (path === '/') { outgoing.setHeader('Content-Type','text/html'); outgoing.end(fixture); return; }
    if (path === '/system-session.js') { outgoing.setHeader('Content-Type','application/javascript'); outgoing.setHeader('Cache-Control','no-store'); outgoing.end(readFileSync('public/system-session.js')); return; }
    const req = new Request(url, { method: incoming.method, headers: incoming.headers,
      ...(!['GET','HEAD'].includes(incoming.method) ? { body: Buffer.concat(chunks) } : {}) });
    const context = request => ({ request, env: { DB: db }, params: {}, data: {}, next: async () => new Response('unused'), waitUntil() {}, passThroughOnException() {} });
    const response = await onRequest({ ...context(req), next: async (forwarded = req) => {
      if (functions[path]) return functions[path](context(forwarded));
      if (path === '/secretary_general.png') return new Response(readFileSync('public/secretary_general.png'), { headers: { 'Content-Type':'image/png' } });
      if (path === '/chongmuwonjang_seal.png') return new Response(readFileSync('public/chongmuwonjang_seal.png'), { headers: { 'Content-Type':'image/png' } });
      if (path === '/api/temporary-error') return Response.json({ ok:false, message:'temporary SQL failure' }, { status:503 });
      if (path === '/api/raw-401') return Response.json({ok:false, message:'upstream'}, {status:401});
      if (path === '/api/html-gateway') return new Response('<h1>Access login</h1>', {status:401, headers:{'Content-Type':'text/html'}});
      if (path === '/api/slow-expired') { await new Promise(resolve => setTimeout(resolve, 500)); return Response.json({ok:false,code:'SESSION_EXPIRED'}, {status:401}); }
      return Response.json({ok:false,code:'NOT_FOUND'}, {status:404});
    }});
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { outgoing.statusCode = 500; outgoing.end('harness error'); console.error(error); }
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({port:server.address().port})));
const close = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM',close); process.on('SIGINT',close);
