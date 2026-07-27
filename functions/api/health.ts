import { ensureTables, json } from '../_shared/helpers';
import {
  ensureAccountingTables,
  ACCOUNTING_SCHEMA_VERSION,
} from '../_shared/accounting';
import {
  ensureAccountingIntegrationSchema,
  getAccountingOutboxSummary,
} from '../_shared/accounting-integration';

interface Env {
  DB: D1Database;
  ACCOUNTING_DB?: D1Database;
  FILES?: R2Bucket;
  ACCOUNTING_FILES?: R2Bucket;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const storage = !!env.FILES;
  const accountingStorage = !!env.ACCOUNTING_FILES;

  if (!env.DB) {
    return json(
      {
        ok: false,
        database: false,
        accountingDatabase: false,
        storage,
        accountingStorage,
        message: 'DB 바인딩이 없습니다.',
      },
      500,
    );
  }

  try {
    await ensureTables(env.DB);
    await ensureAccountingIntegrationSchema(env.DB);

    const userRow = await env.DB
      .prepare(`SELECT COUNT(*) AS count FROM system_users`)
      .first<{ count: number }>();

    let accountingDatabase = false;
    let accountingSchemaVersion = '';
    let integration: any = null;

    if (env.ACCOUNTING_DB) {
      await ensureAccountingTables(env.ACCOUNTING_DB);

      const version = await env.ACCOUNTING_DB
        .prepare(`
          SELECT meta_value
          FROM accounting_meta
          WHERE meta_key = 'schema_version'
        `)
        .first<{ meta_value: string }>();

      accountingSchemaVersion = String(version?.meta_value || '');
      accountingDatabase = true;
      integration = await getAccountingOutboxSummary(env.DB);
    }

    const healthy = accountingDatabase && accountingStorage;

    return json(
      {
        ok: healthy,
        database: true,
        accountingDatabase,
        accountingSchemaVersion,
        expectedAccountingSchemaVersion: ACCOUNTING_SCHEMA_VERSION,

        // 전자문서용 R2
        storage,

        // 회계 전용 R2
        accountingStorage,

        users: Number(userRow?.count || 0),
        integration: integration?.summary || null,

        message: healthy
          ? '정상'
          : !accountingDatabase
            ? 'ACCOUNTING_DB 바인딩이 없거나 회계 스키마를 확인할 수 없습니다.'
            : 'ACCOUNTING_FILES 회계 전용 R2 바인딩이 없습니다.',
      },
      healthy ? 200 : 503,
    );
  } catch (error) {
    console.error('health check failed', error);

    return json(
      {
        ok: false,
        database: false,
        accountingDatabase: false,
        storage,
        accountingStorage,
        message:
          error instanceof Error
            ? error.message
            : 'DB 점검에 실패했습니다.',
      },
      500,
    );
  }
};

export const onRequestPost = onRequestGet;
