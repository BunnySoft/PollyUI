[CmdletBinding()]
param(
    [string]$Dest = (Join-Path $PSScriptRoot '..\third_party\vulkan-headers'),
    [string]$Cache = (Join-Path $PSScriptRoot '..\.cache\vulkan-headers-b379292')
)
$ErrorActionPreference = 'Stop'
$manifest = Get-Content (Join-Path $PSScriptRoot '..\third_party\vulkan-headers-manifest.json') -Raw |
    ConvertFrom-Json
$Dest = [IO.Path]::GetFullPath($Dest)
$Cache = [IO.Path]::GetFullPath($Cache)
New-Item -ItemType Directory -Path $Dest, $Cache -Force | Out-Null
$archive = Join-Path $Cache 'Vulkan-Headers-b379292.tar.gz'
if (-not (Test-Path -LiteralPath $archive)) {
    & curl.exe -fL --silent --show-error $manifest.archiveUrl -o $archive
    if ($LASTEXITCODE) { throw 'Cannot retrieve pinned Khronos Vulkan headers' }
}
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.archiveSha256) {
    throw 'Pinned Vulkan header archive checksum mismatch'
}
& tar -xf $archive -C $Dest --strip-components=1
if ($LASTEXITCODE) { throw 'Cannot extract pinned Vulkan header source archive' }
Write-Host "Restored maintained headers and original licenses to $Dest. No SDK or driver was installed."
