[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SmokeScript,
    [string[]]$SmokeArgs = @()
)

# Process-local only: children inherit the Windows error mode. Never change WER policy,
# the registry, or Electron's Chromium sandbox. Launch this wrapper outside the tool sandbox.
$ErrorActionPreference = 'Stop'
$smokeScriptsRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$smokeWorkspaceRoot = Split-Path -Parent $smokeScriptsRoot
$smokeTarget = Get-Item -LiteralPath $SmokeScript -Force
if ($smokeTarget.PSIsContainer -or
    $smokeTarget.Name -notmatch '^smoke-[a-zA-Z0-9][a-zA-Z0-9._-]*\.mjs$' -or
    -not [string]::Equals($smokeTarget.DirectoryName, $smokeScriptsRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Choose one smoke-*.mjs file directly inside this workspace scripts directory.'
}
foreach ($smokePath in @($smokeTarget.FullName, $smokeScriptsRoot)) {
    if ((Get-Item -LiteralPath $smokePath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'A smoke script or scripts directory must not be a reparse point.'
    }
}
$smokeNode = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
if (-not ('ConductorSmoke.NativeErrorMode' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace ConductorSmoke {
    public static class NativeErrorMode {
        [DllImport("kernel32.dll")] public static extern uint GetErrorMode();
        [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode);
    }
}
'@
}
$smokePreviousMode = [ConductorSmoke.NativeErrorMode]::GetErrorMode()
$smokePreviousBackground = [Environment]::GetEnvironmentVariable('CONDUCTOR_BACKGROUND_WINDOWS', 'Process')
$smokePreviousLocation = Get-Location
$smokeExitCode = 1
try {
    # SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX
    [void][ConductorSmoke.NativeErrorMode]::SetErrorMode($smokePreviousMode -bor 0x8003)
    [Environment]::SetEnvironmentVariable('CONDUCTOR_BACKGROUND_WINDOWS', '1', 'Process')
    Set-Location -LiteralPath $smokeWorkspaceRoot
    & $smokeNode $smokeTarget.FullName @SmokeArgs
    $smokeExitCode = $LASTEXITCODE
} finally {
    Set-Location -LiteralPath $smokePreviousLocation.Path
    [Environment]::SetEnvironmentVariable('CONDUCTOR_BACKGROUND_WINDOWS', $smokePreviousBackground, 'Process')
    [void][ConductorSmoke.NativeErrorMode]::SetErrorMode($smokePreviousMode)
}
exit $smokeExitCode
