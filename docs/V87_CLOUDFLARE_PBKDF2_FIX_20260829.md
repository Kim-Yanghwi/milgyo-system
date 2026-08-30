# V87 Cloudflare PBKDF2 runtime compatibility fix

## Root cause
Cloudflare Pages/Workers WebCrypto rejected PBKDF2 with 210,000 iterations at runtime:
`NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported (requested 210000).`

The V85/V86 security hardening raised the password hash target from 30,000 to 210,000 iterations. This was valid in some WebCrypto runtimes, but not in the deployed Cloudflare runtime. The failure occurred before the first administrator row could be inserted.

## Fix
- Set the runtime-safe PBKDF2-SHA256 target to 100,000 iterations.
- Enforce the same 100,000 maximum while verifying stored PBKDF2 hashes so an unsupported iteration count cannot throw a 500 error.
- Keep legacy salted SHA-256 verification for existing old accounts; successful legacy logins are rehashed to the current 100,000-iteration PBKDF2 format.
- Keep 16-byte cryptographically random salts and 256-bit derived hashes.
- Add regression tests preventing a future accidental increase above the Cloudflare runtime limit.

## Database impact
No D1 migration is required for V87. Password hashes are stored as text in the existing `system_users.password_hash` column.

## Preview deployment
1. Apply the V87 source files.
2. Run `npm.cmd run verify`.
3. Redeploy the existing Preview branch.
4. Retry first-admin bootstrap.
5. Confirm `system_users` contains exactly one administrator and `document_templates` contains 37 system templates.

## Compatibility
- Existing 30,000-iteration PBKDF2 hashes remain verifiable and are upgraded after successful login.
- Existing legacy `salt:sha256` hashes remain verifiable and are upgraded after successful login.
- A stored PBKDF2 hash above 100,000 iterations is rejected rather than passed to Cloudflare WebCrypto, avoiding a runtime exception. Such a hash would require password reset because Cloudflare cannot derive it with the deployed WebCrypto limit.
