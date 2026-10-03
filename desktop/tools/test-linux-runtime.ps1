param(
    [string]$Distro = "podman-machine-default",
    [switch]$Nested,
    [switch]$Sanitize
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$image = "localhost/pollyui-linux-runtime"
$buildDir = if ($Sanitize) { "build/linux-sdl-asan" } else { "build/linux-sdl" }
$flags = if ($Sanitize) {
    "-DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ " +
    "-DCMAKE_C_FLAGS=-fsanitize=address,undefined -DCMAKE_CXX_FLAGS=-fsanitize=address,undefined"
} else { "" }

function Invoke-Wsl([string]$Command) {
    & wsl -d $Distro --cd $repo -- sh -lc $Command
    if ($LASTEXITCODE -ne 0) { throw "Linux runtime command failed with exit code $LASTEXITCODE" }
}

# The first build compiles pinned Skia; subsequent runs reuse the image layer.
Invoke-Wsl "podman build -q --target runtime -t $image -f desktop/Containerfile desktop"
$build = "cmake -S . -B $buildDir -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo " +
         "-DPU_HOST=sdl -DSKIA_ROOT=/opt/pollyui-skia -DPU_BUILD_DESKTOP=ON $flags"
$checks = "$build; cmake --build $buildDir -j 2"
$checks += "; sh desktop/tests/runtime-headless.sh /workspace/$buildDir/pollyui"
$checks += "; ctest --test-dir $buildDir --output-on-failure"
Invoke-Wsl ('podman run --rm -v "$PWD:/workspace" ' + $image + " sh -ec '$checks'")

if ($Nested) {
    $checks = "sh desktop/tests/runtime-wayland.sh /workspace/$buildDir/pollyui /workspace/$buildDir/desktop/pollywm"
    Invoke-Wsl ('test -S /mnt/wslg/runtime-dir/wayland-0 && ' +
        'podman run --rm -v "$PWD:/workspace" -v /mnt/wslg:/mnt/wslg:ro ' +
        "-e WAYLAND_DISPLAY=/mnt/wslg/runtime-dir/wayland-0 $image sh -ec '$checks'")
}
