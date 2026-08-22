/**
 * Canonical accounting domain contract.
 *
 * The legacy API files remain in place for backward compatibility, but every
 * business action/query is owned by exactly one functional domain. New UI code
 * should route through /api/accounting-domains/<domain>/{query|action}.
 *
 * `init` is intentionally excluded: each legacy workspace still performs its
 * own bootstrap while the UI is migrated incrementally. Binary/shared
 * attachment APIs are platform services and are also intentionally excluded.
 */
export type AccountingDomain = 'core' | 'cash' | 'giving' | 'governance' | 'tax';
export type AccountingLegacyApi = 'accounting' | 'operations' | 'special' | 'compliance' | 'tax';
export type AccountingDomainKind = 'query' | 'action';

type DomainContract = Record<AccountingDomain, Partial<Record<AccountingLegacyApi, readonly string[]>>>;

export const ACCOUNTING_DOMAIN_QUERIES: DomainContract = {
  core: {
    accounting: ['accounts','budget-execution','budgets','budgets-export','closings','integration-status','journal-detail','journals','ledger','ledger-export','resolutions','statement','trial-balance'],
    operations: ['budget-versions','budgets'],
    special: ['master'],
  },
  cash: {
    operations: ['match-candidates','reconciliations','transactions'],
    special: ['cards'],
  },
  giving: {
    special: ['assets','assets-export','branch-reports','consolidated-report','donations','donations-export','donors','receipt-detail','special-summary','summary'],
  },
  governance: {
    operations: ['contract-detail','contracts','vendors'],
    compliance: ['checks','compliance-preview','incidents','procurement-detail','procurement-preview','procurements','reserve-detail','reserves','revenue-businesses','vehicle-detail','vehicles'],
  },
  tax: {
    operations: ['donation-export-candidates','donation-export-detail'],
    tax: ['export-history','overview','payees','profile','source-candidates','vat-export','vat-records','withholding-export','withholding-records'],
  },
};

export const ACCOUNTING_DOMAIN_ACTIONS: DomainContract = {
  core: {
    accounting: ['close-period','create-manual-journal','create-resolution','reopen-period','retry-integration','reverse-journal','save-account','save-budget','save-fiscal-year'],
    operations: ['create-budget-change','decide-budget-change'],
    special: ['save-book-type','save-entity','save-fund'],
  },
  cash: {
    operations: ['auto-match','complete-reconciliation','confirm-match','ignore-transaction','import-transactions','save-bank-account','save-matching-rule','unmatch'],
    special: ['delete-card','post-card-payment','post-card-transaction','save-card','save-card-transaction'],
  },
  giving: {
    special: ['cancel-receipt','dispose-asset','issue-entity-certificate','issue-receipt','post-donation','review-branch-report','save-asset','save-branch-report','save-donation','save-donor'],
  },
  governance: {
    operations: ['decide-vendor-bank-change','link-contract-payment','request-vendor-bank-change','save-contract','save-contract-payment','save-vendor'],
    compliance: ['add-reserve-transaction','add-vehicle-log','save-check','save-guarantee','save-incident','save-procurement','save-reserve','save-revenue-business','save-vehicle','save-vehicle-succession','set-vehicle-status'],
  },
  tax: {
    operations: ['apply-donation-results','create-donation-export'],
    tax: ['post-vat-adjustment','save-payee','save-profile','save-vat-record','save-withholding-record','set-vat-status','set-withholding-status'],
  },
};

export const ACCOUNTING_LEGACY_BOOTSTRAP_ACTIONS = ['init'] as const;
export const ACCOUNTING_SHARED_PLATFORM_SERVICES = [
  'attachment-admin', 'attachment-data', 'delete-attachment', 'list-attachments', 'upload-attachment', 'tax-package',
] as const;

export const actionsFor = (domain: AccountingDomain, kind: AccountingDomainKind, source: AccountingLegacyApi): readonly string[] =>
  (kind === 'query' ? ACCOUNTING_DOMAIN_QUERIES : ACCOUNTING_DOMAIN_ACTIONS)[domain][source] || [];

export const ownsAccountingAction = (domain: AccountingDomain, kind: AccountingDomainKind, source: AccountingLegacyApi, action: string): boolean =>
  actionsFor(domain, kind, source).includes(action);
