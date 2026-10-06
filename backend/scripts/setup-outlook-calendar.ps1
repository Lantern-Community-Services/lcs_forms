<#
  Gives the Lantern Forms app the Exchange access the calendar's Outlook sync
  needs, and no more (Exchange "RBAC for Applications"). See README
  "Calendar in Outlook".

    Calendars.ReadWrite        on the Lantern Calendar mailbox (it organizes the
                               invites) and on staff mailboxes (events added
                               quietly, with no email, go straight into them)
    MailboxSettings.ReadWrite  on staff mailboxes (to create the calendar's
                               colored categories in their Outlook)

  "Staff mailboxes" means every user mailbox in the organization by default
  (not shared mailboxes, rooms or groups). To narrow it, pass -StaffFilter,
  for example:
    -StaffFilter "MemberOfGroup -eq '<distinguished name of a mail-enabled security group>'"

  Run in PowerShell as an Exchange admin:
    powershell -ExecutionPolicy Bypass -File .\backend\scripts\setup-outlook-calendar.ps1
  It asks for the two IDs from Entra admin center -> Enterprise applications ->
  Lantern Forms -> Overview (NOT App registrations: its Object ID is different).
  Safe to run again: anything already set up is left as it is.

  Don't add these permissions under API permissions in Entra: an Entra grant
  can't be limited to some mailboxes, and it would add to these.
#>
param(
  [string]$AppId,
  [string]$ObjectId,
  [string]$Mailbox = "calendar@lanterncommunity.org",
  [string]$DisplayName = "Lantern Forms",
  [string]$OrganizerScope = "Lantern Calendar only",
  [string]$StaffScope = "Lantern Forms staff mailboxes",
  [string]$StaffFilter = "RecipientTypeDetails -eq 'UserMailbox'"
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

function Ensure-Scope($name, $filter) {
  $scope = Get-ManagementScope -Identity $name -ErrorAction SilentlyContinue
  if ($scope) { Write-Host "Scope '$name' already there: $($scope.RecipientFilter)" }
  else { New-ManagementScope -Name $name -RecipientRestrictionFilter $filter | Out-Null; Write-Host "Scope '$name' added: $filter" }
}

function Ensure-Role($role, $scopeName) {
  $existing = Get-ManagementRoleAssignment -Role $role -ErrorAction SilentlyContinue |
    Where-Object { ($_.RoleAssignee -eq $ObjectId -or $_.RoleAssigneeName -eq $ObjectId -or $_.RoleAssigneeName -eq $DisplayName) -and $_.CustomResourceScope -eq $scopeName }
  if ($existing) { Write-Host "$role on '$scopeName': already assigned." }
  else { New-ManagementRoleAssignment -App $ObjectId -Role $role -CustomResourceScope $scopeName | Out-Null; Write-Host "$role on '$scopeName': assigned." }
}

function In-Scope($results, $role) {
  $r = $results | Where-Object { $_.RoleName -eq $role -and ($_.InScope -eq $true -or "$($_.InScope)" -eq "True") }
  return [bool]$r
}

try {
  Step "Checking the organizer mailbox $Mailbox"
  $mbx = Get-Mailbox -Identity $Mailbox -ErrorAction SilentlyContinue
  if (-not $mbx) { throw "No mailbox $Mailbox. Create the Lantern Calendar user with an Office 365 E1 license first (it can take a few minutes to appear)." }
  Write-Host "Found: $($mbx.DisplayName) <$($mbx.PrimarySmtpAddress)>"
  $address = [string]$mbx.PrimarySmtpAddress

  Step "Service principal for the app"
  $sp = Get-ServicePrincipal -ErrorAction SilentlyContinue | Where-Object { $_.AppId -eq $AppId }
  if ($sp) { Write-Host "Already there." }
  else { New-ServicePrincipal -AppId $AppId -ObjectId $ObjectId -DisplayName $DisplayName | Out-Null; Write-Host "Added." }

  Step "Scopes"
  Ensure-Scope $OrganizerScope "PrimarySmtpAddress -eq '$address'"
  Ensure-Scope $StaffScope $StaffFilter

  Step "Roles"
  Ensure-Role "Application Calendars.ReadWrite" $OrganizerScope
  Ensure-Role "Application Calendars.ReadWrite" $StaffScope
  Ensure-Role "Application MailboxSettings.ReadWrite" $StaffScope

  Step "Testing"
  $me = (Get-ConnectionInformation | Select-Object -First 1).UserPrincipalName
  $ok = $true
  $organizer = Test-ServicePrincipalAuthorization -Identity $ObjectId -Resource $address
  Write-Host "On $address :"
  $organizer | Format-Table RoleName, AllowedResourceScope, InScope -AutoSize
  if (-not (In-Scope $organizer "Application Calendars.ReadWrite")) { $ok = $false }
  if ($me) {
    $staff = Test-ServicePrincipalAuthorization -Identity $ObjectId -Resource $me
    Write-Host "On a staff mailbox ($me):"
    $staff | Format-Table RoleName, AllowedResourceScope, InScope -AutoSize
    if (-not (In-Scope $staff "Application Calendars.ReadWrite")) { $ok = $false }
    if (-not (In-Scope $staff "Application MailboxSettings.ReadWrite")) { $ok = $false }
  }

  if ($ok) {
    Write-Host "Done. Lantern Forms can organize invites as $address, add events quietly to staff calendars, and color them." -ForegroundColor Green
    Write-Host "Exchange can take 30 minutes to 2 hours before the app can use new access."
  } else {
    Write-Host "Something isn't in scope yet. Paste the tables above to Claude." -ForegroundColor Yellow
  }
}
finally {
  Disconnect-ExchangeOnline -Confirm:$false | Out-Null
}
