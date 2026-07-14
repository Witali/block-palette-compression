$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root "benchmark\texture-datasets.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$downloadRoot = Join-Path $root $manifest.downloadRoot

function Get-VerifiedArchive {
  param(
    [Parameter(Mandatory = $true)]$Archive
  )

  $path = Join-Path $downloadRoot $Archive.file

  if (-not (Test-Path -LiteralPath $path)) {
    Write-Host "Downloading $($Archive.file)"
    Invoke-WebRequest -UseBasicParsing -Uri $Archive.url -OutFile $path
  } else {
    Write-Host "Using existing $($Archive.file)"
  }

  $file = Get-Item -LiteralPath $path
  if ($file.Length -ne [long]$Archive.sizeBytes) {
    throw "Size mismatch for $path. Expected $($Archive.sizeBytes), got $($file.Length)."
  }

  $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Archive.sha256) {
    throw "SHA-256 mismatch for $path. Expected $($Archive.sha256), got $actual."
  }

  return $path
}

function Get-ExtractedImageCount {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Pattern
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    return 0
  }

  return (Get-ChildItem -LiteralPath $Path -Recurse -File -Filter $Pattern).Count
}

function Expand-VerifiedArchive {
  param(
    [Parameter(Mandatory = $true)]$Archive,
    [Parameter(Mandatory = $true)][string]$ArchivePath
  )

  $target = Join-Path $root $Archive.extractTo
  $expectedCount = [int]$Archive.expected.count
  $pattern = [string]$Archive.expected.pattern
  $currentCount = Get-ExtractedImageCount -Path $target -Pattern $pattern

  if ($currentCount -eq $expectedCount) {
    Write-Host "Ready: $($Archive.extractTo) ($currentCount images)"
    return
  }

  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Write-Host "Extracting $($Archive.file)"

  switch ($Archive.format) {
    "zip" {
      Expand-Archive -LiteralPath $ArchivePath -DestinationPath $target -Force
    }
    "tar.gz" {
      $tar = Get-Command tar.exe -ErrorAction Stop
      & $tar.Source -xf $ArchivePath -C $target
      if ($LASTEXITCODE -ne 0) {
        throw "tar.exe failed for $ArchivePath with exit code $LASTEXITCODE."
      }
    }
    default {
      throw "Unsupported archive format: $($Archive.format)"
    }
  }

  $actualCount = Get-ExtractedImageCount -Path $target -Pattern $pattern
  if ($actualCount -ne $expectedCount) {
    throw "Image count mismatch under $target. Expected $expectedCount $pattern files, got $actualCount."
  }

  Write-Host "Ready: $($Archive.extractTo) ($actualCount images)"
}

New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null

$archiveCount = 0
$imageCount = 0
$archiveBytes = [long]0

foreach ($dataset in $manifest.datasets) {
  Write-Host "Dataset: $($dataset.name)"

  foreach ($archive in $dataset.archives) {
    $archivePath = Get-VerifiedArchive -Archive $archive
    Expand-VerifiedArchive -Archive $archive -ArchivePath $archivePath
    $archiveCount++
    $imageCount += [int]$archive.expected.count
    $archiveBytes += [long]$archive.sizeBytes
  }
}

Write-Host "Texture datasets are ready:"
Write-Host "  $archiveCount verified archives"
Write-Host "  $imageCount source images and maps"
Write-Host "  $([math]::Round($archiveBytes / 1GB, 2)) GiB downloaded"
Write-Host "  $root\.benchmark-corpus"
Write-Host "Dataset files remain local and are excluded from Git."
