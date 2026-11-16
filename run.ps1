# MediCore HMS - one-command launcher (Docker: PostgreSQL + API + web UI).
# Usage:  .\run.ps1            lab mode (vulnerable scenarios enabled, loopback only)
#         .\run.ps1 -Secure    secure mode
#         .\run.ps1 -Stop      stop the containers
#         .\run.ps1 -NoBrowser do not open the browser
#         .\run.ps1 -Rebuild   force rebuilding the images (after code or dependency changes)
param([switch]$Secure, [switch]$Stop, [switch]$NoBrowser, [switch]$Rebuild)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$url = 'http://127.0.0.1:5173'

$files = @('-f', 'docker-compose.yml')
if (-not $Secure) { $files += @('-f', 'docker-compose.lab.yml') }
$mode = if ($Secure) { 'secure' } else { 'lab (vulnerable scenarios ON)' }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'Docker is not installed or not on PATH. Install Docker Desktop first.' -ForegroundColor Red
  exit 1
}

if ($Stop) {
  & docker compose @files down
  exit $LASTEXITCODE
}

# 1. make sure the Docker engine is running (start Docker Desktop if needed)
& docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Docker engine is not running, starting Docker Desktop...' -ForegroundColor Yellow
  $candidates = @("$env:ProgramFiles\Docker\Docker\Docker Desktop.exe", "${env:ProgramFiles(x86)}\Docker\Docker\Docker Desktop.exe")
  $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $exe) { Write-Host 'Docker Desktop not found. Start Docker manually and re-run.' -ForegroundColor Red; exit 1 }
  Start-Process $exe
  $ready = $false
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    & docker info *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  }
  if (-not $ready) { Write-Host 'Docker did not become ready in 3 minutes.' -ForegroundColor Red; exit 1 }
}

# 2. .env with synthetic defaults, if missing
if (-not (Test-Path .env) -and (Test-Path .env.example)) { Copy-Item .env.example .env }

# 2b. ports 4000/5173 must be free (unless our own containers already hold them)
$ours = (& docker compose @files ps -q 2>$null)
if (-not $ours) {
  foreach ($p in 4000, 5173) {
    $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) {
      $name = (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName
      Write-Host "Port $p is already in use by '$name' (PID $($c.OwningProcess)). Stop it (e.g. a local npm dev server) and re-run." -ForegroundColor Red
      exit 1
    }
  }
}

# 3. build and start everything in the background
Write-Host "Starting MediCore HMS in $mode mode (first build can take a few minutes)..." -ForegroundColor Cyan
# images are reused when they already exist (no re-download, no rebuild); use -Rebuild after changing code or dependencies
$missing = $false
foreach ($img in (& docker compose @files config --images)) {
  & docker image inspect $img *> $null
  if ($LASTEXITCODE -ne 0) { $missing = $true }
}
if ($Rebuild -or $missing) {
  Write-Host 'Building images...' -ForegroundColor Yellow
  & docker compose @files up --build -d
} else {
  Write-Host 'Reusing existing images (no rebuild).' -ForegroundColor DarkGray
  & docker compose @files up -d
}
if ($LASTEXITCODE -ne 0) { Write-Host 'docker compose failed.' -ForegroundColor Red; exit $LASTEXITCODE }

# 4. wait until the API and the web UI answer
function Test-Url($u) {
  try { return (Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 3).StatusCode -lt 500 } catch { return $false }
}
Write-Host 'Waiting for the services to be ready...' -NoNewline
$up = $false
for ($i = 0; $i -lt 120; $i++) {
  if ((Test-Url 'http://127.0.0.1:4000/api/health') -and (Test-Url $url)) { $up = $true; break }
  Write-Host '.' -NoNewline
  Start-Sleep -Seconds 2
}
Write-Host ''
if (-not $up) {
  Write-Host 'Timed out. Check the logs:  docker compose logs --tail 50' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host '  MediCore HMS is running' -ForegroundColor Green
Write-Host "  Open:  $url" -ForegroundColor Green
Write-Host '  API:   http://127.0.0.1:4000/api/health'
Write-Host '  Demo accounts: see README.md  |  Stop: .\run.ps1 -Stop  |  Logs: docker compose logs -f'
Write-Host ''
if (-not $NoBrowser) { Start-Process $url }
