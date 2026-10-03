$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$releaseDirectory = Join-Path $repoRoot 'dist/windows'
$targets = @('ChessRabbit-Setup.exe', 'win-unpacked')
foreach ($target in $targets) {
    if (-not (Test-Path -LiteralPath (Join-Path $releaseDirectory $target))) {
        throw "Required scan target is missing: $target"
    }
}
$status = Get-MpComputerStatus -ErrorAction Stop
if (-not $status.AMServiceEnabled -or -not $status.AntivirusEnabled) {
    throw 'Microsoft Defender is unavailable. Release publication is blocked.'
}
Update-MpSignature -ErrorAction Stop
$status = Get-MpComputerStatus -ErrorAction Stop
$status | Select-Object AMProductVersion, AMEngineVersion, AntivirusSignatureVersion, AntivirusSignatureLastUpdated | Format-List
$scanner = Get-ChildItem -Path "$env:ProgramData/Microsoft/Windows Defender/Platform/*/MpCmdRun.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $scanner) { $scanner = Join-Path $env:ProgramFiles 'Windows Defender/MpCmdRun.exe' }
if (-not (Test-Path -LiteralPath $scanner)) { throw 'Defender scanner is missing. Release publication is blocked.' }
foreach ($target in $targets) {
    $scanPath = Join-Path $releaseDirectory $target
    Write-Host "Scanning $scanPath"
    # This scan-only mode ignores file exclusions and inspects archives.
    # It reports threats without altering artifacts; any nonzero result blocks release.
    & $scanner -Scan -ScanType 3 -File $scanPath -DisableRemediation
    if ($LASTEXITCODE -ne 0) { throw "Defender scan failed for $target (exit $LASTEXITCODE). Release publication is blocked." }
}
$recent = Get-MpThreatDetection -ErrorAction Stop | Where-Object { $_.InitialDetectionTime -gt (Get-Date).AddHours(-2) }
if ($recent) { throw 'Defender recorded a recent detection on this build runner. Investigate before releasing.' }
Write-Host 'DEFENDER_RELEASE_SCAN_PASSED'
