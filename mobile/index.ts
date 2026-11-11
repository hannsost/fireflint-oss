// RN's built-in URL is partial. Use WHATWG normalization for origin-bound auth.
import 'react-native-url-polyfill/auto';
import { registerRootComponent } from 'expo';
import App from './App';
registerRootComponent(App);
