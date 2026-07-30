-- v35: 기부금영수증 법정서식 준용 출력정보 스냅샷
ALTER TABLE accounting_donations ADD COLUMN receipt_donation_type TEXT NOT NULL DEFAULT '소득세법 제34조 제1항 기부금중 종교단체 기부금';
ALTER TABLE accounting_donations ADD COLUMN receipt_donation_code TEXT NOT NULL DEFAULT '41';
ALTER TABLE accounting_donations ADD COLUMN receipt_description TEXT;
ALTER TABLE accounting_donations ADD COLUMN receipt_org_name TEXT;
ALTER TABLE accounting_donations ADD COLUMN receipt_org_registration_no TEXT;
ALTER TABLE accounting_donations ADD COLUMN receipt_org_address TEXT;
ALTER TABLE accounting_donations ADD COLUMN receipt_collector_name TEXT;
ALTER TABLE accounting_donations ADD COLUMN receipt_collector_registration_no TEXT;
ALTER TABLE accounting_donations ADD COLUMN receipt_collector_address TEXT;
ALTER TABLE accounting_donations ADD COLUMN receipt_issuer_title TEXT NOT NULL DEFAULT '주지';
ALTER TABLE accounting_donations ADD COLUMN receipt_issuer_name TEXT;
ALTER TABLE accounting_donations ADD COLUMN receipt_issuer_phone TEXT;

UPDATE accounting_donations
SET receipt_description = COALESCE(NULLIF(receipt_description, ''), purpose),
    receipt_org_name = COALESCE(NULLIF(receipt_org_name, ''), (SELECT name FROM accounting_entities e WHERE e.id = accounting_donations.entity_id)),
    receipt_org_registration_no = COALESCE(NULLIF(receipt_org_registration_no, ''), (SELECT registration_no FROM accounting_entities e WHERE e.id = accounting_donations.entity_id)),
    receipt_org_address = COALESCE(NULLIF(receipt_org_address, ''), (SELECT address FROM accounting_entities e WHERE e.id = accounting_donations.entity_id)),
    receipt_issuer_name = COALESCE(NULLIF(receipt_issuer_name, ''), (SELECT representative FROM accounting_entities e WHERE e.id = accounting_donations.entity_id));

CREATE INDEX IF NOT EXISTS idx_accounting_donations_receipt_no
  ON accounting_donations(receipt_no, receipt_status);
