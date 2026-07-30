-- v36: 기부금영수증 기부내용 다건 저장
ALTER TABLE accounting_donations ADD COLUMN receipt_items_json TEXT NOT NULL DEFAULT '[]';

UPDATE accounting_donations
SET receipt_items_json = json_array(json_object(
  'date', donation_date,
  'description', COALESCE(NULLIF(receipt_description, ''), NULLIF(purpose, ''), '기부금'),
  'amount', amount
))
WHERE receipt_items_json = '[]';

CREATE INDEX IF NOT EXISTS idx_accounting_donations_receipt_items
  ON accounting_donations(receipt_status, donation_date);
