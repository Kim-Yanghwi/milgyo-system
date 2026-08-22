/**
 * Shared accounting-domain schema readiness check.
 *
 * These tables were introduced by the former "special accounting" migration,
 * but they now support multiple business domains (core/cash/giving/governance/tax).
 * Keep the physical table names for data compatibility while removing the
 * architectural dependency on the former UI/module name.
 */
const REQUIRED_DOMAIN_TABLES = [
  'accounting_book_types', 'accounting_entities', 'accounting_funds', 'accounting_budget_plans',
  'accounting_resolution_dimensions', 'accounting_journal_line_dimensions', 'accounting_donors',
  'accounting_donations', 'accounting_assets', 'accounting_cards', 'accounting_card_transactions',
  'accounting_branch_reports', 'accounting_special_sequences', 'accounting_entity_certificates',
];

const domainSchemaReady = new WeakSet<object>();
const domainSchemaPromises = new WeakMap<object, Promise<void>>();

export const ensureAccountingDomainTables = async (db: D1Database) => {
  const key = db as unknown as object;
  if (domainSchemaReady.has(key)) return;

  let pending = domainSchemaPromises.get(key);
  if (!pending) {
    pending = (async () => {
      const placeholders = REQUIRED_DOMAIN_TABLES.map(() => '?').join(',');
      const row = await db.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`,
      ).bind(...REQUIRED_DOMAIN_TABLES).first<{ count: number }>();
      if (Number(row?.count || 0) !== REQUIRED_DOMAIN_TABLES.length) {
        throw new Error('회계 전용 DB의 확장 업무 스키마가 준비되지 않았습니다. v26 이후 회계 마이그레이션을 먼저 적용해 주세요.');
      }
      domainSchemaReady.add(key);
    })().catch((error) => {
      domainSchemaPromises.delete(key);
      throw error;
    });
    domainSchemaPromises.set(key, pending);
  }
  await pending;
};
