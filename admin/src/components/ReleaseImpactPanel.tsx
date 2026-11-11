import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { compareWebsiteImpact, impactBlockReason, stableJson, type SavedChannels } from "../lib/releaseImpact";
import type { ContentObject, FieldDef, Website } from "../types";
import { UiIcon } from "./Brand";

const STATUS = { added: "Neu auf dieser Website", removed: "Wird zurückgezogen", changed: "Wird geändert", unchanged: "Bleibt unverändert" };

function Value({ value, present }: { value: unknown; present: boolean }) {
  if (!present) return <span className="impact-empty">Nicht vorhanden</span>;
  if (value === null) return <span className="impact-empty">Leerer Wert (null)</span>;
  if (value === "") return <span className="impact-empty">Leerer Text</span>;
  return <span className="impact-value">{typeof value === "object" ? stableJson(value) : String(value)}</span>;
}

export function ReleaseImpactPanel({ org, typeKey, object, fields, dirty, channelsDirty, busy, conflict, contentFetching, contentFailed }: {
  org: string; typeKey: string; object: ContentObject; fields: FieldDef[];
  dirty: boolean; channelsDirty: boolean; busy: boolean; conflict: boolean; contentFetching: boolean; contentFailed: boolean;
}) {
  const current = useQuery({
    queryKey: ["channels", org, typeKey, object.id],
    queryFn: () => api.get<SavedChannels>(`/api/orgs/${org}/content/${typeKey}/${object.id}/channels`),
  });
  const websites = useQuery({
    queryKey: ["websites", org],
    queryFn: () => api.get<Website[]>(`/api/orgs/${org}/websites`),
  });
  const blocked = impactBlockReason({ revision: object.revision, channels: current.data, dirty, channelsDirty,
    busy, conflict, fetching: contentFetching || current.isFetching, failed: contentFailed || current.isError });
  const impacts = blocked ? [] : compareWebsiteImpact(object.data, current.data!.assignments, object.publication);
  const changed = impacts.filter(impact => impact.status !== "unchanged").length;

  return <section id="website-impact" className={`panel release-impact${blocked ? " impact-blocked" : ""}`} aria-labelledby="release-impact-title" data-testid="release-impact">
    <div className="section-heading">
      <div><p className="eyebrow">VOR DER VERÖFFENTLICHUNG</p><h2 id="release-impact-title">Was ändert sich auf deinen Websites?</h2></div>
      <span className="section-icon"><UiIcon name="website" /></span>
    </div>
    {blocked ? <p className="impact-notice" role="status">{blocked}</p> : <>
      <p className="hint">Gespeicherter Vergleich · Stand {object.revision}. Prüfe die Werte je Website. Beim Veröffentlichen wird dieser Stand erneut abgeglichen.</p>
      {websites.isError && <p className="hint">Websitenamen sind gerade nicht verfügbar. Die Zuordnungen werden mit ihrer ID angezeigt.</p>}
      {impacts.length === 0 ? <div className="impact-notice"><strong>Noch keiner Website zugewiesen.</strong><p>Wähle unten in „Channels“ die Websites und speichere die Zuweisung. Ohne Zuweisung wird dieser Inhalt auf keiner Website ausgeliefert.</p></div> : <>
        <div className="impact-summary" role="status"><strong>{changed} von {impacts.length}</strong> {impacts.length === 1 ? "Website betroffen" : "Websites betroffen"}<span>Lokale Werte werden berücksichtigt.</span></div>
        <div className="impact-sites">{impacts.map(impact => {
          const website = websites.data?.find(site => site.id === impact.websiteId);
          const relevant = impact.fields.filter(field => field.changed || field.sourceChanged || field.localPreserved);
          const untouched = impact.fields.filter(field => !field.changed && !field.sourceChanged && !field.localPreserved);
          const renderFields = (rows: typeof impact.fields) => <div className="impact-fields">{rows.map(field => <div className={`impact-field${field.changed ? " field-changed" : ""}`} key={field.key}>
            <div className="impact-field-label"><strong>{fields.find(f => f.key === field.key)?.label || field.key}</strong>
              {field.localPreserved ? <span className="impact-local">Lokale Ausnahme bleibt</span>
                : field.sourceChanged ? <span className="impact-local">{field.afterLocal ? "Künftig lokal gepflegt" : "Künftig zentral gepflegt"}</span>
                  : field.afterLocal ? <span className="impact-local">Lokaler Wert</span> : null}</div>
            <div className="impact-values"><div><span className="impact-value-label">Bisher öffentlich{field.beforeLocal ? " · lokal" : ""}</span><Value value={field.before} present={field.beforePresent} /></div>
              <span className="impact-direction"><UiIcon name="arrow" /></span>
              <div><span className="impact-value-label">Nach Veröffentlichung{field.afterLocal ? " · lokal" : ""}</span><Value value={field.after} present={field.afterPresent} /></div></div>
          </div>)}</div>;
          return <article key={impact.websiteId} className={`impact-site impact-${impact.status}`} aria-label={website?.name ?? impact.websiteId}>
            <div className="impact-site-heading"><div><h3>{website?.name ?? impact.websiteId}</h3>{website?.domain && <span className="hint">{website.domain}</span>}</div><span className={`impact-status status-${impact.status}`}>{STATUS[impact.status]}</span></div>
            {impact.status === "removed" && <p className="impact-notice">Mit dieser Veröffentlichung wird der Inhalt von dieser Website zurückgezogen.</p>}
            {renderFields(relevant)}
            {untouched.length > 0 && <details className="impact-unchanged"><summary>{untouched.length} {untouched.length === 1 ? "unverändertes Feld" : "unveränderte Felder"} ansehen</summary>{renderFields(untouched)}</details>}
            {impact.fields.length === 0 && <p className="hint">Dieser Inhalt enthält noch keine Felder.</p>}
          </article>;
        })}</div>
      </>}
      <p className="impact-footnote">Der Vergleich zeigt die Content-Ausgabe. Websites übernehmen sie entsprechend ihrer Cache- und Aktualisierungseinstellungen.</p>
    </>}
    {current.isError && <button onClick={() => current.refetch()} disabled={current.isFetching}>Website-Zuordnungen erneut laden</button>}
  </section>;
}
