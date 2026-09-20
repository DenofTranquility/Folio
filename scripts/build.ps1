$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    cargo build --release --locked
    if ($LASTEXITCODE -ne 0) { throw 'Rust build failed.' }
    New-Item -ItemType Directory -Force -Path 'dist' | Out-Null
    Copy-Item -LiteralPath 'target\release\folio.exe' -Destination 'dist\Folio.exe'
    Copy-Item -LiteralPath 'README.md' -Destination 'dist\README.md'
    Copy-Item -LiteralPath 'LICENSE' -Destination 'dist\LICENSE.txt'
    Copy-Item -LiteralPath 'examples' -Destination 'dist' -Recurse -Force
    Write-Output 'Ready: dist\Folio.exe'
} finally {
    Pop-Location
}
