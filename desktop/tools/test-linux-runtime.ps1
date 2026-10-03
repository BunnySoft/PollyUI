param(
    [string]$Distro = "podman-machine-default",
    [switch]$Nested,
    [switch]$Sanitize
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$image = "localhost/pollyui-linux-runtime"
$buildDir = if ($Sanitize) { "build/linux-sdl-asan" } else { "build/linux-sdl" }
$flags = if ($Sanitize) { '--sanitize' } else { '' }

function Invoke-Wsl([string]$Command) {
    & wsl -d $Distro --cd $repo -- sh -lc $Command
    if ($LASTEXITCODE -ne 0) { throw "Linux runtime command failed with exit code $LASTEXITCODE" }
}

# The first build compiles pinned Skia; subsequent runs reuse the image layer.
Invoke-Wsl "podman build -q --target runtime -t $image -f desktop/Containerfile desktop"
$checks = "sh desktop/tools/check-linux-runtime.sh $buildDir $flags"
$checks += "; sh desktop/tests/runtime-wayland.sh /workspace/$buildDir/pollyui /workspace/$buildDir/desktop/pollywm --headless"
Invoke-Wsl ('podman run --rm -v "$PWD:/workspace" ' + $image + " sh -ec '$checks'")

if ($Nested) {
    $checks = "sh desktop/tests/runtime-wayland.sh /workspace/$buildDir/pollyui /workspace/$buildDir/desktop/pollywm"
    Invoke-Wsl ('test -S /mnt/wslg/runtime-dir/wayland-0 && ' +
        'podman run --rm -v "$PWD:/workspace" -v /mnt/wslg:/mnt/wslg:ro ' +
        "-e WAYLAND_DISPLAY=/mnt/wslg/runtime-dir/wayland-0 $image sh -ec '$checks'")
}
