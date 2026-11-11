# FireFlint EDI

Modulares EDI-Gateway-Gerüst für den elektronischen Geschäftsdatenverkehr mit
Trading Partnern, Behörden, Lieferanten, Kunden und Logistikdienstleistern.

## Standards und Transporte

- UN/EDIFACT, unter anderem ORDERS, ORDRSP, DESADV, INVOIC und CONTRL
- ANSI ASC X12, unter anderem 850, 855, 856, 810, 997 und 999
- UBL und CII
- Peppol BIS und XRechnung
- AS2, SFTP, Peppol, API, VAN und Dateiaustausch

Standardversionen und Implementierungsrichtlinien werden nicht hart verdrahtet.
Sie gehören in eine versionierte Trading-Partner-Vereinbarung.

## Enthalten

- Partner, Identifikatoren, Endpunkte und Vereinbarungen
- Message-Profile, Versionen, Code- und Schema-Referenzen
- Parser-, Serializer-, Validator- und Mapping-Ports
- Canonical Document Model
- Routing, Signatur, Verschlüsselung und Transport
- CONTRL, APERAK, 997, 999 und Peppol/Application Responses
- Duplikaterkennung, Idempotenz, Quarantäne und Replay
- unveränderliche Rohdatenarchivierung
- Processing Attempts, Events, Metriken und Tracing
- Supply-Chain-, Retail- und Public-Sector-Profile
- In-Memory-Sandbox und Ende-zu-Ende-Szenarien

## Referenz-Sandbox

```ts
import {
  createReferenceEdi,
  referenceEdiContext,
  referenceEnvelope,
  supplyChainEdiProfile,
} from "@sitegraph/edi";

const { sandbox } = await createReferenceEdi(supplyChainEdiProfile);
const result = await sandbox.processInbound(
  referenceEdiContext(),
  referenceEnvelope("edifact-orders"),
);
```

Die Sandbox ist kein produktiver EDI-Konverter. Ihre Parser und Validatoren
erkennen nur die mitgelieferten Referenznachrichten.

## Prüfung

```bash
npm run build
npm test
```

Die Szenarien sind fachliche Akzeptanzkriterien. Parser, Persistenz,
Kryptografie, Transporte und Standardartefakte müssen später durch produktive
Provider ersetzt werden.
