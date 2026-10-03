# PollyUI build driver.
# Sets up the MSVC environment (so clang-cl finds the Windows SDK + CRT), puts
# LLVM/CMake on PATH, then configures + builds the `win-clang` preset with Ninja.
#
#   ./tools/build.ps1            # configure + build
#   ./tools/build.ps1 -Clean     # wipe build/ first
#   ./tools/build.ps1 -Run       # also launch the app afterward
[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$Run
)
$ErrorActionPreference = 'Stop'

$repo    = Split-Path $PSScriptRoot -Parent
$llvmBin = 'C:\Program Files\LLVM\bin'
$cmake   = 'C:\Program Files\CMake\bin\cmake.exe'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw "Required tool not found: $vswhere" }
$installation = & $vswhere -latest -prerelease -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'No Visual Studio C++ toolchain found' }
$vcvars = Join-Path $installation.Trim() 'VC\Auxiliary\Build\vcvars64.bat'

foreach ($p in @($llvmBin, $cmake, $vcvars)) {
    if (-not (Test-Path $p)) { throw "Required tool not found: $p" }
}

# Import the MSVC developer environment (INCLUDE / LIB / PATH ...) into this session.
Write-Host '==> importing MSVC environment (vcvars64)' -ForegroundColor Cyan
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "Env:$($matches[1])" -Value $matches[2] }
}

# Make sure our chosen LLVM + CMake win over anything else on PATH.
$env:Path = "$llvmBin;" + (Split-Path $cmake) + ';' + $env:Path

if ($Clean) {
    Write-Host '==> cleaning build/' -ForegroundColor Cyan
    Remove-Item -Recurse -Force (Join-Path $repo 'build') -ErrorAction SilentlyContinue
}

Push-Location $repo
try {
    Write-Host '==> configure' -ForegroundColor Cyan
    & $cmake --preset win-clang
    if ($LASTEXITCODE) { throw "configure failed ($LASTEXITCODE)" }

    Write-Host '==> build' -ForegroundColor Cyan
    & $cmake --build --preset win-clang
    if ($LASTEXITCODE) { throw "build failed ($LASTEXITCODE)" }

    $exe = Join-Path $repo 'build\win-clang\pollyui.exe'
    Write-Host "==> built: $exe" -ForegroundColor Green

    if ($Run) {
        Write-Host '==> running' -ForegroundColor Cyan
        & $exe
    }
}
finally {
    Pop-Location
}
