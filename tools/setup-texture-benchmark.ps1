$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $root ".benchmark-tools"
$downloadRoot = Join-Path $toolRoot "downloads"
$astcArchive = Join-Path $downloadRoot "astcenc-5.6.0-windows-x64.zip"
$astcRoot = Join-Path $toolRoot "astcenc-5.6.0"
$texconvPath = Join-Path $toolRoot "texconv.exe"

$astcUrl = "https://github.com/ARM-software/astc-encoder/releases/download/5.6.0/astcenc-5.6.0-windows-x64.zip"
$astcSha256 = "25871b3f798005b11cfb2b369ee7911043d4d5e7bcde5b10cb8b51f81bf4a95d"
$texconvUrl = "https://github.com/microsoft/DirectXTex/releases/download/may2026/texconv.exe"
$texconvSha256 = "dcfdec10244e02cf5037fba089c55fb7e1326b1c8181742d77d15fa5cb5eef06"

function Get-VerifiedFile {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Sha256
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path
  }

  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()

  if ($actual -ne $Sha256) {
    throw "SHA-256 mismatch for $Path. Expected $Sha256, got $actual."
  }
}

New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null

Get-VerifiedFile -Url $astcUrl -Path $astcArchive -Sha256 $astcSha256
Get-VerifiedFile -Url $texconvUrl -Path $texconvPath -Sha256 $texconvSha256

if (-not (Test-Path -LiteralPath (Join-Path $astcRoot "bin\astcenc-avx2.exe"))) {
  Expand-Archive -LiteralPath $astcArchive -DestinationPath $astcRoot -Force
}

Write-Host "Texture benchmark tools are ready:"
Write-Host "  $texconvPath"
Write-Host "  $(Join-Path $astcRoot 'bin\astcenc-avx2.exe')"
