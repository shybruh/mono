# Builds the Android app for arm64 phones and signs it: with the release key
# (~/.android/mono-release.jks, alias "mono") when present, otherwise with the
# local debug key.
#
#   scripts/android.ps1            build, sign -> src-tauri/gen/android/app/build/outputs/apk/mono-arm64.apk
#   scripts/android.ps1 -Install   also install it on the phone connected through adb

param([switch]$Install)

# No $ErrorActionPreference = "Stop": the build tools log to stderr, which
# Windows PowerShell would treat as failure. Exit codes are checked instead.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$ndk = Get-ChildItem "$env:ANDROID_HOME\ndk" -Directory | Sort-Object Name | Select-Object -Last 1
if (-not $ndk) { throw "No Android NDK in $env:ANDROID_HOME\ndk" }
$env:NDK_HOME = $ndk.FullName

pnpm tauri android build --target aarch64 --apk
if ($LASTEXITCODE -ne 0) { throw "Android build failed" }

$bt = Get-ChildItem "$env:ANDROID_HOME\build-tools" -Directory | Sort-Object Name | Select-Object -Last 1
$outDir = "src-tauri\gen\android\app\build\outputs\apk"
$unsigned = "$outDir\universal\release\app-universal-release-unsigned.apk"
$aligned = "$outDir\mono-arm64-aligned.apk"
$apk = "$outDir\mono-arm64.apk"

& "$($bt.FullName)\zipalign.exe" -f -p 4 $unsigned $aligned
# The release key if you have one (apksigner asks for its password), else the
# debug key. Android won't install one over the other: uninstall first.
$release = "$env:USERPROFILE\.android\mono-release.jks"
if (Test-Path $release) {
  & "$($bt.FullName)\apksigner.bat" sign --ks $release --ks-key-alias mono --out $apk $aligned
} else {
  & "$($bt.FullName)\apksigner.bat" sign --ks "$env:USERPROFILE\.android\debug.keystore" `
    --ks-pass pass:android --ks-key-alias androiddebugkey --key-pass pass:android --out $apk $aligned
}
if ($LASTEXITCODE -ne 0) { throw "Signing failed" }
Remove-Item $aligned

$mb = [math]::Round((Get-Item $apk).Length / 1MB, 1)
Write-Host "Signed $apk ($mb MB)"

if ($Install) {
  & "$env:ANDROID_HOME\platform-tools\adb.exe" install -r $apk
}
