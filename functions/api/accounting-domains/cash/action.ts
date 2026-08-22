import { routeAccountingDomainPost } from '../../../_shared/accounting-domain-router';
import { onRequestPost as operations } from '../../accounting-operations/action';
import { onRequestPost as special } from '../../accounting-special/action';
export const onRequestPost: PagesFunction = (context) => routeAccountingDomainPost(context, 'cash', 'action', { operations, special });
