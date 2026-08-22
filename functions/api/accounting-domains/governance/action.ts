import { routeAccountingDomainPost } from '../../../_shared/accounting-domain-router';
import { onRequestPost as operations } from '../../accounting-operations/action';
import { onRequestPost as compliance } from '../../accounting-compliance/action';
export const onRequestPost: PagesFunction = (context) => routeAccountingDomainPost(context, 'governance', 'action', { operations, compliance });
