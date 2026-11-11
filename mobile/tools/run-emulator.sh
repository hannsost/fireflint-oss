#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
export ANDROID_HOME="$root/data/mobile/toolchain/android-sdk"
export ANDROID_USER_HOME="$root/data/mobile/toolchain/android-user"
export ANDROID_EMULATOR_HOME="$ANDROID_USER_HOME"
export ANDROID_AVD_HOME="$root/data/mobile/avd"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
test -d "$ANDROID_AVD_HOME/fireflint-mobile.avd"
test -z "$(ss -H -ltn 'sport = :5554 or sport = :5555')" || { echo 'Emulator port occupied; refusing takeover' >&2; exit 1; }
exec "$ANDROID_HOME/emulator/emulator" -avd fireflint-mobile -port 5554 \
  -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader \
  -memory 2048 -partition-size 2048 -cores 2 -no-metrics
