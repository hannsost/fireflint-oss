import type { ExpoConfig } from 'expo/config';

// Public build configuration only. Expo dotenv loading is disabled by scripts.
const development = process.env.FIREFLINT_MOBILE_VARIANT === 'development';
const config: ExpoConfig = {
  name: development ? 'FireFlint Dev' : 'FireFlint',
  slug: 'fireflint-mobile',
  version: '0.1.0',
  orientation: 'default',
  userInterfaceStyle: 'light',
  icon: './assets/icon.png',
  scheme: development ? 'fireflint-dev' : 'fireflint',
  ios: {
    bundleIdentifier: development ? 'de.fireflint.mobile.dev' : 'de.fireflint.mobile',
    supportsTablet: true,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
    },
  },
  android: {
    package: development ? 'de.fireflint.mobile.dev' : 'de.fireflint.mobile',
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#152B2A' },
    allowBackup: false,
    blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'],
  },
  plugins: [
    ['./plugins/withBuildSafety', { development }],
    ['expo-secure-store', { configureAndroidBackup: true, faceIDPermission: false }],
    ['expo-build-properties', { android: { usesCleartextTraffic: development } }],
  ],
  extra: { development, defaultApiUrl: development ? 'http://10.0.2.2:18090' : '' },
};
export default config;
