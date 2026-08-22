import { clean } from './helpers';

/** Shared accounting dimensions: book type, accounting entity and fund. */
export const getDimensionMaster=async(db:D1Database)=>{
  const [books,entities,funds]=await db.batch([
    db.prepare(`SELECT code,name,description,active,system_type FROM accounting_book_types WHERE active=1 ORDER BY CASE code WHEN 'general' THEN 1 WHEN 'purpose' THEN 2 WHEN 'revenue' THEN 3 ELSE 9 END,name`),
    db.prepare(`SELECT id,entity_code,name,entity_type,parent_id,department_path,registration_no,representative,address,affiliation_registered_at,consolidation_enabled,active FROM accounting_entities WHERE active=1 ORDER BY entity_type,entity_code,name`),
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
