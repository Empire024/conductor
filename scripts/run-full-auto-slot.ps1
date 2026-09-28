param(
  [Parameter(Mandatory = $true)][long]$Generation,
  [Parameter(Mandatory = $true)][ValidatePattern('^agent_[a-z0-9]+_[a-z0-9]+$')][string]$AgentSessionId,
  [ValidateSet('core', 'edges')][string]$Scenario = 'core',
  [string]$SlotPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $SlotPath) { $SlotPath = Join-Path $repoRoot 'artifacts/fixer-coordination/electron-slot.json' }
$slot = Get-Content -LiteralPath $slotPath -Raw | ConvertFrom-Json
$expectedSmoke = if ($Scenario -eq 'edges') { 'scripts/smoke-full-auto-edges.mjs' } else { 'scripts/smoke-full-auto.mjs' }
$expectedScript = "node scripts/smoke-lock.mjs --timeout-min 20 -- node $expectedSmoke"
$expectedBuild = Join-Path $repoRoot 'out/main/index.js'
$expectedEnvKey = if ($Scenario -eq 'edges') { 'CONDUCTOR_FULL_AUTO_EDGES' } else { 'CONDUCTOR_FULL_AUTO_ACCEPTANCE' }
$expectedScenario = if ($Scenario -eq 'edges') { 'full-auto-edges' } else { 'full-auto-native' }
if ($slot.status -ne 'granted' -or $slot.generation -ne $Generation -or
    $slot.agentSessionId -ne $AgentSessionId -or
    $slot.script -ne $expectedScript -or $slot.scenario -ne $expectedScenario -or
    [System.IO.Path]::GetFullPath($slot.cwd) -ne $repoRoot -or
    [System.IO.Path]::GetFullPath($slot.build) -ne $expectedBuild -or $slot.env.$expectedEnvKey -ne '1' -or
    $slot.runner -ne 'conductor-local host run_and_summarize') {
  throw 'Full Auto Electron slot does not match this agent, generation, script, build, environment, and host runner'
}
$grantUtc = ([DateTimeOffset]::Parse($slot.grantedAt)).UtcDateTime
if ([Math]::Abs(([DateTime]::UtcNow - $grantUtc).TotalMinutes) -gt 5) { throw 'Full Auto Electron slot grant is stale' }
$scriptPath = Join-Path $repoRoot $expectedSmoke
if (-not ($slot.scriptSha256 -is [string]) -or -not $slot.scriptSha256) { throw 'Full Auto Electron slot is missing scriptSha256' }
$scriptHash = (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($scriptHash -ne $slot.scriptSha256.ToLowerInvariant()) { throw 'Full Auto Electron script SHA-256 differs from the granted script' }
$hash = (Get-FileHash -LiteralPath $slot.build -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $slot.candidateSha256.ToLowerInvariant()) { throw 'Full Auto Electron build SHA-256 differs from the granted candidate' }
$installedExecutable = $slot.env.CONDUCTOR_PACKAGED_ACCEPTANCE_EXE
if ($installedExecutable) {
  if (-not [IO.Path]::IsPathRooted($installedExecutable) -or $slot.executableSha256 -notmatch '^[a-fA-F0-9]{64}$' -or -not $slot.installedVersion) { throw 'Installed fixture requires an absolute executable, exact hash, and installed version' }
  $executableHash = (Get-FileHash -LiteralPath $installedExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($executableHash -ne $slot.executableSha256.ToLowerInvariant()) { throw 'Installed executable hash differs from the granted build' }
  $executableInfo = (Get-Item -LiteralPath $installedExecutable).VersionInfo
  if ($executableInfo.ProductVersion -ne $slot.installedVersion -and $executableInfo.FileVersion -ne $slot.installedVersion) { throw 'Installed executable version differs from the grant' }
  $env:CONDUCTOR_PACKAGED_ACCEPTANCE_EXE = $installedExecutable
  $env:CONDUCTOR_PACKAGED_ACCEPTANCE_SHA256 = $executableHash
  $env:CONDUCTOR_PACKAGED_ACCEPTANCE_VERSION = $slot.installedVersion
} else {
  Remove-Item Env:CONDUCTOR_PACKAGED_ACCEPTANCE_EXE -ErrorAction SilentlyContinue
  Remove-Item Env:CONDUCTOR_PACKAGED_ACCEPTANCE_SHA256 -ErrorAction SilentlyContinue
  Remove-Item Env:CONDUCTOR_PACKAGED_ACCEPTANCE_VERSION -ErrorAction SilentlyContinue
}
$inventory = @(Get-CimInstance Win32_Process -ErrorAction Stop)
if ($inventory.Count -eq 0) { throw 'Host Win32_Process preflight returned no processes' }
Write-Output "Slot verified: generation=$Generation hash=$hash hostProcesses=$($inventory.Count) at=$([DateTime]::UtcNow.ToString('o'))"
Set-Location -LiteralPath $repoRoot
if ($Scenario -eq 'edges') {
  $env:CONDUCTOR_FULL_AUTO_EDGES = '1'
  node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-full-auto-edges.mjs
} else {
  $env:CONDUCTOR_FULL_AUTO_ACCEPTANCE = '1'
  node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-full-auto.mjs
}
exit $LASTEXITCODE
