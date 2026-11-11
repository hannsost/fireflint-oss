import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { ContentObject, ContentType, FireFlintClient } from '../core';
import { Badge, Button, contentTitle, Loading, Notice } from './components';
import { userError } from './errors';
import { colors, styles } from './theme';

export function ContentBrowser({ client, onOpen }: {
  client: FireFlintClient; onOpen: (type: ContentType, content: ContentObject) => void;
}) {
  const [types, setTypes] = useState<ContentType[]>([]);
  const [type, setType] = useState<ContentType | null>(null);
  const [contents, setContents] = useState<ContentObject[]>([]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'draft' | 'published'>('all');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let valid = true;
    setLoading(true); setError('');
    void client.getTypes().then(next => {
      if (!valid) return;
      setTypes(next); setType(previous => next.find(item => item.key === previous?.key) ?? next[0] ?? null);
      if (!next.length) setLoading(false);
    }).catch(failure => { if (valid) { setError(userError(failure)); setLoading(false); } });
    return () => { valid = false; };
  }, [client, reload]);

  useEffect(() => {
    if (!type) return;
    let valid = true;
    setLoading(true); setError(''); setContents([]);
    void client.listContent(type.key, search).then(next => { if (valid) setContents(next); })
      .catch(failure => { if (valid) setError(userError(failure)); })
      .finally(() => { if (valid) setLoading(false); });
    return () => { valid = false; };
  }, [client, type, search, reload]);

  const shown = contents.filter(content => status === 'all' || content.status === status);
  return <View style={{ gap: 20 }}>
    <View style={{ gap: 8 }}>
      <Text style={styles.eyebrow}>Dein Arbeitsbereich</Text>
      <Text accessibilityRole="header" style={styles.title}>Gemeinsam gepflegt.{'\n'}Gezielt veröffentlicht.</Text>
      <Text style={styles.body}>Öffne einen Inhalt, prüfe den Entwurf und seine Auswirkungen auf die verbundenen Websites.</Text>
    </View>
    {!!error && <Notice error>{error}</Notice>}
    <View style={{ gap: 10 }}>
      <Text style={styles.label}>Inhaltstyp</Text>
      <View style={styles.row}>{types.map(item => <Button key={item.key} label={item.name} secondary={item.key !== type?.key}
        testID={`type-${item.key}`} onPress={() => { setType(item); setSearch(''); setQuery(''); }} />)}</View>
    </View>
    <View style={styles.field}>
      <Text style={styles.label}>Inhalte durchsuchen</Text>
      <TextInput testID="content-search" accessibilityLabel="Inhalte durchsuchen" value={query} onChangeText={setQuery}
        onSubmitEditing={() => setSearch(query.trim())} returnKeyType="search" style={styles.input} placeholder="Titel oder Text suchen" />
      <Button label="Suchen" secondary testID="search-submit" onPress={() => setSearch(query.trim())} />
    </View>
    <View style={styles.row}>
      {([['all', 'Alle'], ['draft', 'Entwürfe'], ['published', 'Veröffentlicht']] as const).map(([key, label]) =>
        <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: status === key }} onPress={() => setStatus(key)}
          style={{ borderBottomWidth: status === key ? 2 : 0, borderBottomColor: colors.green, minHeight: 46, paddingHorizontal: 9, justifyContent: 'center' }}>
          <Text style={[styles.label, { color: status === key ? colors.green : colors.muted }]}>{label}</Text>
        </Pressable>)}
    </View>
    {loading ? <Loading /> : shown.length ? <View style={{ gap: 12 }}>{shown.map(content => <Pressable key={content.id}
      testID={`content-${content.id}`} accessibilityRole="button" accessibilityLabel={`${contentTitle(content.data)}, ${content.publication ? 'veröffentlicht' : 'Entwurf'}`}
      onPress={() => { if (type) onOpen(type, content); }} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <Text style={styles.heading}>{contentTitle(content.data)}</Text>
      <View style={styles.row}><Badge draft={!content.publication}>{content.publication ? 'Veröffentlicht' : 'Entwurf'}</Badge>
        {content.has_unpublished_changes && content.publication && <Badge draft>Änderungen offen</Badge>}</View>
      <Text style={styles.muted}>Stand {content.revision} · Inhalt und Websites ansehen →</Text>
    </Pressable>)}</View> : <View style={styles.card}>
      <Text style={styles.heading}>{types.length ? 'Keine passenden Inhalte' : 'Noch keine Inhaltstypen'}</Text>
      <Text style={styles.body}>{types.length ? 'Ändere die Suche oder den Statusfilter. Neue Inhalte legst du in der Weboberfläche an.' : 'Richte den ersten Inhaltstyp und die Websites in der Weboberfläche ein.'}</Text>
    </View>}
    <Button label="Aktualisieren" secondary testID="refresh-content" disabled={loading} onPress={() => setReload(value => value + 1)} />
  </View>;
}
