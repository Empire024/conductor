<#
.SYNOPSIS
Set up the CPU decision model (docs/model-routing.md, "CPU decider"): an isolated Python venv under
<local root>\decider with laya 0.3.21 and CPU-only torch at pinned versions, and the Laya
typed-decisions checkpoint at its reviewed revision, SHA-256 checked. The owner runs this once; Conductor
never installs or downloads anything itself, and starts the sidecar offline from what this left on disk.
Idempotent: an existing venv and a verified checkpoint are reused.
#>
param(
  [string]$Root,
  [string]$Python = 'py -3.13'
)
$ErrorActionPreference = 'Stop'
$revision = '55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851'
$weights = '4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e'
if (-not $Root) {
  $pointer = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.local-models\root.json'
  if (-not (Test-Path $pointer)) { $pointer = Join-Path $HOME '.conductor\local-root.json' }
  if (-not (Test-Path $pointer)) { throw 'No local root is configured; run scripts/local-models/setup.ps1 first or pass -Root' }
  $Root = (Get-Content $pointer -Raw | ConvertFrom-Json).root
}
$dir = Join-Path $Root 'decider'
$venvPython = Join-Path $dir 'venv\Scripts\python.exe'
New-Item -ItemType Directory -Force $dir | Out-Null
if (-not (Test-Path $venvPython)) {
  $launcher = $Python.Split(' ')
  & $launcher[0] @($launcher[1..($launcher.Length - 1)] + @('-m', 'venv', (Join-Path $dir 'venv')))
  if ($LASTEXITCODE) { throw 'Creating the venv failed' }
}
& $venvPython -m pip install --disable-pip-version-check --index-url https://download.pytorch.org/whl/cpu 'torch==2.14.0+cpu'
if ($LASTEXITCODE) { throw 'Installing CPU torch failed' }
& $venvPython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'decider-requirements.txt')
if ($LASTEXITCODE) { throw 'Installing laya failed' }
# The one download: exactly the typed-decisions subfolder at the reviewed revision, checked before it loads.
$env:HF_HOME = Join-Path $dir 'hf'
$env:USE_TF = '0'
$env:LAYA_THREADS = '4'
$env:LAYA_SHA256_DIGESTS = "{`"model.safetensors`":`"$weights`"}"
& $venvPython -c "import laya; a = laya.load('convaiinnovations/laya', subfolder='typed-decisions', device='cpu', revision='$revision'); print('laya typed-decisions ready at', a.revision)"
if ($LASTEXITCODE) { throw 'Downloading or verifying the checkpoint failed' }
