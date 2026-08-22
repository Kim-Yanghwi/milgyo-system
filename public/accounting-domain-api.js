(()=>{
  'use strict';
  const endpoints={
    '/api/accounting/query':{source:'accounting',kind:'query'},
    '/api/accounting/action':{source:'accounting',kind:'action'},
    '/api/accounting-operations/query':{source:'operations',kind:'query'},
    '/api/accounting-operations/action':{source:'operations',kind:'action'},
    '/api/accounting-special/query':{source:'special',kind:'query'},
    '/api/accounting-special/action':{source:'special',kind:'action'},
    '/api/accounting-compliance/query':{source:'compliance',kind:'query'},
    '/api/accounting-compliance/action':{source:'compliance',kind:'action'},
    '/api/accounting-tax/query':{source:'tax',kind:'query'},
    '/api/accounting-tax/action':{source:'tax',kind:'action'},
  };
  const owner=new Map();
  const add=(domain,kind,source,actions)=>actions.forEach((action)=>owner.set(`${kind}:${source}:${action}`,domain));

  add('core','query','accounting',['accounts','budget-execution','budgets','budgets-export','closings','integration-status','journal-detail','journals','ledger','ledger-export','resolutions','statement','trial-balance']);
  add('core','query','operations',['budget-versions','budgets']);
  add('core','query','special',['master']);
  add('cash','query','operations',['match-candidates','reconciliations','transactions']);
  add('cash','query','special',['cards']);
  add('giving','query','special',['assets','assets-export','branch-reports','consolidated-report','donations','donations-export','donors','receipt-detail','special-summary','summary']);
  add('governance','query','operations',['contract-detail','contracts','vendors']);
  add('governance','query','compliance',['checks','compliance-preview','incidents','procurement-detail','procurement-preview','procurements','reserve-detail','reserves','revenue-businesses','vehicle-detail','vehicles']);
  add('tax','query','operations',['donation-export-candidates','donation-export-detail']);
  add('tax','query','tax',['export-history','overview','payees','profile','source-candidates','vat-export','vat-records','withholding-export','withholding-records']);

  add('core','action','accounting',['close-period','create-manual-journal','create-resolution','reopen-period','retry-integration','reverse-journal','save-account','save-budget','save-fiscal-year']);
  add('core','action','operations',['create-budget-change','decide-budget-change']);
  add('core','action','special',['save-book-type','save-entity','save-fund']);
  add('cash','action','operations',['auto-match','complete-reconciliation','confirm-match','ignore-transaction','import-transactions','save-bank-account','save-matching-rule','unmatch']);
  add('cash','action','special',['delete-card','post-card-payment','post-card-transaction','save-card','save-card-transaction']);
  add('giving','action','special',['cancel-receipt','dispose-asset','issue-entity-certificate','issue-receipt','post-donation','review-branch-report','save-asset','save-branch-report','save-donation','save-donor']);
  add('governance','action','operations',['decide-vendor-bank-change','link-contract-payment','request-vendor-bank-change','save-contract','save-contract-payment','save-vendor']);
  add('governance','action','compliance',['add-reserve-transaction','add-vehicle-log','save-check','save-guarantee','save-incident','save-procurement','save-reserve','save-revenue-business','save-vehicle','save-vehicle-succession','set-vehicle-status']);
  add('tax','action','operations',['apply-donation-results','create-donation-export']);
  add('tax','action','tax',['post-vat-adjustment','save-payee','save-profile','save-vat-record','save-withholding-record','set-vat-status','set-withholding-status']);

  const route=(path,body={})=>{
    const endpoint=endpoints[path];
    if(!endpoint)return {path,body};
    const action=String(body?.action||'');
    if(!action)return {path,body};
    if(action==='init'){
      if(endpoint.kind!=='query')throw new Error(`회계 초기화 요청 형식이 올바르지 않습니다: ${endpoint.source}/${endpoint.kind}`);
      return {path:'/api/accounting-bootstrap',body:{...body,_legacyApi:endpoint.source}};
    }
    const domain=owner.get(`${endpoint.kind}:${endpoint.source}:${action}`);
    if(!domain)throw new Error(`회계 API 업무영역이 지정되지 않았습니다: ${endpoint.source}/${endpoint.kind}/${action}`);
    return {path:`/api/accounting-domains/${domain}/${endpoint.kind}`,body:{...body,_legacyApi:endpoint.source}};
  };
  window.AccountingDomainApi=Object.freeze({route});
})();
