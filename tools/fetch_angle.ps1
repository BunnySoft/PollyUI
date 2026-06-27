# Stage ANGLE (libEGL / libGLESv2 / d3dcompiler_47) next to the built exe so the
# GPU backend (Skia GLES -> ANGLE -> D3D11) can load them at runtime.
#
# ANGLE is the standard Windows GPU path (Chrome/Edge/Flutter/Electron use it);
# it works even where native OpenGL drivers don't (remote/VM sessions). These
# x64 DLLs are sourced from an installed Chrome or Edge. For a real release,
# ship official ANGLE binaries instead.
#
#   ./tools/fetch_angle.ps1
[CmdletBinding()]
param([string]$Dest = (Join-Path $PSScriptRoot "..\build\win-clang"))
$ErrorActionPreference = 'Stop'

$dlls = 'libEGL.dll', 'libGLESv2.dll', 'd3dcompiler_47.dll'
$roots = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application')
)

$src = $null
foreach ($r in $roots) {
    if (Test-Path $r) {
        $cand = Get-ChildItem $r -Directory -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending |
                Where-Object { Test-Path (Join-Path $_.FullName 'libGLESv2.dll') } |
                Select-Object -First 1
        if ($cand) { $src = $cand.FullName; break }
    }
}
if (-not $src) { throw "No ANGLE DLLs found. Install Chrome/Edge, or supply libEGL/libGLESv2/d3dcompiler_47 manually." }

New-Item -ItemType Directory -Force $Dest | Out-Null
foreach ($d in $dlls) { Copy-Item (Join-Path $src $d) (Join-Path $Dest $d) -Force }
Write-Host "Staged ANGLE DLLs from`n  $src`nto`n  $Dest" -ForegroundColor Green
