import { Link, useParams, useSearchParams } from "react-router-dom";
import { Empty, ErrorNotice, PageTitle, Pager, ValueView, formatDate, useHub, useHubQuery, type HubRecord, type RecordPage } from "./common";

interface Dossier extends RecordPage { company: HubRecord }
function originalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function CompanyDossier() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const rawOffset = Number(params.get("offset") ?? 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const { contracts, canWrite } = useHub();
  const result = useHubQuery<Dossier>("company-dossier", `/companies/${id}/dossier?offset=${offset}`, !!id);
  const definition = contracts.data?.kinds.find(k => k.key === "company");
  const dossier = result.data;
  return <>
    <Link className="hub-back" to="/hub/records/company">Alle Unternehmen</Link>
    <PageTitle title={dossier ? `${dossier.company.name} · Unternehmensakte` : "Unternehmensakte"}
      description="Stammdaten, Kontakte, Standorte, Leistungen und Dokumente aus ausdrücklich gepflegten Beziehungen.">
      {dossier && <Link className="button" to={`/hub/records/company/${id}`}>{canWrite ? "Stammdaten und Beziehungen pflegen" : "Stammdaten und Beziehungen ansehen"}</Link>}
    </PageTitle>
    <ErrorNotice error={result.error || contracts.error} onReload={() => { void result.refetch(); void contracts.refetch(); }} />
    {result.isPending && <p role="status">Unternehmensakte wird geladen…</p>}
    {dossier && <>
      {dossier.company.archived && <p className="hub-warning">Dieses Unternehmen ist archiviert. Die Akte zeigt weiterhin seine aktiven Verknüpfungen.</p>}
      <section className="panel"><h2>Unternehmensdaten</h2>
        {definition && <ValueView fields={definition.fields} data={dossier.company.data} />}
        <p className="hint">Stand {dossier.company.revision} · {formatDate(dossier.company.updated_at)}</p>
        {dossier.company.source_id && <Link to={`/hub/records/source/${dossier.company.source_id}`}>Herkunft der Unternehmensdaten ansehen</Link>}
      </section>
      <section className="panel"><h2>Verknüpfte Informationen · {dossier.total}</h2>
        <p className="hint">Aktive Datensätze aus eingeschalteten Modulen. Gleiche Namen erzeugen keine automatische Zuordnung. Dokumentmetadaten zeigen den zuletzt übernommenen Stand; Originale öffnest du mit deinem eigenen Nextcloud-Zugang.</p>
        {dossier.items.length === 0 && <Empty>{offset ? "Auf dieser Seite gibt es keine Verknüpfungen." : "Noch keine aktiven Verknüpfungen. Kontakte oder Dokumentverweise lassen sich bei den Stammdaten unter Beziehungen zuordnen."}</Empty>}
        <div className="hub-card-grid">{dossier.items.map(row => {
          const kind = contracts.data?.kinds.find(k => k.key === row.kind);
          const document = row.kind === "external_document";
          const url = document ? originalUrl(row.data.url) : null;
          return <article className="panel hub-tool" key={row.id}>
            <p className="eyebrow">{kind?.name ?? row.kind}</p>
            <h3><Link to={`/hub/records/${row.kind}/${row.id}`}>{row.name}</Link></h3>
            {document ? <>
              <p>{String(row.data.mime_type || "Dateityp nicht angegeben")}{typeof row.data.size_bytes === "number" ? ` · ${row.data.size_bytes.toLocaleString("de-DE")} Bytes` : ""}</p>
              <p className="hint">Quellstand: {formatDate(String(row.data.source_modified_at || ""))}</p>
              {url && <a className="button" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Original in Nextcloud öffnen ↗</a>}
            </> : kind && <ValueView fields={kind.fields.filter(f => ["email", "phone", "position", "address", "sku", "website"].includes(f.key))} data={row.data} />}
            <p className="hint">FireFlint-Stand {row.revision} · {formatDate(row.updated_at)}</p>
            {row.source_id && <Link to={`/hub/records/source/${row.source_id}`}>Datenquelle ansehen</Link>}
          </article>;
        })}</div>
        <Pager offset={offset} count={dossier.items.length} total={dossier.total} pageSize={50} onChange={value => setParams({ offset: String(value) })} />
      </section>
    </>}
  </>;
}
