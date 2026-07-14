<#
.SYNOPSIS
Downloads and extracts a minimal local CUDA developer toolchain for Windows.

.DESCRIPTION
Uses NVIDIA's redistributable manifest to download nvcc, CUDA CRT, CUDA
Runtime, CCCL, and NVVM. Every archive is checked against the SHA-256 value in
the manifest, then merged under tools/cuda/toolkit. No administrator rights or
system-wide CUDA installation are required.

.PARAMETER Release
NVIDIA redistributable manifest release. The default is 13.3.1.

.PARAMETER ToolkitVersion
Local directory and environment-variable version. The default is 13.3.

.PARAMETER NoUserEnvironment
Do not persist CUDA_PATH or add the local CUDA bin directory to the user PATH.

.EXAMPLE
.\tools\setup-local-cuda.ps1

.EXAMPLE
.\tools\setup-local-cuda.ps1 -NoUserEnvironment
#>
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

    if ($null -eq ("CudaEnvironmentBroadcast" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class CudaEnvironmentBroadcast {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr window,
        uint message,
        UIntPtr parameter,
        string value,
        uint flags,
        uint timeout,
        out UIntPtr result);
}
"@
    }
    $broadcastResult = [UIntPtr]::Zero
    [void][CudaEnvironmentBroadcast]::SendMessageTimeout(
        [IntPtr]0xffff,
        0x001A,
        [UIntPtr]::Zero,
        "Environment",
        2,
        5000,
        [ref]$broadcastResult
    )
}

& $nvccPath --version
Write-Host "Local CUDA Toolkit is ready at $toolkitDirectory"
if (-not $NoUserEnvironment) {
    Write-Host "Open a new terminal to use nvcc from PATH."
}
