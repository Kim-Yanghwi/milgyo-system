import { ensureAuthSchema } from './sessions';
const cleanedAt = new WeakMap<object, number>();
async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reserve attempts BEFORE credential checks. Concurrent failed requests cannot pass a COUNT-then-insert gap. */
export async function reserveAuthAttempt(db: D1Database, request: Request, scope = 'login', username = '') {
  await ensureAuthSchema(db);
  const now = Date.now();
  // Only Cloudflare's overwrite-protected client IP header is trusted. Never accept X-Forwarded-For.
  const ip = (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 80);
  const identities = [{ id: `ip:${ip}`, limit: scope === 'bootstrap' ? 5 : 120, window: 10 * 60_000 },
    { id: `ip:${ip}`, limit: scope === 'bootstrap' ? 20 : 3000, window: 24 * 60 * 60_000 }];
  if (scope === 'login' && username) identities.push(
    { id: `user:${username.toLowerCase()}`, limit: 20, window: 10 * 60_000 },
    { id: `user:${username.toLowerCase()}`, limit: 120, window: 24 * 60 * 60_000 },
  );
  const buckets = await Promise.all(identities.map(async (entry) => {
    const start = Math.floor(now / entry.window) * entry.window;
    return { ...entry, key: await digest(`v97:${scope}:${entry.id}:${entry.window}:${start}`), expires: start + entry.window };
  }));
  const rows = await db.batch(buckets.map((bucket) => db.prepare(`
    INSERT INTO auth_rate_buckets(bucket_key,attempts,expires_at) VALUES(?,1,?)
    ON CONFLICT(bucket_key) DO UPDATE SET attempts=auth_rate_buckets.attempts+1
    WHERE auth_rate_buckets.attempts < ? RETURNING attempts
  `).bind(bucket.key, bucket.expires, bucket.limit)));
  if (now - (cleanedAt.get(db) || 0) > 10 * 60_000) {
    await db.prepare(`DELETE FROM auth_rate_buckets WHERE bucket_key IN
      (SELECT bucket_key FROM auth_rate_buckets WHERE expires_at<? LIMIT 500)`)
      .bind(now).run();
    cleanedAt.set(db, now);
  }
  const denied = buckets.filter((_, i) => !rows[i]?.results?.length);
  if (denied.length) return { ok: false as const, retryAfter: Math.max(...denied.map((b) => Math.ceil((b.expires - now) / 1000))),
    message: '\uc778\uc99d \uc2dc\ub3c4 \ud55c\ub3c4\ub97c \ucd08\uacfc\ud588\uc2b5\ub2c8\ub2e4. \uc7a0\uc2dc \ud6c4 \ub2e4\uc2dc \uc2dc\ub3c4\ud574 \uc8fc\uc138\uc694.' };
  return { ok: true as const, rateKey: buckets[0].key };
}
