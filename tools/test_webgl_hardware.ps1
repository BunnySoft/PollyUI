[CmdletBinding()]
param(
    [string]$Build = (Join-Path $PSScriptRoot '..\build\gpu-hardware-win'),
    [string]$Evidence = (Join-Path $PSScriptRoot '..\build\gpu-hardware-qualification')
)
$ErrorActionPreference = 'Stop'
$Build = [IO.Path]::GetFullPath($Build)
$Evidence = [IO.Path]::GetFullPath($Evidence)
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
New-Item -ItemType Directory -Path $Evidence -Force | Out-Null
$previousPolicy = $env:PU_WEBGL2_DEVICE
$location = Get-Location
try {
    Set-Location $root
    $env:PU_WEBGL2_DEVICE = 'hardware'
    & (Join-Path $Build 'gui\pollyui-gpu-device-test.exe') --hardware-required --strict *>&1 |
        Tee-Object (Join-Path $Evidence 'native-device.log')
    $result = $LASTEXITCODE
    if ($result -eq 77) {
        Write-Host 'SKIP: No accessible physical Vulkan GPU was qualified. Software rendering was not used as proof.'
        exit 77
    }
    if ($result) { throw "Native hardware selection/verification failed ($result)" }
    foreach ($hint in @('--low-power', '--high-performance')) {
        & (Join-Path $Build 'gui\pollyui-gpu-device-test.exe') --hardware --strict $hint *>&1 |
            Tee-Object (Join-Path $Evidence "$hint.log")
        if ($LASTEXITCODE) { throw "Native GPU-backed power hint verification failed: $hint" }
    }
    & (Join-Path $Build 'gui\pollyui-gpu-current-test.exe') *>&1 |
        Tee-Object (Join-Path $Evidence 'owning-context.log')
    if ($LASTEXITCODE) { throw 'Hardware/software/UI lifetime or owning-context restoration failed' }
    & (Join-Path $Build 'gui\pollyui-gpu-test.exe') (Join-Path $root 'gui\tests\gpu-policy.mjs') *>&1 |
        Tee-Object (Join-Path $Evidence 'provider-policy.log')
    if ($LASTEXITCODE) { throw 'Hardware/default and explicitly separate software policy assertions failed' }
    foreach ($fixture in @('gpu.mjs', 'gpu-core.mjs', 'gpu-api.mjs', 'gpu-transfer.mjs',
        'gpu-state.mjs', 'gpu-uniform.mjs', 'gpu-review.mjs', 'gpu-three.mjs')) {
        & (Join-Path $Build 'gui\pollyui-gpu-test.exe') (Join-Path $root "gui\tests\$fixture") *>&1 |
            Tee-Object (Join-Path $Evidence "$fixture.log")
        if ($LASTEXITCODE) { throw "Real hardware fixture failed: $fixture" }
    }
    Write-Host 'PASS: Selected physical Vulkan GPU and real WebGL2/Three/mip/pixel/lifetime fixtures.'
    Write-Host 'This does not certify every GPU/driver or full WebGL/WPT conformance.'
} finally {
    $env:PU_WEBGL2_DEVICE = $previousPolicy
    Set-Location $location
}
