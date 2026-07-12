$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$corpusRoot = Join-Path $root ".benchmark-corpus"
$downloadRoot = Join-Path $corpusRoot "downloads"
$archivePath = Join-Path $downloadRoot "clic2020_professional_valid.zip"
$extractRoot = Join-Path $corpusRoot "clic2020-professional-valid"
$licensePath = Join-Path $corpusRoot "LICENSE_professional_2020.txt"

$archiveUrl = "https://storage.googleapis.com/clic_datasets/clic2020_professional_valid.zip"
$licenseUrl = "https://data.vision.ee.ethz.ch/cvl/clic/LICENSE_professional_2020.txt"
$archiveSha256 = "e56568e20ead6bd215b313fed260d1c98b9ba863540039f00892ab67b1e39baf"

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
Get-VerifiedFile -Url $archiveUrl -Path $archivePath -Sha256 $archiveSha256

if (-not (Test-Path -LiteralPath $extractRoot)) {
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
}

$imageCount = (Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter *.png).Count
if ($imageCount -lt 8) {
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
}

if (-not (Test-Path -LiteralPath $licensePath)) {
  Invoke-WebRequest -UseBasicParsing -Uri $licenseUrl -OutFile $licensePath
}

$imageCount = (Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter *.png).Count
if ($imageCount -lt 8) {
  throw "Expected at least 8 CLIC PNG images, found $imageCount."
}

Write-Host "CLIC 2020 Professional Validation is ready:"
Write-Host "  $extractRoot"
Write-Host "  $imageCount PNG images"
Write-Host "Dataset files remain local and are excluded from Git."
