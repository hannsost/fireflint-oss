import { Text, View } from 'react-native';
import { websiteImpacts, type ContentObject, type FireFlintClient, type Website } from '../core';
import { Badge, displayValue } from './components';
import { colors, styles } from './theme';

type Channels = Awaited<ReturnType<FireFlintClient['getChannels']>>;
const kindLabel = { added: 'Neu auf dieser Website', removed: 'Wird von Website entfernt', changed: 'Änderungen', unchanged: 'Unverändert' };

export function WebsiteComparison({ content, channels, websites }: {
  content: ContentObject; channels: Channels; websites: Website[];
}) {
  const impacts = websiteImpacts(content, channels, websites);
  return <View style={{ gap: 16 }}>
    <View style={{ gap: 6 }}>
      <Text style={styles.heading}>Auswirkungen auf Websites</Text>
      <Text style={styles.muted}>Gespeicherter Stand {content.revision}. Lokale Ausnahmen ersetzen den jeweiligen zentralen Wert. Website-Caches können Änderungen verzögert anzeigen.</Text>
    </View>
    {!impacts.length && <View style={styles.card}>
      <Text style={styles.heading}>Noch keiner Website zugeordnet</Text>
      <Text style={styles.body}>Ordne den Inhalt in der Weboberfläche einer Website zu. Die App ändert keine Zuordnungen oder lokalen Ausnahmen.</Text>
    </View>}
    {impacts.map(impact => <View key={impact.websiteId} style={styles.card} testID={`website-${impact.websiteId}`}>
      <Text style={styles.heading}>{impact.name}</Text><Badge draft={impact.kind !== 'unchanged'}>{kindLabel[impact.kind]}</Badge>
      {[...new Set([...Object.keys(impact.before ?? {}), ...Object.keys(impact.after ?? {})])].map(key => <View key={key} style={{ gap: 7, paddingTop: 8 }}>
        <Text style={styles.label}>{key}</Text>
        <View style={{ borderLeftWidth: 3, borderLeftColor: colors.line, paddingLeft: 11, gap: 3 }}>
          <Text style={styles.muted}>Bisher öffentlich</Text>
          <Text selectable style={styles.body}>{impact.before ? displayValue(impact.before[key]) : 'Nicht auf dieser Website'}</Text>
        </View>
        <View style={{ borderLeftWidth: 3, borderLeftColor: colors.green, paddingLeft: 11, gap: 3 }}>
          <Text style={[styles.muted, { color: colors.green }]}>Nach Veröffentlichung{Object.prototype.hasOwnProperty.call(impact.overrides, key) ? ' · lokale Ausnahme' : ' · zentral'}</Text>
          <Text selectable style={styles.body}>{impact.after ? displayValue(impact.after[key]) : 'Nicht mehr auf dieser Website'}</Text>
        </View>
      </View>)}
    </View>)}
  </View>;
}
