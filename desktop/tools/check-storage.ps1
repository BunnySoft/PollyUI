param(
    [ValidateSet('fast', 'mounts', 'initramfs')]
    [string]$Mode = 'fast',
    [string]$Distro = 'podman-machine-default'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$linuxRepo = & wsl -d $Distro --exec wslpath -a $repo
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the repository path in WSL.' }
& wsl -d $Distro --exec sh "$linuxRepo/desktop/tools/check-storage.sh" $Mode
exit $LASTEXITCODE
