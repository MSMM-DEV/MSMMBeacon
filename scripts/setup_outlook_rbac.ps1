# MSMM Beacon — Exchange Online RBAC for Applications setup for outlook-sync.
#
# Replaces the deprecated New-ApplicationAccessPolicy approach. Grants the
# Beacon Entra app (Calendars.Read application permission) access to ONLY
# beacon@msmmeng.com via a custom Management Scope + Role Assignment.
#
# Run from an already-connected EXO session:
#   Connect-ExchangeOnline -UserPrincipalName rmehta@msmmeng.com
#   . ./scripts/setup_outlook_rbac.ps1
#
# Idempotent: re-running is a no-op once the scope + assignment exist.

$AppId          = "2679090c-09d0-4212-abce-537c0116a349"
$Mailbox        = "beacon@msmmeng.com"
$ScopeName      = "Beacon Mailbox Only"
$AssignmentName = "Beacon outlook-sync Calendars.Read"
$Role           = "Application Calendars.Read"

# Sanity-check the EXO connection up front.
$connInfo = Get-ConnectionInformation -ErrorAction SilentlyContinue
if (-not $connInfo -or $connInfo.Count -eq 0) {
    Write-Error "No active Exchange Online connection found (Get-ConnectionInformation is empty)."
    Write-Host "Run: Connect-ExchangeOnline -UserPrincipalName rmehta@msmmeng.com -Device -ShowBanner:`$false" -ForegroundColor Yellow
    return
}
Write-Host "[+] EXO connection: $($connInfo[0].UserPrincipalName) -> $($connInfo[0].TenantId)"

# Verify the RBAC-for-Applications cmdlets we need are actually exposed.
# These are gated server-side: missing here means the connected account lacks
# an Exchange Administrator (or Global Administrator) role in Entra ID.
$needed = @(
    'Get-ManagementScope',
    'New-ManagementScope',
    'Get-ManagementRoleAssignment',
    'New-ManagementRoleAssignment',
    'Test-ServicePrincipalAuthorization'
)
$missing = $needed | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
if ($missing) {
    Write-Error "Required EXO cmdlets not exposed in this session: $($missing -join ', ')"
    Write-Host "Your account ($($connInfo[0].UserPrincipalName)) likely lacks the Exchange Administrator role in Entra ID." -ForegroundColor Yellow
    Write-Host "Fix: Entra portal -> Roles & administrators -> Exchange Administrator -> Add assignment for $($connInfo[0].UserPrincipalName), then reconnect." -ForegroundColor Yellow
    return
}

# 1. Custom Management Scope -> resolves to only beacon@msmmeng.com.
$existingScope = Get-ManagementScope -Identity $ScopeName -ErrorAction SilentlyContinue
if (-not $existingScope) {
    Write-Host "[+] Creating Management Scope: $ScopeName"
    New-ManagementScope `
        -Name $ScopeName `
        -RecipientRestrictionFilter "PrimarySmtpAddress -eq '$Mailbox'" | Out-Null
} else {
    Write-Host "[=] Management Scope '$ScopeName' already exists; skipping."
}

# 2. Role assignment -> binds Calendars.Read on the app to that scope.
$existingAssignment = Get-ManagementRoleAssignment -Identity $AssignmentName -ErrorAction SilentlyContinue
if (-not $existingAssignment) {
    Write-Host "[+] Creating Role Assignment: $AssignmentName"
    try {
        New-ManagementRoleAssignment `
            -App $AppId `
            -Role $Role `
            -CustomResourceScope $ScopeName `
            -Name $AssignmentName | Out-Null
    } catch {
        Write-Warning "New-ManagementRoleAssignment failed: $($_.Exception.Message)"
        Write-Warning "If this says the service principal is not found, the Entra SP isn't synced into EXO yet."
        Write-Warning "Grab the SP ObjectId from Entra portal -> Enterprise applications -> <your app> -> Object ID, then run:"
        Write-Warning "  New-ServicePrincipal -AppId '$AppId' -ServiceId '<sp-object-id>' -DisplayName 'Beacon outlook-sync'"
        Write-Warning "...and re-run this script."
        return
    }
} else {
    Write-Host "[=] Role Assignment '$AssignmentName' already exists; skipping."
}

# 3. Verify -- in-scope mailbox should show Calendars.Read; out-of-scope should be empty.
Write-Host "`n--- Verification ---"
Write-Host "In-scope ($Mailbox) -- expect Application Calendars.Read in GrantedPermissions:"
Test-ServicePrincipalAuthorization -Identity $AppId -Resource $Mailbox | Format-List

# Pick any other mailbox for the negative check; falls back to rmehta@msmmeng.com.
$otherMailbox = "rmehta@msmmeng.com"
if ($otherMailbox -ne $Mailbox) {
    Write-Host "Out-of-scope ($otherMailbox) -- expect EMPTY GrantedPermissions:"
    Test-ServicePrincipalAuthorization -Identity $AppId -Resource $otherMailbox | Format-List
}

Write-Host "Done."
