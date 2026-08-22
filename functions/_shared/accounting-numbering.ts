/** Shared sequence/number generation used across accounting business domains. */
export const nextAccountingDomainSequence=async(db:D1Database,key:string)=>{
  await db.prepare(`INSERT OR IGNORE INTO accounting_special_sequences (seq_key,last_seq) VALUES (?,0)`).bind(key).run();
  const row=await db.prepare(`UPDATE accounting_special_sequences SET last_seq=last_seq+1 WHERE seq_key=? RETURNING last_seq`).bind(key).first<{last_seq:number}>();
  return Number(row?.last_seq||1);
};

// Backward-compatible name retained because the physical sequence table was
// introduced with the former "special accounting" module.
export const nextSpecialSequence=nextAccountingDomainSequence;

export const nextSpecialNumber=async(db:D1Database,type:'donor'|'donation'|'receipt'|'asset'|'card'|'card-tx',year?:number)=>{
  const y=year||new Date(Date.now()+9*60*60*1000).getUTCFullYear();
  const meta={donor:['후원자',`donor:${y}`,5],donation:['기부',`donation:${y}`,5],receipt:['기부금영수증',`receipt:${y}`,5],asset:['자산',`asset:${y}`,5],card:['카드',`card:${y}`,4],'card-tx':['카드사용',`card-tx:${y}`,5]} as const;
  const [prefix,key,digits]=meta[type];
  const seq=await nextAccountingDomainSequence(db,key);
  return `${prefix}-${y}-${String(seq).padStart(digits,'0')}`;
};
