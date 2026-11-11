# FireFlint für Android und iPhone

Eigenständiger nativer React-Native/Expo-Client für die vorhandene FireFlint-API.
Keine FlintPlate-App, kein zweites Backend, kein öffentliches Delivery-Token im
Client. Kunden und Mitarbeitende erhalten ihre tatsächliche serverseitige Rolle.

Der Umfang: sichere Anmeldung, Arbeitsbereiche, Inhaltssuche, Publikationsstand,
Text-/Zahl-/Datumsfelder bearbeiten, Website-Auswirkungen einschließlich lokaler
Overrides vergleichen und die ausdrücklich geprüfte Revision veröffentlichen.
Komplexe/Richtext-/Medien-/Relationsfelder bleiben lesbar und unverändert; deren
Bearbeitung sowie Channel-/Type-/Website-Einrichtung erfolgt vorerst im Web-Admin.
Viewer bleibt lesend. Dies ist kein Vier-Augen- oder Website-Rollenmodell.

## Entwicklungsumgebung

Node mindestens 22.13, Expo SDK57/RN0.86/React19.2.3 laut Lockfile. Keine dotenv-
Dateien verwenden. Alle Expo-Kommandos mit `EXPO_NO_DOTENV=1`, Telemetrie aus.

```bash
npm --prefix mobile ci
npm --prefix mobile run typecheck
npm --prefix mobile test
cd mobile
EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1 npx expo install --check
```

`src/core` enthält den tatsächlich verwendeten API-/Sessionvertrag;
`src/native/client.ts` adaptiert Expo SecureStore. Nur Refresh bleibt origin-gebunden
in Keychain/Keystore; Access, private Inhalte und Entwürfe bleiben im Speicher.
Ein App-Neustart prüft `/auth/refresh` und `/api/me`, bevor Inhalte zugänglich werden.
Der native Transport sperrt Redirects und Cookies. Android deaktiviert zusätzlich
transparente Verbindungswiederholungen und HTTP-Diskcache; iOS ist mit ephemerer
URLSession vorbereitet. Orgwechsel verwirft den vorherigen Bereich. Eine geänderte aktive Membership
invalidiert den Zugriff, Änderungen anderer Memberships verwerfen keine Eingaben.

Logout entfernt die lokale Sitzung; es gibt keinen serverseitigen Logout-Endpunkt,
der alle anderen Geräte widerruft. Passwortänderungen widerrufen bestehende Sessions.
Bei Fehler der sicheren Löschung zeigt die App eine erneute Abmeldung an und
sperrt Login bis zur erfolgreichen Löschung. iOS-Keychain kann Neuinstallationen
überleben; Neuinstallation ist kein zugesagter Logout.

Bei Netzverlust und 409 bleiben offene Eingaben erhalten. Unklarer Schreibausgang
verlangt Serververgleich, keine blinde Wiederholung. Entwürfe sind **nicht dauerhaft
offline gespeichert**; App-Prozessende verwirft sie. Keine automatische Publikation
bei Wiederverbindung. Push, Kamera und Support-Chat sind nicht implementiert.

## Android lokal bauen

Das Werkzeugverzeichnis gehört ausschließlich diesem Projekt. JDK17 und
Android SDK36/Build Tools36.0.0/NDK27.1.12297006/CMake3.22.1 werden lokal verwendet.
Gradle installiert für native Abhängigkeiten zusätzlich Build Tools35.0.0.
`install-toolchain.py` prüft Downloads anhand offizieller Prüfsummen. Für eine
frische Installation, vom Repository-Root:

```bash
python3 mobile/tools/install-toolchain.py
bash mobile/tools/install-sdk.sh
```

Diese Downloads benötigen mehrere GiB. Keinen fremden Cache oder Datenvolume
bereinigen. Lange Installationen/Builds im Cockpit über `systemd-run --user`
starten, wie im tatsächlich verwendeten Aufruf:

```bash
systemd-run --user --unit=fireflint-mobile-android-build --collect \
  --property=WorkingDirectory="$PWD" \
  --property=StandardOutput="append:$PWD/data/mobile/logs/android-build.log" \
  --property=StandardError="append:$PWD/data/mobile/logs/android-build.log" \
  --setenv="PATH=$PATH" /usr/bin/bash mobile/tools/build-android.sh
```

Script erzeugt eine **Entwicklungs-App** `de.fireflint.mobile.dev`, Name
**FireFlint Dev**, mit eingebettetem JavaScript/Hermes und öffentlicher Android-
Debugsignierung. Gradle heißt `assembleRelease`, die App bleibt wegen eigener
Konfiguration/Signierung ein Entwicklungsartefakt, kein Store-Release.
Standardmäßig arm64-v8a und x86_64; für gezielte lokale Builds kann
`FIREFLINT_ANDROID_ARCHS=x86_64` gesetzt werden.

Ergebnis: `data/mobile/artifacts/fireflint-development.apk`. Installation nur auf
einem ausdrücklich ausgewählten eigenen Gerät/Emulator:

```bash
bash mobile/tools/create-emulator.sh
systemd-run --user --unit=fireflint-mobile-emulator --collect \
  --property=WorkingDirectory="$PWD" \
  --property=StandardOutput="append:$PWD/data/mobile/logs/emulator.log" \
  --property=StandardError="append:$PWD/data/mobile/logs/emulator.log" \
  /usr/bin/bash mobile/tools/run-emulator.sh
# Warten, bis adb shell getprop sys.boot_completed den Wert 1 liefert.
data/mobile/toolchain/android-sdk/platform-tools/adb -s emulator-5554 \
  install -r data/mobile/artifacts/fireflint-development.apk
```

Es wird kein Metro-Server für dieses eingebettete APK benötigt. In der
Entwicklungsvariante ist lokale HTTP-Nutzung erlaubt; Emulator-Standardserver
ist `http://10.0.2.2:18090` (Hostadresse aus dem Android-Emulator). Ein physisches
Gerät benötigt eine tatsächlich erreichbare API-Adresse. Keine echten Credentials
über öffentliches HTTP übertragen. Produktionskonfiguration verwendet HTTPS,
separate App-ID `de.fireflint.mobile`, deaktivierte Android-Backups und native
Android-`FLAG_SECURE`-Fenster; Debug-Release-Signierung wird dort entfernt.
Eigene Distributionssignierung muss separat eingerichtet werden, ohne private
Schlüssel in Repository/Bundle. Kein Store-/Cloud-Upload Bestandteil dieses Auftrags.

Die kontrollierte Produktions-Projektgenerierung prüft diesen Unterschied:

```bash
node mobile/tools/test-native-config.mjs
```

## iOS-Projekt und fehlende externe Voraussetzungen

`ios/FireFlintDev.xcodeproj` ist ein echtes erzeugtes natives Projekt mit Podfile,
AppDelegate, Flammenicon, konfigurierter Privacy-Manifest-Aggregation und sicherer Ablage. Es ist auf diesem
Linux-Host **nicht kompiliert oder auf einem iPhone ausgeführt** worden.

Benötigt werden ein eigener Mac mit Xcode mindestens26.4 (für26.4.1 laut
[Apple-Systemanforderungen](https://developer.apple.com/xcode/system-requirements)
macOS Tahoe26.2 oder neuer aus der26.x-Reihe), passende Command-Line-Tools,
Node, Ruby/CocoaPods und installierter iOS-Simulator. Expo57 benötigt mindestens
iOS16.4. Quellenstand18.09.2026; konkrete Xcode-/Simulator-Kompatibilität beim
Mac-Auftrag erneut prüfen. Kein vorhandenes Apple-Konto oder Team angenommen.

Auf dem Mac im gleichen Quellstand, zunächst ohne Geräte-/Store-Signierung:

```bash
cd mobile
npm ci
EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1 FIREFLINT_MOBILE_VARIANT=development \
  npx expo prebuild --platform ios --no-install
cd ios
pod install
EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1 FIREFLINT_MOBILE_VARIANT=development \
  xcodebuild -workspace FireFlintDev.xcworkspace -scheme FireFlintDev \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Für iPhone: konkrete Developer-Team-Zuordnung, eindeutige Bundle-ID, geeignetes
Provisioningprofil/Entwicklungssignierung und autorisiertes Gerät einrichten.
Keine privaten Schlüssel hier hinterlegen. iOS-ATS bleibt eingeschaltet; für den
fachlichen Test einen tatsächlich erreichbaren HTTPS-Testserver verwenden, nicht
die Android-spezifische Hostadresse. iOS-App-Switcher-/Geräteschutz und VoiceOver
sind erst am Mac/Gerät abzunehmen, eine JS-Abdeckung ist kein OS-Nachweis.

## Reale isolierte Abnahme

Preview DB5433/API8090/Admin5174 bleibt in den bestehenden systemd-Diensten.
Tests verwenden ausschließlich Release DB15433/API18090/Admin15174. Der
Fixture-Helper prüft Port, DB-Identität und eine frisch erzeugte Owner-Identität
gegen die API, bevor er schreibend arbeitet. Keine bestehende Vorschau bereinigen.

```bash
bash mobile/tools/start-fixture.sh
E2E_DATABASE=release npm --prefix mobile run test:api
E2E_DATABASE=release node mobile/tools/fixture.mjs create
# Nach Installation auf der eigenen fireflint-mobile-AVD:
python3 mobile/tools/test-android.py --reset-app --offline --membership
# Erst nach beendeter Geräteabnahme:
E2E_DATABASE=release node mobile/tools/fixture.mjs cleanup
```

Die Native-Fixture enthält ausschließlich eigene synthetische Accounts/IDs, keine
gespeicherten Access-/Refresh-Tokens. HTTP-Tests verwenden denselben Client mit
Speicheradapter im RAM; erst der native Neustart-/Logout-Test prüft SecureStore
auf Android. Reale Plattform-/Buildnachweise, Grenzen und Screenshots stehen im
datierten Umsetzungsbericht (interne Dokumentation, nicht veröffentlicht).
