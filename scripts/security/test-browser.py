"""Optional local-browser audit. Requires Python Playwright + Chromium; not an Astro production E2E test."""
import json, os, pathlib, subprocess, time
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parents[2]
os.chdir(root)
server = subprocess.Popen(['node', '--import', './scripts/security/register-loader.mjs', './scripts/security/browser-harness.mjs'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
checks = []
def check(name, condition):
    if not condition: raise AssertionError(name)
    checks.append(name)
try:
    port = json.loads(server.stdout.readline())['port']
    origin = f'http://127.0.0.1:{port}'
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        context = browser.new_context()
        page = context.new_page()
        page.goto(origin)
        page.evaluate('window.initialReady')
        check('logged-out state starts empty', page.evaluate('MilgyoSession.peek()') is None)
        check('anonymous seal is rejected', context.request.get(origin + '/secretary_general.png').status == 401)
        login_js = """async()=>{const r=await MilgyoSession.fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'browser-user',password:'Test-Only-Password-97!'})});const d=await r.json(); if(d.ok)MilgyoSession.set(d);return {status:r.status,body:d}}"""
        login = page.evaluate(login_js)
        check('browser login succeeds using actual handler', login['status'] == 200 and login['body']['ok'])
        check('login JSON has no credential', 'token' not in login['body'])
        cookies = context.cookies()
        cookie = next(c for c in cookies if c['name'] == 'milgyo_session_dev')
        check('browser cookie is HttpOnly and Strict', cookie['httpOnly'] and cookie['sameSite'] == 'Strict')
        check('JavaScript cannot read session cookie', 'milgyo_session_dev' not in page.evaluate('document.cookie'))
        stored = page.evaluate('localStorage.getItem("milgyo-system-session")')
        check('localStorage has metadata only', 'token' not in json.loads(stored) and cookie['value'] not in stored and 'savedAt' not in stored)
        check('authenticated seal is accessible and private', context.request.get(origin+'/secretary_general.png').headers.get('cache-control') == 'private, no-store')
        original_expiry = login['body']['expiresAt']
        page.reload(); page.evaluate('window.initialReady')
        check('reload restores from server cookie without extending lifetime', page.evaluate('MilgyoSession.peek().expiresAt') == original_expiry)
        result = page.evaluate("""async()=>{const r=await MilgyoSession.fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'browser-user',password:'wrong'})});return {status:r.status,body:await r.json(),alive:!!MilgyoSession.peek()}}""")
        check('wrong password does not destroy existing session', result['status']==401 and result['body']['code']=='INVALID_CREDENTIALS' and result['alive'])
        for path in ['temporary-error','raw-401','html-gateway']:
            result = page.evaluate("""async(path)=>{const r=await MilgyoSession.fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return {status:r.status,body:await r.json(),alive:!!MilgyoSession.peek()}}""", path)
            check(f'{path} does not erase valid session', result['alive'])
            if path == 'html-gateway': check('HTML gateway gives diagnostic code', result['body']['code']=='AUTH_GATEWAY_RESPONSE')
        result = page.evaluate("""async()=>{const stale=MilgyoSession.fetch('/api/slow-expired',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const r=await MilgyoSession.fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'browser-user',password:'Test-Only-Password-97!'})});MilgyoSession.set(await r.json());const old=await stale;return {status:old.status,body:await old.json(),alive:!!MilgyoSession.peek()}}""")
        check('late old 401 cannot terminate a newer login', result['alive'] and result['status']==409 and result['body']['code']=='STALE_SESSION_RESPONSE')
        page.fill('#unsaved','Draft must survive expiration')
        context.request.get(origin + '/__test/expire')
        result = page.evaluate("""async()=>{const r=await MilgyoSession.fetch('/api/auth/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return {status:r.status,body:await r.json(),alive:!!MilgyoSession.peek()}}""")
        check('genuine session expiry is distinguished', result['status']==401 and result['body']['code']=='SESSION_EXPIRED' and not result['alive'])
        check('expiry preserves unsaved form input', page.input_value('#unsaved')=='Draft must survive expiration')
        check('expiry exposes re-login banner', page.locator('#milgyo-session-notice').is_visible())
        new_tab = context.new_page(); new_tab.goto(origin); new_tab.evaluate('window.initialReady'); new_tab.evaluate(login_js)
        page.wait_for_function('!!MilgyoSession.peek() && !document.getElementById("milgyo-session-notice")')
        check('same-user re-login in another tab restores session and removes banner', page.evaluate('!!MilgyoSession.peek()'))
        check('cross-tab re-login preserves unsaved draft', page.input_value('#unsaved')=='Draft must survive expiration')
        new_tab.click('[data-logout]'); new_tab.wait_for_function('!MilgyoSession.peek()'); page.wait_for_function('!MilgyoSession.peek()')
        check('confirmed logout removes cookie and synchronizes tabs', not any(c['name']=='milgyo_session_dev' for c in context.cookies()))
        check('logout makes protected seal inaccessible', context.request.get(origin+'/secretary_general.png').status==401)
        legacy = browser.new_context()
        legacy.add_init_script("localStorage.setItem('milgyo-system-session',JSON.stringify({token:'old-real-token',user:{id:'x'},savedAt:Date.now()}));")
        legacy_page = legacy.new_page(); legacy_page.goto(origin); legacy_page.evaluate('window.initialReady')
        check('legacy localStorage bearer credentials removed', legacy_page.evaluate('localStorage.getItem("milgyo-system-session")') is None)
        legacy.close()
        # Storage-disabled users can still log in and restore via their HttpOnly cookie.
        blocked = browser.new_context()
        blocked.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError')}});Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('Blocked','SecurityError')}});")
        bp = blocked.new_page(); bp.goto(origin); bp.evaluate('window.initialReady'); r = bp.evaluate(login_js)
        check('blocked localStorage does not break cookie login', r['status']==200)
        bp.reload(); bp.evaluate('window.initialReady'); check('blocked storage still restores server session', bp.evaluate('!!MilgyoSession.peek()'))
        blocked.close(); browser.close()
    print(json.dumps({'ok':True,'count':len(checks),'checks':checks,'scope':'Chromium + actual auth handlers + local SQLite, not built Astro UI or Cloudflare runtime'},indent=2))
finally:
    server.terminate()
    try: server.wait(timeout=8)
    except subprocess.TimeoutExpired: server.kill()
