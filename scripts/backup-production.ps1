param(
  [string]$OutputRoot = ".\backups",
  [string]$RcloneRemote = "",
  [switch]$SkipR2
)

$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputBase = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputRoot))
$snapshotDir = Join-Path $outputBase $timestamp
$d1Dir = Join-Path $snapshotDir "d1"
$metaDir = Join-Path $snapshotDir "metadata"
New-Item -ItemType Directory -Force -Path $d1Dir, $metaDir | Out-Null

function Invoke-Checked {
  param([string]$Command, [string[]]$Arguments)
  Write-Host "> $Command $($Arguments -join ' ')"
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "명령 실행 실패(exit=$LASTEXITCODE): $Command $($Arguments -join ' ')"
  }
}

$npx = (Get-Command npx.cmd -ErrorAction Stop).Source

$mainD1 = Join-Path $d1Dir "milgyo-system-db.sql"
$accountingD1 = Join-Path $d1Dir "milgyo-accounting-db.sql"
Invoke-Checked $npx @("wrangler", "d1", "export", "milgyo-system-db", "--remote", "--output=$mainD1", "--skip-confirmation")
Invoke-Checked $npx @("wrangler", "d1", "export", "milgyo-accounting-db", "--remote", "--output=$accountingD1", "--skip-confirmation")

$utcNow = (Get-Date).ToUniversalTime().ToString("o")
foreach ($database in @("milgyo-system-db", "milgyo-accounting-db")) {
  $bookmarkFile = Join-Path $metaDir "$database-time-travel.json"
  & $npx wrangler d1 time-travel info $database --timestamp $utcNow --json 2>&1 | Out-File -FilePath $bookmarkFile -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "$database Time Travel 북마크 조회에 실패했습니다. D1 전체 SQL 백업은 정상 생성되었는지 확인하세요."
  }
}

$sourceZip = Join-Path $snapshotDir "milgyo-system-source.zip"
$git = Get-Command git.exe -ErrorAction SilentlyContinue
$archivedByGit = $false
if ($git) {
  Push-Location $projectRoot
  try {
    & $git.Source rev-parse --is-inside-work-tree *> $null
    if ($LASTEXITCODE -eq 0) {
      Invoke-Checked $git.Source @("archive", "--format=zip", "--output=$sourceZip", "HEAD")
      $archivedByGit = $true
    }
  } finally {
    Pop-Location
  }
}

if (-not $archivedByGit) {
  $staging = Join-Path $env:TEMP "milgyo-source-$timestamp"
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  $items = @(
    "src", "functions", "public", "migrations", "workers", "scripts", "docs",
    "package.json", "package-lock.json", "astro.config.mjs", "wrangler.toml",
    "wrangler.accounting-maintenance.toml", "tsconfig.check.json",
    "accounting_schema_v26.sql"
  )
  foreach ($item in $items) {
    $source = Join-Path $projectRoot $item
    if (Test-Path $source) { Copy-Item $source -Destination $staging -Recurse -Force }
  }
  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $sourceZip -Force
  Remove-Item $staging -Recurse -Force
}

$r2Result = "skipped"
if (-not $SkipR2 -and $RcloneRemote) {
  $rclone = (Get-Command rclone.exe -ErrorAction Stop).Source
  $r2Current = Join-Path $outputBase "r2-current"
  $r2History = Join-Path $outputBase (Join-Path "r2-history" $timestamp)
  foreach ($bucket in @("milgyo-system-files", "milgyo-accounting-files")) {
    $source = "${RcloneRemote}:$bucket"
    $current = Join-Path $r2Current $bucket
    $history = Join-Path $r2History $bucket
    New-Item -ItemType Directory -Force -Path $current, $history | Out-Null
    Invoke-Checked $rclone @(
      "sync", $source, $current,
      "--backup-dir", $history,
      "--checksum", "--metadata", "--fast-list",
      "--log-file", (Join-Path $metaDir "$bucket-rclone.log"),
      "--log-level", "INFO"
    )
  }
  $r2Result = "completed"
} elseif (-not $SkipR2) {
  Write-Warning "Rclone 원격 이름이 없어 R2 파일 백업을 건너뜁니다. -RcloneRemote 매개변수를 지정하거나 -SkipR2를 사용하세요."
}

$manifest = Join-Path $snapshotDir "SHA256SUMS.txt"
Get-ChildItem $snapshotDir -File -Recurse |
  Where-Object { $_.FullName -ne $manifest } |
  Sort-Object FullName |
  ForEach-Object {
    $hash = Get-FileHash $_.FullName -Algorithm SHA256
    $relative = [System.IO.Path]::GetRelativePath($snapshotDir, $_.FullName)
    "$($hash.Hash.ToLower())  $relative"
  } | Out-File -FilePath $manifest -Encoding ascii

$summary = [ordered]@{
  createdAtLocal = (Get-Date).ToString("o")
  createdAtUtc = (Get-Date).ToUniversalTime().ToString("o")
  projectRoot = $projectRoot
  snapshotDirectory = $snapshotDir
  databases = @("milgyo-system-db", "milgyo-accounting-db")
  sourceArchive = $sourceZip
  r2Backup = $r2Result
  warning = "비밀번호, API 토큰, .env, .dev.vars는 백업 ZIP에 포함하지 않습니다. 비밀값은 별도 비밀관리 절차로 관리하세요."
}
$summary | ConvertTo-Json -Depth 5 | Out-File -FilePath (Join-Path $snapshotDir "backup-summary.json") -Encoding utf8

Write-Host ""
Write-Host "백업 생성 완료: $snapshotDir" -ForegroundColor Green
Write-Host "무결성 목록: $manifest"
