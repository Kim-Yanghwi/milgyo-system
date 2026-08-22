import { routeAccountingDomainPost } from '../../../_shared/accounting-domain-router';
import { onRequestPost as operations } from '../../accounting-operations/query';
import { onRequestPost as tax } from '../../accounting-tax/query';
export const onRequestPost: PagesFunction = (context) => routeAccountingDomainPost(context, 'tax', 'query', { operations, tax });
