import { json } from './helpers';
import { ownsAccountingAction, type AccountingDomain, type AccountingDomainKind, type AccountingLegacyApi } from './accounting-domain-contract';

type Handler = (context: any) => Response | Promise<Response>;
type HandlerMap = Partial<Record<AccountingLegacyApi, Handler>>;

export const routeAccountingDomainPost = async (
  context: any,
  domain: AccountingDomain,
  kind: AccountingDomainKind,
  handlers: HandlerMap,
): Promise<Response> => {
  let payload: any;
  try { payload = await context.request.clone().json(); }
  catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }
  const source = String(payload?._legacyApi || '') as AccountingLegacyApi;
  const action = String(payload?.action || '');
  if (!source || !action || !ownsAccountingAction(domain, kind, source, action)) {
    return json({ ok: false, message: `회계 업무영역 라우팅이 올바르지 않습니다. (${domain}/${kind}/${source || '-'}/${action || '-'})` }, 400);
  }
  const handler = handlers[source];
  if (!handler) return json({ ok: false, message: '해당 회계 업무 처리기가 연결되지 않았습니다.' }, 500);
  return handler(context);
};
