[CmdletBinding()]
param(
  [string]$OutputDirectory,
  [string]$Architecture = "native"
)

$ErrorActionPreference = "Stop"
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = (Resolve-Path (Join-Path $scriptDirectory "..\..")).Path

if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $repositoryRoot ".tmp\dctcuda-build"
}

$nvccCommand = Get-Command nvcc.exe -ErrorAction SilentlyContinue
if (-not $nvccCommand) {
  $localNvcc = Get-ChildItem `
    -LiteralPath (Join-Path $repositoryRoot "tools\cuda\toolkit") `
    -Filter nvcc.exe `
    -File `
    -Recurse `
    -ErrorAction SilentlyContinue |
    Select-Object -First 1

  if ($localNvcc) {
    $nvccPath = $localNvcc.FullName
  } else {
    throw "nvcc.exe was not found. Run .\setup.ps1 or add CUDA to PATH."
  }
} else {
  $nvccPath = $nvccCommand.Source
}

$vsDevCmd = $null
if ($env:VSINSTALLDIR) {
  $candidate = Join-Path $env:VSINSTALLDIR "Common7\Tools\VsDevCmd.bat"
  if (Test-Path -LiteralPath $candidate) {
    $vsDevCmd = $candidate
  }
}

if (-not $vsDevCmd) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($installation) {
      $candidate = Join-Path $installation "Common7\Tools\VsDevCmd.bat"
      if (Test-Path -LiteralPath $candidate) {
        $vsDevCmd = $candidate
      }
    }
  }
}

if (-not $vsDevCmd) {
  throw "Visual Studio C++ developer environment was not found."
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outputPath = Join-Path (Resolve-Path $OutputDirectory).Path "dctcuda.exe"
$sourcePath = Join-Path $scriptDirectory "dctcuda.cu"
$includePath = Join-Path $repositoryRoot "native\bpal5_simd\third_party\stb"
$arguments = @(
  "-std=c++17",
  "-O3",
  "-arch=$Architecture",
  "-I", "`"$includePath`"",
  "`"$sourcePath`"",
  "-o", "`"$outputPath`""
) -join " "
$command = "call `"$vsDevCmd`" -arch=x64 -host_arch=x64 && `"$nvccPath`" $arguments"

& $env:ComSpec /d /s /c $command
if ($LASTEXITCODE -ne 0) {
  throw "nvcc failed with exit code $LASTEXITCODE."
}

Write-Host "Built $outputPath"
