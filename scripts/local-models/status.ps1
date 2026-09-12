<#
.SYNOPSIS
Report local model server health, API key enforcement, Docker availability and provenance.
#>
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $repo
try { & node '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON' (Join-Path $PSScriptRoot 'cli.ts') 'status' } finally { Pop-Location }
exit $LASTEXITCODE
