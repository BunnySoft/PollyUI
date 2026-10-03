param([string]$Executable = '.\build\win-clang\pollyui.exe')
$ErrorActionPreference = 'Stop'
$executablePath = (Resolve-Path $Executable).Path
$repo = Split-Path $PSScriptRoot -Parent
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("pollyui-tests-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporary | Out-Null
$storage = Join-Path $temporary 'storage.dat'
$previousStorage = $env:PU_TEST_STORAGE
Push-Location $repo
try {
    $env:PU_TEST_STORAGE = $storage
    foreach ($test in Get-Content .\tools\core-tests.txt) {
        $output = & $executablePath --test (Join-Path 'tests' $test) 2>&1
        if ($LASTEXITCODE -ne 0 -or ($output -match '^FAIL:')) {
            $output | Write-Output
            throw "Core test failed: $test"
        }
        Write-Output "PASS: $test"
    }
} finally {
    Pop-Location
    $env:PU_TEST_STORAGE = $previousStorage
    if (Test-Path $storage) { Remove-Item -LiteralPath $storage }
    Remove-Item -LiteralPath $temporary
}
