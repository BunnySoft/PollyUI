# PollyUI build driver.
# Discovers a VS 2022+ C++ toolchain, imports its x64 environment, locates
# clang-cl/CMake/Ninja, then configures + builds the `win-clang` preset.
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

$repo = Split-Path $PSScriptRoot -Parent

function Find-Executable {
    param([string]$Name, [string[]]$Fallbacks)
    foreach ($path in $Fallbacks) {
        if ($path -and (Test-Path $path)) { return $path }
    }
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

$vswhere = Find-Executable 'vswhere.exe' @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
)
if (-not $vswhere) {
    throw 'Visual Studio Installer (vswhere.exe) not found. Install Visual Studio 2022 Build Tools with the C++ workload.'
}

$vsInstall = & $vswhere -latest -products * -version '[17.0,)' `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath
if (-not $vsInstall) {
    throw 'Visual Studio 2022 or newer C++ Build Tools not found. Install the Desktop development with C++ workload.'
}

$vcvars = Join-Path $vsInstall 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "Required tool not found: $vcvars" }

# Import the MSVC developer environment (INCLUDE / LIB / PATH ...) into this session.
Write-Host "==> importing MSVC environment: $vsInstall" -ForegroundColor Cyan
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "Env:$($matches[1])" -Value $matches[2] }
}
if ($LASTEXITCODE) { throw "Failed to import the Visual Studio environment ($LASTEXITCODE)" }

$clangCl = Find-Executable 'clang-cl.exe' @(
    (Join-Path $vsInstall 'VC\Tools\Llvm\x64\bin\clang-cl.exe'),
    "$env:ProgramFiles\LLVM\bin\clang-cl.exe"
)
$cmake = Find-Executable 'cmake.exe' @(
    (Join-Path $vsInstall 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'),
    "$env:ProgramFiles\CMake\bin\cmake.exe"
)
$ninja = Find-Executable 'ninja.exe' @(
    (Join-Path $vsInstall 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe')
)
foreach ($tool in @(
    @{ Name = 'clang-cl'; Path = $clangCl },
    @{ Name = 'CMake'; Path = $cmake },
    @{ Name = 'Ninja'; Path = $ninja }
)) {
    if (-not $tool.Path) { throw "$($tool.Name) not found. Install it before building PollyUI." }
}

$cmakeVersionText = (& $cmake --version | Select-Object -First 1) -replace '^cmake version ', ''
if ($cmakeVersionText -notmatch '^(\d+\.\d+(?:\.\d+)?)') {
    throw "Could not parse CMake version '$cmakeVersionText' from $cmake"
}
if ([version]$matches[1] -lt [version]'3.25') {
    throw "CMake 3.25 or newer is required; found $cmakeVersionText at $cmake"
}

# Make the discovered tools win over stale PATH entries used by the preset.
$toolDirs = @(
    (Split-Path $clangCl),
    (Split-Path $cmake),
    (Split-Path $ninja)
) | Select-Object -Unique
$env:Path = ($toolDirs -join ';') + ';' + $env:Path

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
