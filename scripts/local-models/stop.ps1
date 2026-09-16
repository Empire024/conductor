<#
.SYNOPSIS
Stop only the llama.cpp servers this stack started, and optionally its sandbox container.
#>
param([string]$Model, [switch]$Sandbox)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cliArgs = @('stop')
if ($Model) { $cliArgs += @('--model', $Model) }
if ($Sandbox) { $cliArgs += '--sandbox' }
Push-Location $repo
try { & node '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON' (Join-Path $PSScriptRoot 'cli.ts') @cliArgs } finally { Pop-Location }
exit $LASTEXITCODE
