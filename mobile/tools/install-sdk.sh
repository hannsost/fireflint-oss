#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
export JAVA_HOME="$root/data/mobile/toolchain/jdk"
export ANDROID_HOME="$root/data/mobile/toolchain/android-sdk"
export ANDROID_USER_HOME="$root/data/mobile/toolchain/android-user"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:/usr/bin:/bin"
mkdir -p "$ANDROID_USER_HOME"
# Current command tools delegate sdkmanager to this CLI. Explicit project paths,
# no metrics, no cloud build or account access. SDK installation accepts its license.
android --no-metrics --sdk="$ANDROID_HOME" sdk install 'platform-tools' 'platforms/android-36' 'build-tools/36.0.0' 'ndk/27.1.12297006' 'cmake/3.22.1' 'emulator' 'system-images/android-30/default/x86_64'
