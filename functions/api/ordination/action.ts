import { authenticateSession, clean, ensureTables, isValidIsoDate, json, randomHex } from '../../_shared/helpers';
import { makeOrdinationCertificateNumber, writeManagementAudit } from '../../_shared/management';

interface Env { DB: D1Database; }
type Payload = {
  token?: string;
  operation?: string;
  requestId?: string;
  recipientName?: string;
  birthCalendar?: string;
  birthDate?: string;
  dharmaNameHanja?: string;
  dharmaNameKorean?: string;
  ordinationDate?: string;
  teacherName?: string;
  preceptorName?: string;
  witnessName?: string;
  organizationName?: string;
  templeName?: string;
  issuerName?: string;
  closingText?: string;
  includeTopSeal?: boolean | number | string;
  topSealKey?: string;
  note?: string;
  id?: string;
  reason?: string;
};

const TEMPLATE_VERSION = 'ordination-v3';
const DEFAULT_TOP_SEAL_KEY = 'logo_sq';
const TOP_SEAL_KEYS = new Set(['logo_sq', 'hyangcheonsa']);
const BIRTH_CALENDARS = ['음력', '양력'] as const;
const DEFAULTS = {
  teacherName: '睡翁 眞妙',
  preceptorName: '東翁 呑析',
  witnessName: 'LAMA WANGDA',
  organizationName: '大韓佛敎 密敎宗',
  templeName: '香天寺',
  issuerName: '睡翁 眞妙',
  closingText: '合掌',
};

const fixedCertificateText = {
  ordinationTitle: '受 戒',
  commandTitle: '戒命',
  preceptsTitle: '五戒',
  commandLines: [
    '본래 청정한 자기 성품을 찾아가는 {법명} 보람되고 성스러운',
    '수행과 효도를 바탕으로 생사와 선악과 종교를 초월한 자성',
    '자리에서 심신을 갈고 닦아 마침내 득도를 이루어',
    '중생의 광명이 되리라.',
  ],
  precepts: [
    { hanja: '不殺生', korean: '불살생', text: '생명이 있는 것은 불성이 있고 불성이 있는 것은 불자이니 생명을 존중히 여겨 함부로 죽이지 말자.' },
    { hanja: '不偸盜', korean: '불투도', text: '모든 물질은 입자로 구성된 오온의 화합이라 무상한 것이니 삼독심을 버리고 베풀되 훔치지 말자.' },
    { hanja: '不邪淫', korean: '불사음', text: '하늘에 부끄럽지 아니하고 마음에 거리낌 없는 청정한 심신을 지키되 음행하지 말자.' },
    { hanja: '不妄語', korean: '불망어', text: '화안, 애어로서 화합을 즐기고 항상 진실을 지키며 망어, 기어, 양설, 악구를 행하지 말자.' },
    { hanja: '不飮酒', korean: '불음주', text: '음욕은 윤회의 근본이요, 술은 파계의 근본이니 정견 정행으로서 필요 없는 술을 마시지 말자.' },
  ],
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.DB) return json({ ok: false, message: 'DB가 연결되지 않았습니다.' }, 500);
  let payload: Payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, message: '요청 형식이 올바르지 않습니다.' }, 400); }

  await ensureTables(env.DB);
  const auth = await authenticateSession(env.DB, clean(payload.token, 200));
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);
  const operation = clean(payload.operation, 30);

  if (operation === 'issue') {
    if (auth.user.role !== 'admin') return json({ ok: false, message: '수계증서는 관리자만 발급할 수 있습니다.' }, 403);

    const requestId = clean(payload.requestId, 100);
    if (!/^[A-Za-z0-9_-]{12,100}$/.test(requestId)) {
      return json({ ok: false, message: '발급 요청 식별값이 올바르지 않습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.' }, 400);
    }
    const previous = await env.DB.prepare(`
      SELECT * FROM ordination_certificates WHERE request_id=? AND issued_by_user_id=?
    `).bind(requestId, auth.user.id).first<any>();
    if (previous) {
      let snapshot: Record<string, unknown> | null = null;
      try { snapshot = JSON.parse(String(previous.certificate_snapshot || '{}')); } catch {}
      return json({ ok: true, row: { ...previous, snapshot }, repeated: true, message: `N:${previous.certificate_no} 수계증서가 이미 발급되어 기존 발급본을 불러왔습니다.` });
    }

    const recipientName = clean(payload.recipientName, 60);
    const birthCalendar = clean(payload.birthCalendar, 10);
    const birthDate = clean(payload.birthDate, 10);
    const dharmaNameHanja = clean(payload.dharmaNameHanja, 60);
    const dharmaNameKorean = clean(payload.dharmaNameKorean, 60);
    const ordinationDate = clean(payload.ordinationDate, 10);
    if (!recipientName || !dharmaNameHanja || !dharmaNameKorean) {
      return json({ ok: false, message: '성명과 법명(한자·한글)을 모두 입력해 주세요.' }, 400);
    }
    if (!BIRTH_CALENDARS.includes(birthCalendar as typeof BIRTH_CALENDARS[number])) {
      return json({ ok: false, message: '생년월일 기준은 음력 또는 양력으로 선택해 주세요.' }, 400);
    }
    if (!isValidIsoDate(birthDate)) return json({ ok: false, message: '생년월일이 올바르지 않습니다.' }, 400);
    if (!isValidIsoDate(ordinationDate)) return json({ ok: false, message: '수계일이 올바르지 않습니다.' }, 400);

    const teacherName = clean(payload.teacherName, 80) || DEFAULTS.teacherName;
    const preceptorName = clean(payload.preceptorName, 80) || DEFAULTS.preceptorName;
    const witnessName = clean(payload.witnessName, 100) || DEFAULTS.witnessName;
    const organizationName = clean(payload.organizationName, 100) || DEFAULTS.organizationName;
    const templeName = clean(payload.templeName, 80) || DEFAULTS.templeName;
    const issuerName = clean(payload.issuerName, 80) || DEFAULTS.issuerName;
    const closingText = clean(payload.closingText, 30) || DEFAULTS.closingText;
    const includeTopSeal = payload.includeTopSeal === undefined
      ? true
      : payload.includeTopSeal === true || payload.includeTopSeal === 1
        || payload.includeTopSeal === '1' || payload.includeTopSeal === 'true' || payload.includeTopSeal === 'on';
    const requestedTopSealKey = clean(payload.topSealKey, 30);
    const topSealKey = TOP_SEAL_KEYS.has(requestedTopSealKey) ? requestedTopSealKey : DEFAULT_TOP_SEAL_KEY;
    const note = clean(payload.note, 1000);
    const buddhistYear = Number(ordinationDate.slice(0, 4)) + 544;
    const { certificateNo, issueYear, sequence } = await makeOrdinationCertificateNumber(env.DB, ordinationDate);
    const id = `ORDCERT-${randomHex(24)}`;
    const now = new Date().toISOString();
    const snapshot = {
      certificateNo, recipientName, birthCalendar, birthDate, dharmaNameHanja, dharmaNameKorean,
      ordinationDate, buddhistYear, teacherName, preceptorName, witnessName, organizationName,
      templeName, issuerName, closingText, includeTopSeal, topSealKey, note, templateVersion: TEMPLATE_VERSION, fixedCertificateText,
    };

    try {
      await env.DB.prepare(`
        INSERT INTO ordination_certificates (
          id,certificate_no,request_id,issue_year,sequence_no,recipient_name,birth_calendar,birth_date,
          dharma_name_hanja,dharma_name_korean,ordination_date,buddhist_year,
          teacher_name,preceptor_name,witness_name,organization_name,temple_name,issuer_name,closing_text,
          include_top_seal,top_seal_key,note,template_version,certificate_snapshot,status,issued_by_user_id,issued_by_name,issued_at,
          created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        id, certificateNo, requestId, issueYear, sequence, recipientName, birthCalendar, birthDate,
        dharmaNameHanja, dharmaNameKorean, ordinationDate, buddhistYear,
        teacherName, preceptorName, witnessName, organizationName, templeName, issuerName, closingText,
        includeTopSeal ? 1 : 0, topSealKey, note, TEMPLATE_VERSION, JSON.stringify(snapshot), '발급', auth.user.id, auth.user.name, now, now, now,
      ).run();
    } catch (error) {
      console.error('ordination certificate issue failed', error);
      return json({ ok: false, message: '수계증서 발급번호 생성 또는 저장 중 오류가 발생했습니다. 다시 시도해 주세요.' }, 500);
    }

    await writeManagementAudit(env.DB, auth.user, '수계증서', '발급', id, {
      certificateNo, recipientName, dharmaNameHanja, dharmaNameKorean, ordinationDate, includeTopSeal, topSealKey,
    });
    const row = await env.DB.prepare('SELECT * FROM ordination_certificates WHERE id=?').bind(id).first<any>();
    return json({ ok: true, row: { ...row, snapshot }, message: `N:${certificateNo} 수계증서가 발급되었습니다.` });
  }

  if (operation === 'cancel') {
    if (auth.user.role !== 'admin') return json({ ok: false, message: '수계증서 취소는 관리자만 처리할 수 있습니다.' }, 403);
    const id = clean(payload.id, 80);
    const reason = clean(payload.reason, 500);
    if (!id) return json({ ok: false, message: '취소할 발급내역을 선택해 주세요.' }, 400);
    if (!reason) return json({ ok: false, message: '취소 사유를 입력해 주세요.' }, 400);
    const row = await env.DB.prepare('SELECT * FROM ordination_certificates WHERE id=?').bind(id).first<any>();
    if (!row) return json({ ok: false, message: '수계증서 발급내역을 찾을 수 없습니다.' }, 404);
    if (row.status === '취소') return json({ ok: false, message: '이미 취소된 수계증서입니다.' }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE ordination_certificates
      SET status='취소',canceled_at=?,canceled_by_user_id=?,canceled_by_name=?,cancel_reason=?,updated_at=?
      WHERE id=?
    `).bind(now, auth.user.id, auth.user.name, reason, now, id).run();
    await writeManagementAudit(env.DB, auth.user, '수계증서', '취소', id, { certificateNo: row.certificate_no, reason });
    return json({ ok: true, message: '수계증서 발급이 취소되었습니다.' });
  }

  return json({ ok: false, message: '지원하지 않는 작업입니다.' }, 400);
};

export const onRequestGet: PagesFunction = async () => json({ ok: false, message: 'POST 방식으로 요청해 주세요.' }, 405);
