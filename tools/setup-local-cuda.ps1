[CmdletBinding()]
param(
    [string]$Release = "13.3.1",
    [string]$ToolkitVersion = "13.3",
    [switch]$NoUserEnvironment
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$cudaRoot = Join-Path $PSScriptRoot "cuda"
$archiveDirectory = Join-Path $cudaRoot "archives"
$extractDirectory = Join-Path $cudaRoot "extracted"
$toolkitDirectory = Join-Path $cudaRoot ("toolkit\v" + $ToolkitVersion)
$manifestPath = Join-Path $cudaRoot ("redistrib_" + $Release + ".json")
$manifestUri = "https://developer.download.nvidia.com/compute/cuda/redist/redistrib_$Release.json"
$packageNames = @("cuda_nvcc", "cuda_crt", "cuda_cudart", "cccl", "libnvvm")

New-Item -ItemType Directory -Force -Path $cudaRoot, $archiveDirectory, $extractDirectory, $toolkitDirectory | Out-Null
Invoke-WebRequest -Uri $manifestUri -OutFile $manifestPath -UseBasicParsing
$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json

foreach ($packageName in $packageNames) {
    $package = $manifest.$packageName.'windows-x86_64'
    if ($null -eq $package) {
        throw "CUDA manifest has no Windows x86-64 package named $packageName"
    }

    $archiveName = [IO.Path]::GetFileName($package.relative_path)
    $archivePath = Join-Path $archiveDirectory $archiveName
    $archiveValid = Test-Path -LiteralPath $archivePath
    if ($archiveValid) {
        $archiveValid = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash -ieq $package.sha256
    }
    if (-not $archiveValid) {
        Write-Host "Downloading $archiveName"
        $archiveUri = "https://developer.download.nvidia.com/compute/cuda/redist/$($package.relative_path)"
        Invoke-WebRequest -Uri $archiveUri -OutFile $archivePath -UseBasicParsing
    }

    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
    if ($actualHash -ine $package.sha256) {
        throw "SHA-256 mismatch for $archiveName"
    }

    $packageExtractDirectory = Join-Path $extractDirectory ([IO.Path]::GetFileNameWithoutExtension($archiveName))
    Write-Host "Extracting $archiveName"
    Expand-Archive -LiteralPath $archivePath -DestinationPath $packageExtractDirectory -Force
    $archiveRoots = @(Get-ChildItem -LiteralPath $packageExtractDirectory -Directory)
    if ($archiveRoots.Count -ne 1) {
        throw "Expected one top-level directory in $archiveName"
    }
    Copy-Item -Path (Join-Path $archiveRoots[0].FullName "*") -Destination $toolkitDirectory -Recurse -Force
}

$nvccPath = Join-Path $toolkitDirectory "bin\nvcc.exe"
if (-not (Test-Path -LiteralPath $nvccPath)) {
    throw "Local CUDA extraction did not produce bin\nvcc.exe"
}

if (-not $NoUserEnvironment) {
    $binDirectory = Join-Path $toolkitDirectory "bin"
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $pathEntries = @($userPath -split ";" | Where-Object { $_ })
    if (-not ($pathEntries | Where-Object { $_.TrimEnd("\") -ieq $binDirectory.TrimEnd("\") })) {
        $pathEntries = @($binDirectory) + $pathEntries
    }
    [Environment]::SetEnvironmentVariable("CUDA_PATH", $toolkitDirectory, "User")
    [Environment]::SetEnvironmentVariable("CUDA_PATH_V$($ToolkitVersion.Replace('.', '_'))", $toolkitDirectory, "User")
    [Environment]::SetEnvironmentVariable("Path", ($pathEntries -join ";"), "User")
}

& $nvccPath --version
Write-Host "Local CUDA Toolkit is ready at $toolkitDirectory"
if (-not $NoUserEnvironment) {
    Write-Host "Open a new terminal to use nvcc from PATH."
}
