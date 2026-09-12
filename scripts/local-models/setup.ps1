<#
.SYNOPSIS
Prepare Conductor's local model stack on a non-system drive: data root, config, API key, GGUF
downloads and the sandbox image. Idempotent - an existing root, llama.cpp install, verified model
or built image is reused, and a model found at an older location is migrated rather than refetched.
#>
param(
  [string]$Root,
  [ValidateSet('Q4_K_M', 'Q6_K')][string]$Quant9b = 'Q4_K_M',
  [int]$Context = 32768,
  [string]$LlamaServer,
  [switch]$SkipModels,
  [switch]$SkipImage
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cliArgs = @('setup', '--quant-9b', $Quant9b, '--context', "$Context")
if ($Root) { $cliArgs += @('--root', $Root) }
if ($LlamaServer) { $cliArgs += @('--llama-server', $LlamaServer) }
if ($SkipModels) { $cliArgs += '--skip-models' }
if ($SkipImage) { $cliArgs += '--skip-image' }
Push-Location $repo
try { & node '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON' (Join-Path $PSScriptRoot 'cli.ts') @cliArgs } finally { Pop-Location }
exit $LASTEXITCODE
