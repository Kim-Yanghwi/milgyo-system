import { clean } from './helpers';

// Backward-compatible exports for callers that still use the former module name.
export { ensureAccountingDomainTables as ensureAccountingSpecialTables } from './accounting-domain-schema';

export { nextSpecialSequence, nextSpecialNumber } from './accounting-numbering';
export { getDimensionMaster, validateDimensions, getResolutionDimensions } from './accounting-dimensions';

export const nextAvailableCardNumber=async(db:D1Database,year?:number)=>{
  const y=year||new Date(Date.now()+9*60*60*1000).getUTCFullYear();
  const prefix=`카드-${y}-`;
  const rows=await db.prepare(`SELECT card_code FROM accounting_cards WHERE card_code LIKE ? ORDER BY card_code`)
    .bind(`${prefix}%`).all<{card_code:string}>();
  const used=new Set<number>();
  for(const row of rows.results||[]){
    const match=String(row.card_code||'').match(new RegExp(`^카드-${y}-(\\d{4})$`));
    if(match)used.add(Number(match[1]));
  }
  let seq=1;
  while(used.has(seq)&&seq<=9999)seq+=1;
  if(seq>9999)throw new Error(`${y}년 법인카드 코드를 더 이상 생성할 수 없습니다.`);
  await db.prepare(`INSERT INTO accounting_special_sequences (seq_key,last_seq) VALUES (?,?)
    ON CONFLICT(seq_key) DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq)`)
    .bind(`card:${y}`,seq).run();
  return `${prefix}${String(seq).padStart(4,'0')}`;
};

export const cleanSpecialText=(value:unknown,max=200)=>clean(value,max);
