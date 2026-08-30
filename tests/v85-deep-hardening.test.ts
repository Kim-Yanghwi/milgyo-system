import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=(p:string)=>fs.readFileSync(p,'utf8');
test('fresh DB bootstrap migrations exist for both D1 databases',()=>{assert.match(read('migrations/main/0000_v0_core_schema.sql'),/CREATE TABLE IF NOT EXISTS system_users/);assert.match(read('migrations/accounting/0000_v26_base_schema.sql'),/CREATE TABLE IF NOT EXISTS accounting_meta/)});
test('document decision and recall use transition protection',()=>{for(const f of ['functions/api/documents/decide.ts','functions/api/documents/recall.ts'])assert.match(read(f),/claimDocumentTransition/);assert.match(read('functions/api/documents/decide.ts'),/AP-DEC-/)});
test('batch decision is status-bound and deterministic',()=>{const s=read('functions/api/documents/decide-batch.ts');assert.match(s,/AND status=\?/);assert.match(s,/AP-DEC-/);assert.match(s,/hasLines/)});
test('reconciliation target duplicate is blocked at DB layer',()=>{const s=read('migrations/accounting/0018_v85_reconciliation_integrity.sql');assert.match(s,/duplicate accounting match target/);assert.match(s,/BEFORE UPDATE OF status,matched_type,matched_id/)});
test('password hashing has no salted SHA256 downgrade and supports upgrade',()=>{const h=read('functions/_shared/helpers.ts');assert.match(h,/PBKDF2_MAX_RUNTIME_ITERATIONS = 100_000/);assert.match(h,/PBKDF2_ITERATIONS = PBKDF2_MAX_RUNTIME_ITERATIONS/);assert.match(h,/iterations > PBKDF2_MAX_RUNTIME_ITERATIONS/);assert.match(h,/needsPasswordRehash/);assert.doesNotMatch(h,/using compatible salted SHA-256 password hash/);assert.match(read('functions/api/auth/login.ts'),/password hash upgrade failed/)});
test('public health endpoint does not disclose operational counters',()=>{const s=read('functions/api/health.ts');assert.doesNotMatch(s,/user_count|outbox|schema_version|bindings/i);assert.match(s,/서비스 점검이 필요합니다/)});
test('session expiry cleanup and index are present',()=>{assert.match(read('functions/_shared/helpers.ts'),/DELETE FROM system_sessions WHERE expires_at < \?/);assert.match(read('migrations/main/0007_v85_session_expiry_index.sql'),/idx_system_sessions_expires/)});
test('document create idempotency handles concurrent unique conflict',()=>{assert.match(read('functions/api/documents/create.ts'),/isClientRequestUniqueError/);assert.match(read('functions/api/documents/create.ts'),/duplicate: true/)});
test('last active admin protection is enforced in the mutation SQL',()=>{assert.match(read('functions/api/users/update.ts'),/NOT EXISTS\(SELECT 1 FROM system_users other/);assert.match(read('functions/api/users/delete.ts'),/RETURNING id/)});
test('high-volume accounting inputs fail explicitly instead of silent truncation',()=>{const s=read('functions/api/accounting-operations/action.ts');assert.match(s,/rawRows.length>1000/);assert.doesNotMatch(s,/payload\.rows\).*slice\(0, 1000\)/)});

test('donation receipt bulk processing is set-based and retry-guarded',()=>{const s=read('functions/api/accounting-operations/action.ts');assert.match(s,/processing_results/);assert.match(s,/reserveSpecialNumberBlock/);assert.match(s,/FROM json_each\(\?\).*accounting_donation_export_items/s);});
