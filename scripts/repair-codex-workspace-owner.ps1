<#
.SYNOPSIS
Diagnose (or explicitly repair) Codex-owned workspace directories that block sandbox setup.
.DESCRIPTION
Only the workspace directory and its .git directory are considered, never descendants.
Repair requires an administrator PowerShell, changes only ownership, and verifies that
DACLs are unchanged. It never changes Codex configuration or grants extra sandbox access.
#>
[CmdletBinding()]
param(
  [string]$WorkspacePath = (Split-Path -Parent $PSScriptRoot),
  [switch]$Repair
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Get-Acl lives in the on-demand Microsoft.PowerShell.Security module, which does not load on
# every host (a CI runner, or a shell started with a rewritten PSModulePath). Read the same
# descriptor through the DirectoryInfo method the cmdlet itself calls.
function Get-DirectoryAcl([string]$Path) { (Get-Item -LiteralPath $Path -Force).GetAccessControl() }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$targetOwner = $identity.User
$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
$workspace = Get-Item -LiteralPath $WorkspacePath -Force
if (-not $workspace.PSIsContainer -or $workspace.FullName.TrimEnd('\') -eq [System.IO.Path]::GetPathRoot($workspace.FullName).TrimEnd('\')) {
  throw 'Select an existing workspace directory, never a filesystem root.'
}

# Reject junctions and symlinks at every ancestor, including the chosen workspace.
function Assert-OrdinaryDirectory([System.IO.DirectoryInfo]$Directory) {
  $ancestor = $Directory
  while ($null -ne $ancestor) {
    if (($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing a reparse-point path: $($ancestor.FullName)"
    }
    $ancestor = $ancestor.Parent
  }
}
Assert-OrdinaryDirectory $workspace

$sandboxOwners = @()
foreach ($account in @('CodexSandboxOffline', 'CodexSandboxOnline')) {
  try {
    $sandboxOwners += ([System.Security.Principal.NTAccount]::new($env:COMPUTERNAME, $account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch [System.Security.Principal.IdentityNotMappedException] {
    # A missing sandbox account is not permission to alter an unknown owner's files.
  }
}
if ($Repair -and ($sandboxOwners -contains $targetOwner.Value)) { throw 'Run this from the workspace owner account, not a sandbox account.' }

$targets = @($workspace)
$gitPath = Join-Path $workspace.FullName '.git'
if (Test-Path -LiteralPath $gitPath -PathType Container) {
  $gitDirectory = Get-Item -LiteralPath $gitPath -Force
  Assert-OrdinaryDirectory $gitDirectory
  $targets += $gitDirectory
}

$entries = @(foreach ($directory in $targets) {
  $acl = Get-DirectoryAcl $directory.FullName
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  [pscustomobject]@{
    Path = $directory.FullName
    Owner = $acl.Owner
    OwnerSid = $owner
    TargetOwnerSid = $targetOwner.Value
    NeedsRepair = ($sandboxOwners -contains $owner)
    Dacl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
  }
})
if (-not $Repair) { $entries | ConvertTo-Json -Depth 3; return }
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Ownership repair requires an administrator PowerShell for the workspace owner. Diagnostic mode made no changes.'
}

$repairs = @($entries | Where-Object NeedsRepair)
if ($repairs.Count -eq 0) { Write-Output 'No Codex-owned workspace directories need repair.'; return }
# Preserve the original owner and DACL for review before the first mutation.
$backupPath = Join-Path ([System.IO.Path]::GetTempPath()) ('conductor-codex-owner-' + [guid]::NewGuid().ToString('N') + '.json')
$entries | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $backupPath -Encoding UTF8
Write-Output "Original ownership and DACL backup: $backupPath"
foreach ($entry in $repairs) {
  $directory = Get-Item -LiteralPath $entry.Path -Force
  Assert-OrdinaryDirectory $directory
  $current = Get-DirectoryAcl $directory.FullName
  if ($current.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $entry.OwnerSid -or
      $current.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access) -ne $entry.Dacl) {
    throw "Directory permissions changed during repair; inspect before retrying: $($entry.Path)"
  }
  # A fresh descriptor marks only the owner field as changed. Do not rewrite its DACL.
  $ownerOnly = [System.Security.AccessControl.DirectorySecurity]::new()
  $ownerOnly.SetOwner($targetOwner)
  $directory.SetAccessControl($ownerOnly)
  $after = Get-DirectoryAcl $entry.Path
  if ($after.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $targetOwner.Value -or
      $after.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access) -ne $entry.Dacl) {
    throw "Ownership or unchanged-DACL verification failed: $($entry.Path). Backup: $backupPath"
  }
  Write-Output "Restored owner to $($identity.Name); DACL unchanged: $($entry.Path)"
}
