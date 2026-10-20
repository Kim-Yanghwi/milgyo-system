-- READ-ONLY: schema/template verification. No personal records are returned.
WITH expected(type,name) AS (VALUES
 ('table','monk_card_sequences'),('table','monk_card_numbers'),('table','monk_cards'),
 ('table','monk_card_changes'),('table','monk_card_attachments'),
 ('index','idx_monk_card_first'),('index','idx_monk_card_replacement'),
 ('index','idx_monk_cards_registry'),('index','idx_monk_cards_validity'),('index','idx_monk_cards_document'),
 ('index','idx_monk_card_changes_card'),('index','idx_monk_card_attachments_card'),
 ('trigger','trg_monk_card_identity_immutable'),('trigger','trg_monk_cards_registry_status'))
SELECT e.type,e.name,CASE WHEN s.name IS NULL THEN 'MISSING' ELSE 'OK' END AS status
FROM expected e LEFT JOIN sqlite_master s ON s.type=e.type AND s.name=e.name
ORDER BY e.type,e.name;
SELECT id,name,active,is_system FROM document_templates
WHERE id IN ('TPL-MONK-CARD-APPLICATION','TPL-MONK-CARD-CONSENT') ORDER BY id;
PRAGMA foreign_key_check;
