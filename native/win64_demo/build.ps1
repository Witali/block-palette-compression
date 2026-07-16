param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$ProjectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildDirectory = Join-Path $ProjectDirectory "build-x64"
$VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$VisualStudio = if (Test-Path -LiteralPath $VsWhere) {
    & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if (-not $VisualStudio) {
    throw "Visual Studio with the C++ desktop workload was not found."
}

$VcVars = Join-Path $VisualStudio "VC\Auxiliary\Build\vcvars64.bat"
$BundledCMake = Join-Path $VisualStudio "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
$BundledNinja = Join-Path $VisualStudio "Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
$CMakeCommand = Get-Command cmake.exe -ErrorAction SilentlyContinue
$CMake = if ($CMakeCommand) { $CMakeCommand.Source } else { $BundledCMake }
if (-not (Test-Path -LiteralPath $CMake) -or -not (Test-Path -LiteralPath $BundledNinja)) {
    throw "CMake and Ninja were not found. Install the C++ desktop workload for Visual Studio."
}

if ($Clean -and (Test-Path -LiteralPath $BuildDirectory)) {
    $ResolvedProject = [IO.Path]::GetFullPath($ProjectDirectory).TrimEnd('\') + '\'
    $ResolvedBuild = [IO.Path]::GetFullPath($BuildDirectory)
    if (-not $ResolvedBuild.StartsWith($ResolvedProject, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a build directory outside the demo project."
    }
    Remove-Item -LiteralPath $BuildDirectory -Recurse -Force
}

$EnvironmentLines = & $env:ComSpec /d /c "call `"$VcVars`" >nul && set"
$DeveloperPath = $null
foreach ($Line in $EnvironmentLines) {
    $Separator = $Line.IndexOf('=')
    if ($Separator -gt 0) {
        $Name = $Line.Substring(0, $Separator)
        $Value = $Line.Substring($Separator + 1)
        if ($Name.Equals("PATH", [StringComparison]::Ordinal)) {
            $DeveloperPath = $Value
        } elseif (-not $Name.Equals("Path", [StringComparison]::OrdinalIgnoreCase)) {
            Set-Item -Path ("Env:" + $Name) -Value $Value
        }
    }
}
if (-not $DeveloperPath) {
    throw "The Visual Studio developer environment did not provide PATH."
}
$env:Path = $DeveloperPath
$Compiler = (Get-Command cl.exe -ErrorAction Stop).Source

& $CMake -S $ProjectDirectory -B $BuildDirectory -G Ninja `
    "-DCMAKE_MAKE_PROGRAM=$BundledNinja" "-DCMAKE_BUILD_TYPE=$Configuration" `
    "-DCMAKE_C_COMPILER=$Compiler" "-DCMAKE_CXX_COMPILER=$Compiler" -DBUILD_TESTING=ON
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $CMake --build $BuildDirectory --parallel
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $CMake --build $BuildDirectory --target test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$Executable = Join-Path $BuildDirectory "block_texture_demo.exe"
Write-Host "Built and tested: $Executable"
