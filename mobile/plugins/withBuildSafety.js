const { withAppBuildGradle, withMainActivity, withMainApplication, withAppDelegate } = require('expo/config-plugins');

module.exports = function withBuildSafety(config, { development = false } = {}) {
  config = withAppBuildGradle(config, config => {
    // Expo templates sign release with the public debug key. Only our explicitly
    // separate development application is allowed to retain that behavior.
    if (development) {
      config.modResults.contents = config.modResults.contents.replace(
        '// Distribution signing must be configured explicitly by the app owner.',
        'signingConfig signingConfigs.debug'
      );
    } else {
      config.modResults.contents = config.modResults.contents.replace(
        /(release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/,
        '$1// Distribution signing must be configured explicitly by the app owner.'
      );
    }
    return config;
  });
  config = withMainActivity(config, config => {
    // Native window protection covers the Android task switcher too; JS
    // AppState alone cannot guarantee the timing of an OS screenshot.
    const marker = '    // FireFlint: protect private content from OS capture.';
    const protection = marker + '\n    window.setFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE, android.view.WindowManager.LayoutParams.FLAG_SECURE)';
    if (development) {
      config.modResults.contents = config.modResults.contents.replace('\n' + protection, '');
    } else if (!config.modResults.contents.includes(marker)) {
      config.modResults.contents = config.modResults.contents.replace(
        '    super.onCreate(null)',
        '    super.onCreate(null)\n' + protection
      );
    }
    return config;
  });
  config = withMainApplication(config, config => {
    const marker = '    // FireFlint: never replay writes or retain a private HTTP disk cache.';
    if (!config.modResults.contents.includes(marker)) {
      const anchor = '    super.onCreate()';
      if (!config.modResults.contents.includes(anchor)) throw new Error('FireFlint network setup: Android template changed');
      config.modResults.contents = config.modResults.contents.replace(anchor, anchor + '\n' + marker + `
    com.facebook.react.modules.network.OkHttpClientProvider.setOkHttpClientFactory {
      com.facebook.react.modules.network.OkHttpClientProvider.createClientBuilder()
        .retryOnConnectionFailure(false)
        .cache(null)
        .build()
    }`);
    }
    return config;
  });
  config = withAppDelegate(config, config => {
    const marker = '    // FireFlint: no persistent private HTTP cache or cookie storage.';
    if (!config.modResults.contents.includes(marker)) {
      const anchor = '    let delegate = ReactNativeDelegate()';
      if (!config.modResults.contents.includes(anchor)) throw new Error('FireFlint network setup: iOS template changed');
      config.modResults.contents = config.modResults.contents.replace(anchor, marker + `
    ExpoFetchCustomExtension.setCustomURLSessionConfigurationProvider {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.urlCache = nil
      configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
      configuration.httpCookieStorage = nil
      configuration.httpShouldSetCookies = false
      return configuration
    }
` + anchor);
    }
    return config;
  });
  return config;
};
