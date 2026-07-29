SELECT COUNT(*) AS accounting_tables
FROM sqlite_master
WHERE type='table' AND name LIKE 'accounting_%';

SELECT
  (SELECT COUNT(*) FROM accounting_accounts) AS accounts,
  (SELECT COUNT(*) FROM accounting_fiscal_years) AS fiscal_years,
  (SELECT COUNT(*) FROM accounting_book_types) AS book_types,
  (SELECT COUNT(*) FROM accounting_funds) AS funds,
  (SELECT COUNT(*) FROM accounting_monthly_summary) AS monthly_rows,
  (SELECT meta_value FROM accounting_meta WHERE meta_key='schema_version') AS schema_version;
