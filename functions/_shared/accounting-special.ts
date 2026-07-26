import { clean } from './helpers';

const REQUIRED_SPECIAL_TABLES = [
  'accounting_book_types','accounting_entities','accounting_funds','accounting_budget_plans',
  'accounting_resolution_dimensions','accounting_journal_line_dimensions','accounting_donors',
  'accounting_donations','accounting_assets','accounting_cards','accounting_card_transactions',
  'accounting_branch_reports','accounting_special_sequences',
];
const specialSchemaReady=new WeakSet<object>();
const specialSchemaPromises=new WeakMap<object,Promise<void>>();

export const ensureAccountingSpecialTables=async(db:D1Database)=>{
  const key=db as unknown as object;
  if(specialSchemaReady.has(key))return;
  let pending=specialSchemaPromises.get(key);
  if(!pending){pending=(async()=>{
    const placeholders=REQUIRED_SPECIAL_TABLES.map(()=>'?').join(',');
    const row=await db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`)
      .bind(...REQUIRED_SPECIAL_TABLES).first<{count:number}>();
    if(Number(row?.count||0)!==REQUIRED_SPECIAL_TABLES.length)throw new Error('회계 전용 DB의 특화회계 스키마가 준비되지 않았습니다. v26 마이그레이션을 먼저 적용해 주세요.');
    specialSchemaReady.add(key);
  })().catch((error)=>{specialSchemaPromises.delete(key);throw error;});
    specialSchemaPromises.set(key,pending);
  }
  await pending;
};

export const nextSpecialSequence=async(db:D1Database,key:string)=>{
  await db.prepare(`INSERT OR IGNORE INTO accounting_special_sequences (seq_key,last_seq) VALUES (?,0)`).bind(key).run();
  const row=await db.prepare(`UPDATE accounting_special_sequences SET last_seq=last_seq+1 WHERE seq_key=? RETURNING last_seq`).bind(key).first<{last_seq:number}>();
  return Number(row?.last_seq||1);
};

export const nextSpecialNumber=async(db:D1Database,type:'donor'|'donation'|'receipt'|'asset'|'card'|'card-tx',year?:number)=>{
  const y=year||new Date(Date.now()+9*60*60*1000).getUTCFullYear();
  const meta={donor:['후원자',`donor:${y}`,5],donation:['기부',`donation:${y}`,5],receipt:['기부금영수증',`receipt:${y}`,5],asset:['자산',`asset:${y}`,5],card:['카드',`card:${y}`,4],'card-tx':['카드사용',`card-tx:${y}`,5]} as const;
  const [prefix,key,digits]=meta[type];
  const seq=await nextSpecialSequence(db,key);
  return `${prefix}-${y}-${String(seq).padStart(digits,'0')}`;
};

export const getDimensionMaster=async(db:D1Database)=>{
  const [books,entities,funds]=await db.batch([
    db.prepare(`SELECT code,name,description,active,system_type FROM accounting_book_types WHERE active=1 ORDER BY CASE code WHEN 'general' THEN 1 WHEN 'purpose' THEN 2 WHEN 'revenue' THEN 3 ELSE 9 END,name`),
    db.prepare(`SELECT id,entity_code,name,entity_type,parent_id,department_path,representative,address,consolidation_enabled,active FROM accounting_entities WHERE active=1 ORDER BY entity_type,entity_code,name`),
    db.prepare(`SELECT id,fund_code,name,fund_type,purpose,restriction_note,active,system_fund FROM accounting_funds WHERE active=1 ORDER BY system_fund DESC,fund_code,name`),
  ]);
  return {books:books.results||[],entities:entities.results||[],funds:funds.results||[]};
};

export const validateDimensions=async(db:D1Database,raw:Record<string,unknown>)=>{
  const bookTypeCode=clean(raw.bookTypeCode,30)||'general';
  const entityId=clean(raw.entityId,80)||'ENTITY-HQ';
  const fundId=clean(raw.fundId,80);
  const [book,entity,fund]=await db.batch([
    db.prepare(`SELECT code FROM accounting_book_types WHERE code=? AND active=1`).bind(bookTypeCode),
    db.prepare(`SELECT id FROM accounting_entities WHERE id=? AND active=1`).bind(entityId),
    fundId?db.prepare(`SELECT id FROM accounting_funds WHERE id=? AND active=1`).bind(fundId):db.prepare(`SELECT '' AS id`),
  ]);
  if(!book.results?.length)throw new Error('회계구분을 확인해 주세요.');
  if(!entity.results?.length)throw new Error('회계조직을 확인해 주세요.');
  if(fundId&&!fund.results?.length)throw new Error('재원을 확인해 주세요.');
  return {bookTypeCode,entityId,fundId};
};

export const getResolutionDimensions=async(db:D1Database,resolutionId:string)=>{
  const row=await db.prepare(`SELECT book_type_code,entity_id,fund_id,source_category FROM accounting_resolution_dimensions WHERE resolution_id=?`).bind(resolutionId).first<any>();
  return {bookTypeCode:row?.book_type_code||'general',entityId:row?.entity_id||'ENTITY-HQ',fundId:row?.fund_id||'',sourceCategory:row?.source_category||''};
};

export const cleanSpecialText=(value:unknown,max=200)=>clean(value,max);
