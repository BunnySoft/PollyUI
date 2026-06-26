# Fetches the prebuilt Skia used by PollyUI into third_party/skia (gitignored).
# Skia is large, so it is NOT vendored in git — run this once after cloning.
#
#   ./tools/fetch_skia.ps1
#
# Pinned to the aseprite/skia m124 Windows x64 Release build (static CRT /MT),
# matching CMakeLists.txt (CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded).
[CmdletBinding()]
param(
    [string]$Tag   = 'm124-08a5439a6b',
    [string]$Asset = 'Skia-Windows-Release-x64.zip'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = Split-Path $PSScriptRoot -Parent
$dest = Join-Path $repo 'third_party\skia'
$zip  = Join-Path $repo 'third_party\_skia.zip'
$url  = "https://github.com/aseprite/skia/releases/download/$Tag/$Asset"

if (Test-Path (Join-Path $dest 'out\Release-x64\skia.lib')) {
    Write-Host "Skia already present at $dest" -ForegroundColor Green
    return
}

New-Item -ItemType Directory -Force (Join-Path $repo 'third_party') | Out-Null
Write-Host "Downloading $url" -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $zip -Headers @{ 'User-Agent' = 'PollyUI' }

Write-Host "Extracting to $dest" -ForegroundColor Cyan
Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
Expand-Archive -Path $zip -DestinationPath $dest -Force
Remove-Item $zip

if (Test-Path (Join-Path $dest 'out\Release-x64\skia.lib')) {
    Write-Host "Skia ready." -ForegroundColor Green
} else {
    throw "skia.lib not found after extraction — unexpected archive layout."
}
