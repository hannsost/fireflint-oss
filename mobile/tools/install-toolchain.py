#!/usr/bin/env python3
"""Project-local JDK/Android command tools; no system package/config changes."""
from pathlib import Path
import hashlib
import json
import tarfile
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[2]
dest = root / 'data/mobile/toolchain'
dest.mkdir(parents=True, exist_ok=True)

def download(url, path, algorithm, expected):
    urllib.request.urlretrieve(url, path)
    h = hashlib.new(algorithm)
    with path.open('rb') as f:
        for part in iter(lambda: f.read(1048576), b''):
            h.update(part)
    if h.hexdigest() != expected:
        raise RuntimeError(f'Checksum mismatch: {path.name}')

metadata = dest / 'jdk-metadata.json'
if not metadata.exists():
    urllib.request.urlretrieve('https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=linux&vendor=eclipse', metadata)
repository_file = dest / 'repository.xml'
if not repository_file.exists():
    urllib.request.urlretrieve('https://dl.google.com/android/repository/repository2-1.xml', repository_file)
package = json.loads(metadata.read_text())[0]['binary']['package']
if not (dest / 'jdk/bin/java').exists():
    archive = dest / 'jdk.tar.gz'
    download(package['link'], archive, 'sha256', package['checksum'])
    with tarfile.open(archive) as tar:
        prefix = tar.getmembers()[0].name.split('/')[0]
        tar.extractall(dest, filter='data')
    (dest / prefix).rename(dest / 'jdk')
    archive.unlink()
    print('Verified project-local Temurin JDK 17 installed', flush=True)

sdk = dest / 'android-sdk'
if not (sdk / 'cmdline-tools/latest/bin/sdkmanager').exists():
    repository = ET.parse(dest / 'repository.xml')
    p = next(p for p in repository.getroot() if p.attrib.get('path') == 'cmdline-tools;latest')
    a = next(a for a in p.iter('archive') if a.findtext('host-os') == 'linux')
    archive = dest / 'android-tools.zip'
    download('https://dl.google.com/android/repository/' + a.findtext('complete/url'),
             archive, 'sha1', a.findtext('complete/checksum'))
    sdk.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        z.extractall(sdk)
    (sdk / 'cmdline-tools').rename(sdk / 'downloaded-tools')
    (sdk / 'cmdline-tools').mkdir()
    (sdk / 'downloaded-tools').rename(sdk / 'cmdline-tools/latest')
    for executable in (sdk / 'cmdline-tools/latest/bin').iterdir():
        executable.chmod(0o755)
    archive.unlink()
    print('Verified project-local Android command tools installed', flush=True)
