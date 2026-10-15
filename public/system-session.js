/* V99 login-notice hotfix (2026-10-15), retaining the V97 shared session transport. No credential is read/written by JavaScript.
 * token='cookie-session' is an IN-MEMORY compatibility marker, never a bearer token.
 */
(() => {
  'use strict';
  if (window.MilgyoSession) return;
  const KEY = 'milgyo-system-session';
  const authCodes = new Set(['SESSION_REQUIRED', 'SESSION_EXPIRED', 'ACCOUNT_DISABLED']);
  let state = null, revision = 0, readyPromise = null, loggingOut = false;
  const nativeFetch = window.fetch.bind(window);
  const isAuthFailure = (data) => !!data && authCodes.has(data.code);
  const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
  const publicUser = (user) => user && typeof user.id === 'string' ? ({
    id: user.id, name: String(user.name || ''), username: String(user.username || ''),
    position: user.position || '', grade: user.grade || '', department: user.department || '', role: user.role || 'user',
    canApprove: user.canApprove ?? !!user.can_approve,
    canAccounting: user.canAccounting ?? (user.role === 'admin' || !!user.can_accounting),
  }) : null;
  const normalize = (value, stored = false) => {
    if (!value || (stored && (value.version !== 2 || 'token' in value))) return null;
    const user = publicUser(value.user);
    const expiry = Date.parse(value.expiresAt), issued = Date.parse(value.issuedAt);
    if (!user || !Number.isFinite(expiry) || !Number.isFinite(issued) || expiry <= issued || expiry <= Date.now()) return null;
    return { version: 2, user, expiresAt: value.expiresAt, issuedAt: value.issuedAt };
  };
  const expireLocalStateIfNeeded = () => {
    if (!state || Date.parse(state.expiresAt) > Date.now()) return false;
    state = null; revision += 1; readyPromise = null;
    try { localStorage.removeItem(KEY); } catch {}
    try { sessionStorage.removeItem(KEY); } catch {}
    emit('milgyo:session-ended', { reason: 'SESSION_EXPIRED', hadSession: true });
    return true;
  };
  const peek = () => expireLocalStateIfNeeded() ? null : (state ? { ...state, user: { ...state.user }, token: 'cookie-session' } : null);
  const set = (value) => {
    const next = normalize(value);
    if (!next) throw new Error('Server session metadata is required');
    state = next; revision += 1;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Cookie restoration still works without Web Storage. */ }
    try { sessionStorage.removeItem(KEY); } catch {}
    readyPromise = Promise.resolve(peek());
    emit('milgyo:session-updated', { user: next.user, expiresAt: next.expiresAt });
    return peek();
  };
  const clear = (reason = 'expired') => {
    const hadSession = !!state;
    state = null; revision += 1; readyPromise = null;
    try { localStorage.removeItem(KEY); } catch {}
    try { sessionStorage.removeItem(KEY); } catch {}
    emit('milgyo:session-ended', { reason, hadSession });
  };
  try {
    state = normalize(JSON.parse(localStorage.getItem(KEY) || 'null'), true);
    if (!state) localStorage.removeItem(KEY); // Remove the former raw localStorage token.
  } catch { try { localStorage.removeItem(KEY); } catch {} }
  try { sessionStorage.removeItem(KEY); } catch {}

  const synthetic = (status, code, message) => new Response(JSON.stringify({ ok: false, code, message }), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  const fetchApi = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) throw new Error('Only same-origin system API requests are allowed');
    const startedAtRevision = revision;
    const controller = new AbortController();
    const external = init.signal;
    const abort = () => controller.abort(external?.reason);
    if (external?.aborted) abort(); else external?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), 60_000);
    const headers = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
    headers.set('X-Milgyo-Request', '1');
    headers.set('Accept', 'application/json');
    let response;
    try {
      // No automatic retry of writes: an uncertain network result must not duplicate approvals or accounting entries.
      response = await nativeFetch(input, { ...init, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    } finally { clearTimeout(timer); external?.removeEventListener('abort', abort); }
    const binaryEndpoint = /\/(?:attachment-data|package)$/.test(url.pathname);
    if (response.redirected || (!response.headers.get('content-type')?.includes('application/json') && (!response.ok || !binaryEndpoint))) {
      return synthetic(502, 'AUTH_GATEWAY_RESPONSE', '\ub85c\uadf8\uc778 \uac8c\uc774\ud2b8\uc6e8\uc774 \ub610\ub294 \uc11c\ubc84 \uc751\ub2f5\uc744 \ud655\uc778\ud574 \uc8fc\uc138\uc694. \ud604\uc7ac \uc138\uc158\uc740 \uc784\uc758\ub85c \uc0ad\uc81c\ud558\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4.');
    }
    if (response.status === 401) {
      const data = await response.clone().json().catch(() => null);
      if (!isAuthFailure(data)) return response; // Incorrect password / Access 401 != expired application session.
      if (startedAtRevision !== revision) return synthetic(409, 'STALE_SESSION_RESPONSE', '\uc774\uc804 \uc138\uc158\uc758 \uc751\ub2f5\uc785\ub2c8\ub2e4. \ud604\uc7ac \ub85c\uadf8\uc778\uc740 \uc720\uc9c0\ub429\ub2c8\ub2e4.');
      clear(data.code);
    }
    return response;
  };

  const ready = () => {
    if (readyPromise) return readyPromise;
    const startedAtRevision = revision;
    readyPromise = (async () => {
      try {
        const response = await fetchApi('/api/auth/session', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const data = await response.json().catch(() => null);
        if (data?.ok && data.user && startedAtRevision === revision) return set(data);
        if (!response.ok && !isAuthFailure(data)) emit('milgyo:session-check-error', { code: data?.code || 'SESSION_CHECK_FAILED' });
        return peek();
      } catch {
        // Do not clear a valid cookie or cached profile just because the network/D1/Access is temporarily unavailable.
        emit('milgyo:session-check-error', { code: 'NETWORK_ERROR' });
        return peek();
      }
    })();
    return readyPromise;
  };

  const logout = async () => {
    if (loggingOut) return;
    loggingOut = true;
    try {
      const response = await fetchApi('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error('Logout was not confirmed');
      clear('logout');
      location.replace('/');
    } catch {
      window.alert('\ub85c\uadf8\uc544\uc6c3\uc744 \uc11c\ubc84\uc5d0\uc11c \ud655\uc778\ud558\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4. \uc5f0\uacb0 \ud655\uc778 \ud6c4 \ub2e4\uc2dc \uc2dc\ub3c4\ud574 \uc8fc\uc138\uc694.');
    } finally { loggingOut = false; }
  };
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-logout]')) return;
    event.preventDefault(); event.stopImmediatePropagation(); void logout();
  }, true);
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY) return;
    const previousId = state?.user.id;
    try { state = normalize(JSON.parse(event.newValue || 'null'), true); } catch { state = null; }
    revision += 1; readyPromise = null;
    if (!state) emit('milgyo:session-ended', { reason: 'another-tab', hadSession: !!previousId });
    else if (previousId && previousId !== state.user.id) location.reload();
    else emit('milgyo:session-updated', { user: state.user, expiresAt: state.expiresAt });
  });
  // On subpages preserve unsaved input; a re-login link opens a new tab instead of silently discarding forms.
  window.addEventListener('milgyo:session-ended', (event) => {
    if (event.detail?.reason === 'logout' || !document.body) return;
    // A first anonymous visit gets SESSION_REQUIRED; no previous login has expired.
    // Also avoid a second login link when the sign-in form is already on screen.
    const loginScreen = document.querySelector('[data-login-screen]');
    if (event.detail?.hadSession === false || (loginScreen && !loginScreen.hidden)) {
      // Do not remove a real expiry warning on a protected form just because a
      // second in-flight API request also returned 401 after state was cleared.
      if (loginScreen && !loginScreen.hidden) document.getElementById('milgyo-session-notice')?.remove();
      return;
    }
    let notice = document.getElementById('milgyo-session-notice');
    if (!notice) {
      notice = document.createElement('div'); notice.id = 'milgyo-session-notice'; notice.setAttribute('role', 'alert');
      Object.assign(notice.style, { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '10000', padding: '12px', background: '#fff3cd', color: '#3d3020', borderBottom: '1px solid #c8ac66', textAlign: 'center' });
      const message = document.createElement('span'); message.textContent = '\uc138\uc158\uc774 \uc885\ub8cc\ub418\uc5c8\uc2b5\ub2c8\ub2e4. \uc791\uc131 \uc911\uc778 \ub0b4\uc6a9\uc744 \ubcf4\uc874\ud55c \ub4a4 \ub2e4\uc2dc \ub85c\uadf8\uc778\ud574 \uc8fc\uc138\uc694. ';
      const link = document.createElement('a'); link.href = '/'; link.target = '_blank'; link.rel = 'noopener'; link.textContent = '\uc0c8 \ud0ed\uc5d0\uc11c \ub85c\uadf8\uc778';
      notice.append(message, link); document.body.append(notice);
    }
  });
  window.addEventListener('milgyo:session-updated', () => document.getElementById('milgyo-session-notice')?.remove());
  window.MilgyoSession = Object.freeze({ ready, peek, set, clear, fetch: fetchApi, logout, isAuthFailure });
})();
