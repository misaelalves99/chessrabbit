param([string]$Python = "python", [switch]$SkipWeb, [switch]$UnpackedOnly)
$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
if (-not $IsWindows -and $env:OS -ne "Windows_NT") { throw "Build the Windows installer on Windows." }
function Invoke-Checked([scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "Build step failed with exit code $LASTEXITCODE" }
}
Push-Location $repoRoot
try {
    $env:ELECTRON_CACHE = Join-Path $repoRoot ".test-cache/electron"
    $env:ELECTRON_BUILDER_CACHE = Join-Path $repoRoot ".test-cache/electron-builder"
    Invoke-Checked { & $Python apps/desktop/scripts/prepare_resources.py }
    if (-not $SkipWeb) {
        Push-Location apps/web
        try {
            $env:NEXT_PUBLIC_API_URL = "/api"
            $env:NEXT_PUBLIC_WS_URL = "/api"
            $env:NEXT_TELEMETRY_DISABLED = "1"
            Invoke-Checked { npm run build }
        } finally { Pop-Location }
    }
    Invoke-Checked {
        # Keep standard streams for readiness, logging and parent-exit detection.
        # Electron's windowsHide option prevents a console window at launch.
        & $Python -m PyInstaller --noconfirm --clean --noupx --onedir --name ChessRabbitBackend `
            --distpath dist/desktop-backend --workpath .test-cache/pyinstaller --specpath .test-cache `
            --paths apps/api --paths services/engine --paths apps/desktop/backend `
            --collect-submodules app --collect-all fakeredis --collect-all asyncpg `
            --collect-all psycopg_binary --hidden-import sqlalchemy.dialects.postgresql.asyncpg `
            --hidden-import uvicorn.logging --hidden-import uvicorn.loops.asyncio `
            --hidden-import uvicorn.protocols.http.h11_impl --hidden-import uvicorn.protocols.websockets.websockets_impl `
            --hidden-import uvicorn.lifespan.on apps/desktop/backend/runtime.py
    }
    Push-Location apps/desktop
    try {
        if ($UnpackedOnly) { Invoke-Checked { npx electron-builder --win --x64 --dir --publish never } }
        else { Invoke-Checked { npm run dist:win } }
    } finally { Pop-Location }
    if (-not $UnpackedOnly) {
        $installer = Join-Path $repoRoot "dist/windows/ChessRabbit-Setup.exe"
        $checksum = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
        "$checksum  ChessRabbit-Setup.exe" | Set-Content -LiteralPath "$installer.sha256" -Encoding ascii
        Write-Host "Installer: $installer"
    }
} finally { Pop-Location }
