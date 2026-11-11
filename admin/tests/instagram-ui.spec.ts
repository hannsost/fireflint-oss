import { test, expect, type Page } from "@playwright/test";

const org="11111111-1111-4111-8111-111111111111", site="22222222-2222-4222-8222-222222222222", content="33333333-3333-4333-8333-333333333333";
const image=`/assets/${org}/44444444-4444-4444-8444-444444444444`;
async function workspace(page:Page,options:{role?:string;configured?:boolean;connected?:boolean;badRedirect?:boolean;publication?:boolean;unknownPrepare?:boolean;mode?:"instagram_login"|"unified";forever?:boolean;reconnect?:boolean;pending?:boolean}={}) {
  const writes:{path:string;body:unknown;key?:string}[]=[];
  let attempts=0; let chosen=false;
  const job={id:"55555555-5555-4555-8555-555555555555",content_id:content,content_revision:7,state:"prepared",revision:2,container_id:"123456",media_id:null,error_code:null,created_at:"2026-11-07T18:00:00Z",payload:{caption:"Explicit Instagram caption",image_url:`http://127.0.0.1:15175${image}`,alt:"A synthetic image"}};
  await page.addInitScript(({org})=>{localStorage.setItem("sg.access","synthetic-instagram-ui-only");localStorage.setItem("sg.org",org);},{org});
  await page.route(url=>url.pathname.startsWith("/api/")||url.pathname.startsWith("/auth/"),async route=>{
    const path=new URL(route.request().url()).pathname,method=route.request().method(),root=`/api/orgs/${org}`;
    const reply=(data:unknown,status=200)=>route.fulfill({status,json:data});
    if(method!=="GET")writes.push({path,body:route.request().postDataJSON(),key:route.request().headers()["idempotency-key"]});
    if(path==="/api/me")return reply({user:{id:"user",email:"synthetic@example.test",name:"Fixture"},memberships:[{org_id:org,org_name:"Instagram fixture",role:options.role||"owner"}],platform_admin:false});
    if(path===`${root}/hub/modules`)return reply([]);
    if(path==="/api/hub/contracts")return reply({version:1,kinds:[],modules:[]});
    if(path===`${root}/hub/kinds`)return reply([]);
    if(path===`${root}/content-types`)return reply([{id:"type",org_id:org,key:"website_page",name:"Website page",schema:{fields:[]}}]);
    if(path===`${root}/websites`)return reply([{id:site,org_id:org,name:"Beispielmarke fixture",slug:"fixture",created_at:"2026-11-07T18:00:00Z"}]);
    if(path===`${root}/content/website_page`)return reply([{id:content,org_id:org,content_type_id:"type",revision:7,status:"published",has_unpublished_changes:false,data:{title:"Reviewed page",body:"Website body must not become caption",instagram_text:"Explicit Instagram caption",instagram_image:image},publication:{revision:7,published_at:"2026-11-07T18:00:00Z",assignments:[{website_id:site}],data:{title:"Reviewed page",body:"Website body must not become caption",instagram_text:"Explicit Instagram caption",instagram_image:image}}}]);
    if(path===`${root}/instagram`)return reply({configured:options.configured??false,login_mode:options.mode||"instagram_login",reconnect_required:options.reconnect||false,connection:options.connected||chosen?{id:"binding",instagram_id:"123",username:"examplebrand_fixture",active:true,revision:3,login_mode:options.mode||"instagram_login",expires_at:options.forever?null:"2027-01-01T00:00:00Z",expired:false,refresh_recommended:false,scopes:["instagram_business_basic","instagram_business_content_publish"]}:null,required_permissions:[],capabilities:["single_image_publish"],automatic_publishing:false,profile_editing:false});
    if(path===`${root}/instagram/pending/66666666-6666-4666-8666-666666666666`&&method==="GET")return reply({id:"66666666-6666-4666-8666-666666666666",accounts:[{id:"123",username:"first"},{id:"456",username:"second"}],expected_revision:0,expires_at:"2027-01-01T00:00:00Z",client_business_id:"987"});
    if(path===`${root}/instagram/pending/66666666-6666-4666-8666-666666666666/select`){chosen=true;return reply({connected:true});}
    if(path===`${root}/instagram/publications`&&method==="GET")return reply(options.publication||attempts>0?[job]:[]);
    if(path===`${root}/instagram/connect`)return reply({authorization_url:options.badRedirect?"https://evil.example.test/steal":"https://www.instagram.com/oauth/authorize?client_id=123"});
    if(path===`${root}/instagram/publications`&&method==="POST"){
      attempts++;
      if(options.unknownPrepare&&attempts===1)return reply({error:"instagram_outcome_unknown"},502);
      return reply(job,202);
    }
    if(path===`${root}/instagram/publications/${job.id}/advance`)return reply({error:"instagram_revision_conflict"},409);
    return reply({error:"Unmocked synthetic fixture request"},404);
  });
  await page.goto("/instagram");
  return {writes,job};
}

test("missing Meta setup is honest and keeps connection disabled on mobile",async({page})=>{
  await page.setViewportSize({width:360,height:800});const {writes}=await workspace(page);
  await expect(page.getByRole("heading",{name:"Instagram",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Instagram verbinden",exact:true})).toBeDisabled();
  await expect(page.getByText("Die Instagram-Verbindung wird noch vom Betreiber eingerichtet.",{exact:false})).toBeVisible();
  await expect(page.getByText("Noch keine direkten Veröffentlichungsaufträge.",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();expect(writes).toHaveLength(0);
});

test("viewers can read the connected account and pending posts without write controls",async({page})=>{
  const {writes}=await workspace(page,{role:"viewer",configured:true,connected:true,publication:true});
  await expect(page.getByRole("heading",{name:"@examplebrand_fixture"})).toBeVisible();
  await expect(page.getByRole("button",{name:"Erneut verbinden",exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Geprüften Bildbeitrag jetzt veröffentlichen"})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Geprüften Bildbeitrag vorbereiten",exact:true})).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test("an invalid authorization URL never redirects the user outside Instagram",async({page})=>{
  const {writes}=await workspace(page,{configured:true,badRedirect:true});
  await page.getByRole("button",{name:"Instagram verbinden",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Meta-App-Konfiguration");
  await expect(page).toHaveURL(/\/instagram$/);expect(writes).toHaveLength(1);expect(writes[0].body).toEqual({expected_revision:0});
});

test("an explicit reviewed variant uses one stable request key after an unknown result",async({page})=>{
  const {writes}=await workspace(page,{configured:true,connected:true,unknownPrepare:true});
  await page.getByLabel("Freigegebener Inhalt",{exact:true}).selectOption(`website_page:${content}`);
  await page.getByLabel("Website",{exact:true}).selectOption(site);
  const panel=page.getByRole("region",{name:"Instagram-Bildbeitrag vorbereiten"});
  await expect(panel).toContainText("Explicit Instagram caption");await expect(panel).not.toContainText("Website body must not become caption");
  await page.getByRole("button",{name:"Geprüften Bildbeitrag vorbereiten",exact:true}).click();
  await expect(panel.getByRole("alert")).toContainText("kein automatischer erneuter Versand");
  expect(writes).toHaveLength(1);
  await page.getByRole("button",{name:"Geprüften Bildbeitrag vorbereiten",exact:true}).click();
  await expect(panel.getByRole("status")).toContainText("Auftrag übernommen");
  expect(writes).toHaveLength(2);expect(writes[0].key).toBeTruthy();expect(writes[1].key).toBe(writes[0].key);
  expect(writes[0].body).toEqual({content_type:"website_page",content_id:content,website_id:site,expected_revision:7});
});

test("publish conflicts are shown without silently retrying a newer revision",async({page})=>{
  const {writes,job}=await workspace(page,{configured:true,connected:true,publication:true});
  await page.getByRole("button",{name:"Geprüften Bildbeitrag jetzt veröffentlichen"}).click();
  await expect(page.getByRole("alert")).toContainText("inzwischen geändert");expect(writes).toHaveLength(1);expect(writes[0].body).toEqual({expected_revision:job.revision});
});


test("Unified grants with no fixed expiry use verification instead of the legacy refresh",async({page})=>{
  await workspace(page,{configured:true,connected:true,mode:"unified",forever:true});
  await expect(page.getByText("Kein festes Ablaufdatum.",{exact:false})).toBeVisible();
  await expect(page.getByRole("button",{name:"Verbindung prüfen",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Freigabe aktualisieren",exact:true})).toHaveCount(0);
  await expect(page.getByText("Meta-Geschäftsanmeldung",{exact:true})).toBeVisible();
});

test("a provider configuration change blocks publishing until a new connection",async({page})=>{
  const {writes}=await workspace(page,{configured:true,connected:true,publication:true,reconnect:true,mode:"unified"});
  await expect(page.getByRole("alert")).toContainText("Anmeldeweg oder die App-Konfiguration");
  await expect(page.getByRole("button",{name:"Geprüften Bildbeitrag jetzt veröffentlichen"})).toBeDisabled();
  await expect(page.getByRole("region",{name:"Instagram-Bildbeitrag vorbereiten"})).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test("multiple shared accounts require an explicit account choice",async({page})=>{
  const {writes}=await workspace(page,{configured:true,mode:"unified",pending:true});
  await page.goto("/instagram?result=select_account&pending=66666666-6666-4666-8666-666666666666");
  await expect(page.getByRole("button",{name:"Dieses Konto verbinden",exact:true})).toBeDisabled();
  await page.getByLabel("Freigegebenes Instagram-Konto",{exact:true}).selectOption("456");
  await page.getByRole("button",{name:"Dieses Konto verbinden",exact:true}).click();
  await expect(page).toHaveURL(/\/instagram$/);
  expect(writes).toHaveLength(1);expect(writes[0].body).toEqual({account_id:"456",expected_revision:0});
});
