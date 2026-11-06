# Builds the signed Android app into release/<version>/ at the project root:
#
#     powershell -ExecutionPolicy Bypass -File android\build-apk.ps1
#
# Copies what the app ships from main-site/, then Flutter and Gradle build the release APK, signed with
# android.keystore using the passwords in keystore.properties, and its signature is checked against
# main-site/.well-known/assetlinks.json before it's copied out as uwumaps-<version>.apk.
#
# On the first run only, with no keystore and assetlinks.json still naming the UwU Apps template's key, it
# makes the key and writes its fingerprint into assetlinks.json. After that, a missing keystore stops it:
# it never makes a second key, as a different key can't update installed apps.
#
# Needs Flutter, a JDK 21 or later and the Android SDK. It finds them in FLUTTER_ROOT or on the PATH or in
# ~\flutter, in JAVA_HOME or under Program Files, and in ANDROID_HOME or %LOCALAPPDATA%\Android\Sdk.

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path $here -Parent
$assetlinks = "$root\main-site\.well-known\assetlinks.json"
$templateKey = 'E4:EB:13:B6'

function Find-Jdk {
    if ($env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME\bin\java.exe")) {
        # Windows PowerShell turns anything a program writes to stderr into an error, and java -version
        # writes there, so it's only looked at, under Continue.
        $ErrorActionPreference = 'Continue'
        $v = & "$env:JAVA_HOME\bin\java.exe" -version 2>&1 | Out-String
        $ErrorActionPreference = 'Stop'
        if ($v -match 'version "(\d+)' -and [int]$Matches[1] -ge 21) { return $env:JAVA_HOME }
    }
    $candidates = @('C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Java', 'C:\Program Files\Microsoft') |
        Where-Object { Test-Path $_ } |
        ForEach-Object { Get-ChildItem $_ -Directory -Filter 'jdk*' } |
        Where-Object { $_.Name -match 'jdk-?(\d+)' -and [int]$Matches[1] -ge 21 -and (Test-Path "$($_.FullName)\bin\java.exe") } |
        Sort-Object { [int]([regex]::Match($_.Name, 'jdk-?(\d+)').Groups[1].Value) }
    if ($candidates) { return ($candidates | Select-Object -Last 1).FullName }
    throw 'No JDK 21 or later found. Install one (https://adoptium.net) or set JAVA_HOME to it.'
}

function Find-Flutter {
    if ($env:FLUTTER_ROOT -and (Test-Path "$env:FLUTTER_ROOT\bin\flutter.bat")) { return "$env:FLUTTER_ROOT\bin\flutter.bat" }
    $onPath = Get-Command flutter.bat -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    if (Test-Path "$env:USERPROFILE\flutter\bin\flutter.bat") { return "$env:USERPROFILE\flutter\bin\flutter.bat" }
    throw 'Flutter not found. Install it (https://docs.flutter.dev/install) or set FLUTTER_ROOT to it.'
}

# A native tool writing to stderr becomes a PowerShell error, so its exit code alone is judged.
function Invoke-Tool($exe, [string[]]$arguments) {
    $ErrorActionPreference = 'Continue'
    & $exe @arguments
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) { throw "$exe $($arguments -join ' ') failed (exit $code). Its messages are above." }
}

$env:JAVA_HOME = Find-Jdk
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
if (-not $env:ANDROID_HOME) {
    if (Test-Path "$env:LOCALAPPDATA\Android\Sdk") { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
    else { throw 'No Android SDK found. Set ANDROID_HOME to it.' }
}
$flutter = Find-Flutter
$buildTools = Get-ChildItem "$env:ANDROID_HOME\build-tools" -Directory | Sort-Object { [version]$_.Name } | Select-Object -Last 1

$linksText = Get-Content $assetlinks -Raw
$hasKey = (Test-Path "$here\android.keystore") -and (Test-Path "$here\keystore.properties")
if (-not $hasKey) {
    if ($linksText -notmatch $templateKey) {
        throw "android.keystore and keystore.properties are missing from $here, and assetlinks.json names a key already. Restore them from your backup: a new key can't update installed apps."
    }
    Write-Host 'First build: making the signing key. Back up android\android.keystore and android\keystore.properties.'
    $chars = [char[]]'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $password = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
    Invoke-Tool "$env:JAVA_HOME\bin\keytool.exe" @('-genkeypair', '-noprompt', '-keystore', "$here\android.keystore", '-storetype', 'PKCS12', '-storepass', $password, '-keypass', $password, '-alias', 'uwumaps', '-keyalg', 'RSA', '-keysize', '4096', '-validity', '36500', '-dname', 'CN=uwuMaps, O=UwU Apps, C=SG')
    Set-Content "$here\keystore.properties" -Encoding ASCII -Value @("storeFile=android.keystore", "storePassword=$password", "keyAlias=uwumaps", "keyPassword=$password")
    $ErrorActionPreference = 'Continue'
    $listing = & "$env:JAVA_HOME\bin\keytool.exe" -list -v -keystore "$here\android.keystore" -storepass $password -alias uwumaps 2>&1 | Out-String
    $ErrorActionPreference = 'Stop'
    if ($listing -notmatch 'SHA256:\s*([0-9A-F:]{95})') { throw "Couldn't read the new key's fingerprint." }
    $fingerprint = $Matches[1]
    $linksText = $linksText -replace '"sha256_cert_fingerprints":\s*\["[^"]*"\]', "`"sha256_cert_fingerprints`": [`"$fingerprint`"]"
    Set-Content $assetlinks -Encoding ASCII -Value $linksText.TrimEnd()
    Write-Host "Wrote the key's fingerprint into main-site\.well-known\assetlinks.json: deploy the site for links to open in the app."
}

$pubspec = Get-Content "$here\pubspec.yaml" -Raw
$version = [regex]::Match($pubspec, '(?m)^version:\s*([\d.]+)\+\d+').Groups[1].Value
if (-not $version) { throw "No version in pubspec.yaml." }
Write-Host "Building uwuMaps $version for Android (JDK: $env:JAVA_HOME)..."

Push-Location $here
try {
    Invoke-Tool 'node' @('tool\sync-assets.mjs')
    Invoke-Tool $flutter @('pub', 'get')
    Invoke-Tool $flutter @('build', 'apk', '--release', '--target-platform', 'android-arm,android-arm64,android-x64')
} finally {
    Pop-Location
}

$signed = "$here\build\app\outputs\flutter-apk\app-release.apk"
if (-not (Test-Path $signed)) { throw 'Flutter made no APK.' }

# Its warnings come with every Android build and mean nothing here; only a failure matters.
$ErrorActionPreference = 'Continue'
$check = & "$($buildTools.FullName)\apksigner.bat" verify --print-certs $signed 2>&1
$verified = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
if (-not $verified) { $check | Write-Host; throw 'The signed app failed its signature check.' }
$text = $check | Out-String
if ($text -notmatch 'SHA-256 digest: ([0-9a-f]{64})') { throw "Couldn't read the APK's signature." }
$got = $Matches[1].ToUpper()
$want = ([regex]::Match((Get-Content $assetlinks -Raw), '"sha256_cert_fingerprints":\s*\["([^"]+)"\]').Groups[1].Value) -replace ':', ''
if ($got -ne $want) { throw "The APK is signed with a different key ($got) than assetlinks.json names ($want), so it can't update the app already installed." }

New-Item -ItemType Directory -Force "$root\release\$version" | Out-Null
$dest = "$root\release\$version\uwumaps-$version.apk"
if (Test-Path $dest) { Write-Warning "Replacing the APK already there for $version." }
Copy-Item $signed $dest -Force
$mb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
Write-Host "Done: $dest ($mb MB)"
