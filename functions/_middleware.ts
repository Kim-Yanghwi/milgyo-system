import { authenticateSession, ensureTables, getSessionToken, json } from './_shared/helpers';
import { AuthSchemaError } from './_shared/security/sessions';
import { RequestSecurityError, assertSameOriginApiRequest, readLimitedBody, validateJsonBody, canonicalRequestPath, isProtectedSealPath, hardenResponse } from './_shared/security/request';

interface Env { DB?: D1Database; }
export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const path = new URL(request.url).pathname;
  let canonical = path;
  try { canonical = canonicalRequestPath(path); } catch { /* Invalid paths fail closed below. */ }
  const api = path.startsWith('/api/') || canonical.startsWith('/api/');
  const seal = isProtectedSealPath(path);
  if (!api && !seal) return context.next();
  const requestId = crypto.randomUUID();
  const finish = (response: Response) => hardenResponse(response, request, requestId);
  try {
    canonicalRequestPath(path);
    if (api && path !== canonical) throw new RequestSecurityError('INVALID_API_PATH', 400, 'Use the canonical API path.');
    if (seal) {
      if (!['GET', 'HEAD'].includes(request.method)) return finish(json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405));
      if (!env.DB) return finish(json({ ok: false, code: 'SERVICE_UNAVAILABLE' }, 503));
      const token = getSessionToken(request);
      if (!token) return finish(json({ ok: false, code: 'SESSION_REQUIRED' }, 401));
      await ensureTables(env.DB);
      const auth = await authenticateSession(env.DB, token);
      if (!auth.ok) return finish(json({ ok: false, code: auth.code, message: auth.message }, auth.status));
      return finish(await context.next());
    }
    if (request.method === 'OPTIONS') return finish(json({ ok: false, code: 'CORS_NOT_ALLOWED' }, 405));
    let response: Response;
    if (request.method === 'POST') {
      assertSameOriginApiRequest(request);
      const type = request.headers.get('content-type') || '';
      const multipart = /^multipart\/form-data\b/i.test(type) && path === '/api/accounting/upload-attachment';
      if (!multipart && !/^application\/json(?:\s*;|$)/i.test(type)) {
        throw new RequestSecurityError('UNSUPPORTED_MEDIA_TYPE', 415, 'Content-Type: application/json required.');
      }
      const publicAuth = ['/api/auth/login', '/api/auth/bootstrap', '/api/auth/logout', '/api/health'].includes(path);
      if (!publicAuth && !getSessionToken(request)) return finish(json({ ok: false, code: 'SESSION_REQUIRED', message: '\ub85c\uadf8\uc778\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.' }, 401));
      const bytes = await readLimitedBody(request);
      if (!multipart) validateJsonBody(bytes);
      // readLimitedBody() allocates a new Uint8Array spanning its own ArrayBuffer.
      // Forward the same validated bytes without another copy; ArrayBuffer is BodyInit in TS 5.9 DOM types.
      const bounded = new Request(request, { body: bytes.buffer as ArrayBuffer });
      response = await context.next(bounded);
    } else {
      response = await context.next();
    }
    if (response.status >= 500 && response.headers.get('content-type')?.includes('application/json')) {
      console.error('API endpoint failure', { requestId, path, status: response.status });
      // SQL/native errors from legacy handlers must not be returned to the browser.
      response = json({ ok: false, code: 'SERVICE_UNAVAILABLE', requestId,
        message: '\uc11c\ubc84 \ucc98\ub9ac \uc911 \ubb38\uc81c\uac00 \ubc1c\uc0dd\ud588\uc2b5\ub2c8\ub2e4. \uc7a0\uc2dc \ud6c4 \ub2e4\uc2dc \uc2dc\ub3c4\ud574 \uc8fc\uc138\uc694.' }, response.status);
    }
    return finish(response);
  } catch (error) {
    if (error instanceof RequestSecurityError) return finish(json({ ok: false, code: error.code, message: error.message, requestId }, error.status));
    if (error instanceof AuthSchemaError) {
      console.error('V97 auth schema missing', { requestId, path, binding: 'DB', migration: 'migrations/main/0012_v97_security_sessions.sql' });
      return finish(json({ ok: false, code: error.code, requestId, message: '인증 DB 보안 구조가 준비되지 않았습니다. 관리자가 메인 DB(DB)의 인증 마이그레이션 적용 상태를 확인해야 합니다. (AUTH_SCHEMA_NOT_READY)' }, 503));
    }
    // Do not log request headers/bodies, session cookies or user records.
    console.error('Unhandled Pages Function error', { requestId, path, error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' });
    return finish(json({ ok: false, code: 'INTERNAL_ERROR', requestId, message: '\uc11c\ubc84 \ucc98\ub9ac \uc911 \uc624\ub958\uac00 \ubc1c\uc0dd\ud588\uc2b5\ub2c8\ub2e4.' }, 500));
  }
};
