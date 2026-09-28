param(
  [Parameter(Mandatory = $true)][string]$SinceUtc,
  [Parameter(Mandatory = $true)][string]$FixtureRoot
)

$ErrorActionPreference = 'Stop'
$cutoff = ([DateTimeOffset]::Parse($SinceUtc)).UtcDateTime
$names = @('electron.exe', 'Conductor.exe', 'claude.exe')
$processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$matches = @($processes | Where-Object {
  $_.Name -in $names -and (
    $_.CreationDate.ToUniversalTime() -ge $cutoff -or
    ($_.CommandLine -and $_.CommandLine.Contains($FixtureRoot))
  )
} | ForEach-Object {
  [pscustomobject]@{
    pid = $_.ProcessId
    parentPid = $_.ParentProcessId
    name = $_.Name
    createdUtc = $_.CreationDate.ToUniversalTime().ToString('o')
    executable = $_.ExecutablePath
    fixtureRootInArgs = [bool]($_.CommandLine -and $_.CommandLine.Contains($FixtureRoot))
  }
})

[pscustomobject]@{
  sinceUtc = $cutoff.ToString('o')
  fixtureRoot = $FixtureRoot
  queried = $processes.Count
  matching = $matches.Count
  processes = $matches
} | ConvertTo-Json -Depth 5 -Compress
