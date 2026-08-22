import { json } from '../_shared/helpers';
import type { AccountingLegacyApi } from '../_shared/accounting-domain-contract';
import { onRequestPost as accounting } from './accounting/query';
import { onRequestPost as operations } from './accounting-operations/query';
import { onRequestPost as special } from './accounting-special/query';
import { onRequestPost as compliance } from './accounting-compliance/query';
import { onRequestPost as tax } from './accounting-tax/query';

type Handler = (context: any) => Response | Promise<Response>;
const handlers: Record<AccountingLegacyApi, Handler> = { accounting, operations, special, compliance, tax };

/**
 * Shared workspace bootstrap facade.
 *
 * Legacy query endpoints stay deployed for compatibility, but the current UI
 * initializes through this one endpoint. Business queries/actions are routed
 * through /api/accounting-domains/<domain>/* instead.
 */
export const onRequestPost: PagesFunction = async (context) => {
  let payload: any;
  try { payload = await context.request.clone().json(); }
  catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  const source = String(payload?._legacyApi || '') as AccountingLegacyApi;
  if (String(payload?.action || '') !== 'init' || !Object.prototype.hasOwnProperty.call(handlers, source)) {
    return json({ ok: false, message: '회계 화면 초기화 요청이 올바르지 않습니다.' }, 400);
  }
  return handlers[source](context);
};
