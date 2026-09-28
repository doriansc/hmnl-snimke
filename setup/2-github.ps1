<#
  Objavljuje stranicu na GitHubu:
    - upise Tenant/Client ID-jeve iz setup\ids-*.json u config.json
    - napravi javni repozitorij (ako ne postoji) i ukljuci GitHub Pages iz Actions
    - generira nasumicne lozinke za korisnike i spremi ih u secret USERS
      (lozinke se ispisuju SAMO u ovom prozoru - spremi ih odmah)
    - posalje kod (git push), sto pokrece prvi build

  Pokretanje iz mape hmnl-snimke-v2 (nakon 1-tenant.ps1 za obje lige):
    powershell -ExecutionPolicy Bypass -File .\setup\2-github.ps1
  Nove lozinke (npr. kad se promijeni vodstvo):
    powershell -ExecutionPolicy Bypass -File .\setup\2-github.ps1 -NoveLozinke
  Ako nema Gita ili GitHub CLI-ja, skripta ih instalira preko wingeta.
#>
param(
  [string]$Repo = 'doriansc/hmnl-snimke',
  [string[]]$Korisnici = @('admin', 'romeo.cizmesija'),
  [switch]$NoveLozinke
)
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
function Stani($poruka) { Write-Host "`nGRESKA: $poruka" -ForegroundColor Red; exit 1 }

function Treba($cmd, $winget) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { return }
  Write-Host "Nedostaje '$cmd' - instaliram ($winget)..." -ForegroundColor Yellow
  winget install --id $winget -e --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Stani "'$cmd' nije dostupan nakon instalacije. Otvori novi PowerShell prozor i pokreni skriptu ponovno." }
}
# git i gh su mozda instalirani nakon otvaranja ovog prozora - osvjezi PATH prije provjere
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
Treba git 'Git.Git'
Treba gh 'GitHub.cli'

# 1. ID-jevi iz 1-tenant.ps1 -> config.json
$cfgPath = Join-Path $root 'config.json'
$cfg = [IO.File]::ReadAllText($cfgPath)
foreach ($l in 'prva', 'shmnl') {
  $f = Join-Path $PSScriptRoot "ids-$l.json"
  if (-not (Test-Path $f)) { continue }
  $ids = Get-Content $f -Raw | ConvertFrom-Json
  $tag = @{ prva = 'PRVAHMNL'; shmnl = 'SHMNL' }[$l]
  $cfg = $cfg.Replace("UPISI-TENANT-ID-$tag", $ids.tenantId).Replace("UPISI-CLIENT-ID-$tag", $ids.clientId)
  if ($cfg -notmatch [regex]::Escape($ids.clientId)) { Stani "Client ID za $l nije upisan u config.json (vrijednost je vec promijenjena?). Upisi ga rucno: $($ids.clientId)" }
}
if ($cfg -match 'UPISI-') { Stani "config.json jos ima UPISI-... vrijednosti. Prvo pokreni 1-tenant.ps1 za obje lige (-Liga prva i -Liga shmnl)." }
[IO.File]::WriteAllText($cfgPath, $cfg, (New-Object Text.UTF8Encoding $false))
Write-Host "config.json: Tenant/Client ID-jevi upisani" -ForegroundColor Green

# 2. GitHub prijava
gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "`nPrijava na GitHub (preglednik)..." -ForegroundColor Cyan
  gh auth login --hostname github.com --git-protocol https --web
  if ($LASTEXITCODE -ne 0) { Stani 'GitHub prijava nije uspjela' }
}
$login = gh api user --jq .login
if ($Repo.Split('/')[0] -ne $login) { Write-Warning "Prijavljen si kao '$login', a repozitorij je '$Repo'." }

# 3. repozitorij + Pages
gh repo view $Repo 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  gh repo create $Repo --public --description 'Snimke utakmica HMNL - pregled za vodstvo natjecanja' | Out-Null
  if ($LASTEXITCODE -ne 0) { Stani "Repozitorij $Repo nije napravljen" }
  Write-Host "Repozitorij $Repo napravljen (javni; podaci na stranici su sifrirani)" -ForegroundColor Green
} else { Write-Host "Repozitorij $Repo vec postoji" }

gh api -X POST "repos/$Repo/pages" -f build_type=workflow 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { gh api -X PUT "repos/$Repo/pages" -f build_type=workflow 2>$null | Out-Null }
if ($LASTEXITCODE -ne 0) { Stani 'GitHub Pages nije ukljucen (Settings -> Pages -> Source: GitHub Actions)' }
Write-Host "GitHub Pages: izvor = GitHub Actions" -ForegroundColor Green

# 4. korisnici i lozinke -> secret USERS
$ispis = $null
$postoji = (gh secret list -R $Repo 2>$null) -match '^USERS\s'
if ($postoji -and -not $NoveLozinke) {
  Write-Host "Secret USERS vec postoji - lozinke se ne mijenjaju (za nove: -NoveLozinke)"
} else {
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $redovi = @(); $ispis = @()
  foreach ($k in $Korisnici) {
    $b = New-Object byte[] 15; $rng.GetBytes($b)
    $p = [Convert]::ToBase64String($b).Replace('+', '-').Replace('/', '_')
    $redovi += "$($k.ToLower()):$p"
    $ispis += [pscustomobject]@{ Korisnik = $k.ToLower(); Lozinka = $p }
  }
  ($redovi -join "`n") | gh secret set USERS -R $Repo
  if ($LASTEXITCODE -ne 0) { Stani 'Secret USERS nije postavljen' }
  Write-Host "Secret USERS postavljen ($($Korisnici.Count) korisnika)" -ForegroundColor Green
}

# 5. kod -> GitHub (push pokrece prvi build)
if (-not (Test-Path (Join-Path $root '.git'))) { git init -b main | Out-Null }
if (-not (git config user.email)) { git config user.name $login; git config user.email "$login@users.noreply.github.com" }
gh auth setup-git | Out-Null
git add -A
git commit -q -m 'Snimke utakmica HMNL' 2>$null | Out-Null
if (-not (git remote)) { git remote add origin "https://github.com/$Repo.git" }
git push -u origin main
if ($LASTEXITCODE -ne 0) { Stani 'git push nije uspio' }
if ($NoveLozinke -or -not $postoji) { gh workflow run pages.yml -R $Repo 2>$null | Out-Null }

Write-Host "`nGotovo." -ForegroundColor Cyan
Write-Host "  Build:    https://github.com/$Repo/actions"
Write-Host "  Stranica: https://$login.github.io/$($Repo.Split('/')[1])/  (nakon prvog uspjesnog builda, ~2 min)"
if ($ispis) {
  Write-Host "`nLOZINKE - spremi ih sada (npr. u upravitelj lozinki); nigdje drugdje nisu zapisane:" -ForegroundColor Yellow
  foreach ($r in $ispis) { Write-Host ("  {0,-22} {1}" -f $r.Korisnik, $r.Lozinka) }
  Write-Host ""
}
