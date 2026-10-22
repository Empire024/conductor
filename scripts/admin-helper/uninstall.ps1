<#
  Removes the Conductor admin helper (docs/admin-helper.md): the scheduled task
  "Conductor Admin Helper" and C:\ProgramData\ConductorAdmin. One UAC prompt:

    powershell -NoProfile -ExecutionPolicy Bypass -File C:\Claude\conductor\scripts\admin-helper\uninstall.ps1
#>
param([switch]$Elevated)
$ErrorActionPreference = 'Stop'
$taskName = 'Conductor Admin Helper'
$root = Join-Path $env:ProgramData 'ConductorAdmin'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $admin) {
  if ($Elevated) { exit 1 }
  # Copy this script out of the folder it deletes before asking for elevation.
  $copy = Join-Path $env:TEMP "conductor-admin-uninstall-$PID.ps1"
  Copy-Item -LiteralPath $PSCommandPath -Destination $copy -Force
  try { $process = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$copy`"", '-Elevated') -Verb RunAs -WindowStyle Hidden -Wait -PassThru }
  catch { Write-Output "Not removed: the administrator prompt was declined or failed ($($_.Exception.Message))."; exit 1 }
  finally { Remove-Item -LiteralPath $copy -Force -ErrorAction SilentlyContinue }
  $left = @()
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { $left += "the task '$taskName'" }
  if (Test-Path -LiteralPath $root) { $left += $root }
  if ($left.Count) { Write-Output "Still present: $($left -join ', ')"; exit 1 }
  Write-Output 'Conductor admin helper removed.'
  exit $process.ExitCode
}

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
if (Test-Path -LiteralPath $root) { & cmd.exe /d /c "rmdir /s /q `"$root`"" }
exit 0
