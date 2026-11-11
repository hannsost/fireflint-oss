import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { Brand, Button, Notice } from './components';
import { colors, styles } from './theme';

export function LoginScreen({ server, localHttp, error, busy, onLogin, cleanupRequired = false, onRetryLogout }: {
  server: string; localHttp: boolean; error: string; busy: boolean;
  onLogin: (server: string, email: string, password: string) => Promise<void>;
  cleanupRequired?: boolean; onRetryLogout?: () => void;
}) {
  const [endpoint, setEndpoint] = useState(server);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: 32 }]}>
      <Brand />
      <View style={{ gap: 12, paddingTop: 30, paddingBottom: 10 }}>
        <Text style={styles.eyebrow}>Deine Inhalte. Deine Websites.</Text>
        <Text accessibilityRole="header" style={[styles.title, { fontSize: 38, lineHeight: 44 }]}>Ein klarer Stand.{'\n'}Überall.</Text>
        <Text style={styles.body}>Inhalte unterwegs prüfen, lokale Unterschiede im Blick behalten und bewusst freigeben.</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>Bei FireFlint anmelden</Text>
        {!!error && <Notice error>{error}</Notice>}
        <View style={styles.field}>
          <Text style={styles.label}>Serveradresse</Text>
          <TextInput testID="login-server" accessibilityLabel="Serveradresse" value={endpoint} onChangeText={setEndpoint}
            editable={!busy && !cleanupRequired} keyboardType="url" autoCapitalize="none" autoCorrect={false} style={styles.input} />
          <Text style={styles.muted}>Die HTTPS-Adresse deines FireFlint-Arbeitsbereichs. Prüfe die Adresse, bevor du Zugangsdaten eingibst.</Text>
          {localHttp && <Text style={[styles.muted, { color: colors.flame }]}>Entwicklungsbuild: Lokales HTTP ist nur für eigene Testserver vorgesehen.</Text>}
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>E-Mail</Text>
          <TextInput testID="login-email" accessibilityLabel="E-Mail" value={email} onChangeText={setEmail} editable={!busy && !cleanupRequired}
            keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="username" style={styles.input} />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Passwort</Text>
          <TextInput testID="login-password" accessibilityLabel="Passwort" value={password} onChangeText={setPassword} editable={!busy && !cleanupRequired}
            secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" textContentType="password" style={styles.input}
            onSubmitEditing={() => { if (!busy && !cleanupRequired && email && password) void onLogin(endpoint, email.trim(), password); }} />
        </View>
        {cleanupRequired && <Button label="Abmeldung erneut versuchen" testID="retry-logout" busy={busy} onPress={() => onRetryLogout?.()} />}
        <Button label="Anmelden" testID="login-submit" busy={busy} disabled={cleanupRequired || !email.trim() || !password || !endpoint.trim()}
          onPress={() => void onLogin(endpoint.trim(), email.trim(), password)} />
      </View>
      <Text style={styles.muted}>Dein Konto und deine Rolle werden vom Server bestätigt. Ein Arbeitsbereich enthält die Websites eines Kundenunternehmens.</Text>
    </ScrollView>
  </KeyboardAvoidingView>;
}
