[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -prerelease -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'No Visual Studio C++ toolchain found' }
$vcpkg = Join-Path $installation.Trim() 'VC\vcpkg\vcpkg.exe'
if (-not (Test-Path $vcpkg)) { throw "vcpkg is unavailable: $vcpkg" }
& $vcpkg install --triplet x64-windows-static `
    "--x-manifest-root=$repo\sysrt" "--x-install-root=$repo\build\sysrt-deps" `
    "--downloads-root=$repo\build\sysrt-downloads" `
    "--x-buildtrees-root=$repo\build\sysrt-buildtrees" `
    "--x-packages-root=$repo\build\sysrt-packages"
if ($LASTEXITCODE -ne 0) { throw "SysRT dependency restore failed ($LASTEXITCODE)" }
