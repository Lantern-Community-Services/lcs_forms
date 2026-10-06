<#
  Lets the Lantern Forms app write to the Lantern Calendar mailbox's calendar,
  and to no other mailbox (Exchange "RBAC for Applications").
  See README "Calendar in Outlook".

  Run in PowerShell as an Exchange admin:
    .\backend\scripts\setup-outlook-calendar.ps1
  It asks for the two IDs from Entra admin center -> Enterprise applications ->
  Lantern Forms -> Overview (NOT App registrations: its Object ID is different).
  Safe to run again: anything already set up is left as it is.
#>
param(
  [string]$AppId,
  [string]$ObjectId,
  [string]$Mailbox = "calendar@lanterncommunity.org",
  [string]$DisplayName = "Lantern Forms",
  [string]$ScopeName = "Lantern Calendar only",
  [string]$Role = "Application Calendars.ReadWrite"
)

$ErrorActionPreference = "Stop"

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

if (-not $AppId)    { $AppId    = (Read-Host "Application ID (Enterprise applications -> Lantern Forms -> Overview)").Trim() }
if (-not $ObjectId) { $ObjectId = (Read-Host "Object ID (same page)").Trim() }
$guid = '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
if ($AppId -notmatch $guid -or $ObjectId -notmatch $guid) { throw "Both IDs should look like 1a2b3c4d-1234-5678-9abc-1234567890ab." }
if ($AppId -eq $ObjectId) { throw "The Application ID and Object ID are the same. Copy the Object ID from Enterprise applications, not App registrations." }

Step "Exchange Online module"
if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
  Write-Host "Installing ExchangeOnlineManagement for this user..."
  Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force -AllowClobber
}
Import-Module ExchangeOnlineManagement

Step "Signing in to Exchange Online (a Microsoft sign-in window opens)"
Connect-ExchangeOnline -ShowBanner:$false

try {
  Step "Checking the mailbox $Mailbox"
  $mbx = Get-Mailbox -Identity $Mailbox -ErrorAction SilentlyContinue
  if (-not $mbx) { throw "No mailbox $Mailbox. Create the Lantern Calendar user with an Office 365 E1 license first (it can take a few minutes to appear)." }
  Write-Host "Found: $($mbx.DisplayName) <$($mbx.PrimarySmtpAddress)>"
  $address = [string]$mbx.PrimarySmtpAddress

  Step "Service principal for the app"
  $sp = Get-ServicePrincipal -ErrorAction SilentlyContinue | Where-Object { $_.AppId -eq $AppId }
  if ($sp) { Write-Host "Already there." }
  else { $sp = New-ServicePrincipal -AppId $AppId -ObjectId $ObjectId -DisplayName $DisplayName; Write-Host "Added." }

  Step "Scope: only $address"
  $scope = Get-ManagementScope -Identity $ScopeName -ErrorAction SilentlyContinue
  if ($scope) { Write-Host "Already there: $($scope.RecipientFilter)" }
  else { New-ManagementScope -Name $ScopeName -RecipientRestrictionFilter "PrimarySmtpAddress -eq '$address'" | Out-Null; Write-Host "Added." }

  Step "Role: $Role, limited to that scope"
  $existing = Get-ManagementRoleAssignment -Role $Role -ErrorAction SilentlyContinue | Where-Object { $_.RoleAssignee -eq $ObjectId -or $_.RoleAssigneeName -eq $ObjectId -or $_.RoleAssigneeName -eq $DisplayName }
  if ($existing) { Write-Host "Already assigned." }
  else { New-ManagementRoleAssignment -App $ObjectId -Role $Role -CustomResourceScope $ScopeName | Out-Null; Write-Host "Assigned." }

  Step "Testing"
  $results = Test-ServicePrincipalAuthorization -Identity $ObjectId -Resource $address
  $results | Format-Table RoleName, GrantedPermissions, AllowedResourceScope, InScope -AutoSize
  $calendar = $results | Where-Object { $_.RoleName -eq $Role }
  if ($calendar -and ($calendar.InScope -eq $true -or "$($calendar.InScope)" -eq "True")) {
    Write-Host "Done: Lantern Forms can write to $address's calendar, and only that mailbox's." -ForegroundColor Green
    Write-Host "Exchange can take 30 minutes to 2 hours before the app can use it."
    Write-Host "Reminder: don't add Calendars.ReadWrite under API permissions in Entra; it would reach every mailbox."
  } else {
    Write-Host "Not in scope yet. Paste the table above to Claude." -ForegroundColor Yellow
  }
}
finally {
  Disconnect-ExchangeOnline -Confirm:$false | Out-Null
}
