<#
.SYNOPSIS
Verify the local model stack and start both llama.cpp servers on 127.0.0.1.
#>
param([string]$Model, [switch]$Fast)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cliArgs = @('start')
if ($Model) { $cliArgs += @('--model', $Model) }
if ($Fast) { $cliArgs += '--fast' }
Push-Location $repo
try { & node '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON' (Join-Path $PSScriptRoot 'cli.ts') @cliArgs } finally { Pop-Location }
exit $LASTEXITCODE
