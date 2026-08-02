-- v60: 수계증서 좌측 상단 사찰 도장 표시 여부 및 도장 자산 식별자 보존
ALTER TABLE ordination_certificates
  ADD COLUMN include_top_seal INTEGER NOT NULL DEFAULT 1;

ALTER TABLE ordination_certificates
  ADD COLUMN top_seal_key TEXT NOT NULL DEFAULT 'hyangcheonsa';
