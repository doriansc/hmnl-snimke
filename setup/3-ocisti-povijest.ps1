<#
  Uklanja README.md (i sve prethodne verzije datoteka) iz javne povijesti repozitorija:
  povijest se zamijeni jednim novim commitom s trenutnim stanjem, koji se posalje s --force.
  README.md ostaje lokalno (u .gitignore je), ali se vise ne objavljuje.
  Brise i opis repozitorija na GitHubu.

  Pokretanje iz mape hmnl-snimke-v2:
    powershell -ExecutionPolicy Bypass -File .\setup\3-ocisti-povijest.ps1
#>
param([string]$Repo = 'doriansc/hmnl-snimke')
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot -Parent)
function Stani($p) { Write-Host "`nGRESKA: $p" -ForegroundColor Red; exit 1 }

# git i gh su mozda instalirani nakon otvaranja ovog prozora (winget) - osvjezi PATH
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
foreach ($c in 'git', 'gh') { if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { Stani "'$c' nije pronaden. Pokreni prvo setup\2-github.ps1 ili otvori novi PowerShell prozor." } }

if (-not (Test-Path .git)) { Stani 'Ovo nije git repozitorij.' }
if ((Get-Content .gitignore) -notcontains 'README.md') { Stani 'README.md nije u .gitignore.' }

git checkout -q --orphan nova-povijest
if ($LASTEXITCODE -ne 0) { Stani 'git checkout --orphan nije uspio' }
git rm -q --cached README.md 2>$null | Out-Null
git add -A
git commit -q -m 'Snimke utakmica HMNL'
if ($LASTEXITCODE -ne 0) { Stani 'git commit nije uspio' }
git branch -D main 2>$null | Out-Null
git branch -m main
git push --force -u origin main
if ($LASTEXITCODE -ne 0) { Stani 'git push --force nije uspio' }
gh repo edit $Repo --description= | Out-Null
Write-Host "`nGotovo: povijest ima jedan commit, README.md i opis repozitorija vise nisu javni." -ForegroundColor Green
git log --oneline
git ls-files
