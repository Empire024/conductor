<#
.SYNOPSIS
Preview or explicitly refresh existing native Codex workspace ACL inheritance.
.DESCRIPTION
Repairs inheritance only after workspace ownership has been restored. This reapplies
an unchanged root DACL; it never invents permissions or modifies Codex settings.
Repair requires Windows administrator privileges and explicit owner authorization.
Junctions are not traversed during inspection, and their resolved targets must stay
inside this workspace. Existing owners, explicit ACEs, and protected ACLs are verified.
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
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$workspace = Get-Item -LiteralPath $WorkspacePath -Force
if (-not $workspace.PSIsContainer -or $workspace.FullName.TrimEnd('\') -eq [IO.Path]::GetPathRoot($workspace.FullName).TrimEnd('\')) {
  throw 'Select an existing local workspace directory, never a filesystem root.'
}
$ancestor = $workspace
while ($null -ne $ancestor) {
  if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Workspace has a reparse-point ancestor: $($ancestor.FullName)" }
  $ancestor = $ancestor.Parent
}
if ($workspace.FullName -notmatch '^[a-zA-Z]:\\') { throw 'Only a local drive workspace is supported.' }

# Resolve junctions through Windows handles, including short-name aliases. Never
# assume their displayed target strings prove the actual filesystem boundary.
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class ConductorAclPaths {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
    IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path,
    uint length, uint flags);
  public static string Resolve(string path) {
    using (var handle = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      var buffer = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
      if (length == 0 || length >= buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
      return buffer.ToString().TrimEnd('\\');
    }
  }
}
"@
$physicalRoot = [ConductorAclPaths]::Resolve($workspace.FullName)
$workspacePrefix = $workspace.FullName.TrimEnd('\') + '\'
$codexStateDirectory = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$capabilities = Get-Content -LiteralPath (Join-Path $codexStateDirectory 'cap_sid') -Raw | ConvertFrom-Json
$workspaceKey = $workspace.FullName.Replace('\', '/').ToLowerInvariant()
$nativeCapability = @($capabilities.workspace_by_cwd.PSObject.Properties | Where-Object { $_.Name -eq $workspaceKey })
if ($nativeCapability.Count -ne 1) { throw 'No unique existing native Codex capability for this exact workspace.' }
$capabilitySid = [Security.Principal.SecurityIdentifier]::new([string]$nativeCapability[0].Value)
$rootAcl = Get-DirectoryAcl $workspace.FullName
$rootDacl = $rootAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
$nativeRootRules = @($rootAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object {
  $_.IdentityReference.Value -eq $capabilitySid.Value -and $_.AccessControlType -eq 'Allow' -and
  $_.FileSystemRights -eq ([Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::Synchronize) -and
  $_.InheritanceFlags -eq ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -and
  $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
})
if ($nativeRootRules.Count -ne 1) { throw 'Expected existing inheritable native workspace Modify ACE is missing or ambiguous.' }
if ($rootAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) { throw 'Restore workspace ownership first; run from that same owner account.' }

function Read-EntryAcl([IO.FileSystemInfo]$Entry) {
  $acl = $Entry.GetAccessControl()
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $explicit = @($rules | Where-Object { -not $_.IsInherited } | ForEach-Object {
    '{0}|{1}|{2}|{3}|{4}' -f $_.IdentityReference.Value, [int]$_.AccessControlType, [int]$_.FileSystemRights, [int]$_.InheritanceFlags, [int]$_.PropagationFlags
  })
  [pscustomobject]@{
    Path = $Entry.FullName
    OwnerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    Protected = $acl.AreAccessRulesProtected
    Dacl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    ExplicitRules = ($explicit -join "`n")
    CapabilityPresent = (@($rules | Where-Object { $_.IdentityReference.Value -eq $capabilitySid.Value }).Count -gt 0)
  }
}

$queue = [Collections.Generic.Queue[IO.DirectoryInfo]]::new()
$queue.Enqueue($workspace)
$entries = [Collections.Generic.List[object]]::new()
$links = [Collections.Generic.List[object]]::new()
while ($queue.Count) {
  $directory = $queue.Dequeue()
  foreach ($entry in $directory.GetFileSystemInfos()) {
    if (-not $entry.FullName.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Inventory escaped workspace.' }
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      $target = [ConductorAclPaths]::Resolve($entry.FullName)
      if (-not $target.StartsWith($physicalRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Reparse target leaves workspace: $($entry.FullName)" }
      $logicalPath = '\\?\' + $entry.FullName
      if ($logicalPath.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Reparse target creates an ancestor cycle: $($entry.FullName)" }
      $links.Add([pscustomobject]@{Path=$entry.FullName;Target=$target})
      continue
    }
    if ($entry -is [IO.DirectoryInfo]) { $queue.Enqueue($entry) }
    $entries.Add((Read-EntryAcl $entry))
  }
}
$summary = [pscustomobject]@{
  Workspace = $workspace.FullName
  NativeCapabilitySid = $capabilitySid.Value
  Entries = $entries.Count
  MissingCapability = @($entries | Where-Object { -not $_.CapabilityPresent }).Count
  WithExplicitRules = @($entries | Where-Object ExplicitRules).Count
  Protected = @($entries | Where-Object Protected).Count
  ReparseTargetsInsideWorkspace = $links
}
$summary | ConvertTo-Json -Depth 4
if (-not $Repair) { return }
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Repair needs an administrator PowerShell for the workspace owner. No ACLs were changed.' }

$backupPath = Join-Path ([IO.Path]::GetTempPath()) ('conductor-codex-inheritance-' + [guid]::NewGuid().ToString('N') + '.json')
[pscustomobject]@{Summary=$summary;RootDacl=$rootDacl;Entries=$entries} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $backupPath -Encoding UTF8
Write-Output "Original ACL inventory: $backupPath"
# Recheck the root and every link immediately before the single native ACL write.
if ((Get-DirectoryAcl $workspace.FullName).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ne $rootDacl) { throw 'Root permissions changed; inspect before retrying.' }
$expectedLinks = @{}
foreach ($link in $links) { $expectedLinks[$link.Path] = $link.Target }
$checkedLinks = 0
$queue.Enqueue($workspace)
while ($queue.Count) {
  foreach ($entry in $queue.Dequeue().GetFileSystemInfos()) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      if (-not $expectedLinks.ContainsKey($entry.FullName) -or [ConductorAclPaths]::Resolve($entry.FullName) -ne $expectedLinks[$entry.FullName]) {
        throw "Reparse entry changed during inspection: $($entry.FullName)"
      }
      $checkedLinks++
    } elseif ($entry -is [IO.DirectoryInfo]) { $queue.Enqueue($entry) }
  }
}
if ($checkedLinks -ne $links.Count) { throw 'Reparse inventory changed during inspection; no ACLs were changed.' }
$descriptor = [Security.AccessControl.DirectorySecurity]::new()
$descriptor.SetSecurityDescriptorSddlForm($rootDacl, [Security.AccessControl.AccessControlSections]::Access)
$workspace.SetAccessControl($descriptor)
if ((Get-DirectoryAcl $workspace.FullName).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ne $rootDacl) { throw 'Root DACL unexpectedly changed.' }

$removed = 0
$missingAfter = 0
foreach ($before in $entries) {
  if (-not (Test-Path -LiteralPath $before.Path)) { $removed++; continue }
  $entry = Get-Item -LiteralPath $before.Path -Force
  if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Entry became a reparse point during repair: $($before.Path)" }
  $after = Read-EntryAcl $entry
  if (-not $after.CapabilityPresent) { $missingAfter++ }
  if ($after.OwnerSid -ne $before.OwnerSid -or $after.ExplicitRules -ne $before.ExplicitRules -or
      $after.Protected -ne $before.Protected -or ($before.Protected -and $after.Dacl -ne $before.Dacl)) {
    throw "Owner, explicit ACEs, or protected ACL changed: $($before.Path). Inspect backup: $backupPath"
  }
}
Write-Output "Native workspace inheritance refreshed. Root DACL, existing owners, explicit ACEs and protected ACLs verified. Missing capability after refresh: $missingAfter. Concurrently removed entries: $removed"
