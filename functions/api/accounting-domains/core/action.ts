import { routeAccountingDomainPost } from '../../../_shared/accounting-domain-router';
import { onRequestPost as accounting } from '../../accounting/action';
import { onRequestPost as operations } from '../../accounting-operations/action';
import { onRequestPost as special } from '../../accounting-special/action';
export const onRequestPost: PagesFunction = (context) => routeAccountingDomainPost(context, 'core', 'action', { accounting, operations, special });
