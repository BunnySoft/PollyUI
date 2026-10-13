[CmdletBinding()]
param(
    [string]$Dest = (Join-Path $PSScriptRoot '..\build\gpu-win\gui'),
    [string]$Cache = (Join-Path $PSScriptRoot '..\.cache\webgl-angle-v41.10.7')
)
$ErrorActionPreference = 'Stop'
$manifest = Get-Content (Join-Path $PSScriptRoot '..\gui\tests\gpu\ANGLE-RUNTIME.json') -Raw |
    ConvertFrom-Json
$Dest = [IO.Path]::GetFullPath($Dest)
$Cache = [IO.Path]::GetFullPath($Cache)
New-Item -ItemType Directory -Path $Dest, $Cache -Force | Out-Null

function Confirm-Hash([string]$Path, [string]$Expected) {
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) {
        throw "Native vendor checksum mismatch: $Path"
    }
}
function Fetch-Verified([string]$Url, [string]$Path, [string]$Hash) {
    if (-not (Test-Path -LiteralPath $Path)) {
        & curl.exe -fL --silent --show-error $Url -o $Path
        if ($LASTEXITCODE) { throw "Cannot retrieve pinned vendor artifact: $Url" }
    }
    Confirm-Hash $Path $Hash
}
$zip = Join-Path $Cache 'electron-v41.10.7-win32-x64.zip'
$checksums = Join-Path $Cache 'SHASUMS256.txt'
Fetch-Verified $manifest.archiveUrl $zip $manifest.archiveSha256
Fetch-Verified $manifest.checksumsUrl $checksums $manifest.checksumsSha256
$published = Get-Content -LiteralPath $checksums |
    Where-Object { $_ -match '\*?electron-v41\.10\.7-win32-x64\.zip$' }
if (-not $published -or ($published -replace '\s.*$', '') -ne $manifest.archiveSha256) {
    throw 'Official checksum file does not match the pinned archive digest'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    foreach ($file in $manifest.files.PSObject.Properties) {
        $entry = $archive.GetEntry($file.Name)
        if (-not $entry) { throw "Missing native library/license in verified archive: $($file.Name)" }
        $path = Join-Path $Dest $file.Name
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $path, $true)
        Confirm-Hash $path $file.Value
    }
} finally {
    $archive.Dispose()
}
Copy-Item (Join-Path $PSScriptRoot '..\gui\tests\gpu\ANGLE-RUNTIME.json') $Dest
Write-Host "Staged checksum-pinned ANGLE Vulkan/SwiftShader native libraries and full licenses to $Dest."
Write-Host 'No Electron/browser was installed or run. No system Vulkan settings or shared SDK were changed.'
Write-Host 'Product default is verified Vulkan hardware. PU_WEBGL2_DEVICE=software explicitly selects the CPU qualification provider; no fallback.'
