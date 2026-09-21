<#
.SYNOPSIS
Bounded, reversible Ornith 1.5 9B gate and Qwen 3.5 9B swap.

.DESCRIPTION
Run elevated after the pinned GGUF has been downloaded. The script verifies the file, proves
the current Qwen process is the authenticated Conductor-managed server before stopping it,
runs one bounded tool/edit acceptance against Ornith, and promotes the model only on success.
Every failure stops Ornith, restores the exact config/provenance bytes, and restarts Qwen.

.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\local-models\gate-ornith-9b.ps1
#>
param(
  [string]$Root = 'D:\ConductorLocal',
  [string]$Download = 'D:\ConductorLocal\temp\ornith-9b\Ornith-1.5-9B-Q4_K_M.gguf',
  [ValidateRange(1, 2147483647)][int]$ExpectedQwenPid = 44580,
  [ValidateRange(30, 600)][int]$StartupTimeoutSec = 300,
  [ValidateRange(10, 180)][int]$RequestTimeoutSec = 90
)

$ErrorActionPreference = 'Stop'
$OrnithId = 'local/ornith1.5-9b'
$QwenId = 'local/qwen3.5-9b'
$OrnithFile = 'Ornith-1.5-9B-Q4_K_M.gguf'
$ExpectedBytes = 5780090816
$ExpectedSha256 = '70c112196e0b7023803c9762752e46d29e612a92c83f995bc3ba1ceb07e8fab6'
$Revision = 'abdd624b12ebf020b767fff532ff44fe552b28c3'
$Repo = 'ornith-ai/Ornith-1.5-9B-GGUF'
$ConfigPath = Join-Path $Root 'config\config.json'
$KeyPath = Join-Path $Root 'config\api-key'
$ProvenancePath = Join-Path $Root 'config\provenance.json'
$RuntimeDir = Join-Path $Root 'runtime'
$QwenRunPath = Join-Path $RuntimeDir 'local_qwen3.5-9b.json'
$OrnithRunPath = Join-Path $RuntimeDir 'local_ornith1.5-9b.json'
$DestinationDir = Join-Path $Root 'models\ornith1.5-9b'
$Destination = Join-Path $DestinationDir $OrnithFile
$GateDir = Join-Path $Root 'temp\ornith-9b'
$ResultPath = Join-Path $GateDir 'gate-result.json'
$RestorePath = Join-Path $Root 'config\qwen-9b-restore.json'

function Write-JsonFile([string]$Path, [object]$Value) {
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 20) + "`n"), [Text.UTF8Encoding]::new($false))
}

function Invoke-Authenticated([int]$Port, [string]$Key, [string]$Method, [object]$Body = $null) {
  $parameters = @{
    Uri = "http://127.0.0.1:$Port$Method"
    Headers = @{ Authorization = "Bearer $Key" }
    Method = if ($null -eq $Body) { 'Get' } else { 'Post' }
    TimeoutSec = $RequestTimeoutSec
  }
  if ($null -ne $Body) {
    $parameters.ContentType = 'application/json'
    $parameters.Body = $Body | ConvertTo-Json -Depth 30 -Compress
  }
  Invoke-RestMethod @parameters
}

function Test-KeyEnforced([int]$Port) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 5 | Out-Null
    return $false
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    return $status -eq 401 -or $status -eq 403
  }
}

function Get-ModelIds([object]$Response) {
  @($Response.data | ForEach-Object { [string]$_.id })
}

function Stop-ExactProcess([Diagnostics.Process]$Process) {
  if ($null -eq $Process -or $Process.HasExited) { return }
  Stop-Process -Id $Process.Id -Force
  $Process.WaitForExit(15000) | Out-Null
  if (-not $Process.HasExited) { throw "Process $($Process.Id) did not stop within 15 seconds" }
}

function Start-Llama([string]$Executable, [object]$Model, [string]$ModelPath, [string]$Key, [string]$LogStem) {
  $arguments = @(
    '--host', '127.0.0.1', '--port', [string]$Model.port, '--api-key', $Key, '--no-webui',
    '--model', $ModelPath, '--alias', [string]$Model.id, '--ctx-size', [string]$Model.contextTokens,
    '--n-gpu-layers', [string]$Model.gpuLayers, '--parallel', '1', '--jinja'
  ) + @($Model.extraArgs)
  $quoted = $arguments | ForEach-Object {
    $value = [string]$_
    if ($value -match '[\s"]') { '"' + $value.Replace('"', '\"') + '"' } else { $value }
  }
  $stdout = Join-Path $Root "logs\$LogStem.stdout.log"
  $stderr = Join-Path $Root "logs\$LogStem.stderr.log"
  New-Item -ItemType Directory -Path (Split-Path -Parent $stdout) -Force | Out-Null
  Start-Process -FilePath $Executable -ArgumentList $quoted -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
}

function Wait-Healthy([Diagnostics.Process]$Process, [object]$Model, [string]$Key) {
  $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSec)
  do {
    if ($Process.HasExited) { throw "$($Model.id) server exited during startup with code $($Process.ExitCode)" }
    try {
      $models = Get-ModelIds (Invoke-Authenticated ([int]$Model.port) $Key '/v1/models')
      if ($models -contains [string]$Model.id) {
        if (-not (Test-KeyEnforced ([int]$Model.port))) { throw "$($Model.id) server does not enforce the API key" }
        return
      }
    } catch { if ([DateTime]::UtcNow -ge $deadline) { throw } }
    Start-Sleep -Milliseconds 750
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "$($Model.id) did not become healthy within $StartupTimeoutSec seconds"
}

function Get-Resources([Diagnostics.Process]$Process) {
  $gpu = $null
  try {
    $raw = & nvidia-smi.exe '--query-gpu=utilization.gpu,memory.used,memory.total' '--format=csv,noheader,nounits' 2>$null
    $values = ($raw | Select-Object -First 1).Split(',') | ForEach-Object { [int]$_.Trim() }
    $gpu = @{ utilizationPercent = $values[0]; usedMiB = $values[1]; totalMiB = $values[2] }
  } catch {}
  $Process.Refresh()
  @{ at = [DateTime]::UtcNow.ToString('o'); pid = $Process.Id; workingSetMiB = [Math]::Round($Process.WorkingSet64 / 1MB, 1); cpuSeconds = $Process.TotalProcessorTime.TotalSeconds; gpu = $gpu }
}

function Invoke-Acceptance([object]$Model, [string]$Key, [Diagnostics.Process]$Process) {
  $messages = [Collections.ArrayList]::new()
  [void]$messages.Add(@{ role = 'user'; content = 'Use read_fixture once, then use edit_fixture to replace OLD_VALUE with ORNITH_ACCEPTED. Finish with exactly EDIT_ACCEPTED.' })
  $tools = @(
    @{ type = 'function'; function = @{ name = 'read_fixture'; description = 'Read the bounded acceptance fixture'; parameters = @{ type = 'object'; properties = @{}; additionalProperties = $false } } },
    @{ type = 'function'; function = @{ name = 'edit_fixture'; description = 'Replace one exact string in the bounded acceptance fixture'; parameters = @{ type = 'object'; properties = @{ old = @{ type = 'string' }; replacement = @{ type = 'string' } }; required = @('old', 'replacement'); additionalProperties = $false } } }
  )
  $fixture = 'status=OLD_VALUE'
  $rounds = @()
  $samples = @((Get-Resources $Process))
  $started = [Diagnostics.Stopwatch]::StartNew()

  $body = @{ model = $Model.id; messages = $messages; tools = $tools; tool_choice = 'auto'; temperature = 0; max_tokens = 256; stream = $false }
  $first = Invoke-Authenticated ([int]$Model.port) $Key '/v1/chat/completions' $body
  $call = @($first.choices[0].message.tool_calls)[0]
  if ($null -eq $call -or $call.function.name -ne 'read_fixture') { throw 'Ornith did not emit a parsed read_fixture tool call' }
  $rounds += @{ kind = 'read-tool'; elapsedMs = $started.ElapsedMilliseconds; timings = $first.timings }
  [void]$messages.Add($first.choices[0].message)
  [void]$messages.Add(@{ role = 'tool'; tool_call_id = $call.id; content = $fixture })
  $samples += Get-Resources $Process

  $second = Invoke-Authenticated ([int]$Model.port) $Key '/v1/chat/completions' $body
  $edit = @($second.choices[0].message.tool_calls)[0]
  if ($null -eq $edit -or $edit.function.name -ne 'edit_fixture') { throw 'Ornith did not emit a parsed edit_fixture tool call' }
  $arguments = $edit.function.arguments | ConvertFrom-Json
  if ($arguments.old -ne 'OLD_VALUE' -or $arguments.replacement -ne 'ORNITH_ACCEPTED') { throw 'Ornith requested the wrong bounded edit' }
  $fixture = $fixture.Replace([string]$arguments.old, [string]$arguments.replacement)
  if ($fixture -ne 'status=ORNITH_ACCEPTED') { throw 'The bounded edit was not accepted' }
  $rounds += @{ kind = 'edit-tool'; elapsedMs = $started.ElapsedMilliseconds; timings = $second.timings }
  [void]$messages.Add($second.choices[0].message)
  [void]$messages.Add(@{ role = 'tool'; tool_call_id = $edit.id; content = 'Edit applied.' })
  $samples += Get-Resources $Process

  $final = Invoke-Authenticated ([int]$Model.port) $Key '/v1/chat/completions' $body
  $answer = [string]$final.choices[0].message.content
  if ($answer.Trim() -ne 'EDIT_ACCEPTED') { throw "Ornith final acceptance marker was not exact: $answer" }
  $started.Stop()
  $rounds += @{ kind = 'final'; elapsedMs = $started.ElapsedMilliseconds; timings = $final.timings }
  $samples += Get-Resources $Process
  @{ accepted = $true; elapsedMs = $started.ElapsedMilliseconds; fixture = $fixture; rounds = $rounds; resources = $samples }
}

foreach ($required in @($ConfigPath, $KeyPath, $Download, $QwenRunPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required file is missing: $required" }
}
if ((Get-Item -LiteralPath $Download).Length -ne $ExpectedBytes) { throw "Ornith size mismatch; expected $ExpectedBytes bytes" }
$digest = (Get-FileHash -LiteralPath $Download -Algorithm SHA256).Hash.ToLowerInvariant()
if ($digest -ne $ExpectedSha256) { throw "Ornith SHA256 mismatch: $digest" }

$configBytes = [IO.File]::ReadAllBytes($ConfigPath)
$provenanceBytes = if (Test-Path -LiteralPath $ProvenancePath) { [IO.File]::ReadAllBytes($ProvenancePath) } else { $null }
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$apiKey = (Get-Content -LiteralPath $KeyPath -Raw).Trim()
if ($apiKey -notmatch '^[a-fA-F0-9]{32,}$') { throw 'Local model API key is malformed' }
$qwen = $config.models.$QwenId
if ($null -eq $qwen) { throw "$QwenId is absent from the current config" }
$qwenRun = Get-Content -LiteralPath $QwenRunPath -Raw | ConvertFrom-Json
if ($qwenRun.model -ne $QwenId -or $qwenRun.file -ne $qwen.file -or [int]$qwenRun.pid -ne $ExpectedQwenPid -or $qwenRun.port -ne $qwen.port) { throw "Qwen run record does not exactly match expected managed PID $ExpectedQwenPid and its configured server" }
$qwenProcess = Get-Process -Id $qwenRun.pid -ErrorAction Stop
$qwenCim = Get-CimInstance Win32_Process -Filter "ProcessId=$($qwenRun.pid)"
$qwenPath = Join-Path $Root ("models\qwen3.5-9b\" + $qwen.file)
if ($qwenCim.ExecutablePath -ne $config.llamaServer -or $qwenCim.CommandLine -notlike "*$qwenPath*") { throw 'Recorded Qwen PID is not the configured llama-server/model process' }
$served = Get-ModelIds (Invoke-Authenticated ([int]$qwenRun.port) $apiKey '/v1/models')
if ($served -notcontains $QwenId -or -not (Test-KeyEnforced ([int]$qwenRun.port))) { throw 'Current Qwen server identity or API-key enforcement could not be verified' }
$llamaLeaf = [IO.Path]::GetFileNameWithoutExtension([string]$config.llamaServer)
$allLlama = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -ieq "$llamaLeaf.exe" -or $_.Name -ieq $llamaLeaf -or $_.CommandLine -match '(?i)(^|[\\/])llama-server(?:\.exe)?(?:\s|$)'
})
$unexpectedLlama = @($allLlama | Where-Object { [int]$_.ProcessId -ne $ExpectedQwenPid })
if ($unexpectedLlama.Count) { throw "Unmanaged or additional llama-server process exists: $($unexpectedLlama.ProcessId -join ', ')" }
if ($allLlama.Count -ne 1) { throw "Expected exactly one live llama-server (PID $ExpectedQwenPid), found $($allLlama.Count)" }

$ornith = [pscustomobject]@{
  id = $OrnithId; label = 'Ornith 1.5 9B (local)'; repo = $Repo; revision = $Revision; file = $OrnithFile
  quant = 'Q4_K_M'; sizeBytes = $ExpectedBytes; sha256 = $ExpectedSha256; port = [int]$qwen.port
  contextTokens = [int]$qwen.contextTokens; gpuLayers = [int]$qwen.gpuLayers; extraArgs = @($qwen.extraArgs)
}
$restore = @{ capturedAt = [DateTime]::UtcNow.ToString('o'); qwen = $qwen; run = $qwenRun }
Write-JsonFile $RestorePath $restore

$ornithProcess = $null
$qwenStopped = $false
$moved = $false
$promoted = $false
try {
  Stop-ExactProcess $qwenProcess
  $qwenStopped = $true
  Remove-Item -LiteralPath $QwenRunPath -Force
  $remainingLlama = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq "$llamaLeaf.exe" -or $_.Name -ieq $llamaLeaf -or $_.CommandLine -match '(?i)(^|[\\/])llama-server(?:\.exe)?(?:\s|$)'
  })
  if ($remainingLlama.Count) { throw "A llama-server remained after verified Qwen shutdown: $($remainingLlama.ProcessId -join ', ')" }

  $ornithProcess = Start-Llama $config.llamaServer $ornith $Download $apiKey 'ornith-9b-gate'
  Wait-Healthy $ornithProcess $ornith $apiKey
  $acceptance = Invoke-Acceptance $ornith $apiKey $ornithProcess
  Write-JsonFile $ResultPath (@{ schemaVersion = 1; model = $OrnithId; revision = $Revision; sha256 = $ExpectedSha256; completedAt = [DateTime]::UtcNow.ToString('o'); acceptance = $acceptance })

  Stop-ExactProcess $ornithProcess
  $ornithProcess = $null
  New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null
  if (Test-Path -LiteralPath $Destination) { throw "Promotion destination already exists: $Destination" }
  Move-Item -LiteralPath $Download -Destination $Destination
  $moved = $true
  if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSha256) { throw 'Promoted Ornith file failed re-verification' }

  $ornithProcess = Start-Llama $config.llamaServer $ornith $Destination $apiKey 'ornith-9b'
  Wait-Healthy $ornithProcess $ornith $apiKey

  # Ornith becomes the first/default configured model. Qwen keeps its persisted id as a
  # restorable fallback on a distinct port; only Ornith is running after promotion.
  $usedPorts = @([int]$ornith.port) + @($config.models.PSObject.Properties | Where-Object { $_.Name -ne $QwenId -and $_.Name -ne $OrnithId } | ForEach-Object { [int]$_.Value.port })
  $fallbackPort = 51437
  while ($usedPorts -contains $fallbackPort) { $fallbackPort++ }
  if ($fallbackPort -gt 51537) { throw 'No bounded fallback port is available for Qwen' }
  # Clone before changing the fallback port. The original object remains byte-for-byte aligned
  # with the saved config and is the only object the failure path is allowed to restart.
  $fallbackQwen = $qwen | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  $fallbackQwen.port = $fallbackPort
  $models = [ordered]@{}
  $models[$OrnithId] = $ornith
  $models[$QwenId] = $fallbackQwen
  foreach ($property in $config.models.PSObject.Properties) { if ($property.Name -ne $QwenId -and $property.Name -ne $OrnithId) { $models[$property.Name] = $property.Value } }
  $config.models = [pscustomobject]$models
  Write-JsonFile $ConfigPath $config
  $now = [DateTime]::UtcNow.ToString('o')
  $provenance = if ($null -ne $provenanceBytes) { @(Get-Content -LiteralPath $ProvenancePath -Raw | ConvertFrom-Json) } else { @() }
  $provenance = @($provenance | Where-Object { $_.id -ne $OrnithId }) + @(@{
    id = $OrnithId; repo = $Repo; revision = $Revision; file = $OrnithFile; quant = 'Q4_K_M'
    url = "https://huggingface.co/$Repo/resolve/$Revision/$OrnithFile"; sizeBytes = $ExpectedBytes
    sha256 = $ExpectedSha256; sha256Source = 'upstream-pinned'; downloadedAt = $now; verifiedAt = $now
  })
  Write-JsonFile $ProvenancePath $provenance
  Write-JsonFile $OrnithRunPath @{ pid = $ornithProcess.Id; port = [int]$ornith.port; model = $OrnithId; file = $OrnithFile; startedAt = $now }
  $promoted = $true
  Write-Host "PASS: Ornith accepted and promoted; one authenticated server is running (PID $($ornithProcess.Id))."
  Write-Host "Acceptance evidence: $ResultPath"
  Write-Host "Qwen restore snapshot: $RestorePath"
} finally {
  if (-not $promoted) {
    $rollbackBlock = $null
    $trackedOrnithPid = if ($null -ne $ornithProcess) { $ornithProcess.Id } else { $null }
    try { Stop-ExactProcess $ornithProcess }
    catch { $rollbackBlock = "Could not prove tracked Ornith PID $trackedOrnithPid exited: $($_.Exception.Message)" }
    $rollbackLlama = @()
    if ($qwenStopped) {
      try {
        $rollbackLlama = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
          $_.Name -ieq "$llamaLeaf.exe" -or $_.Name -ieq $llamaLeaf -or $_.CommandLine -match '(?i)(^|[\\/])llama-server(?:\.exe)?(?:\s|$)'
        })
        if ($rollbackLlama.Count) {
          $live = $rollbackLlama | ForEach-Object { "$($_.ProcessId) ($($_.Name))" }
          $rollbackBlock = "A live llama-server remains after rollback stop: $($live -join ', ')"
        }
      } catch {
        $rollbackBlock = "Could not complete the required OS-wide llama-server inventory: $($_.Exception.Message)"
      }
    }
    Remove-Item -LiteralPath $OrnithRunPath -Force -ErrorAction SilentlyContinue
    [IO.File]::WriteAllBytes($ConfigPath, $configBytes)
    if ($null -ne $provenanceBytes) { [IO.File]::WriteAllBytes($ProvenancePath, $provenanceBytes) }
    elseif (Test-Path -LiteralPath $ProvenancePath) { Remove-Item -LiteralPath $ProvenancePath -Force }
    if ($moved -and (Test-Path -LiteralPath $Destination)) { Move-Item -LiteralPath $Destination -Destination $Download -Force }
    if ($qwenStopped) {
      if ($rollbackBlock) {
        $manualPid = if ($trackedOrnithPid) { " (tracked Ornith PID $trackedOrnithPid)" } else { '' }
        throw "$rollbackBlock$manualPid. Original config bytes were restored and Qwen was NOT restarted to avoid a second server. Manually stop the named process, verify no llama-server remains, then run scripts/local-models/start.ps1 -Model $QwenId."
      }
      $restored = Start-Llama $config.llamaServer $qwen $qwenPath $apiKey 'qwen-9b-restored'
      Wait-Healthy $restored $qwen $apiKey
      Write-JsonFile $QwenRunPath @{ pid = $restored.Id; port = [int]$qwen.port; model = $QwenId; file = [string]$qwen.file; startedAt = [DateTime]::UtcNow.ToString('o') }
      Write-Warning "Ornith was not promoted; Qwen was restored as the only managed server (PID $($restored.Id))."
    }
  }
}
