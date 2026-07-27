-- 각 DB에 맞는 부분만 실행하세요.

-- [milgyo-accounting-db 검증]
SELECT
  (SELECT COUNT(*) FROM accounting_resolutions) AS resolutions,
  (SELECT COUNT(*) FROM accounting_journals) AS journals,
  (SELECT COUNT(*) FROM accounting_journal_lines) AS journal_lines,
  (SELECT COUNT(*) FROM accounting_attachments) AS attachments,
  (SELECT COUNT(*) FROM accounting_monthly_summary) AS monthly_summary,
  (SELECT COUNT(*) FROM accounting_audit_logs) AS audit_logs,
  (SELECT COUNT(*) FROM accounting_budget_plans) AS budget_plans,
  (SELECT COUNT(*) FROM accounting_budgets) AS budgets,
  (SELECT COUNT(*) FROM accounting_donations) AS donations,
  (SELECT COUNT(*) FROM accounting_assets) AS assets,
  (SELECT COUNT(*) FROM accounting_card_transactions) AS card_transactions;

-- [milgyo-system-db 검증]
SELECT
  (SELECT COUNT(*) FROM documents) AS documents,
  (SELECT COUNT(*) FROM document_approval_lines) AS approval_lines,
  (SELECT COUNT(*) FROM document_approvals) AS approvals,
  (SELECT COUNT(*) FROM document_attachments) AS document_attachments,
  (SELECT COUNT(*) FROM received_documents) AS received_documents,
  (SELECT COUNT(*) FROM received_attachments) AS received_attachments,
  (SELECT COUNT(*) FROM document_dispatch_links) AS dispatch_links,
  (SELECT COUNT(*) FROM accounting_outbox) AS accounting_outbox;
