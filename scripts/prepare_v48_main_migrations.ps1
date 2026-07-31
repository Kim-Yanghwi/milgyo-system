$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$mainMigrationDir = Join-Path $root 'migrations\main'
$historyDir = Join-Path $root 'docs\migration-history\main-v26-manual'
$legacyVerify = Join-Path $mainMigrationDir 'verify_v26.sql'

if (Test-Path $legacyVerify) {
  New-Item -ItemType Directory -Force $historyDir | Out-Null
  Move-Item -Force $legacyVerify (Join-Path $historyDir 'verify_v26.sql')
  Write-Host 'Moved verify_v26.sql out of migrations/main.' -ForegroundColor Yellow
}

$invalid = Get-ChildItem -Path $mainMigrationDir -Filter '*.sql' |
  Where-Object { $_.Name -notmatch '^\d{4}_[A-Za-z0-9_-]+\.sql$' }
if ($invalid) {
  $names = ($invalid | Select-Object -ExpandProperty Name) -join ', '
  throw "Non-migration SQL files remain in migrations/main: $names"
}

Write-Host 'Main D1 migration directory is clean.' -ForegroundColor Green
Get-ChildItem -Path $mainMigrationDir -Filter '*.sql' |
  Sort-Object Name |
  Select-Object Name, Length, LastWriteTime |
  Format-Table -AutoSize
