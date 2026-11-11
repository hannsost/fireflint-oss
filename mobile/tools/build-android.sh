#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p "$root/data/mobile/logs"
trap 'code=$?; printf "%s\n" "$code" > "$root/data/mobile/logs/android-build.exit"' EXIT
export JAVA_HOME="$root/data/mobile/toolchain/jdk"
export ANDROID_HOME="$root/data/mobile/toolchain/android-sdk"
export ANDROID_USER_HOME="$root/data/mobile/toolchain/android-user"
export GRADLE_USER_HOME="$root/data/mobile/gradle"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
export EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1 CI=1
export FIREFLINT_MOBILE_VARIANT=development
cd "$root/mobile"
npx expo prebuild --platform android --no-install
# Generated public development signing is deliberately absent from source control.
# Preserve an existing key so repeated installs retain the same app identity.
if ! test -f android/app/debug.keystore; then
  "$JAVA_HOME/bin/keytool" -genkeypair -noprompt -storetype JKS \
    -keystore android/app/debug.keystore -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname 'CN=Android Debug,O=Android,C=US'
fi
cd android
# Development applicationId and public Android debug signing only. No store signing.
./gradlew :app:assembleRelease --no-daemon --max-workers=2 -PreactNativeArchitectures="${FIREFLINT_ANDROID_ARCHS:-arm64-v8a,x86_64}" -Dorg.gradle.parallel=false
mkdir -p "$root/data/mobile/artifacts"
cp app/build/outputs/apk/release/app-release.apk "$root/data/mobile/artifacts/fireflint-development.apk"
sha256sum "$root/data/mobile/artifacts/fireflint-development.apk"
