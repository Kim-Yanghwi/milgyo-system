SELECT name FROM sqlite_master
WHERE type='table' AND name IN (
  'management_registers',
  'management_register_attachments',
  'employee_profiles',
  'employment_certificates',
  'management_audit_logs'
)
ORDER BY name;

SELECT name FROM sqlite_master
WHERE type='index' AND name IN (
  'idx_management_registers_type_date',
  'idx_management_registers_applicant',
  'idx_management_registers_status',
  'idx_management_register_attachments_record',
  'idx_employment_certificates_employee',
  'idx_employment_certificates_status',
  'idx_management_audit_target'
)
ORDER BY name;

SELECT 'management_registers' AS item, COUNT(*) AS count FROM management_registers
UNION ALL SELECT 'management_register_attachments', COUNT(*) FROM management_register_attachments
UNION ALL SELECT 'employee_profiles', COUNT(*) FROM employee_profiles
UNION ALL SELECT 'employment_certificates', COUNT(*) FROM employment_certificates
UNION ALL SELECT 'management_audit_logs', COUNT(*) FROM management_audit_logs;
