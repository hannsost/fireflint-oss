import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AppState, BackHandler, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { canEdit, type ContentType, type FireFlintClient, type SessionSnapshot } from './src/core';
import { ALLOW_LOCAL_HTTP, createNativeClient, DEFAULT_API_URL, getLastServer, setLastServer } from './src/native/client';
import { Badge, Brand, Button, Flame, Loading, Notice } from './src/ui/components';
import { ContentBrowser } from './src/ui/ContentBrowser';
import { ContentEditor } from './src/ui/ContentEditor';
import { LoginScreen } from './src/ui/LoginScreen';
import { userError } from './src/ui/errors';
import { colors, styles } from './src/ui/theme';

const EMPTY: SessionSnapshot = { status: 'signedOut', me: null, activeOrgId: null, generation: 0 };
const roleNames = { owner: 'Inhaber', editor: 'Redaktion', viewer: 'Lesezugriff' };

export default function App() {
  return <SafeAreaProvider><Application /></SafeAreaProvider>;
}

function Application() {
  const [client, setClient] = useState<FireFlintClient | null>(null);
  const [server, setServer] = useState(DEFAULT_API_URL);
  const [starting, setStarting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [logoutFailure, setLogoutFailure] = useState<FireFlintClient | null>(null);
  const [privateScreen, setPrivateScreen] = useState(AppState.currentState !== 'active');
  const subscribe = useCallback((listener: () => void) => client ? client.subscribe(listener) : () => {}, [client]);
  const snapshot = useSyncExternalStore(subscribe, client?.getSnapshot ?? (() => EMPTY));

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const origin = await getLastServer() || DEFAULT_API_URL;
        if (!alive) return;
        setServer(origin);
        if (origin) {
          const restored = createNativeClient(origin);
          setClient(restored);
          await restored.restore();
        }
      } catch (failure) { if (alive) setError(userError(failure)); }
      finally { if (alive) setStarting(false); }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const listener = AppState.addEventListener('change', state => setPrivateScreen(state !== 'active'));
    return () => listener.remove();
  }, []);

  const login = async (origin: string, email: string, password: string) => {
    if (busy || logoutFailure) return;
    setBusy(true); setError('');
    try {
      let next: FireFlintClient;
      try { next = createNativeClient(origin); }
      catch { setError('Gib eine gültige HTTPS-Serveradresse ohne Pfad, Zugangsdaten oder Suchparameter ein.'); return; }
      if (client) {
        try { await client.logout(); }
        catch (failure) { setLogoutFailure(client); throw failure; }
      }
      await setLastServer(next.baseUrl);
      setServer(next.baseUrl); setClient(next);
      await next.login(email, password);
    } catch (failure) { setError(userError(failure)); }
    finally { setBusy(false); }
  };

  const logout = async (target: FireFlintClient) => {
    setBusy(true);
    try {
      await target.logout(); setLogoutFailure(null); setError('');
    } catch {
      setLogoutFailure(target);
      setError('Die Sitzung in dieser App ist geschlossen. Die gespeicherte Anmeldung konnte jedoch nicht gelöscht werden. Versuche die Abmeldung erneut, bevor du das Gerät weitergibst.');
    } finally { setBusy(false); }
  };

  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
    <StatusBar style="dark" />
    <View style={styles.flex} importantForAccessibility={privateScreen ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={privateScreen}>
      {starting ? <View style={styles.page}><Brand /><Loading label="Sichere Anmeldung wird geprüft …" /></View>
        : client && snapshot.status === 'authenticated' && snapshot.me
          ? <Workspace key={snapshot.generation} client={client} snapshot={snapshot} privateScreen={privateScreen} onLogout={() => void logout(client)} />
          : <LoginScreen server={server} localHttp={ALLOW_LOCAL_HTTP} error={error} busy={busy || snapshot.status === 'loading'} onLogin={login}
            cleanupRequired={logoutFailure !== null} onRetryLogout={() => { if (logoutFailure) void logout(logoutFailure); }} />}
    </View>
    {privateScreen && <View style={styles.privacy} testID="privacy-cover"><Flame size={50} /><Brand /><Text style={styles.muted}>Dein Arbeitsbereich bleibt privat.</Text></View>}
  </SafeAreaView>;
}

function Workspace({ client, snapshot, privateScreen, onLogout }: {
  client: FireFlintClient; snapshot: SessionSnapshot; privateScreen: boolean; onLogout: () => void;
}) {
  const [chooser, setChooser] = useState(!snapshot.activeOrgId);
  const [selected, setSelected] = useState<{ type: ContentType; id: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [orgBusy, setOrgBusy] = useState(false);
  const mounted = useRef(true);
  const scroll = useRef<ScrollView>(null);
  const originalGeneration = useRef(snapshot.generation);
  const active = snapshot.me?.memberships.find(member => member.org_id === snapshot.activeOrgId);
  const memberships = snapshot.me?.memberships ?? [];
  const onDirty = useCallback((next: boolean) => setDirty(next), []);
  useEffect(() => { scroll.current?.scrollTo({ y: 0, animated: false }); }, [selected]);

  const verify = useCallback(async () => {
    setChecking(true); setVerified(false); setError('');
    try { await client.revalidateMemberships(); if (mounted.current) setVerified(true); }
    catch (failure) { if (mounted.current) setError(userError(failure)); }
    finally { if (mounted.current) setChecking(false); }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    void verify();
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') void verify();
      else setVerified(false);
    });
    return () => { mounted.current = false; listener.remove(); };
  }, [verify]);

  const leave = useCallback((action: () => void) => {
    const stillHere = () => mounted.current && client.getSnapshot().generation === originalGeneration.current;
    if (!stillHere()) return;
    if (!dirty) { action(); return; }
    Alert.alert('Ungespeicherte Eingaben', 'Wenn du diesen Inhalt verlässt, werden deine lokalen Eingaben verworfen.', [
      { text: 'Weiter bearbeiten', style: 'cancel' },
      { text: 'Verwerfen', style: 'destructive', onPress: () => { if (stillHere()) action(); } },
    ]);
  }, [client, dirty]);

  const back = useCallback(() => leave(() => { setSelected(null); setDirty(false); }), [leave]);
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (chooser && snapshot.activeOrgId) { setChooser(false); return true; }
      if (selected) { back(); return true; }
      return false;
    });
    return () => listener.remove();
  }, [back, chooser, selected, snapshot.activeOrgId]);

  const choose = (orgId: string) => leave(() => {
    setOrgBusy(true); setError('');
    void client.selectOrg(orgId).catch(failure => { if (mounted.current) setError(userError(failure)); })
      .finally(() => { if (mounted.current) setOrgBusy(false); });
  });

  const logout = () => leave(onLogout);

  return <View style={styles.flex}>
    <View style={styles.top}>
      <View style={styles.spread}><Brand /><Button label="Abmelden" secondary testID="logout" onPress={logout} /></View>
      {active && <Pressable testID="org-switch" accessibilityRole="button" accessibilityLabel={'Arbeitsbereich wechseln: ' + active.org_name}
        onPress={() => setChooser(true)} style={[styles.spread, { minHeight: 56, paddingTop: 10 }]}>
        <View style={{ flex: 1, gap: 3 }}><Text style={styles.label}>{active.org_name} ▾</Text><Text style={styles.muted}>{roleNames[active.role]}</Text></View>
        <Badge>{selected ? 'Inhalt' : 'Übersicht'}</Badge>
      </Pressable>}
    </View>
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
        {!!error && <Notice error>{error}</Notice>}
        {!verified && !chooser && <View style={{ gap: 10 }}><Notice>{checking ? 'Deine aktuelle Berechtigung wird geprüft …' : 'Schreiben bleibt gesperrt, bis deine Verbindung und Berechtigung erneut bestätigt sind.'}</Notice>
          <Button label="Verbindung prüfen" secondary busy={checking} onPress={() => void verify()} testID="verify-session" /></View>}
        {selected && active ? <>
          <Button label="← Alle Inhalte" secondary onPress={back} testID="editor-back" />
          <ContentEditor key={selected.id} client={client} type={selected.type} id={selected.id}
            canWrite={canEdit(active.role)} connectionVerified={verified} onDirty={onDirty} />
        </> : active ? <ContentBrowser client={client} onOpen={(type, content) => setSelected({ type, id: content.id })} />
          : <View style={styles.card}><Text style={styles.heading}>Wähle deinen Arbeitsbereich</Text><Button label="Arbeitsbereiche öffnen" onPress={() => setChooser(true)} /></View>}
      </ScrollView>
    </KeyboardAvoidingView>
    <Modal visible={chooser} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (active) setChooser(false); }}>
      <SafeAreaView style={styles.screen}><ScrollView contentContainerStyle={styles.page}
        importantForAccessibility={privateScreen ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={privateScreen}>
        <Brand />
        <Text accessibilityRole="header" style={styles.title}>Dein Arbeitsbereich</Text>
        <Text style={styles.body}>Du siehst nur Organisationen, in denen dein Konto Mitglied ist.</Text>
        <Text style={styles.muted}>{snapshot.me?.user.email}</Text>
        {!!error && <Notice error>{error}</Notice>}
        {!memberships.length && <Notice>Deinem Konto ist derzeit kein Arbeitsbereich zugeordnet. Die Verwaltung deines Unternehmens kann deine Mitgliedschaft prüfen.</Notice>}
        {memberships.map(member => <Pressable key={member.org_id} testID={'org-' + member.org_id}
          accessibilityRole="button" accessibilityLabel={member.org_name + ', ' + roleNames[member.role]}
          disabled={orgBusy} onPress={() => choose(member.org_id)} style={({ pressed }) => [styles.card, pressed && styles.pressed, orgBusy && styles.disabled]}>
          <Text style={styles.heading}>{member.org_name}</Text><Badge>{roleNames[member.role]}</Badge>
          <Text style={[styles.muted, { color: colors.green }]}>Arbeitsbereich öffnen →</Text>
        </Pressable>)}
        {orgBusy && <Loading label="Mitgliedschaft wird bestätigt …" />}
        <Button label="Mitgliedschaften aktualisieren" secondary busy={checking} onPress={() => void verify()} />
        {active && <Button label="Zurück zum Inhalt" secondary onPress={() => setChooser(false)} />}
        <Button label="Abmelden" secondary testID="chooser-logout" onPress={logout} />
      </ScrollView>
        {privateScreen && <View style={styles.privacy}><Flame size={50} /><Brand /></View>}
      </SafeAreaView>
    </Modal>
  </View>;
}
