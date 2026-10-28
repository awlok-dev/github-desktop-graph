$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'app/package.json') -Raw | ConvertFrom-Json).version
$appRoot = Join-Path $projectRoot 'dist/GitHubDesktopGraph-win32-x64'
$distRoot = Join-Path $projectRoot 'dist'
$archiveName = "GitHubDesktopGraph-Portable-Windows-x64-$version.zip"
$archivePath = Join-Path $distRoot $archiveName

foreach ($relativePath in @('GitHubDesktopGraph.exe', 'resources/app/portable-main.js', 'resources/app/git/cmd/git.exe', 'resources/app/git/ucrt64/libexec/git-core/git-lfs.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $appRoot $relativePath) -PathType Leaf)) {
    throw "Missing portable dependency: $relativePath. Run yarn build:portable first."
  }
}
# User data must never become part of a public release.
if (Test-Path -LiteralPath (Join-Path $appRoot 'Data')) {
  throw 'The build contains a Data folder. Rebuild before packaging; do not package user settings.'
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'docs/portable.md') -Destination (Join-Path $appRoot 'READ-ME.md')
Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination (Join-Path $appRoot 'LICENSE-GITHUB-DESKTOP.txt')
@{
  name = 'GitHub Desktop Graph Portable'
  version = $version
  target = 'win32-x64'
  commit = (git -C $projectRoot rev-parse HEAD)
  electron = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).devDependencies.electron
  dataDirectory = 'Data'
  automaticUpdates = $false
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appRoot 'build-info.json') -Encoding UTF8

Compress-Archive -LiteralPath $appRoot -DestinationPath $archivePath -CompressionLevel Optimal -Force
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $archiveName" | Set-Content -LiteralPath "$archivePath.sha256" -Encoding ASCII
Write-Output $archivePath
