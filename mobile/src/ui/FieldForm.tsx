import { Text, TextInput, View } from 'react-native';
import type { ContentType } from '../core';
import { displayValue } from './components';
import { styles } from './theme';

type Data = Record<string, unknown>;

export function FieldForm({ type, data, editable, onChange }: {
  type: ContentType; data: Data; editable: boolean; onChange: (next: Data) => void;
}) {
  const fields = type.schema.fields ?? [];
  const known = new Set(fields.map(field => field.key));
  return <View style={{ gap: 20 }}>
    {fields.map(field => {
      const raw = data[field.key];
      const scalar = raw === null || raw === undefined || typeof raw === 'string' || typeof raw === 'number';
      const supported = scalar && ['text', 'date', 'number'].includes(field.type);
      const label = `${field.label || field.key}${field.required ? ' *' : ''}`;
      return <View style={styles.field} key={field.key}>
        <Text style={styles.label}>{label}</Text>
        {supported && editable ? <TextInput testID={`field-${field.key}`} accessibilityLabel={label}
          value={raw == null ? '' : String(raw)} editable={editable}
          autoCapitalize={field.type === 'date' ? 'none' : 'sentences'}
          keyboardType={field.type === 'number' ? 'numbers-and-punctuation' : 'default'}
          placeholder={field.type === 'date' ? 'JJJJ-MM-TT' : undefined}
          style={styles.input} onChangeText={value => {
            // Keep incomplete numeric input in the draft. Submission validates it;
            // silently converting an unfinished value to zero would lose intent.
            onChange({ ...data, [field.key]: value });
          }} /> : <View style={styles.readonly}><Text selectable style={styles.body}>{displayValue(raw)}</Text></View>}
        {!supported && <Text style={styles.muted}>Dieses Feld bleibt unverändert. Bearbeite es bei Bedarf in der Weboberfläche.</Text>}
      </View>;
    })}
    {Object.keys(data).filter(key => !known.has(key)).map(key => <View key={key} style={styles.field}>
      <Text style={styles.label}>{key}</Text><View style={styles.readonly}><Text selectable style={styles.body}>{displayValue(data[key])}</Text></View>
      <Text style={styles.muted}>Zusätzliches Feld · wird unverändert erhalten</Text>
    </View>)}
    {!fields.length && !Object.keys(data).length && <Text style={styles.muted}>Dieser Inhalt besitzt noch keine Felder.</Text>}
  </View>;
}

export function prepareData(type: ContentType, draft: Data): Data {
  const next = { ...draft };
  for (const field of type.schema.fields ?? []) {
    if (['text', 'date', 'number'].includes(field.type) && field.required && (next[field.key] === undefined || next[field.key] === null || next[field.key] === '')) {
      throw new Error(`Bitte fülle „${field.label || field.key}“ aus.`);
    }
    const value = next[field.key];
    if (field.type === 'number' && typeof value === 'string' && value !== '') {
      const number = Number(value.trim());
      if (!value.trim() || !Number.isFinite(number)) throw new Error(`„${field.label || field.key}“ benötigt eine gültige Zahl.`);
      next[field.key] = number;
    }
    if (field.type === 'date' && typeof value === 'string' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`Verwende für „${field.label || field.key}“ das Format JJJJ-MM-TT.`);
    }
  }
  return next;
}
