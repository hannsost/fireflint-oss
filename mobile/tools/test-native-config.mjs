import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(mobile, '../data/mobile/config-check');
mkdirSync(output, { recursive: true });
const project = mkdtempSync(resolve(output, 'native-'));
for (const file of ['app.config.ts', 'package.json', 'package-lock.json', 'assets', 'plugins']) cpSync(resolve(mobile, file), resolve(project, file), { recursive: true });
symlinkSync(resolve(mobile, 'node_modules'), resolve(project, 'node_modules'), 'dir');
execFileSync(process.execPath, [resolve(mobile, 'node_modules/expo/bin/cli'), 'prebuild', '--no-install'], {
  cwd: project,
  env: { ...process.env, EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1', CI: '1', FIREFLINT_MOBILE_VARIANT: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
});
const manifest = readFileSync(resolve(project, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
assert.match(manifest, /android:allowBackup="false"/);
assert.match(manifest, /android:usesCleartextTraffic="false"/);
assert.match(manifest, /secure_store_backup_rules/);
const activity = readFileSync(resolve(project, 'android/app/src/main/java/de/fireflint/mobile/MainActivity.kt'), 'utf8');
assert.match(activity, /FLAG_SECURE/);
const application = readFileSync(resolve(project, 'android/app/src/main/java/de/fireflint/mobile/MainApplication.kt'), 'utf8');
assert.match(application, /\.retryOnConnectionFailure\(false\)/);
assert.match(application, /\.cache\(null\)/);
const gradle = readFileSync(resolve(project, 'android/app/build.gradle'), 'utf8');
assert.match(gradle, /applicationId 'de\.fireflint\.mobile'/);
const release = gradle.split('release {')[1].split('packagingOptions')[0];
assert.doesNotMatch(release, /signingConfig signingConfigs\.debug/);
const plist = readFileSync(resolve(project, 'ios/FireFlint/Info.plist'), 'utf8');
assert.match(plist, /<key>NSAllowsArbitraryLoads<\/key>\s*<false\/>/);
assert.match(plist, /<string>FireFlint<\/string>/);
const delegate = readFileSync(resolve(project, 'ios/FireFlint/AppDelegate.swift'), 'utf8');
assert.match(delegate, /URLSessionConfiguration\.ephemeral/);
assert.match(delegate, /configuration\.urlCache = nil/);
const result = { checkedAt: new Date().toISOString(), productionAndroid: { cleartext: false, backup: false, flagSecure: true, debugReleaseSigning: false, connectionRetry: false, httpDiskCache: false }, ios: { projectGenerated: true, arbitraryLoads: false, persistentHttpSession: false, compiled: false }, note: 'Generated native configuration assertions; no device or production signing claim.' };
writeFileSync(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log('Production native configuration: 12 assertions passed. iOS generated, not compiled.');
