param(
  [ValidateSet('Run','Build','Repair')]
  [string]$Mode = 'Run'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Version = '0.3.0'
$ElectronVersion = '43.4.1'
$ElectronArchiveName = "electron-v$ElectronVersion-win32-x64.zip"
$ElectronReleaseBase = "https://github.com/electron/electron/releases/download/v$ElectronVersion"
$SharedCacheRoot = Join-Path $env:LOCALAPPDATA 'NoorAIStudio\RuntimeCache'
$ElectronRoot = Join-Path $SharedCacheRoot "electron-v$ElectronVersion-win32-x64"
$ElectronExe = Join-Path $ElectronRoot 'electron.exe'
$Archive = Join-Path $SharedCacheRoot $ElectronArchiveName
$Checksums = Join-Path $SharedCacheRoot "electron-v$ElectronVersion-SHASUMS256.txt"
$LogDir = Join-Path $Root 'logs'
$LogName = 'launcher-{0}-{1}.log' -f $Mode.ToLowerInvariant(), (Get-Date -Format 'yyyyMMdd-HHmmss')
$LogFile = Join-Path $LogDir $LogName
$Failure = $null

New-Item -ItemType Directory -Force -Path $SharedCacheRoot, $LogDir | Out-Null
Start-Transcript -Path $LogFile -Force | Out-Null

function Banner([string]$Text) {
  Write-Host "`n============================================================" -ForegroundColor DarkCyan
  Write-Host " $Text" -ForegroundColor Cyan
  Write-Host "============================================================" -ForegroundColor DarkCyan
}

function Get-Sha256([string]$File) {
  # Get-FileHash -Algorithm SHA256 equivalent without depending on module auto-loading.
  $Stream = [IO.File]::OpenRead($File)
  try {
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $Hasher.Dispose()
    }
  } finally {
    $Stream.Dispose()
  }
}

function Invoke-Retry {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Operation,
    [string]$Label = 'operation',
    [int]$Attempts = 3
  )

  $LastError = $null
  for ($Attempt = 1; $Attempt -le $Attempts; $Attempt++) {
    try {
      & $Operation
      return
    } catch {
      $LastError = $_
      Write-Host "$Label failed (attempt $Attempt of $Attempts): $($_.Exception.Message)" -ForegroundColor Yellow
      if ($Attempt -lt $Attempts) { Start-Sleep -Seconds (2 * $Attempt) }
    }
  }
  throw $LastError
}

function Download-OfficialFile([string]$Url, [string]$Destination) {
  $Temp = "$Destination.partial"
  Remove-Item -Force $Temp -ErrorAction SilentlyContinue

  try {
    if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
      Start-BitsTransfer -Source $Url -Destination $Temp -DisplayName 'Noor AI Studio runtime download' -Description $Url
    } else {
      Invoke-WebRequest -Uri $Url -OutFile $Temp -UseBasicParsing
    }
  } catch {
    Remove-Item -Force $Temp -ErrorAction SilentlyContinue
    throw
  }

  if (-not (Test-Path -LiteralPath $Temp)) { throw "Download produced no file: $Url" }
  if ((Get-Item -LiteralPath $Temp).Length -lt 1024) {
    Remove-Item -Force $Temp -ErrorAction SilentlyContinue
    throw "Downloaded file was unexpectedly small: $Url"
  }
  Move-Item -Force -LiteralPath $Temp -Destination $Destination
}

function Test-ElectronRuntime {
  if (-not (Test-Path -LiteralPath $ElectronExe)) { return $false }
  try {
    & $ElectronExe --version | Out-Host
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Ensure-ElectronRuntime {
  if (Test-ElectronRuntime) {
    Write-Host "Electron runtime v$ElectronVersion is ready in the shared cache." -ForegroundColor Green
    return
  }

  Banner 'Downloading the official Electron Windows runtime'
  Write-Host "Version: v$ElectronVersion"
  Write-Host 'Source:  github.com/electron/electron'
  Write-Host 'The runtime is cached under Local AppData and reused by future app versions.'

  Remove-Item -Recurse -Force $ElectronRoot -ErrorAction SilentlyContinue

  Invoke-Retry -Label 'Electron runtime download' -Attempts 3 -Operation {
    Download-OfficialFile "$ElectronReleaseBase/SHASUMS256.txt" $Checksums
    Download-OfficialFile "$ElectronReleaseBase/$ElectronArchiveName" $Archive
  }

  $ChecksumLine = Select-String -LiteralPath $Checksums -Pattern ([regex]::Escape($ElectronArchiveName)) | Select-Object -First 1
  if (-not $ChecksumLine) { throw 'The official Electron checksum list did not contain the requested Windows archive.' }
  $Expected = ($ChecksumLine.Line -split '\s+')[0].ToLowerInvariant()
  $Actual = Get-Sha256 $Archive
  if ($Expected -ne $Actual) {
    Remove-Item -Force $Archive -ErrorAction SilentlyContinue
    throw "Electron checksum verification failed. Expected $Expected but received $Actual."
  }

  $Extract = Join-Path $SharedCacheRoot "extract-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force -Path $Extract | Out-Null
  try {
    Expand-Archive -LiteralPath $Archive -DestinationPath $Extract -Force
    if (-not (Test-Path -LiteralPath (Join-Path $Extract 'electron.exe'))) {
      throw 'The verified Electron archive did not contain electron.exe.'
    }
    Move-Item -LiteralPath $Extract -Destination $ElectronRoot
  } catch {
    Remove-Item -Recurse -Force $Extract -ErrorAction SilentlyContinue
    throw
  }

  if (-not (Test-ElectronRuntime)) { throw 'Electron was extracted but could not be started.' }
  Write-Host 'Electron runtime downloaded, checksum-verified, and started successfully.' -ForegroundColor Green
}

function Invoke-Tests {
  Banner 'Running source tests with Electron bundled Node.js'
  $OldRunAsNode = $env:ELECTRON_RUN_AS_NODE
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $ElectronExe (Join-Path $Root 'tests\run-tests.cjs')
    if ($LASTEXITCODE -ne 0) { throw "Tests failed with exit code $LASTEXITCODE." }
  } finally {
    if ($null -eq $OldRunAsNode) {
      Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    } else {
      $env:ELECTRON_RUN_AS_NODE = $OldRunAsNode
    }
  }
}

function Copy-AppPayload([string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  foreach ($Directory in @('src','renderer','assets')) {
    Copy-Item -Recurse -Force -LiteralPath (Join-Path $Root $Directory) -Destination (Join-Path $Destination $Directory)
  }
  foreach ($File in @('package.json','THIRD_PARTY_NOTICES.md','RELEASE_NOTES.md')) {
    Copy-Item -Force -LiteralPath (Join-Path $Root $File) -Destination (Join-Path $Destination $File)
  }
}

function Write-PortableInstaller([string]$PortableRoot) {
  $InstallPs1 = @'
param()
$ErrorActionPreference = 'Stop'
$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = Join-Path $env:LOCALAPPDATA 'Programs\Noor AI Studio'
$Exe = Join-Path $Target 'Noor AI Studio.exe'
Write-Host 'Installing Noor AI Studio for the current Windows user...'
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Get-ChildItem -LiteralPath $Target -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force -Path (Join-Path $Source '*') -Destination $Target
$Shell = New-Object -ComObject WScript.Shell
$DesktopShortcut = $Shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Noor AI Studio.lnk'))
$DesktopShortcut.TargetPath = $Exe
$DesktopShortcut.WorkingDirectory = $Target
$DesktopShortcut.IconLocation = "$Exe,0"
$DesktopShortcut.Save()
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$StartShortcut = $Shell.CreateShortcut((Join-Path $StartMenu 'Noor AI Studio.lnk'))
$StartShortcut.TargetPath = $Exe
$StartShortcut.WorkingDirectory = $Target
$StartShortcut.IconLocation = "$Exe,0"
$StartShortcut.Save()
Write-Host "Installed to: $Target" -ForegroundColor Green
Start-Process -FilePath $Exe
Read-Host 'Press Enter to close this installer'
'@
  Set-Content -LiteralPath (Join-Path $PortableRoot 'install-local.ps1') -Value $InstallPs1 -Encoding UTF8

  $InstallCmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-local.ps1"
exit /b %ERRORLEVEL%
'@
  Set-Content -LiteralPath (Join-Path $PortableRoot 'INSTALL_NOOR_AI_STUDIO.cmd') -Value $InstallCmd -Encoding ASCII
}

function Build-PortableApp {
  Banner 'Building the portable Windows application'
  $Dist = Join-Path $Root 'dist'
  $PortableName = "Noor-AI-Studio-v$Version-portable"
  $Portable = Join-Path $Dist $PortableName
  $PortableZip = Join-Path $Dist "$PortableName.zip"

  New-Item -ItemType Directory -Force -Path $Dist | Out-Null
  Remove-Item -Recurse -Force $Portable -ErrorAction SilentlyContinue
  Remove-Item -Force $PortableZip -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $Portable | Out-Null

  Copy-Item -Recurse -Force -Path (Join-Path $ElectronRoot '*') -Destination $Portable
  Remove-Item -Force (Join-Path $Portable 'resources\default_app.asar') -ErrorAction SilentlyContinue
  Rename-Item -LiteralPath (Join-Path $Portable 'electron.exe') -NewName 'Noor AI Studio.exe'

  $AppPayload = Join-Path $Portable 'resources\app'
  Copy-AppPayload $AppPayload
  Write-PortableInstaller $Portable

  Set-Content -LiteralPath (Join-Path $Portable 'VERSION.txt') -Encoding UTF8 -Value @(
    "Noor AI Studio v$Version",
    "Electron v$ElectronVersion",
    'Portable local build; executable is unsigned.'
  )

  Write-Host 'Compressing the portable application. This can take several minutes...'
  Compress-Archive -LiteralPath $Portable -DestinationPath $PortableZip -CompressionLevel Optimal -Force
  $Hash = Get-Sha256 $PortableZip
  Set-Content -LiteralPath "$PortableZip.sha256.txt" -Encoding ASCII -Value "$Hash  $([IO.Path]::GetFileName($PortableZip))"

  Write-Host "Portable application folder: $Portable" -ForegroundColor Green
  Write-Host "Portable ZIP:                $PortableZip" -ForegroundColor Green
  Write-Host 'Run INSTALL_NOOR_AI_STUDIO.cmd inside the portable folder for a user-scoped Start Menu/Desktop installation.' -ForegroundColor Cyan
  Start-Process explorer.exe $Dist
}

try {
  Banner "Noor AI Studio - npm-free setup ($Mode mode)"
  Write-Host "App folder: $Root"
  Write-Host "Log file:   $LogFile"

  if ($Mode -eq 'Repair') {
    Banner 'Repairing the shared Electron runtime cache'
    Remove-Item -Recurse -Force $ElectronRoot -ErrorAction SilentlyContinue
    Remove-Item -Force $Archive, $Checksums -ErrorAction SilentlyContinue
  }

  Ensure-ElectronRuntime

  if ($Mode -eq 'Build') {
    Invoke-Tests
    Build-PortableApp
  } else {
    Banner 'Launching Noor AI Studio'
    Write-Host 'No npm installation or node_modules directory is required.'
    & $ElectronExe $Root
    if ($LASTEXITCODE -ne 0) { throw "Noor AI Studio exited with code $LASTEXITCODE." }
  }
} catch {
  $Failure = $_
  Write-Host "`nNOOR AI STUDIO COULD NOT CONTINUE" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host "`nThe full error has been saved to:" -ForegroundColor Yellow
  Write-Host $LogFile -ForegroundColor White
} finally {
  try { Stop-Transcript | Out-Null } catch {}
}

if ($Failure) {
  if (Test-Path -LiteralPath $LogFile) {
    try {
      $Notepad = Join-Path $env:SystemRoot 'System32\notepad.exe'
      Start-Process -FilePath $Notepad -ArgumentList @("`"$LogFile`"")
    } catch {
      Write-Host "Notepad could not be opened automatically: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
  Write-Host "`nKeep this window open and send the log file if repair still fails." -ForegroundColor Yellow
  [void](Read-Host 'Press Enter to close')
  exit 1
}

exit 0
