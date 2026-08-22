import { routeAccountingDomainPost } from '../../../_shared/accounting-domain-router';
import { onRequestPost as operations } from '../../accounting-operations/query';
import { onRequestPost as special } from '../../accounting-special/query';
export const onRequestPost: PagesFunction = (context) => routeAccountingDomainPost(context, 'cash', 'query', { operations, special });
