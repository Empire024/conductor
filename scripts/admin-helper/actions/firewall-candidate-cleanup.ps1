<#
  Admin helper action firewall-candidate-cleanup (docs/admin-helper.md).

  Every acceptance build and parked smoke runs electron.exe from a new folder
  (C:\Claude\conductor-candidates\<sha>\node_modules\electron\dist\electron.exe, or a smoke worktree
  under .conductor-scratch), and Windows Firewall created an inbound "Electron" rule pair for each one
  the owner clicked Allow or Cancel for. This removes those inbound rules and nothing else: a rule is
  removed only when its program is an electron.exe inside a conductor-candidates or .conductor-scratch
  folder. The installed Conductor.exe, the main checkout's electron.exe and every other program keep
  their rules.

  -DryRun lists what would be removed. -Classify <paths> prints which of the given program paths
  would match, without reading the firewall (used by the tests).
#>
param([switch]$DryRun, [string[]]$Classify)
$ErrorActionPreference = 'Stop'

function Test-CandidateProgram([string]$Program) {
  if (-not $Program) { return $false }
  $path = $Program.Trim().Trim('"').Replace('/', '\')
  if ($path -notmatch '^[A-Za-z]:\\') { return $false }
  if ($path -match '\\\.\.(\\|$)') { return $false }
  return $path -match '\\(conductor-candidates|\.conductor-scratch)\\(.+\\)?electron\.exe$'
}

if ($PSBoundParameters.ContainsKey('Classify')) {
  foreach ($program in $Classify) { if (Test-CandidateProgram $program) { Write-Output $program } }
  exit 0
}

$rules = @(Get-NetFirewallApplicationFilter | Where-Object { Test-CandidateProgram $_.Program } |
  ForEach-Object { $_ | Get-NetFirewallRule } | Where-Object { $_.Direction -eq 'Inbound' } | Sort-Object Name -Unique)

if (-not $rules.Count) { Write-Output 'No candidate electron.exe inbound firewall rules found.'; exit 0 }

foreach ($rule in $rules) {
  $program = ($rule | Get-NetFirewallApplicationFilter).Program
  Write-Output ("{0}  {1}  {2}  {3}" -f $rule.Name, $rule.DisplayName, $rule.Action, $program)
}

if ($DryRun) { Write-Output "Dry run: $($rules.Count) rule(s) would be removed."; exit 0 }

$removed = 0
foreach ($rule in $rules) {
  # Re-check the program right before removing, so a rule is never removed on a stale match.
  $program = ($rule | Get-NetFirewallApplicationFilter).Program
  if (-not (Test-CandidateProgram $program)) { continue }
  Remove-NetFirewallRule -Name $rule.Name
  $removed++
  Write-Output "removed $($rule.Name) ($program)"
}
Write-Output "Removed $removed rule(s)."
