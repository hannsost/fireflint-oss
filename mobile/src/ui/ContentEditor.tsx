import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Pressable, Text, View } from 'react-native';
import { ApiError, NetworkError, stableJson, type ContentObject, type ContentType, type FireFlintClient, type Website } from '../core';
import { Badge, Button, contentTitle, displayValue, Loading, Notice } from './components';
import { FieldForm, prepareData } from './FieldForm';
import { userError } from './errors';
import { colors, styles } from './theme';
import { WebsiteComparison } from './WebsiteComparison';

type Channels = Awaited<ReturnType<FireFlintClient['getChannels']>>;
type Snapshot = { content: ContentObject; channels: Channels; websites: Website[] };

export function ContentEditor({ client, type, id, canWrite, connectionVerified, onDirty }: {
  client: FireFlintClient; type: ContentType; id: string; canWrite: boolean; connectionVerified: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const [saved, setSaved] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const draftRef = useRef<Record<string, unknown>>({});
  const updateDraft = useCallback((next: Record<string, unknown>) => { draftRef.current = next; setDraft(next); }, []);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [conflict, setConflict] = useState(false);
  const [server, setServer] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<'fields' | 'websites'>('fields');
  const [reviewed, setReviewed] = useState(false);
  const alive = useRef(true);
  const writeInFlight = useRef(false);
  const viewGeneration = useRef(client.getSnapshot().generation);
  const livePermission = useRef({ canWrite, connectionVerified });
  livePermission.current = { canWrite, connectionVerified };
  const dirty = saved !== null && JSON.stringify(draft) !== JSON.stringify(saved.content.data);
  const activeView = () => alive.current && viewGeneration.current === client.getSnapshot().generation && AppState.currentState === 'active';

  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const readSnapshot = useCallback(async (): Promise<Snapshot> => {
    const [content, channels, websites] = await Promise.all([
      client.getContent(type.key, id), client.getChannels(type.key, id), client.getWebsites(),
    ]);
    if (content.revision !== channels.revision) throw new Error('snapshot-mismatch');
    return { content, channels, websites };
  }, [client, id, type.key]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const snapshot = await readSnapshot();
      if (!alive.current) return;
      setSaved(snapshot); updateDraft(snapshot.content.data); setReviewed(false);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error && failure.message === 'snapshot-mismatch'
        ? 'Der Inhalt wurde während des Ladens geändert. Lade den vollständigen Stand erneut.' : userError(failure));
    } finally { if (alive.current) setLoading(false); }
  }, [readSnapshot, updateDraft]);

  useEffect(() => { void load(); }, [load]);

  const handleWriteError = (failure: unknown) => {
    const uncertain = failure instanceof NetworkError || (failure instanceof ApiError && (failure.status === 409 || failure.status >= 500));
    setConflict(uncertain); setReviewed(false); setServer(null);
    setError(`${userError(failure)}${uncertain ? ' Es wird nichts automatisch wiederholt. Prüfe den Serverstand, bevor du fortfährst.' : ''}`);
  };

  const adoptWrite = async (content: ContentObject, submitted: Record<string, unknown>) => {
    // The response is authoritative for the write. Fetch assignments separately,
    // then require its revision before allowing a publication comparison.
    if (stableJson(draftRef.current) === stableJson(submitted)) updateDraft(content.data);
    setSaved(previous => previous ? { ...previous, content } : previous);
    const [channels, websites] = await Promise.all([client.getChannels(type.key, id), client.getWebsites()]);
    if (!alive.current) return;
    if (channels.revision !== content.revision) {
      setSaved({ content, channels, websites }); setConflict(true);
      setError('Der gespeicherte Inhalt wurde bereits weiterbearbeitet. Vergleiche den aktuellen Serverstand.');
      return;
    }
    setSaved({ content, channels, websites });
  };

  const save = async () => {
    if (!activeView() || !saved || busy || writeInFlight.current || conflict || !livePermission.current.canWrite || !livePermission.current.connectionVerified) return;
    let data: Record<string, unknown>;
    const submitted = draftRef.current;
    try { data = prepareData(type, submitted); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Prüfe deine Eingaben.'); return; }
    writeInFlight.current = true;
    setBusy(true); setError(''); setMessage(''); setReviewed(false);
    try {
      const content = await client.saveContent(type.key, id, data, saved.content.revision);
      if (!alive.current) return;
      await adoptWrite(content, submitted);
      if (alive.current) setMessage('Entwurf gespeichert. Der bisher öffentliche Stand bleibt erhalten.');
    } catch (failure) { if (alive.current) handleWriteError(failure); }
    finally { writeInFlight.current = false; if (alive.current) setBusy(false); }
  };

  const compareServer = async () => {
    if (!activeView()) return;
    setBusy(true); setError('');
    try {
      const snapshot = await readSnapshot();
      if (alive.current) setServer(snapshot);
    } catch (failure) { if (alive.current) setError(userError(failure)); }
    finally { if (alive.current) setBusy(false); }
  };

  const useServer = () => {
    if (!server) return;
    Alert.alert('Lokale Eingaben verwerfen?', 'Der angezeigte Serverstand ersetzt deine lokalen Eingaben. Du kannst die Texte vorher kopieren.', [
      { text: 'Behalten', style: 'cancel' },
      { text: 'Serverstand übernehmen', style: 'destructive', onPress: () => {
        if (!activeView()) return;
        setSaved(server); updateDraft(server.content.data); setServer(null); setConflict(false); setReviewed(false); setError(''); setMessage('Serverstand übernommen. Prüfe deine Änderungen und Website-Auswirkungen erneut.');
      } },
    ]);
  };

  const publish = async () => {
    if (!activeView() || !saved || dirty || busy || writeInFlight.current || conflict || !reviewed || !livePermission.current.canWrite || !livePermission.current.connectionVerified || saved.content.revision !== saved.channels.revision) return;
    const submitted = draftRef.current;
    writeInFlight.current = true;
    setBusy(true); setError(''); setMessage(''); setReviewed(false);
    try {
      const content = await client.publishContent(type.key, id, saved.content.revision);
      if (!alive.current) return;
      await adoptWrite(content, submitted);
      if (alive.current) setMessage('Veröffentlicht. Die Websites erhalten diesen freigegebenen Stand über ihre Anbindung.');
    } catch (failure) { if (alive.current) handleWriteError(failure); }
    finally { writeInFlight.current = false; if (alive.current) setBusy(false); }
  };

  if (loading) return <Loading label="Inhalt und Websites werden abgeglichen …" />;
  if (!saved && !busy && !conflict) return <View style={{ gap: 14 }}><Notice error>{error || 'Der Inhalt konnte nicht geladen werden.'}</Notice><Button label="Erneut laden" onPress={() => void load()} testID="editor-reload" /></View>;

  return <View style={{ gap: 20 }}>
    <View style={{ gap: 9 }}>
      <Text style={styles.eyebrow}>{type.name}</Text>
      <Text accessibilityRole="header" style={styles.title}>{contentTitle(draft)}</Text>
      <View style={styles.row}>
        <Badge draft={!saved?.content.publication}>{saved?.content.publication ? 'Öffentlicher Stand vorhanden' : 'Noch nicht veröffentlicht'}</Badge>
        {(dirty || saved?.content.has_unpublished_changes) && <Badge draft>{dirty ? 'Ungespeicherte Eingaben' : 'Entwurf mit Änderungen'}</Badge>}
      </View>
    </View>
    {!canWrite && <Notice>Du hast Lesezugriff. Bearbeiten und Veröffentlichen sind für deine Rolle gesperrt.</Notice>}
    {!!error && <Notice error>{error}</Notice>}
    {!!message && <Notice>{message}</Notice>}
    {conflict && <View style={[styles.card, { borderColor: colors.flame }]}>
      <Text style={styles.heading}>Eingaben bleiben erhalten</Text>
      <Text style={styles.body}>Der bisher geladene Stand reicht für eine sichere Änderung nicht mehr aus. Deine Texte stehen weiterhin im Formular. Es wird keine neue Revision automatisch zum Überschreiben verwendet.</Text>
      <Button secondary label="Serverstand vergleichen" testID="conflict-compare" busy={busy} onPress={() => void compareServer()} />
      {server && <View style={{ gap: 16 }}>
        <Text style={styles.heading}>Aktueller Serverstand {server.content.revision}</Text>
        {[...new Set([...Object.keys(draft), ...Object.keys(server.content.data)])].map(key => <View key={key} style={{ gap: 5 }}>
          <Text style={styles.label}>{key}</Text>
          <Text style={styles.muted}>Deine Eingabe</Text><Text selectable style={styles.body}>{displayValue(draft[key])}</Text>
          <Text style={styles.muted}>Auf dem Server</Text><Text selectable style={styles.body}>{displayValue(server.content.data[key])}</Text>
        </View>)}
        <WebsiteComparison content={server.content} channels={server.channels} websites={server.websites} />
        <Button secondary label="Serverstand übernehmen" testID="conflict-adopt" onPress={useServer} />
      </View>}
    </View>}
    <View style={styles.row}>
      <Button label="Inhalt" secondary={tab !== 'fields'} testID="editor-fields" onPress={() => setTab('fields')} />
      <Button label="Website-Vergleich" secondary={tab !== 'websites'} testID="editor-websites" onPress={() => setTab('websites')} />
    </View>
    {tab === 'fields' && <View style={styles.card}>
      <Text style={styles.heading}>{canWrite ? 'Zentrale Inhalte bearbeiten' : 'Zentrale Inhalte'}</Text>
      <Text style={styles.muted}>Speichern ändert zunächst den Entwurf. Lokale Website-Ausnahmen werden hier nicht überschrieben.</Text>
      <FieldForm type={type} data={draft} editable={canWrite && !busy} onChange={next => { updateDraft(next); setReviewed(false); setMessage(''); }} />
      {canWrite && <Button label="Entwurf speichern" testID="save-content" busy={busy} disabled={!dirty || conflict || !connectionVerified || !saved}
        onPress={() => void save()} />}
    </View>}
    {tab === 'websites' && <View style={{ gap: 18 }}>
      {dirty ? <Notice>Speichere zuerst deine Eingaben. Danach kannst du genau diesen gespeicherten Stand mit den Websites vergleichen.</Notice>
        : conflict || !saved || saved.content.revision !== saved.channels.revision ? <Notice>Der Vergleich ist bis zur Klärung des Serverstands gesperrt.</Notice>
          : <>
            <WebsiteComparison content={saved.content} channels={saved.channels} websites={saved.websites} />
            {canWrite && <View style={styles.card}>
              <Text style={styles.heading}>Geprüften Stand freigeben</Text>
              <Text style={styles.body}>Du veröffentlichst Stand {saved.content.revision} mit seinen Website-Ausnahmen. Bestehende Freigabe- und Rücknahmetermine werden dabei aufgehoben.</Text>
              <Pressable testID="review-publication" accessibilityRole="checkbox" accessibilityState={{ checked: reviewed, disabled: busy || !connectionVerified }}
                disabled={busy || !connectionVerified} onPress={() => setReviewed(!reviewed)} style={[styles.row, { paddingVertical: 12, minHeight: 48 }]}>
                <View style={{ width: 25, height: 25, borderRadius: 6, borderWidth: 2, borderColor: colors.green, backgroundColor: reviewed ? colors.green : colors.white, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.white, fontWeight: '700' }}>{reviewed ? '✓' : ''}</Text></View>
                <Text style={[styles.body, { flex: 1 }]}>Ich habe die Website-Auswirkungen dieses Stands geprüft.</Text>
              </Pressable>
              <Button label="Jetzt veröffentlichen" testID="publish-content" busy={busy}
                disabled={!reviewed || !connectionVerified || (saved.channels.assignments.length === 0 && !saved.content.publication?.assignments.length)}
                onPress={() => Alert.alert('Geprüften Stand veröffentlichen?', `Stand ${saved.content.revision} wird für die zugeordneten Websites freigegeben.`, [
                  { text: 'Abbrechen', style: 'cancel' }, { text: 'Veröffentlichen', onPress: () => void publish() },
                ])} />
            </View>}
          </>}
    </View>}
  </View>;
}
