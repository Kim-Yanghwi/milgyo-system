import { isValidIsoDate } from './helpers';
export function isMonkCardFields(fields: Array<{id?:string}>): boolean {
 return fields.some(f=>f.id==='cardPrivacyConsent')&&fields.some(f=>f.id==='cardSensitiveConsent');
}
export function validateMonkCardForm(fields:Array<{id?:string}>,data:Record<string,string>):string {
 if(!isMonkCardFields(fields))return '';
 for(const key of ['cardPrivacyConsent','cardSensitiveConsent'])if(!['동의','비동의'].includes(data[key]))return '일반정보·민감정보 동의를 각각 선택해 주세요.';
 if(fields.some(f=>f.id==='applicationType')){
  if(data.cardPrivacyConsent!=='동의'||data.cardSensitiveConsent!=='동의')return '발급 신청에는 별도 동의 확인이 필요합니다. 비동의 기록은 동의서 서식을 사용하세요.';
  if(!['신규','재발급','갱신'].includes(data.applicationType))return '신청 구분을 확인해 주세요.';
  for(const key of ['receiptDate','birthDate','ordinationDate','photoTakenDate','applicationDate'])if(!isValidIsoDate(data[key]||''))return '신청서 날짜를 YYYY-MM-DD로 확인해 주세요.';
  if(data.photoCheck!=='확인')return '사진 요건을 확인해 주세요.';
  if(data.photoTakenDate>data.applicationDate)return '사진 촬영일이 신청일보다 늦습니다.';
  const a=new Date(data.applicationDate+'T00:00:00Z');const min=new Date(Date.UTC(a.getUTCFullYear(),a.getUTCMonth()-6,a.getUTCDate())).toISOString().slice(0,10);
  if(data.photoTakenDate<min)return '신청일 전 6개월 이내에 촬영한 사진을 사용해 주세요.';
  if(data.applicationType!=='신규'&&!data.previousCardNo)return '종전 발급번호를 기입해 주세요.';
  if(data.applicationType==='재발급'&&!['분실','훼손','기재사항 변경'].includes(data.reissueReason))return '재발급 사유를 기입해 주세요.';
 }
 return '';
}
