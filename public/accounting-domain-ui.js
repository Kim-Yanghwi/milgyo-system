(()=>{
  'use strict';
  const pathDefaults={
    '/accounting/':'core',
    '/accounting-operations/':'cash',
    '/accounting-special/':'giving',
    '/accounting-compliance/':'governance',
    '/accounting-tax/':'tax',
    '/accounting-files/':'governance',
  };
  const aliases={accounting:'core',operations:'cash',special:'giving',compliance:'governance',files:'governance'};
  const valid=new Set(['core','cash','giving','governance','tax']);
  const url=new URL(location.href);
  const page=location.pathname.endsWith('/')?location.pathname:`${location.pathname}/`;
  const requested=aliases[url.searchParams.get('domain')]||url.searchParams.get('domain');
  const tab=url.searchParams.get('tab')||'';
  const tabDomains={
    '/accounting-operations/':{overview:'cash',reconciliation:'cash',budget:'core',contract:'governance',donation:'tax'},
    '/accounting-special/':{overview:'giving',master:'core',donation:'giving',asset:'giving',card:'cash',branch:'giving',report:'giving'},
    '/accounting-compliance/':{overview:'governance',revenue:'governance',procurement:'governance',reserve:'governance',check:'governance',vehicle:'governance'},
    '/accounting-tax/':{overview:'tax',profile:'tax',vat:'tax',withholding:'tax',package:'tax'},
    '/accounting/':{dashboard:'core',budget:'core',resolution:'core',journal:'core',ledger:'core',closing:'core',accounts:'core'},
  };
  const inferredFromTab=tabDomains[page]?.[tab];
  const domain=valid.has(requested)?requested:(inferredFromTab||pathDefaults[page]||'core');
  document.documentElement.dataset.accountingDomain=domain;
  const domainLabel={core:'회계·예산·결산',cash:'자금·거래관리',giving:'기부·자산·기관회계',governance:'계약·조달·준법',tax:'세무·신고'}[domain]||'회계관리';
  document.title=`${domainLabel} | 대한불교밀교종`;

  document.querySelectorAll('[data-accounting-domain]').forEach((link)=>{
    const active=link.dataset.accountingDomain===domain;
    link.classList.toggle('is-current',active);
    if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-domain]').forEach((element)=>{
    const domains=String(element.dataset.domain||'').split(/\s+/).filter(Boolean);
    if(domains.length)element.hidden=!domains.includes(domain);
  });
  document.querySelectorAll('[data-domain-context]').forEach((element)=>{
    element.textContent=domainLabel;
  });

  const defaults={
    '/accounting-operations/':{core:'budget',cash:'overview',governance:'contract',tax:'donation'},
    '/accounting-special/':{core:'master',cash:'card',giving:'overview'},
    '/accounting-compliance/':{governance:'overview'},
    '/accounting-tax/':{tax:'overview'},
    '/accounting/':{core:'dashboard'},
  };
  const desired=defaults[page]?.[domain];
  if(desired&&!url.searchParams.get('tab')){
    const canonicalDefault=page==='/accounting/'&&desired==='dashboard'||page==='/accounting-operations/'&&desired==='overview'||page==='/accounting-special/'&&desired==='overview'||page==='/accounting-compliance/'&&desired==='overview'||page==='/accounting-tax/'&&desired==='overview';
    if(!canonicalDefault){url.searchParams.set('tab',desired);history.replaceState(history.state,'',url);}
  }

  /* ACCOUNTING_TABLE_GRID_CONTRACT_V81_2
     Keep dynamically rendered accounting tables on the same visual contract:
     all headers are centered, while monetary values are right aligned. */
  const accountingTableSelector=[
    '.accounting-app table',
    '.ops-app table',
    '.special-app table',
    '.compliance-app table',
    '.tax-app table',
    '.file-admin table',
  ].join(',');
  const monetaryHeaderPattern=/(?:금액|가액|장부가액|예산|현예산|본예산|집행액|잔액|정상잔액|차변|대변|누계|합계|총계|총액|세액|소득세|지방세|과세표준|공급가|매입|매출|수입|지출|수지|현금|부채|기부금|약정액|지급액|입금액|출금액|원가|단가|추정가격|취득가|잔존가|처분가|설정액|사용액|환입액|필요경비|공제|공제액|실지급|총급여|추경전용|한도|차액|차이|집행률|비율|율)(?:원|천원|만원|%)?$/;

  const headerColumns=(table)=>{
    const rows=Array.from(table.tHead?.rows||[]);
    const leafRow=rows.at(-1);
    const columns=new Set();
    if(!leafRow)return columns;
    let logicalIndex=0;
    Array.from(leafRow.cells).forEach((cell)=>{
      const span=Math.max(1,Number(cell.colSpan)||1);
      const label=String(cell.textContent||'').replace(/[\s·:()\[\]/_-]+/g,'');
      const monetary=cell.classList.contains('num')||cell.classList.contains('money')||monetaryHeaderPattern.test(label);
      cell.classList.toggle('accounting-money-heading',monetary);
      if(monetary){
        for(let offset=0;offset<span;offset+=1)columns.add(logicalIndex+offset);
      }
      logicalIndex+=span;
    });
    return columns;
  };

  const markValueCells=(section,columns)=>{
    Array.from(section?.rows||[]).forEach((row)=>{
      let logicalIndex=0;
      Array.from(row.cells).forEach((cell)=>{
        const span=Math.max(1,Number(cell.colSpan)||1);
        const explicit=cell.classList.contains('num')||cell.classList.contains('money');
        let monetary=explicit;
        for(let offset=0;!monetary&&offset<span;offset+=1)monetary=columns.has(logicalIndex+offset);
        if(!cell.classList.contains('empty'))cell.classList.toggle('accounting-money-value',monetary);
        logicalIndex+=span;
      });
    });
  };

  const syncAccountingTables=()=>{
    document.querySelectorAll(accountingTableSelector).forEach((table)=>{
      table.classList.add('accounting-data-table');
      const columns=headerColumns(table);
      Array.from(table.tBodies||[]).forEach((body)=>markValueCells(body,columns));
      markValueCells(table.tFoot,columns);
    });
  };

  syncAccountingTables();
  new MutationObserver(syncAccountingTables).observe(document.documentElement,{childList:true,subtree:true});
  window.syncAccountingTableContract=syncAccountingTables;
})();
