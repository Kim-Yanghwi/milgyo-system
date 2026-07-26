import { authenticateSession, clean, ensureTables, json, makeDocumentNumber, randomHex } from '../../_shared/helpers';
import {
  canViewAllAccounting,
  cleanAccountingText,
  ensureAccountingTables,
  isAccountingManager,
  isPeriodClosed,
  nextAccountingNumber,
  parseMoney,
  prepareResolutionPosting,
} from '../../_shared/accounting';

interface Env { DB: D1Database; }
type Payload = Record<string, unknown> & { token?: string; action?: string };
type UserRow = { id:string; name:string; position:string|null; can_approve:number; active:number };

type ApprovalLine = { lineType:'협조'|'검토'|'결재'|'전결'; userId:string; userName:string; userPosition:string|null };
const statusForLineType=(type:ApprovalLine['lineType'])=>type==='협조'?'협조대기':type==='검토'?'검토대기':type==='전결'?'전결대기':'결재대기';
const listIds=(raw:unknown)=>Array.isArray(raw)?raw.map((v)=>clean(v,60)).filter((v,i,a)=>v&&a.indexOf(v)===i):[];
const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value);
const auditStatement=(db:D1Database,action:string,type:string,id:string,userId:string,userName:string,detail:unknown,now:string)=>
  db.prepare(`INSERT INTO accounting_audit_logs (id,action,entity_type,entity_id,actor_user_id,actor_name,detail_json,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind(`LOG-${randomHex(20)}`,action,type,id,userId,userName,JSON.stringify(detail||{}),now);

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if(!env.DB)return json({ok:false,message:'DB가 연결되지 않았습니다.'},500);
  let payload:Payload;try{payload=await request.json();}catch{return json({ok:false,message:'요청 형식이 올바르지 않습니다.'},400);}
  await ensureTables(env.DB);await ensureAccountingTables(env.DB);
  const auth=await authenticateSession(env.DB,clean(payload.token,200));if(!auth.ok)return json({ok:false,message:auth.message},auth.status);
  const me=auth.user;const action=clean(payload.action,50);const manager=isAccountingManager(me);
  if(me.role==='audit')return json({ok:false,message:'감사 계정은 회계자료를 열람할 수 있지만 등록·수정할 수 없습니다.'},403);

  try{
    if(action==='save-fiscal-year'){
      if(!manager)return json({ok:false,message:'회계연도 설정 권한이 없습니다.'},403);
      const year=Number(payload.year);if(!Number.isInteger(year)||year<2000||year>2200)return json({ok:false,message:'회계연도를 확인해 주세요.'},400);
      const now=new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO accounting_fiscal_years (year,name,start_date,end_date,base_currency,status,created_by,created_at)
          VALUES (?,?,?,?,?,'open',?,?) ON CONFLICT(year) DO UPDATE SET name=excluded.name,start_date=excluded.start_date,end_date=excluded.end_date,base_currency=excluded.base_currency`)
          .bind(year,clean(payload.name,80)||`${year} 회계연도`,clean(payload.startDate,10)||`${year}-01-01`,clean(payload.endDate,10)||`${year}-12-31`,clean(payload.currency,10)||'KRW',me.name,now),
        auditStatement(env.DB,'save','fiscal-year',String(year),me.id,me.name,payload,now),
      ]);
      return json({ok:true,message:'회계연도를 저장했습니다.'});
    }

    if(action==='save-account'){
      if(!manager)return json({ok:false,message:'계정과목 관리 권한이 없습니다.'},403);
      const code=clean(payload.code,20).replace(/[^0-9A-Za-z_-]/g,'');const name=clean(payload.name,80);
      const type=clean(payload.accountType,20);const side=clean(payload.normalSide,10);
      if(!code||!name||!['asset','liability','equity','revenue','expense'].includes(type)||!['debit','credit'].includes(side))return json({ok:false,message:'계정과목 정보를 정확히 입력해 주세요.'},400);
      const existingAccount=await env.DB.prepare(`SELECT system_account FROM accounting_accounts WHERE code=?`).bind(code).first<{system_account:number}>();
      if(existingAccount?.system_account)return json({ok:false,message:'기본 계정과목은 코드·유형을 변경할 수 없습니다. 별도 하위 계정과목을 추가해 주세요.'},400);
      const now=new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO accounting_accounts (code,name,account_type,normal_side,parent_code,active,system_account,created_at,updated_at)
          VALUES (?,?,?,?,?,1,0,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,account_type=excluded.account_type,normal_side=excluded.normal_side,parent_code=excluded.parent_code,active=1,updated_at=excluded.updated_at`)
          .bind(code,name,type,side,clean(payload.parentCode,20)||null,now,now),
        auditStatement(env.DB,'save','account',code,me.id,me.name,{code,name,type,side},now),
      ]);
      return json({ok:true,message:'계정과목을 저장했습니다.'});
    }

    if(action==='save-budget'){
      if(!manager)return json({ok:false,message:'예산 편성 권한이 없습니다.'},403);
      const year=Number(payload.year);const accountCode=clean(payload.accountCode,20);const department=clean(payload.department,80);const project=clean(payload.project,100);
      if(!Number.isInteger(year)||!accountCode)return json({ok:false,message:'회계연도와 예산 계정과목을 선택해 주세요.'},400);
      const account=await env.DB.prepare(`SELECT account_type FROM accounting_accounts WHERE code=? AND active=1`).bind(accountCode).first<{account_type:string}>();
      if(!account||account.account_type!=='expense')return json({ok:false,message:'예산은 지출 계정과목으로 편성해 주세요.'},400);
      const now=new Date().toISOString();const id=`BUD-${year}-${randomHex(14)}`;
      const amounts={original:parseMoney(payload.originalAmount),supplementary:parseMoney(payload.supplementaryAmount),transferIn:parseMoney(payload.transferIn),transferOut:parseMoney(payload.transferOut)};
      if(Object.values(amounts).some((v)=>v<0))return json({ok:false,message:'예산 금액은 0원 이상으로 입력해 주세요.'},400);
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO accounting_budgets
          (id,fiscal_year,department,project,account_code,original_amount,supplementary_amount,transfer_in,transfer_out,memo,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(fiscal_year,department,project,account_code) DO UPDATE SET
          original_amount=excluded.original_amount,supplementary_amount=excluded.supplementary_amount,transfer_in=excluded.transfer_in,transfer_out=excluded.transfer_out,memo=excluded.memo,updated_at=excluded.updated_at`)
          .bind(id,year,department,project,accountCode,amounts.original,amounts.supplementary,amounts.transferIn,amounts.transferOut,clean(payload.memo,1000)||null,me.name,now,now),
        auditStatement(env.DB,'save','budget',`${year}:${department}:${project}:${accountCode}`,me.id,me.name,amounts,now),
      ]);
      return json({ok:true,message:'예산을 저장했습니다.'});
    }

    if(action==='create-resolution'){
      const type=clean(payload.resolutionType,20);if(!['income','expense'].includes(type))return json({ok:false,message:'수입 또는 지출 결의 구분을 선택해 주세요.'},400);
      const date=clean(payload.resolutionDate,10);if(!validDate(date))return json({ok:false,message:'결의일자를 확인해 주세요.'},400);
      if(await isPeriodClosed(env.DB,date))return json({ok:false,message:'해당 회계기간은 마감되어 결의서를 작성할 수 없습니다.'},400);
      const year=Number(date.slice(0,4));const title=clean(payload.title,200);const amount=parseMoney(payload.amount);
      const accountCode=clean(payload.accountCode,20);const settlement=clean(payload.settlementAccountCode,20)||'1120';
      if(!title||amount<=0||!accountCode)return json({ok:false,message:'제목·금액·계정과목을 정확히 입력해 주세요.'},400);
      const accounts=await env.DB.prepare(`SELECT code,account_type FROM accounting_accounts WHERE code IN (?,?) AND active=1`).bind(accountCode,settlement).all<{code:string;account_type:string}>();
      const accountMap=new Map((accounts.results||[]).map((a)=>[a.code,a.account_type]));
      if(accountMap.get(accountCode)!==(type==='income'?'revenue':'expense'))return json({ok:false,message:type==='income'?'수입 계정과목을 선택해 주세요.':'지출 계정과목을 선택해 주세요.'},400);
      if(accountMap.get(settlement)!=='asset')return json({ok:false,message:'입·출금 계정은 현금·예금 등 자산 계정으로 선택해 주세요.'},400);

      if(type==='expense'){
        const budget=await env.DB.prepare(`SELECT (original_amount+supplementary_amount+transfer_in-transfer_out) AS revised FROM accounting_budgets WHERE fiscal_year=? AND department=? AND project=? AND account_code=?`)
          .bind(year,clean(payload.department,80),clean(payload.project,100),accountCode).first<{revised:number}>();
        if(budget){
          const used=await env.DB.prepare(`SELECT COALESCE(SUM(l.debit-l.credit),0) AS used FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id WHERE j.status IN ('posted','reversed') AND j.fiscal_year=? AND l.account_code=? AND l.department=? AND l.project=?`)
            .bind(year,accountCode,clean(payload.department,80),clean(payload.project,100)).first<{used:number}>();
          const available=Number(budget.revised||0)-Number(used?.used||0);
          if(amount>available && !(manager&&payload.allowOverBudget===true))return json({ok:false,message:`예산 잔액(${available.toLocaleString('ko-KR')}원)을 초과합니다. 회계담당자가 초과집행 여부를 확인해 주세요.`,budgetWarning:true,available},400);
        }
      }

      const approverId=clean(payload.approverUserId,60);if(!approverId)return json({ok:false,message:'최종 결재자를 선택해 주세요.'},400);
      const cooperatorIds=listIds(payload.cooperatorUserIds);const reviewerIds=listIds(payload.reviewerUserIds);
      const allIds=[...cooperatorIds,...reviewerIds,approverId];if(new Set(allIds).size!==allIds.length)return json({ok:false,message:'협조자·검토자·결재자는 서로 다르게 지정해 주세요.'},400);
      const users=await env.DB.prepare(`SELECT CAST(id AS TEXT) AS id,name,position,can_approve,active FROM system_users WHERE CAST(id AS TEXT) IN (${allIds.map(()=>'?').join(',')})`).bind(...allIds).all<UserRow>();
      const userMap=new Map((users.results||[]).map((u)=>[u.id,u]));if(allIds.some((id)=>!userMap.get(id)?.active))return json({ok:false,message:'선택한 결재선에 사용할 수 없는 계정이 있습니다.'},400);
      const approver=userMap.get(approverId)!;if(!approver.can_approve)return json({ok:false,message:'최종 결재자에게 결재권이 없습니다.'},400);
      const lines:ApprovalLine[]=[];
      cooperatorIds.forEach((id)=>{const u=userMap.get(id)!;lines.push({lineType:'협조',userId:id,userName:u.name,userPosition:u.position});});
      reviewerIds.forEach((id)=>{const u=userMap.get(id)!;lines.push({lineType:'검토',userId:id,userName:u.name,userPosition:u.position});});
      lines.push({lineType:'결재',userId:approver.id,userName:approver.name,userPosition:approver.position});
      const selfImmediate=lines.length===1&&approver.id===me.id;
      const now=new Date();const nowIso=now.toISOString();const resolutionId=`RES-${randomHex(24)}`;
      const resolutionNo=await nextAccountingNumber(env.DB,type==='income'?'resolution-income':'resolution-expense',year);
      const documentId=await makeDocumentNumber(env.DB,now);const status=selfImmediate?'승인':statusForLineType(lines[0].lineType);
      const department=clean(payload.department,80)||me.department||'';const project=clean(payload.project,100);const counterparty=clean(payload.counterparty,120);
      const memo=clean(payload.memo,2000);const payment=clean(payload.paymentMethod,40);
      const typeLabel=type==='income'?'수입결의':'지출결의';
      const body=`1. 결의번호: ${resolutionNo}\n2. 결의일자: ${date}\n3. 회계구분: ${typeLabel}\n4. 계정과목: ${accountCode}\n5. 금액: ${amount.toLocaleString('ko-KR')}원\n6. 거래처·납부자: ${counterparty||'-'}\n7. 담당부서 / 사업: ${department||'-'} / ${project||'-'}\n8. 입·출금계정: ${settlement}\n9. 지급·수납방법: ${payment||'-'}\n10. 비고\n${memo||'없음'}`;
      const formData={_accountingResolutionId:resolutionId,resolutionNo,resolutionType:type,amount:String(amount),accountCode,settlementAccountCode:settlement};
      const statements:D1PreparedStatement[]=[
        env.DB.prepare(`INSERT INTO accounting_resolutions
          (id,resolution_no,resolution_type,fiscal_year,resolution_date,title,department,project,counterparty,account_code,settlement_account_code,amount,tax_amount,payment_method,memo,document_id,status,created_by_user_id,created_by_name,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(resolutionId,resolutionNo,type,year,date,title,department,project,counterparty,accountCode,settlement,amount,parseMoney(payload.taxAmount),payment||null,memo||null,documentId,selfImmediate?'approved':'approval_pending',me.id,me.name,nowIso,nowIso),
        env.DB.prepare(`INSERT INTO documents
          (id,doc_type,category,title,summary,body,attachments_note,drafter,drafter_user_id,drafter_position,reviewer_user_id,reviewer_name,reviewer_position,approver_user_id,approver_name,approver_position,department,recipient,via,approval_track,approval_mode,status,template_id,template_name,form_data_json,access_scope,submitted_at,completed_at,created_at,updated_at)
          VALUES (?, '기안','예산·결산·사업계획·사업실적 관련 문서',?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'이사장결재','결재',?,NULL,?,?, '관련자',?,?,?,?)`)
          .bind(documentId,`[${typeLabel}] ${title}`,`${resolutionNo} · ${amount.toLocaleString('ko-KR')}원`,body,'',me.name,me.id,me.position||null,
            reviewerIds[0]||null,reviewerIds[0]?userMap.get(reviewerIds[0])?.name:null,reviewerIds[0]?userMap.get(reviewerIds[0])?.position:null,
            approver.id,approver.name,approver.position,department,status,`${typeLabel}서`,JSON.stringify(formData),nowIso,selfImmediate?nowIso:null,nowIso,nowIso),
      ];
      lines.forEach((line,index)=>statements.push(env.DB.prepare(`INSERT INTO document_approval_lines
        (id,document_id,line_order,line_type,user_id,user_name,user_position,status,acted_at,memo,created_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`)
        .bind(`AL-${randomHex(20)}`,documentId,index+1,line.lineType,line.userId,line.userName,line.userPosition,selfImmediate?'완료':index===0?'대기':'예정',selfImmediate?nowIso:null,nowIso)));
      statements.push(env.DB.prepare(`INSERT INTO document_approvals (id,document_id,action,approver_name,approver_role,memo,created_at) VALUES (?,?, '상신',?,?,?,?)`)
        .bind(`AP-${randomHex(20)}`,documentId,me.name,me.position||'기안자',selfImmediate?'기안자와 결재자가 동일하여 즉시 승인':'회계결의 상신',nowIso));
      if(selfImmediate)statements.push(env.DB.prepare(`INSERT INTO document_approvals (id,document_id,action,approver_name,approver_role,memo,created_at) VALUES (?,?, '승인',?,?,?,?)`)
        .bind(`AP-${randomHex(20)}`,documentId,me.name,me.position||'결재자','기안자와 결재자가 동일하여 자동 승인',nowIso));
      statements.push(auditStatement(env.DB,'create','resolution',resolutionId,me.id,me.name,{resolutionNo,documentId,amount},nowIso));
      await env.DB.batch(statements);
      if(selfImmediate){
        const resolution=await env.DB.prepare(`SELECT * FROM accounting_resolutions WHERE id=?`).bind(resolutionId).first<any>();
        const posting=await prepareResolutionPosting(env.DB,resolution,me.name);if(posting.statements.length)await env.DB.batch(posting.statements);
      }
      return json({ok:true,id:resolutionId,resolutionNo,documentId,status:selfImmediate?'posted':'approval_pending',message:selfImmediate?'결의서가 즉시 승인되어 전표가 생성되었습니다.':'결의서가 전자결재로 상신되었습니다.'});
    }

    if(action==='create-manual-journal'){
      if(!manager)return json({ok:false,message:'수동전표 입력 권한이 없습니다.'},403);
      const date=clean(payload.journalDate,10);if(!validDate(date))return json({ok:false,message:'전표일자를 확인해 주세요.'},400);
      if(await isPeriodClosed(env.DB,date))return json({ok:false,message:'해당 회계기간은 마감되었습니다.'},400);
      const rawLines=Array.isArray(payload.lines)?payload.lines as Array<Record<string,unknown>>:[];
      const lines=rawLines.slice(0,30).map((l)=>({accountCode:clean(l.accountCode,20),debit:parseMoney(l.debit),credit:parseMoney(l.credit),department:clean(l.department,80),project:clean(l.project,100),counterparty:clean(l.counterparty,120),memo:clean(l.memo,300)})).filter((l)=>l.accountCode&&(l.debit||l.credit));
      const debit=lines.reduce((s,l)=>s+l.debit,0),credit=lines.reduce((s,l)=>s+l.credit,0);
      if(lines.length<2||debit<=0||debit!==credit||lines.some((l)=>l.debit<0||l.credit<0||(l.debit&&l.credit)))return json({ok:false,message:'차변과 대변을 각각 0원 이상으로 입력하고 합계가 일치하도록 작성해 주세요.'},400);
      const uniqueAccounts=[...new Set(lines.map((l)=>l.accountCode))];
      const validAccounts=await env.DB.prepare(`SELECT code FROM accounting_accounts WHERE active=1 AND code IN (${uniqueAccounts.map(()=>'?').join(',')})`).bind(...uniqueAccounts).all<{code:string}>();
      if((validAccounts.results||[]).length!==uniqueAccounts.length)return json({ok:false,message:'사용할 수 없는 계정과목이 포함되어 있습니다.'},400);
      const year=Number(date.slice(0,4)),id=`JRN-${randomHex(24)}`,journalNo=await nextAccountingNumber(env.DB,'journal',year),now=new Date().toISOString();
      const statements:D1PreparedStatement[]=[env.DB.prepare(`INSERT INTO accounting_journals
        (id,journal_no,fiscal_year,journal_date,source_type,description,status,created_by,approved_by,created_at) VALUES (?,?,?,?, 'manual',?,'posted',?,?,?)`)
        .bind(id,journalNo,year,date,clean(payload.description,300)||'수동전표',me.name,me.name,now)];
      lines.forEach((l,i)=>statements.push(env.DB.prepare(`INSERT INTO accounting_journal_lines
        (id,journal_id,line_no,account_code,debit,credit,department,project,counterparty,memo) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(`JL-${randomHex(20)}`,id,i+1,l.accountCode,l.debit,l.credit,l.department,l.project,l.counterparty,l.memo||null)));
      statements.push(auditStatement(env.DB,'post','journal',id,me.id,me.name,{journalNo,debit,lines:lines.length},now));await env.DB.batch(statements);
      return json({ok:true,id,journalNo,message:'수동전표를 등록했습니다.'});
    }

    if(action==='reverse-journal'){
      if(!manager)return json({ok:false,message:'전표 취소 권한이 없습니다.'},403);
      const sourceId=clean(payload.id,80);const source=await env.DB.prepare(`SELECT * FROM accounting_journals WHERE id=? AND status='posted'`).bind(sourceId).first<any>();
      if(!source)return json({ok:false,message:'취소할 전표를 찾을 수 없습니다.'},404);
      if(source.source_type==='reversal')return json({ok:false,message:'역분개 전표는 다시 취소할 수 없습니다. 원전표와 함께 회계담당자가 확인해 주세요.'},400);
      if(await isPeriodClosed(env.DB,source.journal_date))return json({ok:false,message:'마감된 회계기간의 전표는 취소할 수 없습니다.'},400);
      const lines=await env.DB.prepare(`SELECT * FROM accounting_journal_lines WHERE journal_id=? ORDER BY line_no`).bind(sourceId).all<any>();
      const id=`JRN-${randomHex(24)}`,no=await nextAccountingNumber(env.DB,'journal',source.fiscal_year),now=new Date().toISOString();
      const statements:D1PreparedStatement[]=[
        env.DB.prepare(`INSERT INTO accounting_journals (id,journal_no,fiscal_year,journal_date,source_type,source_id,description,status,reversed_journal_id,created_by,approved_by,created_at)
          VALUES (?,?,?,?, 'reversal',?,?, 'posted',?,?,?,?)`).bind(id,no,source.fiscal_year,source.journal_date,sourceId,`[취소] ${source.description}`,sourceId,me.name,me.name,now),
        env.DB.prepare(`UPDATE accounting_journals SET status='reversed',reversed_journal_id=? WHERE id=?`).bind(id,sourceId),
      ];
      (lines.results||[]).forEach((l:any,i:number)=>statements.push(env.DB.prepare(`INSERT INTO accounting_journal_lines
        (id,journal_id,line_no,account_code,debit,credit,department,project,counterparty,memo) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(`JL-${randomHex(20)}`,id,i+1,l.account_code,l.credit,l.debit,l.department,l.project,l.counterparty,`원전표 ${source.journal_no} 취소`)));
      if(source.source_type==='resolution'&&source.source_id)statements.push(env.DB.prepare(`UPDATE accounting_resolutions SET status='cancelled',updated_at=? WHERE id=?`).bind(now,source.source_id));
      statements.push(auditStatement(env.DB,'reverse','journal',sourceId,me.id,me.name,{reversalNo:no},now));await env.DB.batch(statements);
      return json({ok:true,message:'원전표를 삭제하지 않고 역분개 전표로 취소했습니다.',reversalNo:no});
    }

    if(action==='close-period'||action==='reopen-period'){
      if(!manager)return json({ok:false,message:'회계기간 마감 권한이 없습니다.'},403);
      const year=Number(payload.year),month=Number(payload.month);if(!Number.isInteger(year)||month<1||month>12)return json({ok:false,message:'마감 연월을 확인해 주세요.'},400);
      const now=new Date().toISOString(),id=`CLS-${year}-${String(month).padStart(2,'0')}`;
      if(action==='close-period'){
        const imbalance=await env.DB.prepare(`SELECT COALESCE(SUM(l.debit),0) AS d,COALESCE(SUM(l.credit),0) AS c FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id WHERE j.status IN ('posted','reversed') AND j.fiscal_year=? AND substr(j.journal_date,6,2)=?`).bind(year,String(month).padStart(2,'0')).first<{d:number;c:number}>();
        if(Number(imbalance?.d||0)!==Number(imbalance?.c||0))return json({ok:false,message:'차변·대변 합계가 일치하지 않아 마감할 수 없습니다.'},400);
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO accounting_closings (id,fiscal_year,period_month,status,closed_by,closed_at,memo) VALUES (?,?,?,'closed',?,?,?) ON CONFLICT(fiscal_year,period_month) DO UPDATE SET status='closed',closed_by=excluded.closed_by,closed_at=excluded.closed_at,memo=excluded.memo`).bind(id,year,month,me.name,now,clean(payload.memo,500)||null),
          auditStatement(env.DB,'close','period',id,me.id,me.name,{year,month},now),
        ]);return json({ok:true,message:`${year}년 ${month}월 회계기간을 마감했습니다.`});
      }
      await env.DB.batch([env.DB.prepare(`DELETE FROM accounting_closings WHERE fiscal_year=? AND period_month=?`).bind(year,month),auditStatement(env.DB,'reopen','period',id,me.id,me.name,{year,month},now)]);
      return json({ok:true,message:`${year}년 ${month}월 마감을 해제했습니다.`});
    }

    return json({ok:false,message:'지원하지 않는 회계 처리입니다.'},400);
  }catch(error){console.error('accounting action failed',action,error);return json({ok:false,message:error instanceof Error?error.message:'회계 처리 중 오류가 발생했습니다.'},500);}
};
export const onRequestGet:PagesFunction=async()=>json({ok:false,message:'POST 방식으로 요청해 주세요.'},405);
