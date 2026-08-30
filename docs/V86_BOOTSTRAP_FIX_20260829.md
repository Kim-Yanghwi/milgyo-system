# V86 Bootstrap Fix (2026-08-29)

## Symptom
On a freshly migrated Preview D1 database, the first administrator bootstrap returned the generic server error even though `ADMIN_TOKEN` and the D1/R2 bindings were correct.

## Root cause
The V85 migration chain created the current schema objects but did not populate the runtime `system_meta.schema_version` marker or built-in document templates. `ensureTables()` therefore treated the already-migrated database as stale and invoked the large legacy runtime repair path during the bootstrap request. That path can issue many D1 statements in a single request and is inappropriate for a freshly migrated database.

## Fix
- Add `0009_v86_bootstrap_finalize.sql` to establish the migration-managed schema marker.
- Detect a migration-complete main schema separately from a truly old/incomplete schema.
- For a migration-complete database, run only a lightweight finalize path instead of the legacy full runtime migration.
- Seed all 37 built-in document templates using one set-based `json_each(?)` D1 statement rather than one statement per template.
- Add stage markers to bootstrap server logs for future diagnostics without exposing internal errors to end users.
- Update the checked-in Preview D1 UUIDs to the currently provisioned Preview databases.

## Deployment order
1. Replace/update source with V86.
2. Run `npm.cmd run verify`.
3. Apply Preview main migration `0009_v86_bootstrap_finalize.sql`.
4. Rebuild (`npm.cmd run build`) and redeploy the `v85-preopen`/Preview branch.
5. Retry first administrator creation.
6. Verify `system_users` has exactly the created administrator and `document_templates` has 37 built-in templates.

Do not apply Production changes until Preview bootstrap and login succeed.
