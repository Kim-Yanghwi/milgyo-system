import { routeAccountingDomainPost } from '../../../_shared/accounting-domain-router';
import { onRequestPost as operations } from '../../accounting-operations/action';
import { onRequestPost as tax } from '../../accounting-tax/action';
export const onRequestPost: PagesFunction = (context) => routeAccountingDomainPost(context, 'tax', 'action', { operations, tax });
