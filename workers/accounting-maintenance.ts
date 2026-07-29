import { ensureAccountingTables } from '../functions/_shared/accounting';
import { processAccountingOutbox } from '../functions/_shared/accounting-integration';
import {
  retryPendingAccountingAttachmentOperations,
  runAccountingAttachmentIntegrityScan,
} from '../functions/_shared/accounting-attachment-ops';

type Env = {
  DB: D1Database;
  ACCOUNTING_DB: D1Database;
  ACCOUNTING_FILES: R2Bucket;
};

const WEEKLY_FULL_SCAN_CRON = '40 18 * * 6';

const runMaintenance = async (controller: ScheduledController, env: Env) => {
  if (!env.DB || !env.ACCOUNTING_DB || !env.ACCOUNTING_FILES) {
    throw new Error('DB, ACCOUNTING_DB 또는 ACCOUNTING_FILES 바인딩이 없습니다.');
  }

  await ensureAccountingTables(env.ACCOUNTING_DB);
  const integration = await processAccountingOutbox(
    env.DB,
    env.ACCOUNTING_DB,
    { limit: 50 },
  );
  const retry = await retryPendingAccountingAttachmentOperations(
    env.ACCOUNTING_DB,
    env.ACCOUNTING_FILES,
    30,
  );
  const mode = controller.cron === WEEKLY_FULL_SCAN_CRON ? 'full' : 'd1';
  const integrity = await runAccountingAttachmentIntegrityScan(
    env.ACCOUNTING_DB,
    env.ACCOUNTING_FILES,
    mode,
  );

  console.log(JSON.stringify({
    event: 'accounting-attachment-maintenance',
    cron: controller.cron,
    scheduledTime: new Date(controller.scheduledTime).toISOString(),
    integration,
    retry,
    integrity,
  }));
};

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ) {
    context.waitUntil(
      runMaintenance(controller, env).catch((error) => {
        console.error('accounting attachment maintenance failed', error);
        throw error;
      }),
    );
  },
};
