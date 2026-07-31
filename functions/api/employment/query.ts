import { authenticateSession, clean, ensureTables, json } from '../../_shared/helpers';
interface Env { DB:D1Database; }
type Payload={token?:string;operation?:string;query?:string;status?:string;page?:number;pageSize?:number;employeeUserId?:string;id?:string};
const maskIdentity=(value:unknown)=>{const raw=String(value||'');if(!raw)return '';if(raw.length<=6)return raw.slice(0,2)+'***';return raw.slice(0,6)+'-'+raw.slice(6).replace(/./g,'*');};
export const onRequestPost:PagesFunction<Env>=async({request,env})=>{
  if(!env.DB)return json({ok:false,message:'DB가 연결되지 않았습니다.'},500);
  let p:Payload;try{p=await request.json();}catch{return json({ok:false,message:'요청 형식이 올바르지 않습니다.'},400);}
  await ensureTables(env.DB);const auth=await authenticateSession(env.DB,clean(p.token,200));if(!auth.ok)return json({ok:false,message:auth.message},auth.status);
  const op=clean(p.operation,20)||'list';
  if(op==='options'){
    const all=auth.user.role==='admin';
    // D1 prepared statements cannot be selected dynamically through string interpolation; execute explicitly.
    const result=all
      ? await env.DB.prepare(`SELECT CAST(u.id AS TEXT) AS id,u.name,u.position,u.grade,u.department,u.role,u.active,p.name_hanja,p.birth_or_registration,p.address,p.employment_start_date,p.contact FROM system_users u LEFT JOIN employee_profiles p ON p.user_id=CAST(u.id AS TEXT) WHERE u.active=1 ORDER BY u.name`).all()
      : await env.DB.prepare(`SELECT CAST(u.id AS TEXT) AS id,u.name,u.position,u.grade,u.department,u.role,u.active,p.name_hanja,p.birth_or_registration,p.address,p.employment_start_date,p.contact FROM system_users u LEFT JOIN employee_profiles p ON p.user_id=CAST(u.id AS TEXT) WHERE u.active=1 AND CAST(u.id AS TEXT)=? ORDER BY u.name`).bind(auth.user.id).all();
    return json({ok:true,users:result.results||[],me:auth.user,canManage:auth.user.role==='admin',canIssue:auth.user.role==='admin'});
  }
  if(op==='detail'){
    const id=clean(p.id,80);const row=await env.DB.prepare('SELECT * FROM employment_certificates WHERE id=?').bind(id).first<any>();if(!row)return json({ok:false,message:'재직증명서 발급내역을 찾을 수 없습니다.'},404);if(auth.user.role!=='admin'&&auth.user.role!=='audit'&&String(row.employee_user_id)!==auth.user.id)return json({ok:false,message:'열람 권한이 없습니다.'},403);return json({ok:true,row,me:auth.user,canManage:auth.user.role==='admin'});
  }
  const page=Math.max(1,Math.min(10000,Number(p.page)||1)),pageSize=Math.max(10,Math.min(100,Number(p.pageSize)||20));const filters:string[]=[];const binds:unknown[]=[];
  if(auth.user.role!=='admin'&&auth.user.role!=='audit'){filters.push('employee_user_id=?');binds.push(auth.user.id);}else if(clean(p.employeeUserId,80)){filters.push('employee_user_id=?');binds.push(clean(p.employeeUserId,80));}
  const q=clean(p.query,100);if(q){const k=`%${q}%`;filters.push('(certificate_no LIKE ? OR employee_name_ko LIKE ? OR department LIKE ? OR purpose LIKE ?)');binds.push(k,k,k,k);}const status=clean(p.status,20);if(status){filters.push('status=?');binds.push(status);}const where=filters.length?`WHERE ${filters.join(' AND ')}`:'';const offset=(page-1)*pageSize;
  try{const [cr,rr]=await env.DB.batch([(binds.length?env.DB.prepare(`SELECT COUNT(*) AS count FROM employment_certificates ${where}`).bind(...binds):env.DB.prepare(`SELECT COUNT(*) AS count FROM employment_certificates ${where}`)),env.DB.prepare(`SELECT * FROM employment_certificates ${where} ORDER BY issue_date DESC,created_at DESC LIMIT ? OFFSET ?`).bind(...binds,pageSize,offset)]);const total=Number((cr.results?.[0] as any)?.count||0);const rows=(rr.results||[]).map((r:any)=>{const {birth_or_registration,...safe}=r;return {...safe,birth_or_registration_masked:maskIdentity(birth_or_registration)};});return json({ok:true,rows,total,page,pageSize,pages:Math.max(1,Math.ceil(total/pageSize)),me:auth.user,canManage:auth.user.role==='admin'});}catch(e){console.error('employment query failed',e);return json({ok:false,message:'재직증명서 발급대장 조회 중 오류가 발생했습니다.'},500);}
};
export const onRequestGet:PagesFunction=async()=>json({ok:false,message:'POST 방식으로 요청해 주세요.'},405);
