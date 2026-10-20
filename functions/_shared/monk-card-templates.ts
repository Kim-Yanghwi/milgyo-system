import type { TemplateField } from './helpers';
export const MONK_CARD_TEMPLATES: Array<{id:string;name:string;description:string;docType:string;category:string;titlePrefix:string;fields:TemplateField[];bodyTemplate:string}> = [
  {
    "id": "TPL-MONK-CARD-APPLICATION",
    "name": "승려증 발급 신청서",
    "description": "규정 별지 제1호: 신규·갱신·재발급 신청 및 내부결재. 문서는 관련자로 공개 범위를 제한합니다.",
    "docType": "기안",
    "category": "일반(경미한 내부보고·단순사무 — 전결대상)",
    "titlePrefix": "[승려증 발급 신청서] ",
    "fields": [
      {
        "id": "receiptNo",
        "label": "접수번호",
        "type": "text",
        "required": false,
        "width": "half"
      },
      {
        "id": "receiptDate",
        "label": "접수일",
        "type": "date",
        "required": true,
        "width": "half"
      },
      {
        "id": "applicationType",
        "label": "신청 구분",
        "type": "select",
        "required": true,
        "width": "half",
        "options": [
          "신규",
          "갱신",
          "재발급"
        ]
      },
      {
        "id": "reissueReason",
        "label": "재발급 사유",
        "type": "select",
        "required": true,
        "width": "half",
        "options": [
          "해당 없음",
          "분실",
          "훼손",
          "기재사항 변경"
        ]
      },
      {
        "id": "dharmaNameKo",
        "label": "법명(한글)",
        "type": "text",
        "required": true,
        "width": "half"
      },
      {
        "id": "dharmaNameHanja",
        "label": "법명(한자)",
        "type": "text",
        "required": false,
        "width": "half"
      },
      {
        "id": "monasticNo",
        "label": "승적번호",
        "type": "text",
        "required": true,
        "width": "half"
      },
      {
        "id": "dharmaRank",
        "label": "법계",
        "type": "text",
        "required": true,
        "width": "half"
      },
      {
        "id": "temple",
        "label": "소속사찰",
        "type": "text",
        "required": true,
        "width": "half"
      },
      {
        "id": "birthDate",
        "label": "생년월일",
        "type": "date",
        "required": true,
        "width": "half"
      },
      {
        "id": "ordinationDate",
        "label": "수계일",
        "type": "date",
        "required": true,
        "width": "half"
      },
      {
        "id": "mobile",
        "label": "휴대전화",
        "type": "text",
        "required": false,
        "width": "half"
      },
      {
        "id": "changes",
        "label": "기재사항 변경 내용 (변경 전 / 후)",
        "type": "textarea",
        "required": false,
        "width": "full"
      },
      {
        "id": "previousCardNo",
        "label": "종전 승려증 발급번호",
        "type": "text",
        "required": false,
        "width": "half"
      },
      {
        "id": "previousHandling",
        "label": "종전 승려증 처리",
        "type": "select",
        "required": true,
        "width": "half",
        "options": [
          "해당 없음",
          "함께 반납",
          "분실 신고함"
        ]
      },
      {
        "id": "photoTakenDate",
        "label": "사진 촬영일",
        "type": "date",
        "required": true,
        "width": "half"
      },
      {
        "id": "photoCheck",
        "label": "사진 요건 확인 (6개월 이내 / 승복 / 정면 / 3:4 / JPG 600x800 이상)",
        "type": "select",
        "required": true,
        "width": "full",
        "options": [
          "확인",
          "미확인"
        ]
      },
      {
        "id": "cardPrivacyConsent",
        "label": "일반 개인정보 수집·이용 동의",
        "type": "select",
        "required": true,
        "width": "half",
        "options": [
          "동의",
          "비동의"
        ]
      },
      {
        "id": "cardSensitiveConsent",
        "label": "민감정보 처리 별도 동의",
        "type": "select",
        "required": true,
        "width": "half",
        "options": [
          "동의",
          "비동의"
        ]
      },
      {
        "id": "consentReference",
        "label": "별지 제2호 동의서 참조번호·첨부파일명",
        "type": "text",
        "required": true,
        "width": "full"
      },
      {
        "id": "abbotConfirmation",
        "label": "소속사찰 주지 확인",
        "type": "select",
        "required": true,
        "width": "half",
        "options": [
          "주지 확인",
          "신청인이 주지",
          "변동 없는 갱신"
        ]
      },
      {
        "id": "abbotName",
        "label": "확인 주지 법명",
        "type": "text",
        "required": false,
        "width": "half"
      },
      {
        "id": "applicationDate",
        "label": "신청일",
        "type": "date",
        "required": true,
        "width": "half"
      },
      {
        "id": "applicantName",
        "label": "신청인 법명",
        "type": "text",
        "required": true,
        "width": "half"
      },
      {
        "id": "attachments",
        "label": "붙임 목록 (사진 / 동의서 / 종전 승려증)",
        "type": "textarea",
        "required": true,
        "width": "full"
      },
      {
        "id": "officeNote",
        "label": "총무원 처리란 (승적부 대조 / 발급번호 / 교부일 / 담당자)",
        "type": "textarea",
        "required": false,
        "width": "full"
      }
    ],
    "bodyTemplate": "승려증 발급 및 관리 규정 별지 제1호서식에 따른 전자결재 신청입니다.\n처리기간: 30일 (서류 보완 기간 제외)\n\n접수번호: {{receiptNo}}\n접수일: {{receiptDate}}\n신청 구분: {{applicationType}}\n재발급 사유: {{reissueReason}}\n법명(한글): {{dharmaNameKo}}\n법명(한자): {{dharmaNameHanja}}\n승적번호: {{monasticNo}}\n법계: {{dharmaRank}}\n소속사찰: {{temple}}\n생년월일: {{birthDate}}\n수계일: {{ordinationDate}}\n휴대전화: {{mobile}}\n기재사항 변경 내용 (변경 전 / 후): {{changes}}\n종전 승려증 발급번호: {{previousCardNo}}\n종전 승려증 처리: {{previousHandling}}\n사진 촬영일: {{photoTakenDate}}\n사진 요건 확인 (6개월 이내 / 승복 / 정면 / 3:4 / JPG 600x800 이상): {{photoCheck}}\n일반 개인정보 수집·이용 동의: {{cardPrivacyConsent}}\n민감정보 처리 별도 동의: {{cardSensitiveConsent}}\n별지 제2호 동의서 참조번호·첨부파일명: {{consentReference}}\n소속사찰 주지 확인: {{abbotConfirmation}}\n확인 주지 법명: {{abbotName}}\n신청일: {{applicationDate}}\n신청인 법명: {{applicantName}}\n붙임 목록 (사진 / 동의서 / 종전 승려증): {{attachments}}\n총무원 처리란 (승적부 대조 / 발급번호 / 교부일 / 담당자): {{officeNote}}\n\n위와 같이 승려증 발급을 신청합니다.\n대한불교밀교종 총무원장 귀하\n※ 신청서 결재는 신청인·주지의 서명 및 개인별 동의서 확인을 대체하지 않습니다."
  },
  {
    "id": "TPL-MONK-CARD-CONSENT",
    "name": "개인정보 수집·이용 동의서 (승려증)",
    "description": "별지 제2호: 일반·민감정보 별도 동의 확인 기록.",
    "docType": "기안",
    "category": "일반(경미한 내부보고·단순사무 — 전결대상)",
    "titlePrefix": "[개인정보 수집·이용 동의서 (승려증)] ",
    "fields": [
      {
        "id": "dharmaNameKo",
        "label": "법명",
        "type": "text",
        "required": true,
        "width": "half"
      },
      {
        "id": "consentDate",
        "label": "동의 확인일",
        "type": "date",
        "required": true,
        "width": "half"
      },
      {
        "id": "cardPrivacyConsent",
        "label": "일반 개인정보 수집·이용",
        "type": "select",
        "required": true,
        "width": "half",
        "options": [
          "동의",
          "비동의"
        ]
      },
      {
        "id": "cardSensitiveConsent",
        "label": "민감정보 처리",
        "type": "select",
        "required": true,
        "width": "half",
        "options": [
          "동의",
          "비동의"
        ]
      },
      {
        "id": "contractor",
        "label": "제작 수탁자",
        "type": "text",
        "required": false,
        "width": "half"
      },
      {
        "id": "entrustmentCheck",
        "label": "처리 위탁 사실 확인",
        "type": "select",
        "required": true,
        "width": "half",
        "options": [
          "확인함",
          "해당 없음",
          "미확인"
        ]
      },
      {
        "id": "signatureEvidence",
        "label": "서명된 동의서·확인 증빙",
        "type": "text",
        "required": true,
        "width": "full"
      }
    ],
    "bodyTemplate": "승려증 발급 개인정보 수집·이용 동의서 (별지 제2호)\n목적: 발급·재발급·갱신, 진위 확인, 발급 이력 관리\n일반정보: 법명(한글·한자), 생년월일, 휴대전화번호, 사진\n민감정보: 승적번호, 법계, 소속사찰, 수계일\n수집하지 않는 정보: 주민등록번호, 주소, 속명\n보유기간: 발급관리대장은 승적부와 같은 기간 / 신청서·사진은 효력 종료 후 1년\n처리 위탁: 승려증 인쇄·제작, 인쇄 항목과 사진만 제공. 제작 종료 후 파기.\n동의를 거부할 수 있으며, 동의하지 않으면 승려증을 발급받을 수 없습니다.\n법명: {{dharmaNameKo}}\n동의 확인일: {{consentDate}}\n일반 개인정보 수집·이용: {{cardPrivacyConsent}}\n민감정보 처리: {{cardSensitiveConsent}}\n제작 수탁자: {{contractor}}\n처리 위탁 사실 확인: {{entrustmentCheck}}\n서명된 동의서·확인 증빙: {{signatureEvidence}}\n\n대한불교밀교종 총무원장 귀하"
  }
];
