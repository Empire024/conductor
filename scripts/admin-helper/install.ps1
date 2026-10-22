<#
  Installs (or updates) the Conductor admin helper (docs/admin-helper.md). One UAC prompt:

    powershell -NoProfile -ExecutionPolicy Bypass -File C:\Claude\conductor\scripts\admin-helper\install.ps1

  Run from a normal (not elevated) PowerShell, it asks Windows once to run itself as administrator
  and waits. The elevated copy:
    1. recreates C:\ProgramData\ConductorAdmin owned by Administrators, writable only by
       Administrators and SYSTEM (Users read and run; Users may add request files to
       queue\requests, which are data, never code);
    2. copies runner.ps1, actions.json and the allowlisted action scripts into it;
    3. registers the scheduled task "Conductor Admin Helper": the owner's account, highest privileges,
       no trigger (it runs only when started), running the runner hidden;
    4. as its first job, queues firewall-candidate-cleanup and starts the task, which removes the
       leftover candidate electron.exe firewall rules.
  The elevated output is kept in C:\ProgramData\ConductorAdmin\logs\install.log and shown here after.
  scripts\admin-helper\uninstall.ps1 removes it all again.
#>
param([string]$ForUser, [string]$Commit, [switch]$Elevated, [switch]$SkipFirstJob)
$ErrorActionPreference = 'Stop'
$taskName = 'Conductor Admin Helper'
$root = Join-Path $env:ProgramData 'ConductorAdmin'
$installLog = Join-Path $root 'logs\install.log'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $admin) {
  if ($Elevated) { Write-Error 'The elevated copy is not running as administrator.'; exit 1 }
  # The task runs as the account that asked for it, even when UAC is answered with another admin account.
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $commit = ''
  try { $commit = (& git -C (Split-Path (Split-Path $PSScriptRoot)) rev-parse --short HEAD 2>$null) } catch {}
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated', '-ForUser', "`"$user`"")
  if ($commit) { $arguments += @('-Commit', "$commit") }
  if ($SkipFirstJob) { $arguments += '-SkipFirstJob' }
  Write-Output "Asking Windows for administrator rights once, to install the Conductor admin helper for $user..."
  try { $process = Start-Process -FilePath $powershell -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru }
  catch { Write-Output "Not installed: the administrator prompt was declined or failed ($($_.Exception.Message))."; exit 1 }
  if (Test-Path -LiteralPath $installLog) { Get-Content -LiteralPath $installLog | Write-Output }
  if ($process.ExitCode -eq 0) { Write-Output 'Conductor admin helper installed.' } else { Write-Output "The elevated install failed (exit $($process.ExitCode)); see the log above." }
  exit $process.ExitCode
}

if (-not $ForUser) { $ForUser = "$env:USERDOMAIN\$env:USERNAME" }
if ($ForUser -notmatch '^[^"\\/]+\\[^"\\/]+$') { Write-Error "Not a DOMAIN\user account name: $ForUser"; exit 1 }
$source = $PSScriptRoot
$allowlist = ([IO.File]::ReadAllText((Join-Path $source 'actions.json')) | ConvertFrom-Json).actions

# 1. A fresh folder no non-admin process has ever been able to write. cmd's rmdir never follows a
#    junction, so a junction planted under ProgramData cannot redirect the delete.
if (Test-Path -LiteralPath $root) {
  & cmd.exe /d /c "rmdir /s /q `"$root`""
  if (Test-Path -LiteralPath $root) { Write-Error "Could not remove the old $root (is a file in it open?)"; exit 1 }
}
New-Item -ItemType Directory -Path $root | Out-Null
& icacls.exe $root /setowner '*S-1-5-32-544' /Q | Out-Null
& icacls.exe $root /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "Setting the access list on $root failed"; exit 1 }
if (@(Get-ChildItem -LiteralPath $root -Force).Count) { Write-Error "$root was written to while it was being created; run the install again"; exit 1 }
New-Item -ItemType Directory -Path (Join-Path $root 'actions'), (Join-Path $root 'logs'), (Join-Path $root 'queue\requests'), (Join-Path $root 'queue\results') | Out-Null
# Users may add request files (and replace the ones they added); they cannot remove or rename the folder.
& icacls.exe (Join-Path $root 'queue\requests') /grant '*S-1-5-32-545:(WD)' '*S-1-5-32-545:(OI)(IO)M' /Q | Out-Null

Start-Transcript -LiteralPath $installLog -Force | Out-Null
try {
  Write-Output "Installing the Conductor admin helper from $source (commit $Commit) for $ForUser"

  # 2. The runner, the allowlist and only the scripts the allowlist names.
  Copy-Item -LiteralPath (Join-Path $source 'runner.ps1'), (Join-Path $source 'actions.json'), (Join-Path $source 'uninstall.ps1') -Destination $root
  foreach ($action in $allowlist.PSObject.Properties) {
    $script = [IO.Path]::GetFileName($action.Value.script)
    Copy-Item -LiteralPath (Join-Path $source "actions\$script") -Destination (Join-Path $root "actions\$script")
    Write-Output "action $($action.Name) -> actions\$script"
  }
  $vbs = @(
    "' Conductor admin helper: run the runner with no window (docs/admin-helper.md).",
    'Set shell = CreateObject("WScript.Shell")',
    "WScript.Quit shell.Run(""""""$powershell"""" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """"$root\runner.ps1"""""", 0, True)"
  ) -join "`r`n"
  [IO.File]::WriteAllText((Join-Path $root 'run-hidden.vbs'), $vbs + "`r`n", (New-Object Text.ASCIIEncoding))
  @{ installedAt = (Get-Date).ToUniversalTime().ToString('o'); source = $source; commit = $Commit; user = $ForUser; task = $taskName; actions = @($allowlist.PSObject.Properties.Name) } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'VERSION.json') -Encoding ASCII

  # 3. On demand only: no trigger. Queue lets a start that arrives mid-run run after it.
  $taskAction = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument "//B //NoLogo `"$root\run-hidden.vbs`"" -WorkingDirectory $root
  $principal = New-ScheduledTaskPrincipal -UserId $ForUser -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances Queue -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Principal $principal -Settings $settings -Description 'Conductor admin helper: runs only the allowlisted admin actions in C:\ProgramData\ConductorAdmin when Conductor asks (docs/admin-helper.md in the Conductor checkout).' -Force | Out-Null
  Write-Output "Registered the scheduled task '$taskName' (highest privileges, on demand only)."
  # Conductor starts the task unelevated (schtasks /Run), so the owner's account needs read and run
  # on it even when UAC was answered with another admin account (then that account is the author).
  try {
    $sid = (New-Object Security.Principal.NTAccount($ForUser)).Translate([Security.Principal.SecurityIdentifier]).Value
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    $registered = $service.GetFolder('\').GetTask($taskName)
    $sddl = $registered.GetSecurityDescriptor(4)
    if ($sddl -notmatch [regex]::Escape(";;;$sid)")) { $registered.SetSecurityDescriptor($sddl + "(A;;FRFX;;;$sid)", 0); Write-Output "Granted $ForUser read and run on the task." }
  } catch { Write-Output "Could not check the task's access list ($($_.Exception.Message)); if admin.run cannot start it, run the install again." }

  # 4. The first job, through the same queue Conductor uses.
  if (-not $SkipFirstJob) {
    $id = 'install-' + [Guid]::NewGuid().ToString('n').Substring(0, 12)
    $request = @{ id = $id; action = 'firewall-candidate-cleanup'; args = @{}; by = 'install'; requestedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $root "queue\requests\$id.json"), $request, (New-Object Text.UTF8Encoding $false))
    Start-ScheduledTask -TaskName $taskName
    $resultPath = Join-Path $root "queue\results\$id.json"
    $deadline = (Get-Date).AddMinutes(3)
    while (-not (Test-Path -LiteralPath $resultPath) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Path -LiteralPath $resultPath)) { Write-Output 'The scheduled task did not answer within 3 minutes; running the first job directly.'; & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'runner.ps1') }
    if (Test-Path -LiteralPath $resultPath) {
      $result = [IO.File]::ReadAllText($resultPath) | ConvertFrom-Json
      Write-Output "firewall-candidate-cleanup: ok=$($result.ok) exit=$($result.exitCode)"
      Write-Output $result.output
    } else { Write-Output 'firewall-candidate-cleanup did not run; see logs\runner-errors.log.' }
  }
} finally { Stop-Transcript | Out-Null }
exit 0
