import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { fetch as expoFetch } from 'expo/fetch';
import { FireFlintClient } from '../core';

export const ALLOW_LOCAL_HTTP = Constants.expoConfig?.extra?.development === true;
export const DEFAULT_API_URL: string = Constants.expoConfig?.extra?.defaultApiUrl ?? '';
const options: SecureStore.SecureStoreOptions = {
  keychainService: 'de.fireflint.mobile.credentials.v1',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
export const nativeCredentialStore = {
  get: (key: string) => SecureStore.getItemAsync(key, options),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value, options),
  delete: (key: string) => SecureStore.deleteItemAsync(key, options),
};
export const getLastServer = () => nativeCredentialStore.get('fireflint.last-server');
export const setLastServer = (url: string) => nativeCredentialStore.set('fireflint.last-server', url);
export function createNativeClient(baseUrl: string) {
  return new FireFlintClient({
    baseUrl, credentialStore: nativeCredentialStore, allowInsecureDevelopment: ALLOW_LOCAL_HTTP,
    // RN's global XHR-backed fetch ignores redirect:'error'. Expo's native
    // implementation disables redirects on both platforms before credentials can
    // leave the configured origin. This client always sends a string URL.
    fetch: (input, init) => {
      if (typeof input !== 'string') throw new TypeError('Der native API-Client erwartet eine URL-Zeichenfolge.');
      // Expo's native transport does not implement RequestInit.cache. Express
      // the no-store policy in HTTP as well, including iOS's URLSession cache.
      const headers = new Headers(init?.headers);
      headers.set('Cache-Control', 'no-store');
      return expoFetch(input, { ...init, headers, credentials: 'omit' });
    },
  });
}
