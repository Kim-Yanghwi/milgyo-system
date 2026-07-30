import type { SessionUser } from './helpers';

export const TEST_RESET_CONFIRMATION = '테스트자료 전체삭제';
const MAX_RESET_OBJECTS = 5000;
const R2_DELETE_CHUNK = 500;

type CountRow = { count?: number };
type ResetEnv = {
  DB: D1Database;
  ACCOUNTING_DB: D1Database;
  FILES?: R2Bucket;
  ACCOUNTING_FILES?: R2Bucket;
};

const countFrom = async (db: D1Database, sql: string, ...bindings: unknown[]) => {
  const row = await db.prepare(sql).bind(...bindings).first<CountRow>();
  return Number(row?.count || 0);
};

const listBucketKeys = async (bucket: R2Bucket, prefix = '') => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects || []) {
      if (object?.key) keys.push(object.key);
      if (keys.length > MAX_RESET_OBJECTS) {
        throw new Error(`R2 삭제 대상이 ${MAX_RESET_OBJECTS.toLocaleString('ko-KR')}건을 초과합니다. 일괄 초기화 대신 별도 정리 작업이 필요합니다.`);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
};

const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean)));

const collectMainFileKeys = async (env: ResetEnv) => {
  const metadataRows = await env.DB.prepare(`
    SELECT r2_key AS object_key FROM document_attachments
    WHERE storage_type='r2' AND r2_key IS NOT NULL AND r2_key<>''
    UNION ALL
    SELECT r2_key AS object_key FROM received_attachments
    WHERE storage_type='r2' AND r2_key IS NOT NULL AND r2_key<>''
  `).all<{ object_key: string }>();
  const metadataKeys = (metadataRows.results || []).map((row) => String(row.object_key || ''));
  if (!env.FILES) return { metadataKeys: unique(metadataKeys), bucketKeys: [] as string[] };
  const [documentKeys, registryKeys] = await Promise.all([
    listBucketKeys(env.FILES, 'documents/'),
    listBucketKeys(env.FILES, 'registry/'),
  ]);
  return { metadataKeys: unique(metadataKeys), bucketKeys: unique([...documentKeys, ...registryKeys]) };
};

const collectAccountingFileKeys = async (env: ResetEnv) => {
  const metadataRows = await env.ACCOUNTING_DB.prepare(`
    SELECT object_key FROM accounting_attachments WHERE object_key IS NOT NULL AND object_key<>''
  `).all<{ object_key: string }>();
  const metadataKeys = (metadataRows.results || []).map((row) => String(row.object_key || ''));
  const bucketKeys = env.ACCOUNTING_FILES ? await listBucketKeys(env.ACCOUNTING_FILES) : [];
  return { metadataKeys: unique(metadataKeys), bucketKeys: unique(bucketKeys) };
};

const deleteBucketKeys = async (bucket: R2Bucket | undefined, keys: string[], label: string) => {
  if (!keys.length) return 0;
  if (!bucket) throw new Error(`${label} R2 저장소가 연결되지 않아 파일을 삭제할 수 없습니다.`);
  for (let index = 0; index < keys.length; index += R2_DELETE_CHUNK) {
    await bucket.delete(keys.slice(index, index + R2_DELETE_CHUNK));
  }
  return keys.length;
};

export const getTestResetPreview = async (env: ResetEnv) => {
  const [
    documents,
    receivedDocuments,
    documentAttachments,
    receivedAttachments,
    accountingOutbox,
    resolutions,
    journals,
    donations,
    donors,
    assets,
    cards,
    cardTransactions,
    branchReports,
    certificates,
    accountingAttachments,
    customEntities,
    customFunds,
    customBookTypes,
    customAccounts,
    mainFiles,
    accountingFiles,
  ] = await Promise.all([
    countFrom(env.DB, 'SELECT COUNT(*) AS count FROM documents'),
    countFrom(env.DB, 'SELECT COUNT(*) AS count FROM received_documents'),
    countFrom(env.DB, 'SELECT COUNT(*) AS count FROM document_attachments'),
    countFrom(env.DB, 'SELECT COUNT(*) AS count FROM received_attachments'),
    countFrom(env.DB, 'SELECT COUNT(*) AS count FROM accounting_outbox'),
    countFrom(env.ACCOUNTING_DB, 'SELECT COUNT(*) AS count FROM accounting_resolutions'),
    countFrom(env.ACCOUNTING_DB, 'SELECT COUNT(*) AS count FROM accounting_journals'),
    countFrom(env.ACCOUNTING_DB, 'SELECT COUNT(*) AS count FROM accounting_donations'),
    countFrom(env.ACCOUNTING_DB, 'SELECT COUNT(*) AS count FROM accounting_donors'),
    countFrom(env.ACCOUNTING_DB, 'SELECT COUNT(*) AS count FROM accounting_assets'),
    countFrom(env.ACCOUNTING_DB, 'SELECT COUNT(*) AS count FROM accounting_cards'),
    countFrom(env.ACCOUNTING_DB, 'SELECT COUNT(*) AS count FROM accounting_card_transactions'),
    countFrom(env.ACCOUNTING_DB, 'SELECT COUNT(*) AS count FROM accounting_branch_reports'),
    countFrom(env.ACCOUNTING_DB, 'SELECT COUNT(*) AS count FROM accounting_entity_certificates'),
    countFrom(env.ACCOUNTING_DB, 'SELECT COUNT(*) AS count FROM accounting_attachments'),
    countFrom(env.ACCOUNTING_DB, "SELECT COUNT(*) AS count FROM accounting_entities WHERE id<>'ENTITY-HQ'"),
    countFrom(env.ACCOUNTING_DB, 'SELECT COUNT(*) AS count FROM accounting_funds WHERE system_fund=0'),
    countFrom(env.ACCOUNTING_DB, 'SELECT COUNT(*) AS count FROM accounting_book_types WHERE system_type=0'),
    countFrom(env.ACCOUNTING_DB, 'SELECT COUNT(*) AS count FROM accounting_accounts WHERE system_account=0'),
    collectMainFileKeys(env),
    collectAccountingFileKeys(env),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    main: {
      documents,
      receivedDocuments,
      attachments: documentAttachments + receivedAttachments,
      accountingOutbox,
      r2Objects: unique([...mainFiles.metadataKeys, ...mainFiles.bucketKeys]).length,
    },
    accounting: {
      resolutions,
      journals,
      donations,
      donors,
      assets,
      cards,
      cardTransactions,
      branchReports,
      certificates,
      attachments: accountingAttachments,
      customEntities,
      customFunds,
      customBookTypes,
      customAccounts,
      r2Objects: unique([...accountingFiles.metadataKeys, ...accountingFiles.bucketKeys]).length,
    },
    preserved: [
      '사용자·권한·로그인 세션',
      '전자문서 기본 서식과 종단 설정',
      '회계연도·기본 계정과목·종단 본부',
      '기본 회계구분·기본 재원·첨부 운영정책',
    ],
  };
};

export const resetAllTestData = async (env: ResetEnv, user: SessionUser) => {
  const [mainFiles, accountingFiles] = await Promise.all([
    collectMainFileKeys(env),
    collectAccountingFileKeys(env),
  ]);
  const mainR2Keys = unique([...mainFiles.metadataKeys, ...mainFiles.bucketKeys]);
  const accountingR2Keys = unique([...accountingFiles.metadataKeys, ...accountingFiles.bucketKeys]);

  if (mainR2Keys.length && !env.FILES) throw new Error('전자문서 R2 저장소(FILES)가 연결되지 않아 초기화를 중단했습니다.');
  if (accountingR2Keys.length && !env.ACCOUNTING_FILES) throw new Error('회계 R2 저장소(ACCOUNTING_FILES)가 연결되지 않아 초기화를 중단했습니다.');

  const deletedMainR2 = await deleteBucketKeys(env.FILES, mainR2Keys, '전자문서');
  const deletedAccountingR2 = await deleteBucketKeys(env.ACCOUNTING_FILES, accountingR2Keys, '회계');
  const now = new Date().toISOString();
  const resetDetail = JSON.stringify({
    resetAt: now,
    resetBy: user.name,
    resetByUserId: user.id,
    deletedMainR2,
    deletedAccountingR2,
  });

  await env.DB.batch([
    env.DB.prepare('DELETE FROM document_approval_lines'),
    env.DB.prepare('DELETE FROM document_approvals'),
    env.DB.prepare('DELETE FROM document_dispatch_links'),
    env.DB.prepare('DELETE FROM document_attachments'),
    env.DB.prepare('DELETE FROM received_attachments'),
    env.DB.prepare('DELETE FROM received_documents'),
    env.DB.prepare('DELETE FROM documents'),
    env.DB.prepare('DELETE FROM accounting_outbox'),
    env.DB.prepare('DELETE FROM document_sequences'),
    env.DB.prepare('DELETE FROM admin_rate_limits'),
    env.DB.prepare(`INSERT INTO system_meta (meta_key,meta_value,updated_at) VALUES ('last_test_data_reset',?,?)
      ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=excluded.updated_at`).bind(resetDetail, now),
  ]);

  await env.ACCOUNTING_DB.batch([
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_attachment_operations'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_attachment_integrity_issues'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_attachments'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_entity_certificates'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_journal_line_dimensions'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_journal_lines'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_journals'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_resolution_dimensions'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_resolutions'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_card_transactions'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_cards'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_assets'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_donations'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_donors'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_branch_reports'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_budget_plans'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_budgets'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_closings'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_monthly_summary'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_audit_logs'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_sequences'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_special_sequences'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_accounts WHERE system_account=0'),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_funds WHERE system_fund=0'),
    env.ACCOUNTING_DB.prepare("DELETE FROM accounting_entities WHERE id<>'ENTITY-HQ'"),
    env.ACCOUNTING_DB.prepare('DELETE FROM accounting_book_types WHERE system_type=0'),
    env.ACCOUNTING_DB.prepare(`INSERT INTO accounting_meta (meta_key,meta_value,updated_at) VALUES ('last_test_data_reset',?,?)
      ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=excluded.updated_at`).bind(resetDetail, now),
  ]);

  return {
    resetAt: now,
    deletedMainR2,
    deletedAccountingR2,
    message: '전자문서·회계 테스트자료와 번호 카운트를 초기화했습니다.',
  };
};
