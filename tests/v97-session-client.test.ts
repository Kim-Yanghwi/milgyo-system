import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Web transport/state tests in a VM: real Fetch Request/Response APIs, mocked DOM and network.
// They are not a built Astro browser E2E or Cloudflare integration test.
const code = readFileSync('public/system-session.js', 'utf8');
function harness({ initial = null, storageBlocked = false, loginVisible = false } = {} as any) {
  const store = new Map<string,string>();
  if (initial) store.set('milgyo-system-session', JSON.stringify(initial));
  const storage = { getItem: (key: string) => { if (storageBlocked) throw Error('blocked'); return store.get(key) || null; }, setItem: (key: string, value: string) => { if (storageBlocked) throw Error('blocked'); store.set(key, value); }, removeItem: (key: string) => { if (storageBlocked) throw Error('blocked'); store.delete(key); } };
  const events: any[] = [], listeners = new Map<string,Function[]>(), calls: any[] = [], elements = new Map();
  let responder = async () => Response.json({ ok: false, code: 'SESSION_REQUIRED' }, {status:401});
  const window: any = {
    fetch: async (...args: any[]) => { calls.push(args); return responder(...args); },
    addEventListener: (name: string, cb: Function) => listeners.set(name, [...(listeners.get(name)||[]), cb]),
    dispatchEvent: (event: any) => { events.push(event); for (const cb of listeners.get(event.type)||[]) cb(event); return true; },
    alert: (message: string) => events.push({type:'alert',message}),
  };
  const document: any = {
    body: { append: (element: any) => elements.set(element.id, element) },
    addEventListener: (name: string, cb: Function) => listeners.set('doc:'+name, [...(listeners.get('doc:'+name)||[]), cb]),
    getElementById: (id: string) => elements.get(id),
    querySelector: (selector: string) => selector === '[data-login-screen]' && loginVisible ? { hidden: false } : null,
    createElement: () => ({ style: {}, append() {}, setAttribute() {}, remove() { elements.delete(this.id); } }),
  };
  const location: any = { href:'https://system.example.test/', origin:'https://system.example.test', replace: (url:string)=>events.push({type:'replace',url}), reload: ()=>events.push({type:'reload'}) };
  class CustomEvent { constructor(public type: string, public detail: any) { this.detail = detail?.detail; } }
  const sandbox = { window, document, location, localStorage: storage, sessionStorage: { removeItem() {} }, CustomEvent,
    Element: class {}, URL, Headers, Request, Response, AbortController, DOMException, setTimeout, clearTimeout, console };
  vm.runInNewContext(code, sandbox);
  return { api: window.MilgyoSession, calls, events, store, elements,
    respond: (fn: any) => responder = fn, dispatch: (name:string, value:any) => window.dispatchEvent({type:name,...value}) };
}
const metadata = (id='u1') => ({ ok:true, expiresAt:new Date(Date.now()+43_200_000).toISOString(), issuedAt:new Date().toISOString(), user:{id, name:'Test',role:'user', department:'office'} });
const req = { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' };

test('client removes legacy bearer credentials and never persists the compatibility marker', () => {
  const h = harness({initial:{token:'secret-bearer',user:{id:'u1'},savedAt:Date.now()}});
  assert.equal(h.api.peek(),null); assert.equal(h.store.size,0);
  const m = metadata(); h.api.set({...m, token:'secret-bearer', other:'private'});
  const raw = h.store.get('milgyo-system-session')!; assert.ok(!raw.includes('secret-bearer')); assert.ok(!raw.includes('cookie-session')); assert.ok(!raw.includes('savedAt'));
  assert.equal(h.api.peek().token,'cookie-session'); assert.equal(h.api.peek().expiresAt,m.expiresAt);
});

test('ready coalesces simultaneous session checks and uses credentialed same-origin transport', async () => {
  const h = harness(), m=metadata(); h.respond(async()=>Response.json(m));
  const r = await Promise.all([h.api.ready(),h.api.ready(),h.api.ready()]);
  assert.equal(h.calls.length,1); assert.ok(r.every(x=>x.user.id==='u1'));
  const options = h.calls[0][1]; assert.equal(options.credentials,'same-origin'); assert.equal(options.cache,'no-store'); assert.equal(options.headers.get('X-Milgyo-Request'),'1');
  await assert.rejects(h.api.fetch('https://evil.test/api/action',req));
  await assert.rejects(h.api.fetch('/not-api',req));
});

test('profile update never silently extends server expiry', () => {
  const h=harness(),m=metadata(); h.api.set(m); const old=h.api.peek(); h.api.set({...old,user:{...old.user,name:'Changed'}});
  assert.equal(h.api.peek().expiresAt,m.expiresAt); assert.equal(h.api.peek().issuedAt,m.issuedAt); assert.equal(h.api.peek().user.name,'Changed');
  assert.throws(()=>h.api.set({user:{id:'u1'},savedAt:Date.now()}));
});

for (const response of ['invalid-password','raw-401','html-gateway','temporary-503','network-failure']) test(`transient or non-session error does not logout: ${response}`, async () => {
  const m=metadata(),h=harness({initial:{...m,version:2}});
  h.respond(async()=>{
    if(response==='network-failure')throw Error('offline');
    if(response==='html-gateway')return new Response('Access login',{status:401,headers:{'Content-Type':'text/html'}});
    return Response.json({ok:false,...(response==='invalid-password'?{code:'INVALID_CREDENTIALS'}:{})},{status:response==='temporary-503'?503:401});
  });
  await h.api.ready(); assert.equal(h.api.peek().user.id,'u1'); assert.ok(h.store.size>0); assert.ok(!h.events.some(e=>e.type==='milgyo:session-ended'));
});

for(const authCode of ['SESSION_REQUIRED','SESSION_EXPIRED','ACCOUNT_DISABLED']) test(`genuine authentication failure clears metadata once: ${authCode}`,async()=>{
  const h=harness();h.api.set(metadata());h.respond(async()=>Response.json({ok:false,code:authCode},{status:401}));
  await h.api.fetch('/api/test',req);assert.equal(h.api.peek(),null);assert.equal(h.store.size,0);assert.ok(h.elements.has('milgyo-session-notice'));
});

test('late 401 from a former login cannot overwrite a new session',async()=>{
  const h=harness();h.api.set(metadata('first'));
  let release:any;h.respond(()=>new Promise(resolve=>release=resolve));
  const stale=h.api.fetch('/api/test',req);h.api.set(metadata('second'));release(Response.json({ok:false,code:'SESSION_EXPIRED'},{status:401}));
  const r=await stale;assert.equal(r.status,409);assert.equal((await r.json()).code,'STALE_SESSION_RESPONSE');assert.equal(h.api.peek().user.id,'second');
});

test('late initial session response cannot overwrite a concurrent new login',async()=>{
  const h=harness();let release:any;h.respond(()=>new Promise(resolve=>release=resolve));
  const pending=h.api.ready();h.api.set(metadata('second'));release(Response.json(metadata('first')));await pending;assert.equal(h.api.peek().user.id,'second');
});

test('storage-disabled client can keep session in memory and restore with cookie',async()=>{
  const h=harness({storageBlocked:true}),m=metadata();h.respond(async()=>Response.json(m));await h.api.ready();assert.equal(h.api.peek().user.id,'u1');h.api.set(m);assert.equal(h.api.peek().user.id,'u1');
});

test('cross-tab re-login clears expiry notice and account switch reloads previous account view',()=>{
  const h=harness();h.api.set(metadata());h.api.clear('SESSION_EXPIRED');assert.ok(h.elements.has('milgyo-session-notice'));
  h.dispatch('storage',{key:'milgyo-system-session',newValue:JSON.stringify({...metadata(),version:2})});assert.ok(!h.elements.has('milgyo-session-notice'));assert.equal(h.api.peek().user.id,'u1');
  h.dispatch('storage',{key:'milgyo-system-session',newValue:JSON.stringify({...metadata('different'),version:2})});assert.ok(h.events.some(e=>e.type==='reload'));
  h.dispatch('storage',{key:'milgyo-system-session',newValue:null});assert.equal(h.api.peek(),null);
});

test('logout waits for server success; network error does not claim successful sign-out',async()=>{
  const h=harness();h.api.set(metadata());h.respond(async()=>{throw Error('offline')});await h.api.logout();assert.ok(h.api.peek());assert.ok(h.events.some(e=>e.type==='alert'));assert.ok(!h.events.some(e=>e.type==='replace'));
  h.respond(async()=>Response.json({ok:true}));await h.api.logout();assert.equal(h.api.peek(),null);assert.ok(h.events.some(e=>e.type==='replace'));
});

test('client does not retry uncertain write requests automatically',async()=>{
  const h=harness();h.api.set(metadata());h.respond(async()=>{throw Error('network error')});await assert.rejects(h.api.fetch('/api/documents/decide',req));assert.equal(h.calls.length,1);
});

test('expired persisted session metadata is removed immediately on page load', () => {
  const now = Date.now();
  const h = harness({ initial: {
    version: 2,
    user: { id: 'u1', name: 'Test', role: 'user' },
    issuedAt: new Date(now - 20_000).toISOString(),
    expiresAt: new Date(now - 10_000).toISOString(),
  }});
  assert.equal(h.api.peek(), null);
  assert.equal(h.store.size, 0);
});

test('client refuses already expired metadata instead of showing a stale logged-in UI', () => {
  const h = harness();
  const now = Date.now();
  assert.throws(() => h.api.set({
    user: { id: 'u1', name: 'Test', role: 'user' },
    issuedAt: new Date(now - 20_000).toISOString(),
    expiresAt: new Date(now - 1_000).toISOString(),
  }), /Server session metadata is required/);
  assert.equal(h.api.peek(), null);
});

// V99 regression coverage for the pre-login yellow-banner incident.
test('V99: first anonymous login-page visit is not reported as an expired session', async () => {
  const h = harness({ loginVisible: true });
  await h.api.ready();
  assert.equal(h.api.peek(), null);
  assert.equal(h.calls.length, 1);
  assert.equal(h.elements.has('milgyo-session-notice'), false);
  const ended = h.events.find(e => e.type === 'milgyo:session-ended');
  assert.equal(ended.detail.hadSession, false);
});

test('V99: an anonymous protected-page visit is not a false session-expiry event', async () => {
  const h = harness();
  await h.api.ready();
  assert.equal(h.elements.has('milgyo-session-notice'), false);
  assert.equal(h.api.peek(), null);
});

test('V99: expired stored metadata does not add a banner over the login form', async () => {
  const h = harness({ loginVisible: true, initial: { ...metadata(), version: 2,
    issuedAt: new Date(Date.now() - 30_000).toISOString(),
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  }});
  await h.api.ready();
  assert.equal(h.store.size, 0);
  assert.equal(h.elements.has('milgyo-session-notice'), false);
});

test('V99: migration from legacy browser tokens does not create a login-page warning', async () => {
  const h = harness({ loginVisible: true, initial: { token: 'old-credential', user: { id: 'u1' } } });
  await h.api.ready();
  assert.equal(h.store.size, 0);
  assert.equal(h.elements.has('milgyo-session-notice'), false);
});

test('V99: rejected old cookie on the visible login form needs no second login link', async () => {
  const h = harness({ loginVisible: true, initial: { ...metadata(), version: 2 } });
  h.respond(async () => Response.json({ ok: false, code: 'SESSION_EXPIRED' }, { status: 401 }));
  await h.api.ready();
  assert.equal(h.api.peek(), null);
  assert.equal(h.elements.has('milgyo-session-notice'), false);
});

test('V99: real expiry on an active form still shows the preservation warning', async () => {
  const h = harness();
  h.api.set(metadata());
  h.respond(async () => Response.json({ ok: false, code: 'SESSION_EXPIRED' }, { status: 401 }));
  await h.api.fetch('/api/documents/detail', req);
  assert.equal(h.api.peek(), null);
  assert.equal(h.elements.has('milgyo-session-notice'), true);
  // An additional request after expiry must not remove the original warning.
  await h.api.fetch('/api/documents/detail', req);
  assert.equal(h.elements.has('milgyo-session-notice'), true);
  assert.equal(h.events.some(e => e.type === 'replace' || e.type === 'reload'), false);
});

test('V99: cross-tab logout notifications while already signed out stay quiet', () => {
  const h = harness({ loginVisible: true });
  h.dispatch('storage', { key: 'milgyo-system-session', newValue: null });
  assert.equal(h.elements.has('milgyo-session-notice'), false);
});

test('V99: auth-schema 503 on login is not converted into a session-expiry warning', async () => {
  const h = harness({ loginVisible: true });
  h.respond(async () => Response.json({ ok: false, code: 'AUTH_SCHEMA_NOT_READY' }, { status: 503 }));
  const response = await h.api.fetch('/api/auth/login', req);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'AUTH_SCHEMA_NOT_READY');
  assert.equal(h.elements.has('milgyo-session-notice'), false);
});

test('V99: auth-schema 503 does not discard an existing session profile', async () => {
  const h = harness(); h.api.set(metadata());
  h.respond(async () => Response.json({ ok: false, code: 'AUTH_SCHEMA_NOT_READY' }, { status: 503 }));
  await h.api.fetch('/api/auth/session', req);
  assert.equal(h.api.peek().user.id, 'u1');
  assert.equal(h.elements.has('milgyo-session-notice'), false);
});

test('V99: normal login after an anonymous check can restore session state', async () => {
  const h = harness({ loginVisible: true });
  await h.api.ready();
  h.api.set(metadata());
  assert.equal(h.api.peek().user.id, 'u1');
  assert.equal(h.elements.has('milgyo-session-notice'), false);
});

test('V99: shared script URL changes, while the login screen clears any stale warning', () => {
  assert.match(readFileSync('src/layouts/GovLayout.astro', 'utf8'), /system-session\.js\?v=99-auth-20261015/);
  const index = readFileSync('src/pages/index.astro', 'utf8');
  const showLogin = index.slice(index.indexOf('const showLogin ='), index.indexOf('const setAccountingAccessLinks ='));
  assert.match(showLogin, /getElementById\('milgyo-session-notice'\)\?\.remove\(\)/);
});
