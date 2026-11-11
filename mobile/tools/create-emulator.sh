#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
export JAVA_HOME="$root/data/mobile/toolchain/jdk"
export ANDROID_HOME="$root/data/mobile/toolchain/android-sdk"
export ANDROID_USER_HOME="$root/data/mobile/toolchain/android-user"
export ANDROID_AVD_HOME="$root/data/mobile/avd"
mkdir -p "$ANDROID_AVD_HOME"
if test -e "$ANDROID_AVD_HOME/fireflint-mobile.avd"; then
  echo 'Project AVD already exists; preserving its configuration and data.'
  exit 0
fi
printf 'no\n' | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
  --name fireflint-mobile --package 'system-images;android-30;default;x86_64' \
  --path "$ANDROID_AVD_HOME/fireflint-mobile.avd" --device pixel_4
python3 - "$ANDROID_AVD_HOME/fireflint-mobile.avd/config.ini" <<'PY'
from pathlib import Path
import re
import sys
p = Path(sys.argv[1])
p.write_text(re.sub(r'^disk.dataPartition.size=.*$', 'disk.dataPartition.size=2G', p.read_text(), flags=re.M))
PY
