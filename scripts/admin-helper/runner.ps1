<#
  Conductor admin helper runner (docs/admin-helper.md). Runs elevated from the scheduled task
  "Conductor Admin Helper", installed with one UAC click by install.ps1, from
  C:\ProgramData\ConductorAdmin, which only Administrators and SYSTEM can write.

  It runs only the actions named in actions.json next to it, with the scripts in actions\ next to it.
  A request is data, never code: queue\requests\<id>.json = {id, action, args, by?, requestedAt?},
  written by Conductor (admin.run). The action must be on the allowlist and every arg must be one the
  action declares, of its declared type; a boolean arg turns on the switch the action declares for it.
  Nothing from a request is ever put on a command line as text. The result is queue\results\<id>.json
  and the action's output logs\<id>.log, both readable by Users and writable only by Administrators.
#>
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
# Only system module folders: the user's Documents\WindowsPowerShell\Modules is writable without
# elevation, so a module planted there must never be autoloaded into this elevated process.
$env:PSModulePath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules;$env:ProgramFiles\WindowsPowerShell\Modules"
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$requests = Join-Path $root 'queue\requests'
$results = Join-Path $root 'queue\results'
$logs = Join-Path $root 'logs'
$utf8 = New-Object Text.UTF8Encoding $false
$maxRequestBytes = 16384
$idPattern = '^[a-z0-9][a-z0-9-]{7,63}$'

function Write-Atomic([string]$Path, [string]$Text) {
  $temp = "$Path.$PID.tmp"
  [IO.File]::WriteAllText($temp, $Text, $utf8)
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Write-Result([string]$Id, [hashtable]$Result) {
  $Result.id = $Id
  $Result.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  Write-Atomic (Join-Path $results "$Id.json") ($Result | ConvertTo-Json -Depth 5)
}

function Get-Allowlist {
  $text = [IO.File]::ReadAllText((Join-Path $root 'actions.json'))
  return ($text | ConvertFrom-Json).actions
}

# Returns @{ok; error?; action?; splat?} for one parsed request.
function Test-Request($Request, [string]$Id, $Allowlist) {
  if ($null -eq $Request -or $Request -isnot [Management.Automation.PSCustomObject]) { return @{ ok = $false; error = 'The request is not a JSON object' } }
  if ($Request.id -ne $Id) { return @{ ok = $false; error = 'The request id does not match its file name' } }
  $name = $Request.action
  if ($name -isnot [string] -or -not ($Allowlist.PSObject.Properties.Name -contains $name)) { return @{ ok = $false; error = "Action '$name' is not on the admin helper's allowlist" } }
  $action = $Allowlist.$name
  $splat = @{}
  if ($null -ne $Request.args) {
    if ($Request.args -isnot [Management.Automation.PSCustomObject]) { return @{ ok = $false; error = 'args must be an object' } }
    foreach ($property in $Request.args.PSObject.Properties) {
      $declared = $action.args.($property.Name)
      if ($null -eq $declared) { return @{ ok = $false; error = "Action '$name' takes no argument '$($property.Name)'" } }
      if ($declared.type -eq 'boolean') {
        if ($property.Value -isnot [bool]) { return @{ ok = $false; error = "$($property.Name) must be true or false" } }
        if ($property.Value) { $splat[$declared.switch] = $true }
      } else { return @{ ok = $false; error = "Argument type '$($declared.type)' is not supported" } }
    }
  }
  if ($null -ne $Request.by -and ($Request.by -isnot [string] -or $Request.by.Length -gt 200)) { return @{ ok = $false; error = 'by must be a short string' } }
  return @{ ok = $true; action = $action; name = $name; splat = $splat }
}

function Invoke-Request([IO.FileInfo]$File, $Allowlist) {
  $id = [IO.Path]::GetFileNameWithoutExtension($File.Name)
  $reparse = ($File.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  if ($id -notmatch $idPattern -or $reparse) { Remove-Item -LiteralPath $File.FullName -Force; return }
  $startedAt = (Get-Date).ToUniversalTime().ToString('o')
  if ($File.Length -gt $maxRequestBytes) { Remove-Item -LiteralPath $File.FullName -Force; Write-Result $id @{ ok = $false; startedAt = $startedAt; error = 'The request is larger than 16 KiB' }; return }
  $text = [IO.File]::ReadAllText($File.FullName)
  Remove-Item -LiteralPath $File.FullName -Force
  try { $request = $text | ConvertFrom-Json } catch { Write-Result $id @{ ok = $false; startedAt = $startedAt; error = 'The request is not valid JSON' }; return }
  $checked = Test-Request $request $id $Allowlist
  if (-not $checked.ok) { Write-Result $id @{ ok = $false; startedAt = $startedAt; action = "$($request.action)"; error = $checked.error }; return }
  $script = Join-Path $root ('actions\' + [IO.Path]::GetFileName($checked.action.script))
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script)
  foreach ($switch in $checked.splat.Keys) { $arguments += "-$switch" }
  $log = Join-Path $logs "$id.log"
  $header = "action $($checked.name) requested by $($request.by) at $($request.requestedAt); started $startedAt; switches: $(@($checked.splat.Keys) -join ', ')"
  try {
    $output = & $powershell @arguments 2>&1 | ForEach-Object { "$_" }
    $exitCode = $LASTEXITCODE
  } catch { $output = @("$_"); $exitCode = -1 }
  Write-Atomic $log (($header, '') + $output -join "`r`n")
  $tail = @($output | Select-Object -Last 40)
  Write-Result $id @{ ok = ($exitCode -eq 0); action = $checked.name; args = $request.args; by = $request.by; startedAt = $startedAt; exitCode = $exitCode; output = ($tail -join "`n"); log = $log }
}

$mutex = New-Object Threading.Mutex($false, 'Local\ConductorAdminHelperRunner')
if (-not $mutex.WaitOne([TimeSpan]::FromMinutes(10))) { exit 2 }
try {
  New-Item -ItemType Directory -Force -Path $results, $logs | Out-Null
  $allowlist = Get-Allowlist
  for ($pass = 0; $pass -lt 50; $pass++) {
    $files = @(Get-ChildItem -LiteralPath $requests -File -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc)
    if (-not $files.Count) { break }
    foreach ($file in $files) {
      try { Invoke-Request $file $allowlist } catch { "$(Get-Date -Format o) $($file.Name): $_" | Add-Content -LiteralPath (Join-Path $logs 'runner-errors.log') }
    }
  }
  # Results and logs older than 30 days go.
  $cutoff = (Get-Date).AddDays(-30)
  Get-ChildItem -LiteralPath $results, $logs -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutoff -and $_.Name -ne 'install.log' } | Remove-Item -Force -ErrorAction SilentlyContinue
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
