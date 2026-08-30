-- Prevent one accounting target from being matched to multiple imported transactions.
CREATE TRIGGER IF NOT EXISTS trg_import_match_target_unique_insert
BEFORE INSERT ON accounting_import_transactions
WHEN NEW.status='matched' AND COALESCE(NEW.matched_type,'')<>'' AND COALESCE(NEW.matched_id,'')<>'' AND EXISTS(SELECT 1 FROM accounting_import_transactions e WHERE e.status='matched' AND e.matched_type=NEW.matched_type AND e.matched_id=NEW.matched_id AND e.id<>NEW.id)
BEGIN SELECT RAISE(ABORT,'duplicate accounting match target'); END;
CREATE TRIGGER IF NOT EXISTS trg_import_match_target_unique_update
BEFORE UPDATE OF status,matched_type,matched_id ON accounting_import_transactions
WHEN NEW.status='matched' AND COALESCE(NEW.matched_type,'')<>'' AND COALESCE(NEW.matched_id,'')<>'' AND EXISTS(SELECT 1 FROM accounting_import_transactions e WHERE e.status='matched' AND e.matched_type=NEW.matched_type AND e.matched_id=NEW.matched_id AND e.id<>NEW.id)
BEGIN SELECT RAISE(ABORT,'duplicate accounting match target'); END;
