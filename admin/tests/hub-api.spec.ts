import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { apiUrl, expect, json, test } from "./local-fixture";
import { spawnTestSql, testSql } from "./test-environment";

const password="Hub-Test-2026!Isolated";
function record(name="Acme") {return {kind:"company",name,data:{legal_name:name},expected_revision:0};}
function update(value:any,data:Record<string,unknown>={}) {return {kind:value.kind,name:value.name,data:value.data,archived:value.archived,source_id:value.source_id,external_id:value.external_id,expected_revision:value.revision,...data};}
function scoped(org:string) {expect(org).toMatch(/^[0-9a-f-]{36}$/);return org;}
function state(org:string) {return testSql(`SELECT jsonb_build_object('records',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM hub_records r WHERE org_id='${scoped(org)}'),'events',(SELECT count(*) FROM hub_events WHERE org_id='${org}'),'versions',(SELECT count(*) FROM hub_versions WHERE org_id='${org}'));`);}
async function enable(request:APIRequestContext,root:string,token:string,...keys:string[]) {
  for(const key of keys) await json(request,`${root}/hub/modules/${key}`,token,"PUT",{enabled:true,expected_revision:0});
}
async function member(request:APIRequestContext,local:any,role="editor") {
  const email=`steward-e2e-${randomUUID()}@example.test`;
  const result=await json(request,`${local.root}/members`,local.token,"POST",{email,name:role,role,password});
  const response=await request.post(`${apiUrl}/auth/login`,{data:{email,password}});
  expect(response.status()).toBe(200);const auth=await response.json();local.users.push(auth.user.id);
  return {id:auth.user.id,token:auth.access_token,email,result};
}
async function race(org:string,send:()=>Promise<APIResponse>[]) {
  const locker=spawnTestSql();const close=once(locker,"close");let output="";
  const ready=new Promise<void>((resolve,reject)=>{locker.stdout.on("data",chunk=>{output+=String(chunk);if(output.includes("HUB_LOCKED"))resolve();});locker.on("error",reject);});
  locker.stderr.resume();let calls:Promise<APIResponse>[]=[];
  try {
    locker.stdin.write(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('${scoped(org)}',76102)); SELECT 'HUB_LOCKED';\n`);await ready;
    calls=send();
    await expect.poll(()=>Number(testSql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%';"))).toBe(calls.length);
  } finally {locker.stdin.end("ROLLBACK;\n\\q\n");await close;await Promise.allSettled(calls);}
  return Promise.all(calls);
}

test("Module prüfen Abhängigkeiten, Rechte, Revision und Datenerhalt im Backend",async({request,local})=>{
  const base=`${local.root}/hub`;const headers={Authorization:`Bearer ${local.token}`};
  expect((await request.put(`${apiUrl}${base}/modules/work`,{headers,data:{enabled:true,expected_revision:0}})).status()).toBe(400);
  await enable(request,local.root,local.token,"notifications","work","forms");
  expect((await request.put(`${apiUrl}${base}/modules/notifications`,{headers,data:{enabled:false,expected_revision:1}})).status()).toBe(400);
  expect((await request.put(`${apiUrl}${base}/modules/directory`,{headers,data:{enabled:false,expected_revision:0}})).status()).toBe(400);
  const viewer=await member(request,local,"viewer");const editor=await member(request,local);
  for(const token of [viewer.token,editor.token])expect((await request.put(`${apiUrl}${base}/modules/forms`,{headers:{Authorization:`Bearer ${token}`},data:{enabled:false,expected_revision:1}})).status()).toBe(403);
  const form=await json(request,`${base}/forms`,local.token,"POST",{name:"Anfrage",fields:[{key:"name",label:"Name",kind:"text",required:true}]});
  await json(request,`${base}/modules/forms`,local.token,"PUT",{enabled:false,expected_revision:1});
  expect((await request.get(`${apiUrl}${base}/forms`,{headers})).status()).toBe(400);
  expect(testSql(`SELECT count(*) FROM hub_forms WHERE org_id='${scoped(local.org)}' AND id='${form.id}';`)).toBe("1");
  await json(request,`${base}/modules/forms`,local.token,"PUT",{enabled:true,expected_revision:2});
  expect((await json(request,`${base}/forms`,local.token))[0].id).toBe(form.id);
});

test("Stammdaten sind privat, validiert, revisionsgeschützt und historisiert",async({request,local})=>{
  const base=`${local.root}/hub`;const headers={Authorization:`Bearer ${local.token}`};
  const r=await json(request,`${base}/records`,local.token,"POST",record());
  expect((await request.get(`${apiUrl}${base}/records/${r.id}`,{headers})).headers()["cache-control"]).toBe("private, no-store");
  expect((await request.get(`${apiUrl}${base}/records/${r.id}`)).status()).toBe(401);
  const before=state(local.org);
  for(const data of [{...update(r),expected_revision:undefined},{...update(r),expected_revision:9},{...update(r),data:{legal_name:"X",admin:true}},{...update(r),data:{legal_name:"X",email:"a@@b.test"}},{...update(r),data:{legal_name:"X",website:"http://#"}}]) {
    expect((await request.put(`${apiUrl}${base}/records/${r.id}`,{headers,data})).status()).toBeGreaterThanOrEqual(400);
    expect(state(local.org)).toBe(before);
  }
  const results=await race(local.org,()=>[1,2].map(n=>request.put(`${apiUrl}${base}/records/${r.id}`,{headers,data:update(r,{name:`Autor ${n}`})})));
  expect(results.map(r=>r.status()).sort()).toEqual([200,409]);
  expect((await json(request,`${base}/records/${r.id}/history`,local.token)).map((v:any)=>v.revision)).toEqual([2,1]);
  const viewer=await member(request,local,"viewer");
  expect((await request.post(`${apiUrl}${base}/records`,{headers:{Authorization:`Bearer ${viewer.token}`},data:record("Verboten")})).status()).toBe(403);
});

test("Beziehungen ändern die Quellrevision, erhalten Historie und verweigern fremde IDs",async({request,local})=>{
  const base=`${local.root}/hub`;const headers={Authorization:`Bearer ${local.token}`};
  let a=await json(request,`${base}/records`,local.token,"POST",record("A"));const b=await json(request,`${base}/records`,local.token,"POST",record("B"));
  a=await json(request,`${base}/records/${a.id}/links`,local.token,"POST",{to_id:b.id,relation:"subsidiary",expected_revision:1});
  expect(a.revision).toBe(2);expect(a.links).toHaveLength(1);expect(a.links[0].from_revision).toBe(2);
  expect((await request.post(`${apiUrl}${base}/records/${a.id}/links`,{headers,data:{to_id:b.id,relation:"partner",expected_revision:1}})).status()).toBe(409);
  expect((await request.post(`${apiUrl}${base}/records/${a.id}/links`,{headers,data:{to_id:randomUUID(),relation:"partner",expected_revision:2}})).status()).toBe(404);
  await json(request,`${base}/links/${a.links[0].id}`,local.token,"DELETE",{expected_revision:2});
  expect((await json(request,`${base}/records/${a.id}`,local.token)).revision).toBe(3);
  const history=await json(request,`${base}/records/${a.id}/history`,local.token);expect(history[1].snapshot.links).toHaveLength(1);
});

test("Importvorschau bleibt ohne Schreibwirkung; Übernahme ist atomar und idempotent",async({request,local})=>{
  const base=`${local.root}/hub`;const headers={Authorization:`Bearer ${local.token}`};await enable(request,local.root,local.token,"integrations");
  const source=await json(request,`${base}/records`,local.token,"POST",{kind:"source",name:"CRM",data:{name:"CRM",system:"Test"}});
  const input={source_id:source.id,request_key:randomUUID(),rows:[{external_id:"c1",name:"Company",kind:"company",data:{legal_name:"Company"},expected_revision:0}]};
  const before=state(local.org);const preview=await json(request,`${base}/import/preview`,local.token,"POST",input);expect(preview.rows[0].conflict).toBe(false);expect(state(local.org)).toBe(before);
  const applied=await json(request,`${base}/import/apply`,local.token,"POST",input);const after=state(local.org);
  expect(await json(request,`${base}/import/apply`,local.token,"POST",input)).toEqual(applied);expect(state(local.org)).toBe(after);
  expect((await request.post(`${apiUrl}${base}/import/apply`,{headers,data:{...input,rows:[{...input.rows[0],name:"Different"}]}})).status()).toBe(400);
  const mixed={...input,request_key:randomUUID(),rows:[{...input.rows[0],external_id:"c2"},input.rows[0]]};
  expect((await request.post(`${apiUrl}${base}/import/apply`,{headers,data:mixed})).status()).toBe(409);expect(state(local.org)).toBe(after);
});

test("Formulare binden Einreichungen an Versionen und deduplizieren Wiederholungen",async({request,local})=>{
  const base=`${local.root}/hub`;await enable(request,local.root,local.token,"forms");
  const fields=[{key:"email",label:"E-Mail",kind:"email",required:true}];
  let form=await json(request,`${base}/forms`,local.token,"POST",{name:"Kontakt",description:"Erste Fassung",fields,published:true});
  const url=`${apiUrl}/forms/${form.public_id}`;const body={expected_revision:1,submission_key:randomUUID(),data:{email:"ada@example.test"}};
  const first=await request.post(url,{data:body});expect(first.status()).toBe(200);const receipt=await first.json();
  expect(await (await request.post(url,{data:body})).json()).toEqual(receipt);
  expect((await request.post(url,{data:{...body,submission_key:randomUUID(),data:{email:"wrong"}}})).status()).toBe(400);
  expect((await request.post(url,{data:{...body,submission_key:randomUUID(),data:{email:"ada@example.test",admin:true}}})).status()).toBe(400);
  expect((await request.post(url,{data:{...body,submission_key:randomUUID(),website:"bot"}})).status()).toBe(400);
  form=await json(request,`${base}/forms/${form.id}`,local.token,"PUT",{name:"Kontakt neu",description:"Zweite Fassung",fields,published:true,expected_revision:1});
  expect((await request.post(url,{data:{...body,submission_key:randomUUID()}})).status()).toBe(409);
  expect(await (await request.post(url,{data:body})).json()).toEqual(receipt);
  const submissions=await json(request,`${base}/forms/${form.id}/submissions`,local.token);expect(submissions).toHaveLength(1);expect(submissions[0].form_snapshot.description).toBe("Erste Fassung");
  expect((await json(request,`${base}/forms/${form.id}/history`,local.token))).toHaveLength(2);
  expect(testSql(`SELECT count(*) FROM hub_events WHERE org_id='${scoped(local.org)}' AND event_type='de.fireflint.form.submitted' AND actor_id IS NULL;`)).toBe("1");
  await json(request,`${base}/modules/forms`,local.token,"PUT",{enabled:false,expected_revision:1});
  expect((await request.get(url)).status()).toBe(404);expect((await request.post(url,{data:body})).status()).toBe(404);
});

test("Freigaben benötigen zweite Person und exakt geprüften Datensatz",async({request,local})=>{
  const base=`${local.root}/hub`;await enable(request,local.root,local.token,"notifications","work");const editor=await member(request,local);
  const r=await json(request,`${base}/records`,local.token,"POST",record());
  const task=await json(request,`${base}/tasks`,local.token,"POST",{title:"Prüfen",assignee_id:editor.id,record_id:r.id,subject_revision:1,requires_approval:true});
  const headers={Authorization:`Bearer ${local.token}`};
  expect((await request.post(`${apiUrl}${base}/tasks/${task.id}/decision`,{headers,data:{status:"approved",expected_revision:1}})).status()).toBe(403);
  await json(request,`${base}/records/${r.id}`,local.token,"PUT",update(r,{name:"Neuer Stand"}));
  expect((await request.post(`${apiUrl}${base}/tasks/${task.id}/decision`,{headers:{Authorization:`Bearer ${editor.token}`},data:{status:"approved",expected_revision:1}})).status()).toBe(409);
  const next=await json(request,`${base}/tasks`,local.token,"POST",{title:"Neuen Stand prüfen",assignee_id:editor.id,record_id:r.id,subject_revision:2,requires_approval:true});
  expect((await json(request,`${base}/tasks/${next.id}/decision`,editor.token,"POST",{status:"approved",expected_revision:1})).status).toBe("approved");
  const notices=await json(request,`${base}/notifications`,editor.token);expect(notices).toHaveLength(2);
  expect((await request.post(`${apiUrl}${base}/notifications/${notices[0].id}/read`,{headers})).status()).toBe(404);
  await json(request,`${base}/notifications/${notices[0].id}/read`,editor.token,"POST",{});
  await json(request,`${base}/notifications/${notices[0].id}/read`,editor.token,"POST",{});
});

test("Übersetzungen markieren veraltete Quellen und behalten geprüfte Revisionen",async({request,local})=>{
  const base=`${local.root}/hub`;await enable(request,local.root,local.token,"translations");const r=await json(request,`${base}/records`,local.token,"POST",record());
  const input={locale:"en-GB",source_revision:1,data:{legal_name:"Acme English"},expected_revision:0};
  await json(request,`${base}/records/${r.id}/translations`,local.token,"POST",input);
  expect((await json(request,`${base}/records/${r.id}/translations`,local.token))[0]).toMatchObject({locale:"en-gb",stale:false});
  await json(request,`${base}/records/${r.id}`,local.token,"PUT",update(r,{name:"Neu"}));
  expect((await json(request,`${base}/records/${r.id}/translations`,local.token))[0].stale).toBe(true);
  expect((await request.post(`${apiUrl}${base}/records/${r.id}/translations`,{headers:{Authorization:`Bearer ${local.token}`},data:{...input,expected_revision:1}})).status()).toBe(409);
});

test("PostgreSQL verhindert doppelte Ressourcenbelegung und erlaubt angrenzende Termine",async({request,local})=>{
  const base=`${local.root}/hub`;await enable(request,local.root,local.token,"booking");const headers={Authorization:`Bearer ${local.token}`};
  expect((await request.post(`${apiUrl}${base}/records`,{headers,data:{kind:"resource",name:"Bad",data:{name:"Bad",timezone:"Mars/City"}}})).status()).toBe(400);
  const r=await json(request,`${base}/records`,local.token,"POST",{kind:"resource",name:"Raum",data:{name:"Raum",timezone:"Europe/Berlin"}});
  const body={resource_id:r.id,title:"Besprechung",starts_at:"2099-01-01T09:00:00Z",ends_at:"2099-01-01T10:00:00Z"};
  const responses=await race(local.org,()=>[1,2].map(()=>request.post(`${apiUrl}${base}/bookings`,{headers,data:body})));
  expect(responses.map(r=>r.status()).sort()).toEqual([200,400]);
  await json(request,`${base}/bookings`,local.token,"POST",{...body,starts_at:body.ends_at,ends_at:"2099-01-01T11:00:00Z"});
  expect((await request.put(`${apiUrl}${base}/records/${r.id}`,{headers,data:update(r,{archived:true})})).status()).toBe(400);
  const booking=await responses.find(r=>r.status()===200)!.json();
  await json(request,`${base}/bookings/${booking.id}`,local.token,"PUT",{...body,cancelled:true,expected_revision:1});
  await json(request,`${base}/bookings`,local.token,"POST",body);
  expect((await request.put(`${apiUrl}${base}/bookings/${booking.id}`,{headers,data:{...body,cancelled:true,expected_revision:1}})).status()).toBe(409);
});

test("Eigene Datentypen wachsen kompatibel und bleiben organisationsgebunden",async({request,local})=>{
  const base=`${local.root}/hub`;const headers={Authorization:`Bearer ${local.token}`};
  const fields=[{key:"serial",label:"Seriennummer",kind:"text",required:true}];
  const schema={key:"equipment",name:"Geräte",fields,expected_revision:0};
  await json(request,`${base}/kinds`,local.token,"PUT",schema);
  const r=await json(request,`${base}/records`,local.token,"POST",{kind:"equipment",name:"Gerät A",data:{serial:"A-42"},expected_revision:0});
  expect((await json(request,`${base}/records?kind=equipment`,local.token)).items[0].id).toBe(r.id);
  const before=state(local.org);
  for(const next of [{...schema,expected_revision:1,fields:[]},{...schema,expected_revision:1,fields:[{...fields[0],kind:"number"}]},{...schema,expected_revision:1,fields:[...fields,{key:"owner",label:"Zuständig",kind:"text",required:true}]}]) {
    expect((await request.put(`${apiUrl}${base}/kinds`,{headers,data:next})).status()).toBe(400);
    expect(state(local.org)).toBe(before);
  }
  const grown={...schema,expected_revision:1,fields:[...fields,{key:"owner",label:"Zuständig",kind:"text",required:false}]};
  await json(request,`${base}/kinds`,local.token,"PUT",grown);
  expect((await request.put(`${apiUrl}${base}/kinds`,{headers,data:grown})).status()).toBe(409);
  await json(request,`${base}/records/${r.id}`,local.token,"PUT",update(r,{data:{serial:"A-42",owner:"Ada"}}));
  const editor=await member(request,local);
  expect((await request.put(`${apiUrl}${base}/kinds`,{headers:{Authorization:`Bearer ${editor.token}`},data:{...grown,expected_revision:2}})).status()).toBe(403);
});

test("Bekannte fremde IDs erlauben weder Lesen noch Beziehungen, Imports oder Aufgaben",async({request,local})=>{
  const base=`${local.root}/hub`;const headers={Authorization:`Bearer ${local.token}`};
  const name=`Steward E2E isolation ${randomUUID()}`;
  const foreign=await json(request,"/api/orgs",local.token,"POST",{name});scoped(foreign.id);
  const other=`/api/orgs/${foreign.id}`;
  try {
    await enable(request,local.root,local.token,"integrations","notifications","work","booking","translations");
    await enable(request,other,local.token,"integrations","booking");
    const ours=await json(request,`${base}/records`,local.token,"POST",record("Unser Unternehmen"));
    const theirs=await json(request,`${other}/hub/records`,local.token,"POST",record("Fremde Daten"));
    const source=await json(request,`${other}/hub/records`,local.token,"POST",{kind:"source",name:"CRM",data:{name:"CRM",system:"CRM"}});
    const resource=await json(request,`${other}/hub/records`,local.token,"POST",{kind:"resource",name:"Raum",data:{name:"Raum",timezone:"UTC"}});
    const editor=await member(request,local);const before=state(local.org),otherBefore=state(foreign.id);
    expect((await request.get(`${apiUrl}${other}/hub/records/${theirs.id}`,{headers:{Authorization:`Bearer ${editor.token}`}})).status()).toBe(403);
    for(const path of [`records/${theirs.id}`,`records/${theirs.id}/history`,`records/${theirs.id}/translations`])expect((await request.get(`${apiUrl}${base}/${path}`,{headers})).status()).toBe(404);
    for(const [path,data] of [
      [`records/${ours.id}/links`,{to_id:theirs.id,relation:"partner",expected_revision:1}],
      ["records",{...record("Leak"),source_id:source.id,external_id:"x"}],
      ["import/apply",{source_id:source.id,request_key:randomUUID(),rows:[{external_id:"x",...record()}]}],
      ["tasks",{title:"Prüfen",assignee_id:editor.id,record_id:theirs.id,subject_revision:1,requires_approval:true}],
      ["bookings",{resource_id:resource.id,title:"Fremder Raum",starts_at:"2099-02-01T09:00:00Z",ends_at:"2099-02-01T10:00:00Z"}],
    ] as [string,unknown][]) expect((await request.post(`${apiUrl}${base}/${path}`,{headers,data})).status()).toBe(404);
    expect(state(local.org)).toBe(before);expect(state(foreign.id)).toBe(otherBefore);
  } finally {testSql(`DELETE FROM organizations WHERE id='${foreign.id}' AND name='${name}';`);}
});

test("Medienverwendung verhindert Löschen bis zur revisionsgeprüften Freigabe",async({request,local})=>{
  await enable(request,local.root,local.token,"media");const base=`${local.root}/hub`;const headers={Authorization:`Bearer ${local.token}`};
  const upload=await request.post(`${apiUrl}${local.root}/assets`,{headers,multipart:{file:{name:"isolated.txt",mimeType:"text/plain",buffer:Buffer.from("Isolated hub test document.")}}});
  expect(upload.status()).toBe(200);const asset=await upload.json();
  const r=await json(request,`${base}/records`,local.token,"POST",record());
  const metadata={title:"Dokument",alt_text:"",credit:"Test",license:"Test",collection:"Abnahme",record_ids:[r.id],expected_revision:0};
  await json(request,`${base}/media/${asset.id}`,local.token,"PUT",metadata);
  expect((await request.delete(`${apiUrl}${local.root}/assets/${asset.id}`,{headers})).status()).toBe(400);
  expect((await request.put(`${apiUrl}${base}/media/${asset.id}`,{headers,data:{...metadata,record_ids:[]}})).status()).toBe(409);
  expect((await json(request,`${base}/media`,local.token))[0].record_ids).toEqual([r.id]);
  expect(testSql(`SELECT count(*) FROM hub_media_versions WHERE org_id='${scoped(local.org)}' AND asset_id='${asset.id}';`)).toBe("1");
  await json(request,`${base}/media/${asset.id}`,local.token,"PUT",{...metadata,record_ids:[],expected_revision:1});
  await json(request,`${local.root}/assets/${asset.id}`,local.token,"DELETE");
});
