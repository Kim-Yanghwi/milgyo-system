import { isLocalHttp } from './sessions';

export class RequestSecurityError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}
const MiB = 1024 * 1024;
export function requestBodyLimit(request: Request): number {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/api/auth/')) return 16 * 1024;
  if (path === '/api/accounting/upload-attachment' && /^multipart\/form-data\b/i.test(request.headers.get('content-type') || '')) return 26 * MiB;
  if (path.endsWith('/upload-attachment')) return 6 * MiB; // 4 MiB legacy base64; larger accounting files must use multipart.
  if (path === '/api/settings/save') return 4 * MiB;
  return 2 * MiB;
}

export function assertSameOriginApiRequest(request: Request): void {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !isLocalHttp(request)) throw new RequestSecurityError('HTTPS_REQUIRED', 400, '\ubcf4\uc548 \uc5f0\uacb0(HTTPS)\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.');
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  // Same-site is not same-origin: the official homepage must not issue system writes.
  if ((origin && origin !== url.origin) || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    throw new RequestSecurityError('CROSS_ORIGIN_BLOCKED', 403, '\ub2e4\ub978 \uc0ac\uc774\ud2b8\uc5d0\uc11c\uc758 \uc694\uccad\uc740 \ud5c8\uc6a9\ub418\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4.');
  }
  // This non-simple header plus no CORS prevents form/JS CSRF even when Origin is absent.
  if (request.headers.get('x-milgyo-request') !== '1') throw new RequestSecurityError('CLIENT_UPGRADE_REQUIRED', 409,
    '\uc0c8 \ubc84\uc804\uc744 \uc801\uc6a9\ud558\uae30 \uc704\ud574 \ud398\uc774\uc9c0\ub97c \uc0c8\ub85c\uace0\uce68\ud574 \uc8fc\uc138\uc694.');
}

export async function readLimitedBody(request: Request, limit = requestBodyLimit(request)): Promise<Uint8Array> {
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') throw new RequestSecurityError('UNSUPPORTED_ENCODING', 415, '\uc555\ucd95\ub41c \uc694\uccad \ubcf8\ubb38\uc740 \ud5c8\uc6a9\ub418\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4.');
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw new RequestSecurityError('INVALID_LENGTH', 400, '\uc694\uccad \uae38\uc774\uac00 \uc62c\ubc14\ub974\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4.');
  if (declared && Number(declared) > limit) throw new RequestSecurityError('BODY_TOO_LARGE', 413, '\uc694\uccad \uc6a9\ub7c9\uc774 \ud5c8\uc6a9 \ubc94\uc704\ub97c \ucd08\uacfc\ud588\uc2b5\ub2c8\ub2e4.');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        throw new RequestSecurityError('BODY_TOO_LARGE', 413, '\uc694\uccad \uc6a9\ub7c9\uc774 \ud5c8\uc6a9 \ubc94\uc704\ub97c \ucd08\uacfc\ud588\uc2b5\ub2c8\ub2e4.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export function validateJsonBody(bytes: Uint8Array): void {
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RequestSecurityError('INVALID_JSON', 400, '\uc694\uccad JSON \ud615\uc2dd\uc774 \uc62c\ubc14\ub974\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RequestSecurityError('INVALID_JSON_OBJECT', 400,
    '\uc694\uccad \ubcf8\ubb38\uc740 JSON \uac1d\uccb4\uc5ec\uc57c \ud569\ub2c8\ub2e4.');
}

export function canonicalRequestPath(path: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(path); }
  catch { throw new RequestSecurityError('INVALID_PATH', 400, 'Invalid request path.'); }
  const parts: string[] = [];
  for (const part of decoded.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return '/' + parts.join('/');
}

export function isProtectedSealPath(path: string): boolean {
  let decoded: string;
  try { decoded = canonicalRequestPath(path); } catch { return true; }
  // Known assets only. No change to the original seal image or overlay styles.
  return /^\/(?:organization-seal(?:-official)?\.png|secretary_general\.png|signature-seals(?:\/|$)|certificates\/ordination\/(?:organization-seal|top-seal)\.png)/i.test(decoded);
}

export function hardenResponse(response: Response, request: Request, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  headers.set('X-Request-ID', requestId);
  if (new URL(request.url).protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Pragma', 'no-cache');
  headers.delete('Access-Control-Allow-Origin');
  headers.delete('Access-Control-Allow-Credentials');
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
