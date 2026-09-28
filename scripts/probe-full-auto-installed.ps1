param(
  [string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process -Filter "Name = 'Conductor.exe'" -ErrorAction Stop | ForEach-Object {
  $path = $_.ExecutablePath
  $file = if ($path -and (Test-Path -LiteralPath $path)) { Get-Item -LiteralPath $path } else { $null }
  [pscustomobject]@{
    pid = $_.ProcessId
    parentPid = $_.ParentProcessId
    createdUtc = $_.CreationDate.ToUniversalTime().ToString('o')
    executable = $path
    fileVersion = if ($file) { $file.VersionInfo.FileVersion } else { $null }
    productVersion = if ($file) { $file.VersionInfo.ProductVersion } else { $null }
  }
})
if ($rows.Count -eq 0) { throw 'No running installed Conductor.exe process was found' }
if ($ExpectedVersion -and -not @($rows | Where-Object { $_.ProductVersion -eq $ExpectedVersion -or $_.FileVersion -eq $ExpectedVersion }).Count) {
  throw "No running Conductor.exe matches expected version $ExpectedVersion"
}
[pscustomobject]@{
  observedUtc = [DateTime]::UtcNow.ToString('o')
  expectedVersion = $ExpectedVersion
  running = $rows.Count
  processes = $rows
} | ConvertTo-Json -Depth 4 -Compress
