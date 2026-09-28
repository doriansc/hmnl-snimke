<#
  Postavlja aplikaciju "HMNL snimke - citanje" u JEDNOM M365 tenantu:
    - registracija aplikacije (single-tenant, bez tajne klijenta)
    - dozvola Microsoft Graph Sites.Read.All (application) + admin consent
    - federated credential za GitHub Actions (repo:<repo>:environment:github-pages)
  Na kraju zapiše Tenant ID i Client ID u setup\ids-<liga>.json (nisu tajni).

  Pokretanje iz mape hmnl-snimke-v2 (prijavi se kao globalni administrator tog tenanta):
    powershell -ExecutionPolicy Bypass -File .\setup\1-tenant.ps1 -Liga prva
    powershell -ExecutionPolicy Bypass -File .\setup\1-tenant.ps1 -Liga shmnl
  Skriptu je sigurno pokrenuti više puta: postojeće stavke se ne dupliraju.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('prva', 'shmnl')][string]$Liga,
  [string]$Repo = 'doriansc/hmnl-snimke',
  # GitHub u OIDC token upisuje i nepromjenjive ID-jeve vlasnika i repozitorija (vidi gresku AADSTS700213 u buildu)
  [string]$RepoIds = 'doriansc@262607014/hmnl-snimke@1393813240'
)
$ErrorActionPreference = 'Stop'
$domena = @{ prva = 'prvahmnl.onmicrosoft.com'; shmnl = 'nogometnisavezkazupanije.onmicrosoft.com' }[$Liga]
$naziv = 'HMNL snimke - citanje'
$graphAppId = '00000003-0000-0000-c000-000000000000'

foreach ($m in 'Microsoft.Graph.Authentication', 'Microsoft.Graph.Applications') {
  if (-not (Get-Module -ListAvailable -Name $m)) {
    Write-Host "Instaliram PowerShell modul $m (samo za trenutnog korisnika)..." -ForegroundColor Yellow
    Install-Module $m -Scope CurrentUser -Force -AllowClobber
  }
}
Import-Module Microsoft.Graph.Authentication, Microsoft.Graph.Applications

Write-Host "`nPrijava u tenant $domena - otvorit ce se preglednik, prijavi se kao globalni admin." -ForegroundColor Cyan
Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null
$conn = @{ TenantId = $domena; Scopes = @('Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All') }
if ((Get-Command Connect-MgGraph).Parameters.ContainsKey('NoWelcome')) { $conn.NoWelcome = $true }
Connect-MgGraph @conn
$ctx = Get-MgContext
Write-Host "Prijavljen: $($ctx.Account)   tenant: $($ctx.TenantId)"

# 1. aplikacija i service principal
$app = Get-MgApplication -Filter "displayName eq '$naziv'" -Top 1
if ($app) { Write-Host "Aplikacija vec postoji: $($app.AppId)" }
else {
  $app = New-MgApplication -DisplayName $naziv -SignInAudience 'AzureADMyOrg' -Notes 'Cita snimke utakmica sa siteova kola za stranicu hmnl-snimke (GitHub Actions, federated credential).'
  Write-Host "Aplikacija napravljena: $($app.AppId)" -ForegroundColor Green
}
$sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'" -Top 1
if (-not $sp) { $sp = New-MgServicePrincipal -AppId $app.AppId }

# 2. Sites.Read.All (application) + admin consent
$graphSp = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'" -Top 1
$role = $graphSp.AppRoles | Where-Object { $_.Value -eq 'Sites.Read.All' -and $_.AllowedMemberTypes -contains 'Application' }
Update-MgApplication -ApplicationId $app.Id -RequiredResourceAccess @(@{ ResourceAppId = $graphAppId; ResourceAccess = @(@{ Id = $role.Id; Type = 'Role' }) })
$ima = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -All | Where-Object { $_.AppRoleId -eq $role.Id }
if ($ima) { Write-Host "Dozvola Sites.Read.All je vec odobrena" }
else {
  New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -PrincipalId $sp.Id -ResourceId $graphSp.Id -AppRoleId $role.Id | Out-Null
  Write-Host "Dozvola Sites.Read.All odobrena (admin consent)" -ForegroundColor Green
}

# 3. federated credentials za GitHub Actions (novi oblik s ID-jevima i stari oblik, za svaki slucaj)
$zeljeni = [ordered]@{ 'github-pages' = "repo:${RepoIds}:environment:github-pages"; 'github-pages-legacy' = "repo:${Repo}:environment:github-pages" }
$postojeci = @(Get-MgApplicationFederatedIdentityCredential -ApplicationId $app.Id -All)
foreach ($ime in $zeljeni.Keys) {
  $subject = $zeljeni[$ime]
  $body = @{ issuer = 'https://token.actions.githubusercontent.com'; subject = $subject; audiences = @('api://AzureADTokenExchange') }
  $fic = $postojeci | Where-Object { $_.Name -eq $ime }
  if (-not $fic) {
    New-MgApplicationFederatedIdentityCredential -ApplicationId $app.Id -BodyParameter ($body + @{ name = $ime; description = 'GitHub Actions - hmnl-snimke (GitHub Pages)' }) | Out-Null
    Write-Host "Federated credential dodan: $subject" -ForegroundColor Green
  } elseif ($fic.Subject -ne $subject) {
    Update-MgApplicationFederatedIdentityCredential -ApplicationId $app.Id -FederatedIdentityCredentialId $fic.Id -BodyParameter $body
    Write-Host "Federated credential azuriran: $subject" -ForegroundColor Green
  } else { Write-Host "Federated credential vec postoji: $subject" }
}

# 4. ID-jevi za config.json
$out = Join-Path $PSScriptRoot "ids-$Liga.json"
$json = @{ liga = $Liga; domena = $domena; tenantId = $ctx.TenantId; clientId = $app.AppId } | ConvertTo-Json
[IO.File]::WriteAllText($out, $json, (New-Object Text.UTF8Encoding $false))
Disconnect-MgGraph | Out-Null
Write-Host "`nGotovo ($Liga)." -ForegroundColor Cyan
Write-Host "  Tenant ID: $($ctx.TenantId)"
Write-Host "  Client ID: $($app.AppId)"
Write-Host "  Zapisano u $out"
