import { routeAccountingDomainPost } from '../../../_shared/accounting-domain-router';
import { onRequestPost as operations } from '../../accounting-operations/query';
import { onRequestPost as compliance } from '../../accounting-compliance/query';
export const onRequestPost: PagesFunction = (context) => routeAccountingDomainPost(context, 'governance', 'query', { operations, compliance });
