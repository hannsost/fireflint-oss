#!/usr/bin/env python3
"""Inspect our built development APK; never inspect signing-key/secret files."""
from pathlib import Path
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import zipfile

root = Path(__file__).resolve().parents[2]
apk = root / 'data/mobile/artifacts/fireflint-development.apk'
sdk = root / 'data/mobile/toolchain/android-sdk/build-tools/36.0.0'
env = {**os.environ, 'JAVA_HOME': str(root / 'data/mobile/toolchain/jdk')}
env['PATH'] = env['JAVA_HOME'] + '/bin:' + env['PATH']
badging = subprocess.check_output([str(sdk / 'aapt2'), 'dump', 'badging', str(apk)], text=True, env=env)
assert "package: name='de.fireflint.mobile.dev'" in badging
assert "application-label:'FireFlint Dev'" in badging
assert "minSdkVersion:'24'" in badging and "targetSdkVersion:'36'" in badging
assert 'application-debuggable' not in badging, 'Embedded development artifact must run without a debugger/Metro'
permissions = sorted(re.findall(r"uses-permission: name='([^']+)'", badging))
assert not set(permissions).intersection({
    'android.permission.CAMERA', 'android.permission.RECORD_AUDIO',
    'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
}), 'Unexpected sensitive permission in the installed app scope'
certificate = subprocess.check_output([str(sdk / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk)], text=True, env=env)
assert 'CN=Android Debug' in certificate, 'Expected public development signing, not an assumed production key'
with zipfile.ZipFile(apk) as archive:
    names = archive.namelist()
    assert 'assets/index.android.bundle' in names
    abis = sorted({name.split('/')[1] for name in names if name.startswith('lib/') and name.endswith('.so')})
    assert 'x86_64' in abis
    bundle = archive.read('assets/index.android.bundle')
    for forbidden in [b'Mobile-Fixture-Only-2026!', b'fireflint-mobile-isolated-public-test-jwt',
                      b'development-only-connector-key', b'-----BEGIN PRIVATE KEY-----', b'-----BEGIN RSA PRIVATE KEY-----']:
        assert forbidden not in bundle, 'Unexpected fixture credential or private-key marker in native bundle'
report = {
    'checked_at': dt.datetime.now(dt.timezone.utc).isoformat(),
    'apk': str(apk.relative_to(root)), 'bytes': apk.stat().st_size,
    'sha256': hashlib.file_digest(apk.open('rb'), 'sha256').hexdigest(),
    'application_id': 'de.fireflint.mobile.dev', 'label': 'FireFlint Dev',
    'min_sdk': 24, 'target_sdk': 36, 'abis': abis,
    'permissions': permissions,
    'embedded_javascript': True, 'debuggable': False, 'signature_verified': True,
    'signing': 'Public Android development certificate; not a production release',
    'certificate_sha256': re.search(r'certificate SHA-256 digest: (\S+)', certificate).group(1),
    'fixture_credentials_absent_from_bundle': True,
}
(apk.parent / 'android-artifact.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
