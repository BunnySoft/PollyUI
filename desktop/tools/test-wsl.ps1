param(
    [string]$Distro = "podman-machine-default",
    [switch]$Nested,
    [switch]$Sanitize
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$image = "localhost/pollyui-desktop-dev"
$build = if ($Sanitize) { "build/desktop-clang-asan" } else { "build/desktop" }
$flags = if ($Sanitize) {
    "-DCMAKE_C_COMPILER=clang -DCMAKE_C_FLAGS=-fsanitize=address,undefined"
} else { "" }

function Invoke-Wsl([string]$Command) {
    & wsl -d $Distro --cd $repo -- sh -lc $Command
    if ($LASTEXITCODE -ne 0) { throw "WSL command failed with exit code $LASTEXITCODE" }
}

Invoke-Wsl "podman build -q -t $image -f desktop/Containerfile desktop"
$checks = "cmake -S desktop -B $build -G Ninja -DCMAKE_BUILD_TYPE=Debug -DBUILD_TESTING=ON $flags"
$checks += "; cmake --build $build; ctest --test-dir $build --output-on-failure"
Invoke-Wsl ('podman run --rm -v "$PWD:/workspace" ' + $image + " sh -ec '$checks'")

if ($Nested) {
    $runner = if ($Sanitize) { "" } else {
        "valgrind --error-exitcode=99 --leak-check=full --errors-for-leak-kinds=definite "
    }
    $checks = "${runner}$build/tests/pollywm-integration /workspace/$build/tests/pollywm-test-client --nested"
    $checks += "; sh desktop/tests/nested.sh /workspace/$build/pollywm"
    Invoke-Wsl ('test -S /mnt/wslg/runtime-dir/wayland-0 && ' +
        'podman run --rm -v "$PWD:/workspace" -v /mnt/wslg:/mnt/wslg:ro ' +
        "-e WAYLAND_DISPLAY=/mnt/wslg/runtime-dir/wayland-0 $image sh -ec '$checks'")
}
