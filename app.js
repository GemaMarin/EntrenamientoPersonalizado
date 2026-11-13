(function(){
"use strict";
/* =========================================================
   Cuaderno de Entreno · app independiente
   - Strava: API oficial con OAuth (credenciales solo en este dispositivo)
   - Registros (WODs, marcas, competiciones): local + Gist privado de GitHub
   ========================================================= */

/* ---------- almacenamiento local ---------- */
const LS = {
  get(k, d=null){ try{ const v = localStorage.getItem("ce:"+k); return v==null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem("ce:"+k, JSON.stringify(v)); }catch(e){} },
  del(k){ try{ localStorage.removeItem("ce:"+k); }catch(e){} }
};

const S = {
  cfg: LS.get("cfg", {}),             // {clientId, clientSecret, ghToken, gistId}
  tok: LS.get("stravaTok", null),     // {access_token, refresh_token, expires_at}
  athlete: LS.get("athlete", null),
  acts: LS.get("acts", []),           // actividades normalizadas
  det: LS.get("det", {}),             // detalles por id: {cal, be:[{n,t,d}]}
  recs: LS.get("recs", []),           // registros con tombstones
  syncAt: LS.get("syncAt", null), stravaAt: LS.get("stravaAt", null),
  ph: LS.get("ph", {}), ocr: null,
  busy: {strava:false, sync:false}, err: {}, form: {}, confirmDel: null, toast: ""
};
const saveCfg = () => LS.set("cfg", S.cfg);

const VIEWS = ["resumen","correr","box","futbol","objetivos","plan","ajustes"];
const COL = {run:"var(--run)",box:"var(--box)",futbol:"var(--foot)",walk:"var(--walk)",otro:"var(--other)"};
const NAME = {run:"Carrera",box:"Box / HIIT",futbol:"Fútbol",walk:"Senderismo",otro:"Otro"};
const RPE_DEF = {run:6,box:7,futbol:7,walk:3,otro:4};

/* ---------- utilidades ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2,"0");
const iso = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const parseISO = s => { const [y,m,d] = s.slice(0,10).split("-").map(Number); return new Date(y,m-1,d); };
const localDate = s => { const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/); return m ? new Date(+m[1],m[2]-1,+m[3],+m[4],+m[5],+m[6]) : new Date(s); };
const DIAS = ["lun","mar","mié","jue","vie","sáb","dom"];
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const fDate = d => d.getDate()+" "+MESES[d.getMonth()];
const dow = d => (d.getDay()+6)%7;
const monday = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate()-dow(x)); return x; };
const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const daysBetween = (a,b) => Math.round((parseISO(iso(b)) - parseISO(iso(a)))/864e5);
function fTime(sec){ sec=Math.round(sec); const h=Math.floor(sec/3600), m=Math.floor(sec%3600/60), s=sec%60; return h? h+":"+pad(m)+":"+pad(s) : m+":"+pad(s); }
function fPace(sec){ if(!sec||!isFinite(sec)) return "–"; sec=Math.round(sec); return Math.floor(sec/60)+":"+pad(sec%60); }
function fMin(min){ min=Math.round(min); const h=Math.floor(min/60); return h? h+"h "+pad(min%60)+"m" : min+" min"; }
const fClock = t => { const d=new Date(t); return pad(d.getHours())+":"+pad(d.getMinutes()); };
const uid = () => Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const today = () => iso(new Date());

function catOf(sport){
  if (/Run/.test(sport)) return "run";
  if (/HighIntensity|Crossfit|WeightTraining|Workout|Training|Elliptical|StairStepper|Rowing/.test(sport)) return "box";
  if (/Soccer|Football/.test(sport)) return "futbol";
  if (/Hike|Walk/.test(sport)) return "walk";
  return "otro";
}

/* =========================================================
   STRAVA
   ========================================================= */
const REDIRECT = () => location.origin + location.pathname;
const SCOPE = "read,activity:read_all,profile:read_all";

function stravaAuthUrl(){
  const p = new URLSearchParams({client_id:S.cfg.clientId, redirect_uri:REDIRECT(), response_type:"code", approval_prompt:"auto", scope:SCOPE, state:"strava"});
  return "https://www.strava.com/oauth/authorize?"+p;
}
async function tokenRequest(body){
  const r = await fetch("https://www.strava.com/oauth/token", {method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({client_id:S.cfg.clientId, client_secret:S.cfg.clientSecret, ...body})});
  if(!r.ok) throw {code:"auth", status:r.status, message: (await r.text()).slice(0,200)};
  const j = await r.json();
  // Strava puede rotar el refresh token: se guarda siempre el último y se comparte con los demás dispositivos
  S.tok = {access_token:j.access_token, refresh_token:j.refresh_token||S.tok?.refresh_token, expires_at:j.expires_at, at:Date.now()};
  if(j.athlete){ S.athlete = j.athlete; LS.set("athlete", j.athlete); }
  LS.set("stravaTok", S.tok);
  credDirty = true; LS.set("credDirty", true);
  if(S.cfg.ghToken) schedulePush();
}
// Renovación con candado (una sola a la vez) y rescate desde el Gist si otro dispositivo ya rotó el token
let refreshing = null;
function refreshToken(){
  if(refreshing) return refreshing;
  refreshing = (async ()=>{
    const used = S.tok.refresh_token;
    try{ await tokenRequest({grant_type:"refresh_token", refresh_token:used}); }
    catch(e){
      if(e.status>=400 && e.status<500 && S.cfg.ghToken){
        await syncGist(true);
        if(S.tok && S.tok.refresh_token!==used){
          if(S.tok.expires_at*1000 - Date.now() > 120000) return;
          await tokenRequest({grant_type:"refresh_token", refresh_token:S.tok.refresh_token}); return;
        }
      }
      if(e.status>=400 && e.status<500) throw {code:"auth", status:e.status, message:"Strava ha cerrado la sesión (quizá revocaste el acceso). Pulsa «Volver a conectar» en Ajustes."};
      throw {code:"net", message:"Sin conexión con Strava. Se reintentará al volver a abrir la app."};
    }
  })().finally(()=>{ refreshing = null; });
  return refreshing;
}
async function ensureToken(){
  if(!S.tok) throw {code:"no_token"};
  if(S.tok.expires_at*1000 - Date.now() < 120000) await refreshToken();
}
async function api(path){
  await ensureToken();
  let r = await fetch("https://www.strava.com/api/v3"+path, {headers:{Authorization:"Bearer "+S.tok.access_token}});
  if(r.status===401){ await refreshToken(); r = await fetch("https://www.strava.com/api/v3"+path, {headers:{Authorization:"Bearer "+S.tok.access_token}}); }
  if(r.status===429) throw {code:"rate", message:"Límite de peticiones de Strava alcanzado. Espera 15 minutos."};
  if(r.status===401 || r.status===403) throw {code:"auth", status:r.status, message:"Strava ha rechazado el acceso. Vuelve a conectar en Ajustes."};
  if(!r.ok) throw {code:"http", status:r.status, message:"Strava respondió "+r.status};
  return r.json();
}
function normAct(a){
  const km = (a.distance||0)/1000;
  return { id:String(a.id), name:a.name, sport:a.sport_type||a.type, start:a.start_date_local,
    km, min:(a.moving_time||0)/60, sec:a.moving_time||0, elev:a.total_elevation_gain||0,
    pace: km>0.2 ? a.moving_time/km : null, prs:a.pr_count||0, hr:a.has_heartrate?a.average_heartrate:null, maxhr:a.max_heartrate||null,
    watts:a.average_watts||null, kj:a.kilojoules||null, trainer:!!a.trainer, race:a.workout_type===1, photos:a.total_photo_count||0, poly:a.map?.summary_polyline||"" };
}
async function syncStrava(full){
  if(!S.cfg.clientId || !S.tok || S.busy.strava) return;
  S.busy.strava = true; delete S.err.strava; render();
  try{
    if(!S.athlete || full){ S.athlete = await api("/athlete"); LS.set("athlete", S.athlete); }
    const known = new Map(S.acts.map(a=>[a.id,a]));
    let after = 0;
    if(!full && S.acts.length){ after = Math.floor(Math.max(...S.acts.map(a=>localDate(a.start).getTime()))/1000) - 3*86400; }
    for(let page=1; page<=5; page++){
      const list = await api(`/athlete/activities?per_page=200&page=${page}`+(after?`&after=${after}`:""));
      list.forEach(a=>known.set(String(a.id), normAct(a)));
      if(list.length<200) break;
    }
    S.acts = [...known.values()].sort((a,b)=>b.start.localeCompare(a.start));
    LS.set("acts", S.acts);
    S.stravaAt = Date.now(); LS.set("stravaAt", S.stravaAt);
    render();
    await fetchDetails();
  }catch(e){ S.err.strava = e; }
  S.busy.strava = false; render();
}
// Detalles: calorías, descripción y mejores marcas (best_efforts). Primero todas las carreras, después lo reciente.
// Máx. 40 por apertura para respetar el límite de Strava (100 peticiones / 15 min).
async function fetchDetails(){
  const now = new Date();
  const runs = S.acts.filter(a => catOf(a.sport||"")==="run" && (!S.det[a.id] || S.det[a.id].v!==2));
  const rest = S.acts.filter(a => catOf(a.sport||"")!=="run" && !S.det[a.id] && daysBetween(localDate(a.start), now)<120);
  const pending = [...runs, ...rest].slice(0,40);
  let n = 0;
  for(const a of pending){
    try{
      const d = await api("/activities/"+a.id);
      S.det[a.id] = { v:2, cal: d.calories||0, desc: (d.description||"").slice(0,300), be: (d.best_efforts||[]).map(b=>({n:b.name, t:b.elapsed_time, d:b.start_date_local})),
        sp: (d.splits_metric||[]).map(x=>[Math.round(x.distance), x.moving_time]) };
      if(++n % 5 === 0){ LS.set("det", S.det); render(); }
    }catch(e){ if(e.code==="rate"){ S.err.det = "Strava ha limitado las peticiones: se completará en la próxima apertura."; break; } }
  }
  LS.set("det", S.det);
}
// Fotos que subes a Strava (capturas de AimHarder o de la pizarra)
let phBusy = false;
async function fetchPhotos(ids){
  if(phBusy || !S.tok) return; phBusy = true;
  for(const id of ids){
    if(S.ph[id]) continue;
    try{
      const ph = await api(`/activities/${id}/photos?size=1200&photo_sources=true`);
      S.ph[id] = (ph||[]).map(p => p.urls && (p.urls["1200"] || Object.values(p.urls)[0])).filter(Boolean);
    }catch(e){ if(e.code==="rate") break; S.ph[id] = []; }
  }
  LS.set("ph", S.ph); phBusy = false; render();
}
async function handleOAuthReturn(){
  const q = new URLSearchParams(location.search);
  if(q.get("state")!=="strava") return;
  history.replaceState(null, "", REDIRECT() + (location.hash||"#resumen"));
  if(q.get("error")){ S.err.strava = {code:"denied", message:"Has cancelado la conexión con Strava."}; return; }
  const scope = q.get("scope")||"";
  if(!/activity:read/.test(scope)){ S.err.strava = {code:"scope", message:"Necesito permiso para leer tus actividades. Vuelve a conectar y deja marcadas todas las casillas."}; return; }
  try{ await tokenRequest({code:q.get("code"), grant_type:"authorization_code"}); toast("Strava conectado"); await syncStrava(true); }
  catch(e){ S.err.strava = {code:"auth", message:"No se pudo completar la conexión. Revisa el Client ID y el Client Secret."}; }
}

/* =========================================================
   SINCRONIZACIÓN: Gist privado en GitHub
   ========================================================= */
const GIST_FILE = "cuaderno-entreno.json";
async function gh(path, opts={}){
  const r = await fetch("https://api.github.com"+path, {...opts, headers:{Accept:"application/vnd.github+json", Authorization:"Bearer "+S.cfg.ghToken, "X-GitHub-Api-Version":"2022-11-28", ...(opts.body?{"Content-Type":"application/json"}:{})}});
  if(r.status===401) throw {code:"gh_auth", message:"El token de GitHub no es válido o ha caducado."};
  if(r.status===403||r.status===404) throw {code:"gh_perm", message:"El token no tiene permiso para Gists (scope «gist»)."};
  if(!r.ok) throw {code:"gh_http", message:"GitHub respondió "+r.status};
  return r.status===204 ? null : r.json();
}
async function findOrCreateGist(){
  for(let page=1; page<=5; page++){
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const g = list.find(g => g.files && g.files[GIST_FILE]);
    if(g){ S.cfg.gistId = g.id; saveCfg(); return; }
    if(list.length<100) break;
  }
  const g = await gh("/gists", {method:"POST", body: JSON.stringify({description:"Cuaderno de Entreno · datos", public:false, files:{[GIST_FILE]:{content: JSON.stringify({v:1, registros:S.recs}, null, 1)}}})});
  S.cfg.gistId = g.id; saveCfg();
}
async function readGist(){
  const g = await gh("/gists/"+S.cfg.gistId);
  const f = g.files[GIST_FILE];
  if(!f) return {registros:[]};
  let txt = f.content;
  if(f.truncated){ txt = await (await fetch(f.raw_url)).text(); }
  try{ const j = JSON.parse(txt); return {registros:j.registros||[], secreto:j.secreto||null}; }catch(e){ return {registros:[]}; }
}

/* --- Credenciales de Strava compartidas entre dispositivos, cifradas (AES-GCM) con una clave derivada de tu token de GitHub --- */
let credDirty = LS.get("credDirty", false), wipeCred = LS.get("wipeCred", false);
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c=>c.charCodeAt(0));
async function cryptoKey(){
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(S.cfg.ghToken), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2", salt:new TextEncoder().encode("cuaderno-entreno-v1"), iterations:150000, hash:"SHA-256"}, base, {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"]);
}
async function sealCred(){
  if(!S.cfg.clientId || !S.tok || !crypto.subtle) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({clientId:S.cfg.clientId, clientSecret:S.cfg.clientSecret, tok:S.tok, athlete:S.athlete?{firstname:S.athlete.firstname, id:S.athlete.id}:null}));
  const ct = await crypto.subtle.encrypt({name:"AES-GCM", iv}, await cryptoKey(), plain);
  return {iv:b64(iv), ct:b64(ct)};
}
async function openCred(sec){
  if(!sec || !crypto.subtle) return null;
  try{ const pt = await crypto.subtle.decrypt({name:"AES-GCM", iv:unb64(sec.iv)}, await cryptoKey(), unb64(sec.ct)); return JSON.parse(new TextDecoder().decode(pt)); }
  catch(e){ return null; }
}
function adoptCred(c){
  S.cfg.clientId = c.clientId; S.cfg.clientSecret = c.clientSecret; saveCfg();
  S.tok = c.tok; LS.set("stravaTok", S.tok);
  if(c.athlete && !S.athlete){ S.athlete = c.athlete; LS.set("athlete", c.athlete); }
  if(S.err.strava?.code==="auth") delete S.err.strava;
}
function merge(a, b){
  const m = new Map();
  [...a, ...b].forEach(r => { const o = m.get(r.id); if(!o || (r.mod||0) > (o.mod||0)) m.set(r.id, r); });
  return [...m.values()];
}
let pushTimer = null, dirty = LS.get("dirty", false);
let syncing = null;
function syncGist(force){
  if(!S.cfg.ghToken) return Promise.resolve();
  if(syncing) return force ? syncing.then(()=>syncGist(false)) : syncing;
  syncing = doSyncGist().finally(()=>{ syncing = null; });
  return syncing;
}
async function doSyncGist(){
  S.busy.sync = true; delete S.err.sync; renderStatus();
  try{
    if(!S.cfg.gistId) await findOrCreateGist();
    const remote = await readGist();
    const merged = merge(remote.registros, S.recs);
    const changedRemote = JSON.stringify(sortRecs(merged)) !== JSON.stringify(sortRecs(remote.registros));
    S.recs = merged; if(migrate()) dirty = true; LS.set("recs", S.recs);
    // Credenciales: gana la más reciente (la última que renovó el token)
    const rc = wipeCred ? null : await openCred(remote.secreto);
    const localAt = S.tok?.at || 0, remoteAt = rc?.tok?.at || 0;
    let pushCred = false;
    if(rc && rc.tok && (remoteAt > localAt || !S.tok)){ const hadTok = !!S.tok; adoptCred(rc); credDirty = false; LS.set("credDirty", false); if(!hadTok){ toast("Strava conectado desde tu otro dispositivo"); setTimeout(()=>syncStrava(true), 50); } }
    else if(S.tok && S.cfg.clientId && (localAt > remoteAt || !rc || credDirty)) pushCred = true;
    if(changedRemote || dirty || pushCred || wipeCred){
      const secreto = wipeCred ? null : pushCred ? await sealCred() : (remote.secreto || await sealCred());
      await gh("/gists/"+S.cfg.gistId, {method:"PATCH", body: JSON.stringify({files:{[GIST_FILE]:{content: JSON.stringify({v:1, registros:sortRecs(S.recs), secreto}, null, 1)}}})});
      if(pushCred){ credDirty = false; LS.set("credDirty", false); }
      if(wipeCred){ wipeCred = false; LS.set("wipeCred", false); }
    }
    dirty = false; LS.set("dirty", false);
    S.syncAt = Date.now(); LS.set("syncAt", S.syncAt);
  }catch(e){ S.err.sync = e; }
  S.busy.sync = false; render();
}
const sortRecs = rs => [...rs].sort((a,b)=>a.id.localeCompare(b.id));
function schedulePush(){ dirty = true; LS.set("dirty", true); clearTimeout(pushTimer); pushTimer = setTimeout(syncGist, 600); }

const logs = () => S.recs.filter(r=>!r.borrado);
function migrate(){
  let ch = false;
  S.recs.forEach(r => { if(r.tipo==="evento" && !r.borrado && /hybrid madrid open/i.test(r.nombre||"")){
    Object.assign(r, {nombre:"HYROX Madrid · Doubles Women Open", km:"8", hyrox:"1", notas:"IFEMA · 8 × (1 km + estación) · estaciones repartidas en pareja", mod:Date.now()}); ch = true; } });
  return ch;
}
function addRec(r, quiet){ const now = Date.now(); S.recs.push({id:uid(), creado:now, mod:now, ...r}); if(!quiet){ LS.set("recs", S.recs); schedulePush(); } }
function delRec(id){ const r = S.recs.find(x=>x.id===id); if(r){ Object.keys(r).forEach(k=>{ if(!["id","tipo","fecha"].includes(k)) delete r[k]; }); r.borrado = true; r.mod = Date.now(); LS.set("recs", S.recs); schedulePush(); } }

/* =========================================================
   MODELO
   ========================================================= */
function allSessions(){
  return S.acts.map(a => {
    const c = catOf(a.sport||"");
    return { ...a, cat:c, date:localDate(a.start), kcal:S.det[a.id]?.cal||0,
      rpe: a.race || (c==="run" && a.km>=18) ? 8 : RPE_DEF[c], rpeEst:true };
  }).filter(s=>s.cat!=="walk").concat(logs().filter(l=>l.tipo==="futbol").map(l=>({
    src:"log", id:l.id, cat:"futbol", name:{partido:"Partido de fútbol", entreno:"Entreno de fútbol", pachanga:"Pachanga"}[l.formato]||"Fútbol",
    date:parseISO(l.fecha), start:l.fecha+"T12:00:00", min:+l.minutos||0, km:0, kcal:0, rpe:+l.rpe||RPE_DEF.futbol, rpeEst:!l.rpe, notas:l.notas, goles:l.goles, formato:l.formato }))
  ).sort((a,b)=>b.date-a.date);   // senderismo y caminatas fuera; fútbol desde tus registros
}
const load = s => s.min * s.rpe;
function weekBuckets(sessions, nWeeks){
  const start = addDays(monday(new Date()), -7*(nWeeks-1));
  const weeks = Array.from({length:nWeeks},(_,i)=>({start:addDays(start,7*i), run:0, box:0, futbol:0, walk:0, otro:0, n:0}));
  sessions.forEach(s => { const i = Math.floor(daysBetween(start, s.date)/7); if(i>=0 && i<nWeeks){ weeks[i][s.cat]+=s.min; weeks[i].n++; } });
  return weeks;
}
function acwr(sessions){
  const now = new Date(); let a=0, c=0;
  sessions.forEach(s => { const d = daysBetween(s.date, now); if(d>=0 && d<7) a+=load(s); if(d>=0 && d<28) c+=load(s); });
  const chronic = c/4; return { acute:a, chronic, ratio: chronic>0 ? a/chronic : null };
}
function streak(sessions){
  const set = new Set(sessions.map(s=>iso(monday(s.date))));
  let w = monday(new Date()), n = 0; const ongoing = set.has(iso(w));
  if(!ongoing) w = addDays(w,-7);
  while(set.has(iso(w))){ n++; w = addDays(w,-7); }
  return {n, ongoing};
}
// Strava devuelve los nombres en minúscula ("5k", "10k", "Half-Marathon"): se comparan sin mayúsculas
const BE = {"1 mile":["Milla",1.609],"5k":["5K",5],"10k":["10K",10],"half-marathon":["21K",21.0975],"marathon":["42K",42.195]};
const PRKEY = {"5K":"5k","10K":"10k","21K":"half-marathon","42K":"marathon"};
function parseTime(s){
  const p = String(s||"").trim().replace(/[hH]/g,":").replace(/[’'´]/g,":").split(":").filter(x=>x!=="").map(Number);
  if(!p.length || p.some(isNaN)) return null;
  return p.length===3 ? p[0]*3600+p[1]*60+p[2] : p.length===2 ? p[0]*60+p[1] : null;
}
function bestEfforts(){
  const out = {};
  const put = (k, r) => { if(!out[k] || r.t < out[k].t) out[k] = r; };
  S.acts.filter(a=>catOf(a.sport||"")==="run").forEach(a => {
    const det = S.det[a.id] || {}, be = det.be || [];
    be.forEach(b => { const k = String(b.n).toLowerCase(); if(BE[k]) put(k, {t:b.t, d:b.d, act:a.name, id:a.id, src:"strava"}); });
    if(!be.length && det.sp && det.sp.length){
      const full = det.sp.filter(x=>x[0]>=950).map(x=>x[1]);
      const best = n => { if(full.length<n) return null; let m = Infinity; for(let i=0;i+n<=full.length;i++){ const t = full.slice(i,i+n).reduce((u,v)=>u+v,0); if(t<m) m = t; } return m; };
      const t5 = best(5), t10 = best(10);
      if(t5) put("5k", {t:t5, d:a.start, act:a.name, id:a.id, src:"km"});
      if(t10) put("10k", {t:t10, d:a.start, act:a.name, id:a.id, src:"km"});
      if(a.km>=21.0975 && a.km<23) put("half-marathon", {t:Math.round(a.sec*21.0975/a.km), d:a.start, act:a.name, id:a.id, src:"km"});
    }
  });
  logs().filter(l=>l.tipo==="pr").forEach(l => { const k = PRKEY[l.dist], t = parseTime(l.tiempo); if(k && t) put(k, {t, d:l.fecha, act:l.carrera||"Marca oficial", src:"oficial", rid:l.id}); });
  return out;
}
// Mejor marca por año, para ver la progresión
function bestByYear(key){
  const by = {};
  S.acts.filter(a=>catOf(a.sport||"")==="run").forEach(a => (S.det[a.id]?.be||[]).forEach(b => {
    if(String(b.n).toLowerCase()!==key) return; const y = String(b.d).slice(0,4); if(!by[y] || b.t<by[y]) by[y]=b.t; }));
  return Object.entries(by).sort((a,b)=>a[0].localeCompare(b[0]));
}

/* ---------- Competiciones y fases ---------- */
const SUG = [
  {nombre:"HYROX Madrid · Doubles Women Open", fecha:"2027-03-21", clase:"hibrida", km:"8", objetivo:"", notas:"IFEMA · 8 × (1 km + estación) · estaciones repartidas en pareja", hyrox:"1"},
  {nombre:"Medio Maratón de Madrid", fecha:"2027-04-04", clase:"carrera", km:"21.0975", objetivo:"", notas:""}
];
const eventos = () => logs().filter(l=>l.tipo==="evento").sort((a,b)=>a.fecha.localeCompare(b.fecha));
const futuros = () => eventos().filter(e=>e.fecha>=today());
const PH = {
  base:        {n:"Base", c:"var(--walk)", box:2, runs:2, long:[10,14], d:"Volumen aeróbico sin prisa: carrera suave en Z2 y técnica y fuerza en el box."},
  construccion:{n:"Construcción", c:"var(--run)", box:2, runs:3, long:[14,18], d:"Sube la tirada larga, añade una sesión de calidad y una de «carrera comprometida» (correr justo después de estaciones)."},
  especifico:  {n:"Específico", c:"var(--box)", box:2, runs:3, long:[17,19], d:"Simulaciones con tu pareja cada 2 semanas y tiradas largas con bloques a ritmo objetivo de media."},
  taper:       {n:"Puesta a punto", c:"var(--ok)", box:1, runs:2, long:[8,10], d:"Baja el volumen un 40–50 % y mantén algo de intensidad corta. Duerme y come bien."},
  transicion:  {n:"Recuperar y afinar", c:"var(--warn)", box:1, runs:3, long:[12,15], d:"3–4 días suaves tras la competición y después un recordatorio a ritmo de media (p. ej. 2 × 3 km)."},
  recuperacion:{n:"Recuperación", c:"var(--warn)", box:1, runs:2, long:[6,8], d:"Semana suave tras la competición."}
};
function phases(){
  const ev = futuros(); if(!ev.length) return [];
  const t0 = parseISO(today()), segs = [];
  const add = (key,a,b,e) => { if(b < t0 || b < a) return; segs.push({key, start: a<t0 ? t0 : a, end:b, ev:e}); };
  const D1 = parseISO(ev[0].fecha);
  add("base", t0, addDays(D1,-84), ev[0]);
  add("construccion", addDays(D1,-83), addDays(D1,-35), ev[0]);
  add("especifico", addDays(D1,-34), addDays(D1,-7), ev[0]);
  add("taper", addDays(D1,-6), D1, ev[0]);
  for(let i=1;i<ev.length;i++){
    const P = parseISO(ev[i-1].fecha), D = parseISO(ev[i].fecha), gap = daysBetween(P,D);
    if(gap<=35){ add("transicion", addDays(P,1), addDays(D,-8), ev[i]); add("taper", addDays(D,-7), D, ev[i]); }
    else { add("recuperacion", addDays(P,1), addDays(P,7), ev[i]); add("construccion", addDays(P,8), addDays(D,-35), ev[i]); add("especifico", addDays(D,-34), addDays(D,-7), ev[i]); add("taper", addDays(D,-6), D, ev[i]); }
  }
  return segs.filter(s => s.end >= s.start);
}
function currentPhase(){
  const t = parseISO(today()), ps = phases();
  const p = ps.find(s => t>=s.start && t<=s.end); if(!p) return null;
  const len = Math.max(1, daysBetween(p.start,p.end)), frac = Math.min(1, daysBetween(p.start,t)/len);
  const info = PH[p.key];
  return {...p, info, longKm: Math.round(info.long[0] + (info.long[1]-info.long[0])*frac)};
}
function hmGoalPace(){
  const hm = futuros().find(e=>e.clase==="carrera" && Math.abs((+e.km||0)-21.1)<0.3);
  const t = hm && parseTime(hm.objetivo);
  if(t) return t/21.0975;
  const b = bestEfforts()["half-marathon"]; return b ? b.t/21.0975 : null;
}

/* =========================================================
   GRÁFICOS
   ========================================================= */
function stackedWeeks(weeks){
  const W=400,H=200,pl=34,pr=6,pt=10,pb=24, cats=["run","box","futbol","walk","otro"];
  const max = Math.max(60, ...weeks.map(w=>cats.reduce((t,c)=>t+w[c],0)));
  const step = max>400?120:max>200?60:30, top = Math.ceil(max/step)*step;
  const bw = (W-pl-pr)/weeks.length, y = v => pt+(H-pt-pb)*(1-v/top);
  let g = "";
  for(let v=0; v<=top; v+=step){ g += `<line x1="${pl}" x2="${W-pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${pl-6}" y="${y(v)+3}" text-anchor="end">${v>=60? (v/60)+"h": v}</text>`; }
  weeks.forEach((w,i)=>{
    let acc=0; const x = pl+i*bw+bw*.18, wd = bw*.64;
    cats.forEach(c=>{ if(w[c]>0){ const y0=y(acc), y1=y(acc+w[c]); g+=`<rect x="${x}" y="${y1}" width="${wd}" height="${Math.max(0,y0-y1)}" fill="${COL[c]}" rx="2"><title>${NAME[c]}: ${Math.round(w[c])} min</title></rect>`; acc+=w[c]; } });
    if(i%3===(weeks.length-1)%3) g+=`<text x="${x+wd/2}" y="${H-8}" text-anchor="middle">${w.start.getDate()} ${MESES[w.start.getMonth()]}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Minutos por semana y disciplina">${g}</svg>`;
}
function dowBars(list, color){
  const c=[0,0,0,0,0,0,0]; list.forEach(s=>c[dow(s.date)]++);
  const max=Math.max(1,...c);
  return `<div class="stack" style="gap:6px">${c.map((n,i)=>`<div class="row" style="gap:8px;flex-wrap:nowrap"><span class="small muted" style="width:30px">${DIAS[i]}</span><div class="meter" style="flex:1"><i style="width:${n/max*100}%;background:${color}"></i></div><span class="num" style="width:22px;text-align:right">${n}</span></div>`).join("")}</div>`;
}

/* =========================================================
   PIEZAS
   ========================================================= */
function sessionItem(s){
  const tag = {run:"RUN",box:"WOD",futbol:"FUT",walk:"HIKE",otro:"·"}[s.cat];
  const det = s.cat==="run" ? `${s.km.toFixed(1)} km · ${fPace(s.pace)}/km · ${fMin(s.min)}`
           : s.cat==="walk" ? `${s.km.toFixed(1)} km · ${Math.round(s.elev)} m+ · ${fMin(s.min)}`
           : `${fMin(s.min)}${s.kcal? " · "+s.kcal+" kcal":""}`;
  const hr = s.hr ? ` · ${Math.round(s.hr)} ppm` : "";
  if(s.src==="log") return `<button class="item itembtn" data-fut="${s.id}"><span class="badge" style="background:${COL[s.cat]}">${tag}</span><div style="min-width:0"><div class="t">${esc(s.name)}</div><div class="s">${DIAS[dow(s.date)]} ${fDate(s.date)} · ${fMin(s.min)} · esfuerzo ${s.rpe}/10${s.goles&&+s.goles?` · ${s.goles} gol${+s.goles>1?"es":""}`:""}</div></div><span></span></button>`;
  return `<a class="item" ${s.cat==="run"?`data-run="${s.id}" href="#correr"`:`href="https://www.strava.com/activities/${s.id}" target="_blank" rel="noopener"`} style="text-decoration:none;color:inherit"><span class="badge" style="background:${COL[s.cat]}">${tag}</span><div style="min-width:0"><div class="t">${esc(s.name)}</div><div class="s">${DIAS[dow(s.date)]} ${fDate(s.date)} · ${det}${hr}</div></div>${s.prs?`<span class="pill">${s.prs} PR</span>`:"<span></span>"}</a>`;
}
function weekStrip(sessions){
  const m = monday(new Date()), t = today();
  return `<div class="week">${Array.from({length:7},(_,i)=>{ const d=addDays(m,i); const ss=sessions.filter(s=>iso(s.date)===iso(d));
    return `<div class="day ${iso(d)===t?"today":""}"><span class="muted">${DIAS[i]}</span><b>${d.getDate()}</b><div class="chips">${ss.map(s=>`<span class="chip" title="${esc(NAME[s.cat])}" style="background:${COL[s.cat]}"></span>`).join("")}</div></div>`; }).join("")}</div>`;
}
function legend(cats){ return `<div class="legend">${cats.map(c=>`<span><i class="dot" style="background:${COL[c]}"></i>${NAME[c]}</span>`).join("")}</div>`; }
function stravaBanner(){
  if(!S.cfg.clientId || !S.tok) return `<div class="banner info">Conecta tu cuenta de Strava en <a href="#ajustes">Ajustes</a> para ver tus entrenos.</div>`;
  if(S.err.strava) return `<div class="banner bad">${esc(S.err.strava.message||"No se pudo leer Strava.")} ${S.err.strava.code==="auth"?`<a href="#ajustes">Ir a Ajustes</a>`:""}</div>`;
  return "";
}
function delBtn(id, label){ return S.confirmDel===id ? `<span class="row" style="gap:4px"><button class="ghost danger" data-del="${id}" data-sure="1">Sí, borrar</button><button class="ghost" data-del="">No</button></span>` : `<button class="ghost${label?" danger":""}" data-del="${id}" aria-label="Borrar">${label||"✕"}</button>`; }
function field(id,label,html){ return `<label for="${id}">${label}${html}</label>`; }

/* =========================================================
   VISTAS
   ========================================================= */
/* =========================================================
   FÚTBOL: días fijos y registro
   ========================================================= */
// Días habituales (0 = lunes … 6 = domingo). Por defecto: entreno lunes y miércoles, partido domingo.
function footPrefs(){
  const r = logs().find(l=>l.tipo==="pref" && l.id==="pref-futbol");
  const parse = s => String(s??"").split(",").filter(x=>x!=="").map(Number);
  return r ? {entreno: parse(r.entreno), partido: parse(r.partido)} : {entreno:[0,2], partido:[6]};
}
function footRole(di){ const p = footPrefs(); return p.partido.includes(di) ? "partido" : p.entreno.includes(di) ? "entreno" : null; }
const FUT = {cuadriceps:.8, isquios:.8, gemelos:.8, gluteos:.6, aductores:.7, abdomen:.3, oblicuos:.2};
function fmFutbol(p={}){ return `<form data-form="futbol">${p.id?`<input type="hidden" name="id" value="${val(p.id)}">`:""}
  <div class="seg big3" role="group" aria-label="Tipo">${[["partido","Partido"],["entreno","Entreno"],["pachanga","Pachanga"]].map(([v,l])=>`<label class="segopt"><input type="radio" name="formato" value="${v}" ${ (p.formato||"partido")===v ? "checked":""}><span>${l}</span></label>`).join("")}</div>
  <div class="grid2">${field("f_fecha","Fecha",`<input id="f_fecha" name="fecha" type="date" value="${val(p.fecha||today())}" required>`)}
  ${field("f_min","Minutos jugados",`<input id="f_min" name="minutos" type="number" min="1" max="200" value="${val(p.minutos|| (p.formato==="entreno"?75:60))}" required>`)}</div>
  <label for="f_rpe">Esfuerzo <span class="muted" id="f_rpe_v">${p.rpe||7}/10</span><input id="f_rpe" name="rpe" type="range" min="1" max="10" value="${p.rpe||7}" class="rng"></label>
  <div class="grid2">${field("f_gol","Goles",`<input id="f_gol" name="goles" type="number" min="0" max="20" value="${val(p.goles)}" placeholder="0">`)}
  ${field("f_asi","Asistencias",`<input id="f_asi" name="asistencias" type="number" min="0" max="20" value="${val(p.asistencias)}" placeholder="0">`)}</div>
  ${field("f_notas","Notas",`<input id="f_notas" name="notas" value="${val(p.notas)}" placeholder="Resultado, molestias, sensaciones…">`)}
  <button class="primary big" type="submit">${p.id?"Guardar cambios":"Guardar"}</button></form>`; }
function footPrefsCard(){
  const p = footPrefs();
  return `<div class="card"><div class="row between"><h2>Tu fútbol</h2></div>
    <p class="small">Toca cada día para cambiarlo entre <b>nada</b>, <b>entreno</b> y <b>partido</b>. El entrenador de «Hoy» lo usa para organizar el resto de la semana.</p>
    ${footTimesCard()}
    <div class="daypick">${DIAS.map((d,i)=>{ const r = p.partido.includes(i) ? "partido" : p.entreno.includes(i) ? "entreno" : ""; return `<button type="button" data-footday="${i}" class="${r}"><b>${d}</b><small>${r||"—"}</small></button>`; }).join("")}</div></div>`;
}
function cycleFootDay(i){
  const p = footPrefs(), role = p.partido.includes(i) ? "partido" : p.entreno.includes(i) ? "entreno" : "";
  p.entreno = p.entreno.filter(x=>x!==i); p.partido = p.partido.filter(x=>x!==i);
  if(role==="") p.entreno.push(i); else if(role==="entreno") p.partido.push(i);
  upsertRec("pref-futbol", {tipo:"pref", fecha:today(), entreno:p.entreno.sort().join(","), partido:p.partido.sort().join(",")});   // upsert conserva los horarios
}

/* =========================================================
   FÚTBOL: horarios, pregunta tras el entreno y relleno de temporada
   ========================================================= */
function footTimes(){
  const r = logs().find(l=>l.tipo==="pref" && l.id==="pref-futbol") || {};
  return {entreno:{h:r.hEntreno||"21:00", d:+r.dEntreno||75}, partido:{h:r.hPartido||"11:00", d:+r.dPartido||90}};
}
function footPending(){
  const p = footPrefs(), T = footTimes(), now = new Date(), out = [];
  for(let i=0;i<7;i++){
    const d = addDays(parseISO(today()), -i), role = footRole(dow(d)); if(!role) continue;
    const f = iso(d); if(logs().some(l=>(l.tipo==="futbol" || l.tipo==="futskip") && l.fecha===f)) continue;
    if(i===0){ const [h,m] = T[role].h.split(":").map(Number), end = new Date(d); end.setHours(h||0, (m||0) + T[role].d); if(now < end) continue; }
    out.push({fecha:f, role, d});
  }
  return out;
}
function footAsk(){
  const pend = footPending(); if(!pend.length) return "";
  const T = footTimes();
  return `<div class="ask">${pend.slice(0,3).map(x=>`<div class="askrow">
    <span class="askico">${QI.foot}</span>
    <div class="askq"><b>¿Fuiste al ${x.role==="partido"?"partido":"entreno"} de fútbol${x.fecha===today()?" de hoy":` del ${DIAS[dow(x.d)]} ${x.d.getDate()}`}?</b><span class="small muted">${T[x.role].h} · ${T[x.role].d} min</span></div>
    <div class="askbtns"><button class="ghost" data-fask="no" data-f="${x.fecha}" data-r="${x.role}">No</button><button class="addbtn foot" data-fask="si" data-f="${x.fecha}" data-r="${x.role}">Sí</button></div>
  </div>`).join("")}</div>`;
}
function answerFoot(yes, fecha, role){
  if(yes){ const T = footTimes(); addRec({tipo:"futbol", fecha, formato:role, minutos:String(T[role].d), rpe:"7", origen:"auto"}); toast("Apuntado. Añade goles o esfuerzo en Fútbol"); }
  else { upsertRec("skip-"+fecha, {tipo:"futskip", fecha}); toast("Anotado: ese día no fuiste"); }
  haptic(); render();
}
function fillPlan(desde, hasta, inclE, inclP){
  const p = footPrefs(), have = new Set(logs().filter(l=>l.tipo==="futbol" || l.tipo==="futskip").map(l=>l.fecha)), out = [];
  for(let d = parseISO(desde); iso(d) <= hasta; d = addDays(d,1)){
    const di = dow(d), role = p.partido.includes(di) ? "partido" : p.entreno.includes(di) ? "entreno" : null;
    if(!role || (role==="entreno" && !inclE) || (role==="partido" && !inclP) || have.has(iso(d))) continue;
    out.push({fecha:iso(d), role});
  }
  return out;
}
function futFillSheet(){
  const y = iso(addDays(new Date(), -1)), desde = S.fillFrom || "2026-09-07", T = footTimes();
  const n = fillPlan(desde, y, S.fillE!==false, !!S.fillP);
  return ["Rellenar temporada", `<div class="stack" style="gap:12px">
    <p class="small">Crea de golpe las sesiones de tus días de fútbol que no tengas apuntadas. Luego puedes editar cualquiera (goles, minutos, esfuerzo) o borrar los días que no fuiste.</p>
    <div class="grid2">${field("ff_from","Desde",`<input id="ff_from" type="date" value="${desde}" max="${y}">`)}<label>Hasta<input type="date" value="${y}" disabled></label></div>
    <label class="chk" for="ff_e"><input id="ff_e" type="checkbox" ${S.fillE!==false?"checked":""}> Entrenos (${footPrefs().entreno.map(i=>DIAS[i]).join(", ")||"ninguno"} · ${T.entreno.d} min)</label>
    <label class="chk" for="ff_p"><input id="ff_p" type="checkbox" ${S.fillP?"checked":""}> Partidos (${footPrefs().partido.map(i=>DIAS[i]).join(", ")||"ninguno"} · ${T.partido.d} min)</label>
    <div class="hxsum"><span class="eyebrow">Se crearán</span><span class="num huge2">${n.length}</span><span class="small muted">${n.length?`${n.filter(x=>x.role==="entreno").length} entrenos y ${n.filter(x=>x.role==="partido").length} partidos, con esfuerzo 7/10`:"Nada pendiente en esas fechas"}</span></div>
    <button class="primary big" data-act="dofill" ${n.length?"":"disabled"}>Crear ${n.length} sesiones</button>
  </div>`];
}
function footTimesCard(){
  const T = footTimes();
  return `<div class="ftimes">${[["entreno","Entreno"],["partido","Partido"]].map(([k,l])=>`<div class="ftr"><b>${l}</b><input type="time" data-ftime="${k}" value="${T[k].h}" aria-label="Hora del ${l.toLowerCase()}"><span class="small muted">dura</span><input type="number" min="15" max="180" data-fdur="${k}" value="${T[k].d}" aria-label="Duración del ${l.toLowerCase()} en minutos"><span class="small muted">min</span></div>`).join("")}</div>`;
}

/* =========================================================
   DICTAR POR VOZ → formulario relleno
   ========================================================= */
const NUMW = {cero:0,un:1,uno:1,una:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,once:11,doce:12,trece:13,catorce:14,quince:15,dieciseis:16,diecisiete:17,dieciocho:18,diecinueve:19,veinte:20,veintiun:21,veintiuno:21,veintidos:22,veintitres:23,veinticuatro:24,veinticinco:25,veintiseis:26,veintisiete:27,veintiocho:28,veintinueve:29,treinta:30,cuarenta:40,cincuenta:50,sesenta:60,setenta:70,ochenta:80,noventa:90,cien:100,ciento:100};
function wordsToNums(t){
  t = t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  t = t.replace(/\b(treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa) y (uno|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b/g, (_,a,b)=>String(NUMW[a]+NUMW[b]));
  t = t.replace(/\b(cero|uno|una|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuno|veintiun|veintidos|veintitres|veinticuatro|veinticinco|veintiseis|veintisiete|veintiocho|veintinueve|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien)\b/g, w=>String(NUMW[w]));
  return t.replace(/(\d+) coma (\d+)/g, "$1.$2").replace(/(\d+) y medio/g, (_,a)=>a+".5");
}
function voiceDate(t){
  if(/\bayer\b/.test(t)) return iso(addDays(new Date(), -1));
  if(/\banteayer\b/.test(t)) return iso(addDays(new Date(), -2));
  const m = t.match(/\bel (lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
  if(m){ const di = ["lunes","martes","miercoles","jueves","viernes","sabado","domingo"].indexOf(m[1]); let d = new Date(); for(let i=0;i<7;i++){ if(dow(d)===di) return iso(d); d = addDays(d,-1); } }
  return today();
}
function parseVoice(raw){
  const t = wordsToNums(raw), fecha = voiceDate(t), mm = re => { const m = t.match(re); return m ? m[1] : ""; };
  const durMin = () => { if(/hora y cuarto/.test(t)) return "75"; if(/hora y media/.test(t)) return "90"; if(/\b2 horas\b/.test(t)) return "120"; if(/\b1 hora\b|una hora/.test(t)) return "60"; return mm(/(\d+)\s*min/); };
  if(/futbol|partido|pachanga|\bgol(es)?\b/.test(t)){
    const fmt = /pachanga/.test(t) ? "pachanga" : /entreno|entrenamiento/.test(t) && !/partido/.test(t) ? "entreno" : "partido";
    const g = /(ningun|sin|0) gol/.test(t) ? "0" : (mm(/(\d+)\s*gol/) || (/\bun gol\b|1 gol|meti gol|marque/.test(t) ? "1" : ""));
    return {kind:"futbol", label:"Fútbol", p:{fecha, formato:fmt, minutos:durMin() || (fmt==="entreno"?"75":"60"), goles:g, asistencias:mm(/(\d+)\s*asist/), rpe: mm(/esfuerzo (?:de )?(\d+)/) || mm(/(\d+) sobre 10/) || "7", notas: raw.trim()}};
  }
  if(/\bmarca\b|\brm\b|record|personal/.test(t)){
    const v = mm(/(\d+(?:\.\d+)?)\s*(?:kilos|kg|kilogramos|repeticiones|reps|centimetros|cm|calorias|cal|metros|m)\b/) || mm(/(\d+(?:\.\d+)?)/);
    const un = /centimetro|cm\b/.test(t) ? "cm" : /repeticion|reps/.test(t) ? "reps" : /calorias|\bcal\b/.test(t) ? "cal" : /metros/.test(t) ? "m" : "kg";
    const ES = [["peso muerto rumano","romanian deadlift"],["peso muerto sumo","sumo deadlift"],["peso muerto","deadlift"],["sentadilla trasera","back squat"],["sentadilla frontal","front squat"],["sentadilla overhead","overhead squat"],["press banca","bench press"],["press de banca","bench press"],["press militar","strict press"],["press de hombro","shoulder press"],["arrancada","snatch"],["cargada","clean"],["dos tiempos","clean and jerk"],["envion","jerk"],["zancadas","lunges"]];
    let te = t; ES.forEach(([a,b])=>{ te = te.replace(new RegExp("\\b"+a+"\\b","g"), b); });
    const lift = matchLift(te), ej = lift ? cap1(lift) : cap1((t.match(/(?:marca|rm|record)(?: personal)? (?:de|en) ([a-z ]+?)(?: de| con| a)? \d/)||[])[1]||"");
    return {kind:"marca", label:"Marca", p:{fecha, ejercicio:ej, valor:v, unidad:un, nota:raw.trim()}};
  }
  // WOD por defecto
  const fmt = /amrap/.test(t) ? "AMRAP" : /emom/.test(t) ? "EMOM" : /for time|por tiempo/.test(t) ? "For time" : /hyrox|hybrid|hibrido/.test(t) ? "Hyrox / Hybrid" : /fuerza|rm\b/.test(t) ? "Fuerza" : "Otro";
  const mins = mm(/(?:amrap|emom)(?: de)? (\d+)/);
  let res = "";
  const rr = t.match(/(\d+)\s*rondas?(?:\s*(?:y|mas|\+)\s*(\d+)\s*(?:repeticiones|reps))?/);
  if(rr) res = rr[2] ? `${rr[1]}R + ${rr[2]} REPS` : `${rr[1]} RONDAS`;
  const tm = t.match(/(?:en|tiempo de|hice|tarde)\s*(\d{1,2})\s*minutos?\s*(?:y\s*)?(\d{1,2})\s*segundos?/) || t.match(/\b(\d{1,2}):(\d{2})\b/);
  if(!res && tm) res = `${tm[1]}:${String(tm[2]).padStart(2,"0")}`;
  const loads = [...t.matchAll(/([a-z][a-z ]{2,30}?)\s*(?:con|a|de)?\s*(\d+(?:\.\d+)?)\s*(?:kilos|kg|kilogramos)\b/g)].map(m=>`${cap1(m[1].replace(/^(y|con|el|la|los|las|de|he hecho|hice) /,"").trim())} ${m[2]} kg`);
  const nombre = fmt==="AMRAP" && mins ? `AMRAP ${mins}′` : fmt==="EMOM" && mins ? `EMOM ${mins}′` : fmt==="Hyrox / Hybrid" ? "Hybrid" : "WOD del día";
  return {kind:"wod", label:"WOD", p:{fecha, formato:fmt, nombre, resultado:res, notas:loads.join(" · "), texto:raw.trim()}};
}
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function voiceSheet(){
  const v = S.voice || {text:"", on:false};
  const pv = v.text ? parseVoice(v.text) : null;
  const sum = pv ? (pv.kind==="futbol" ? `${FMT[pv.p.formato]} · ${pv.p.minutos} min${pv.p.goles?` · ${pv.p.goles} gol${+pv.p.goles===1?"":"es"}`:""} · esfuerzo ${pv.p.rpe}`
    : pv.kind==="marca" ? `${pv.p.ejercicio||"¿ejercicio?"} · ${pv.p.valor||"?"} ${pv.p.unidad}` : `${pv.p.nombre}${pv.p.resultado?` · ${pv.p.resultado}`:""}${pv.p.notas?` · ${pv.p.notas}`:""}`) : "";
  return ["Dictar", `<div class="stack" style="gap:14px;align-items:center">
    ${SR ? `<button class="mic ${v.on?"on":""}" data-act="mic" aria-label="${v.on?"Parar":"Hablar"}"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
      <p class="small muted" style="text-align:center">${v.on?"Te escucho… pulsa para terminar":"Pulsa y cuéntame tu entreno"}</p>` : `<p class="small" style="text-align:center">Pulsa el micrófono del teclado del móvil y dicta en el cuadro.</p>`}
    <textarea id="vtext" placeholder="«Partido de fútbol, 70 minutos, metí 2 goles, esfuerzo 8»&#10;«AMRAP de 14 minutos, 3 rondas y 18 repeticiones, back squat con 45 kilos»&#10;«Nueva marca en peso muerto de 60 kilos»" style="width:100%;min-height:96px">${esc(v.text)}</textarea>
    ${pv?`<div class="vres"><span class="eyebrow">He entendido · ${pv.label}</span><b>${esc(sum)}</b><span class="small muted">${fDate(parseISO(pv.p.fecha))}</span></div>
      <button class="primary big" data-act="vuse" style="width:100%">Revisar y guardar</button>`:`<button class="ghost" data-act="vparse">Interpretar</button>`}
  </div>`];
}
function micToggle(){
  if(!SR) return;
  if(rec){ try{ rec.stop(); }catch(e){} return; }
  S.voice = {text:"", on:true}; renderSheet();
  rec = new SR(); rec.lang = "es-ES"; rec.interimResults = true; rec.continuous = true;
  let fin = "";
  rec.onresult = e => { let tmp = ""; for(let i=e.resultIndex;i<e.results.length;i++){ if(e.results[i].isFinal) fin += e.results[i][0].transcript+" "; else tmp += e.results[i][0].transcript; }
    S.voice.text = (fin+tmp).trim(); const ta = document.getElementById("vtext"); if(ta) ta.value = S.voice.text; };
  rec.onerror = e => { toast(e.error==="not-allowed" ? "Permite el micrófono para dictar, o usa el del teclado" : "No te he oído bien, prueba otra vez"); };
  rec.onend = () => { rec = null; S.voice.on = false; S.voice.text = (fin || S.voice.text).trim(); renderSheet(); };
  try{ rec.start(); haptic(); }catch(e){ rec = null; S.voice.on = false; renderSheet(); }
}

/* =========================================================
   PESTAÑA FÚTBOL
   ========================================================= */
const FMT = {partido:"Partido", entreno:"Entreno", pachanga:"Pachanga"};
function seasonStart(){ const t = new Date(); return new Date(t.getMonth()>=7 ? t.getFullYear() : t.getFullYear()-1, 7, 1); }  // temporada desde agosto
function nextFoot(){
  const p = footPrefs(); if(!p.entreno.length && !p.partido.length) return null;
  for(let i=0;i<8;i++){ const d = addDays(new Date(), i), r = footRole(dow(d)); if(!r) continue;
    if(i===0 && logs().some(l=>l.tipo==="futbol" && l.fecha===today())) continue;
    return {d, r, i}; }
  return null;
}
function futCard(f){
  const d = parseISO(f.fecha), g = +f.goles||0, a = +f.asistencias||0, isP = f.formato==="partido";
  return `<button class="futc ${isP?"p":""}" data-fut="${f.id}">
    <span class="wdate"><b>${d.getDate()}</b><span>${MESES[d.getMonth()]}</span></span>
    <span class="wbody"><span class="row" style="gap:6px"><span class="ftag ${isP?"p":""}">${FMT[f.formato]||"Fútbol"}</span><span class="small muted">${DIAS[dow(d)]}</span></span>
      <span class="fline"><b>${esc(f.minutos)}′</b> · esfuerzo ${esc(f.rpe||"–")}/10${g?` · <b>${g}</b> gol${g>1?"es":""}`:""}${a?` · ${a} asist.`:""}</span>
      ${f.notas?`<span class="com">${esc(f.notas)}</span>`:""}</span>
    <span class="effort" style="--e:${(+f.rpe||5)*10}%"><i></i></span>
  </button>`;
}
function futWeeks(list){
  const weeks = 10, start = addDays(monday(new Date()), -7*(weeks-1)), w = Array.from({length:weeks},(_,i)=>({s:addDays(start,7*i), p:0, e:0}));
  list.forEach(f=>{ const i = Math.floor(daysBetween(start, parseISO(f.fecha))/7); if(i>=0 && i<weeks){ if(f.formato==="partido") w[i].p += +f.minutos||0; else w[i].e += +f.minutos||0; } });
  const W = 400, H = 150, pl = 30, pb = 22, pt = 8, mx = Math.max(90, ...w.map(x=>x.p+x.e)), top = Math.ceil(mx/60)*60, bw = (W-pl-6)/weeks, y = v => pt + (H-pt-pb)*(1-v/top);
  let g = "";
  for(let v=0; v<=top; v+=60) g += `<line x1="${pl}" x2="${W-6}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pl-5}" y="${y(v)+3}" text-anchor="end">${v/60}h</text>`;
  w.forEach((x,i)=>{ const X = pl + i*bw + bw*.2, bwid = bw*.6;
    if(x.e) g += `<rect x="${X}" y="${y(x.e)}" width="${bwid}" height="${y(0)-y(x.e)}" rx="3" fill="var(--foot)" fill-opacity=".45"/>`;
    if(x.p) g += `<rect x="${X}" y="${y(x.e+x.p)}" width="${bwid}" height="${y(x.e)-y(x.e+x.p)}" rx="3" fill="var(--foot)"/>`;
    if(i%2===(weeks-1)%2) g += `<text x="${X+bwid/2}" y="${H-6}" text-anchor="middle">${x.s.getDate()} ${MESES[x.s.getMonth()]}</text>`; });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Minutos de fútbol por semana">${g}</svg>
  <div class="legend"><span><i class="dot" style="background:var(--foot)"></i>Partido</span><span><i class="dot" style="background:var(--foot);opacity:.45"></i>Entreno</span></div>`;
}
function vFutbol(){
  const all = logs().filter(l=>l.tipo==="futbol").sort((a,b)=>b.fecha.localeCompare(a.fecha));
  const ss = seasonStart(), season = all.filter(f=>parseISO(f.fecha)>=ss);
  const P = season.filter(f=>f.formato==="partido"), E = season.filter(f=>f.formato!=="partido");
  const goals = season.reduce((t,f)=>t+(+f.goles||0),0), ast = season.reduce((t,f)=>t+(+f.asistencias||0),0);
  const mins = season.reduce((t,f)=>t+(+f.minutos||0),0), rpe = season.length ? season.reduce((t,f)=>t+(+f.rpe||0),0)/season.length : 0;
  const nf = nextFoot();
  // Peso del fútbol en tu carga de las últimas 4 semanas
  const s28 = allSessions().filter(s=>daysBetween(s.date,new Date())<28), lt = s28.reduce((t,s)=>t+load(s),0), lf = s28.filter(s=>s.cat==="futbol").reduce((t,s)=>t+load(s),0);
  const share = lt ? Math.round(100*lf/lt) : 0;
  const fv = {}; Object.entries(FUT).forEach(([k,v])=>fv[k]=v/.8);
  return `
  <div class="hero foothero">
    <div class="row between"><span class="eyebrow">Temporada ${ss.getFullYear()}/${String(ss.getFullYear()+1).slice(2)}</span>${nf?`<span class="glass">${nf.i===0?"Hoy":nf.i===1?"Mañana":DIAS[dow(nf.d)]} · ${nf.r}</span>`:""}</div>
    <div class="fstats">
      <div><b data-count="${P.length}">${P.length}</b><span>partidos</span></div>
      <div><b data-count="${E.length}">${E.length}</b><span>entrenos</span></div>
      <div><b data-count="${goals}">${goals}</b><span>goles</span></div>
      <div><b data-count="${ast}">${ast}</b><span>asistencias</span></div>
    </div>
    <div class="hero-stats"><div><b>${fMin(mins)}</b><span>jugados</span></div><div><b>${P.length?(goals/P.length).toFixed(2).replace(".",","):"–"}</b><span>goles / partido</span></div><div><b>${rpe?rpe.toFixed(1).replace(".",","):"–"}</b><span>esfuerzo medio</span></div></div>
  </div>
  ${footAsk()}
  <div class="row" style="gap:10px;flex-wrap:nowrap"><button class="addbtn foot wide" data-sheet="futbol" style="flex:1">+ Registrar</button><button class="addbtn soft wide" data-sheet="futfill" style="flex:1">Rellenar temporada</button></div>
  ${footPrefsCard()}
  ${all.length?`<div class="card"><div class="row between"><h2>Tus sesiones</h2><span class="small muted">${all.length}</span></div>
    <div class="wodlist">${all.slice(0, S.futAll?200:8).map(futCard).join("")}</div>
    ${all.length>8?`<button class="ghost" data-act="futall" style="align-self:center">${S.futAll?"Ver menos":`Ver las ${all.length}`}</button>`:""}</div>`
  : `<div class="card"><h2>Tus sesiones</h2><p class="small">Aún no has apuntado fútbol. Pulsa «Registrar fútbol» al terminar cada entreno o partido y aquí verás tu temporada.</p></div>`}
  <div class="card"><div class="row between"><h3>Minutos por semana</h3><span class="small muted">${share}% de tu carga (4 sem)</span></div>${futWeeks(all)}
    <p class="note">Carga = minutos × esfuerzo. El fútbol cuenta como entrenamiento de intervalos: sprints, cambios de ritmo y frenadas.</p></div>
  <div class="card"><h3>Lo que trabaja el fútbol</h3>
    <div class="bodygrid"><div class="twin" style="grid-column:1/-1"><div><span class="eyebrow">Delante</span>${Body.figure("f", fv, {id:"ff"})}</div><div><span class="eyebrow">Detrás</span>${Body.figure("b", fv, {id:"fb"})}</div></div></div>
    <p class="small">Isquios, aductores y gemelos son los que más sufren con sprints y frenadas: son también los que necesitas para la media y el HYROX.</p></div>
  <div class="card"><h3>Cómo encaja con tus objetivos</h3>
    <div class="list small">
      <div class="check"><span class="box">1</span><div><b>El partido es tu sesión de intensidad del domingo.</b> No hace falta sumar series el mismo fin de semana.</div></div>
      <div class="check"><span class="box">2</span><div><b>El lunes tras el partido</b>, si notas las piernas cargadas en el chequeo, toma el entreno con calma.</div></div>
      <div class="check"><span class="box">3</span><div><b>El sábado</b>, rodaje suave o descanso: llegar fresca al partido también es entrenar.</div></div>
      <div class="check"><span class="box">4</span><div><b>Isquios y aductores:</b> 2 series de nórdicos o Copenhagen una vez por semana reducen el riesgo de lesión en fútbol y te ayudan en carrera.</div></div>
    </div>
    <p class="note">Pautas generales de prevención en deportes de equipo; no sustituyen a tu entrenador ni a tu fisio.</p></div>`;
}
function futSheet(id){
  const f = logs().find(l=>l.id===id && l.tipo==="futbol"); if(!f) return ["Fútbol","<p>Ya no existe.</p>"];
  return [`${FMT[f.formato]||"Fútbol"} · ${fDate(parseISO(f.fecha))}`, `${fmFutbol(f)}<div class="row between" style="margin-top:12px">${delBtn(f.id, "Borrar")}<button class="ghost" data-act="close">Cerrar</button></div>`];
}

/* =========================================================
   FORMA DE HOY: puntuación y consejos a partir del chequeo
   ========================================================= */
function readiness(ck){
  if(!ck) return null;
  if(ck.sintoma==="si") return 0;
  const v = {mal:0, normal:.6, bien:1, baja:0, alta:1, cargadas:0, normales:.6, frescas:1};
  const parts = [["sueno",35],["energia",35],["piernas",30]].filter(([k])=>ck[k]);
  if(!parts.length) return null;
  const max = parts.reduce((t,[,w])=>t+w,0);
  return Math.round(100 * parts.reduce((t,[k,w])=>t+w*(v[ck[k]]??.6),0) / max);
}
function readinessTips(ck){
  if(!ck) return [];
  const t = [];
  if(ck.sintoma==="si") return ["Hoy nada de intensidad: descanso o paseo suave.", "Bebe agua con algo de sal y come con normalidad.", "Si se repite o te mareas entrenando, consúltalo con tu médico antes de volver a cargar."];
  if(ck.sueno==="mal") t.push("Has dormido mal: baja un punto la intensidad y evita series o RM. Intenta acostarte 30 min antes esta noche.");
  if(ck.energia==="baja") t.push("Poca energía: come algo con hidratos 1–2 h antes de entrenar y llega bien hidratada.");
  if(ck.piernas==="cargadas") t.push("Piernas cargadas: rodaje muy suave o bici. 10 min de movilidad de cadera, gemelos e isquios. En el box, escala las cargas de pierna.");
  if(ck.sueno==="bien" && ck.energia==="alta" && ck.piernas==="frescas") t.push("Estás fresca: buen día para la sesión de calidad o para apretar en el WOD.");
  // Tendencia: 3 de los últimos 4 días con forma baja → descarga
  const last = logs().filter(l=>l.tipo==="checkin").sort((a,b)=>b.fecha.localeCompare(a.fecha)).slice(0,4).map(readiness).filter(x=>x!=null);
  if(last.length>=3 && last.filter(x=>x<45).length>=3) t.push("Llevas varios días con la forma baja: plantéate una semana de descarga (mismo número de sesiones, la mitad de intensidad).");
  return t;
}
function ring(score){
  const r = 26, c = 2*Math.PI*r, col = score>=70 ? "var(--ok)" : score>=45 ? "var(--warn)" : "var(--bad)";
  return `<svg class="ring" viewBox="0 0 64 64" role="img" aria-label="Forma ${score} de 100"><circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--line)" stroke-width="7"/><circle cx="32" cy="32" r="${r}" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${c*score/100} ${c}" transform="rotate(-90 32 32)"/><text x="32" y="37" text-anchor="middle" style="font:800 17px var(--display);fill:var(--fg)">${score}</text></svg>`;
}

/* =========================================================
   HOY: entrenador diario + chequeo rápido
   ========================================================= */
function upsertRec(id, fields){
  const now = Date.now(), r = S.recs.find(x=>x.id===id);
  if(r){ Object.assign(r, fields, {mod:now}); delete r.borrado; } else S.recs.push({id, creado:now, mod:now, ...fields});
  LS.set("recs", S.recs); schedulePush();
}
const haptic = () => { try{ navigator.vibrate && navigator.vibrate(10); }catch(e){} };
function boxDays(){
  const c = [0,0,0,0,0,0,0]; allSessions().filter(s=>s.cat==="box" && daysBetween(s.date,new Date())<90).forEach(s=>c[dow(s.date)]++);
  const tot = c.reduce((a,b)=>a+b,0);
  return tot ? c.map((n,i)=>[i,n]).filter(([,n])=>n/tot>=0.22).map(([i])=>i) : [1,3];
}
const checkinToday = () => logs().find(l=>l.tipo==="checkin" && l.fecha===today());
function paces(){
  const k5 = bestEfforts()["5k"]?.t, p5 = k5 ? k5/5 : 298;
  return {p5, z2:`${fPace(p5+100)}–${fPace(p5+65)}`, z3:`${fPace(p5+65)}–${fPace(p5+35)}`, z4:`${fPace(p5+35)}–${fPace(p5+15)}`, hm: hmGoalPace()};
}
function coachToday(){
  const now = new Date(), t = today(), di = dow(now), ss = allSessions();
  const cp = currentPhase(), info = cp?.info || {n:"Mantenimiento", box:2, runs:2};
  const P = paces(), longKm = cp?.longKm || 12;
  const m = monday(now), wk = ss.filter(s=>daysBetween(m,s.date)>=0 && s.date<=now && daysBetween(m,s.date)<7);
  const nBox = wk.filter(s=>s.cat==="box").length, runs = wk.filter(s=>s.cat==="run");
  const longDone = runs.some(r=>r.km >= longKm*0.9), qualDone = runs.some(r=>r.pace && r.pace < P.p5+50 && r.km < 14);
  const runsLeft = Math.max(0, info.runs - runs.length), boxLeft = Math.max(0, info.box - nBox), daysLeft = 7 - di;
  const yest = ss.filter(s=>daysBetween(s.date, now)===1);
  const hardY = yest.some(s=>s.cat==="box" || s.cat==="futbol" || (s.cat==="run" && (s.km>=14 || (s.pace && s.pace < P.p5+50))));
  const role = footRole(di), tomorrow = footRole((di+1)%7);
  const lastRun = ss.find(s=>s.cat==="run"), sinceRun = lastRun ? daysBetween(lastRun.date, now) : 99;
  const n28 = ss.filter(s=>daysBetween(s.date, now) < 28).length;
  const A = n28 >= 6 ? acwr(ss).ratio : null, ck = checkinToday();   // con poco historial el cociente no es fiable
  const done = ss.filter(s=>iso(s.date)===t);
  const why = [];
  if(cp) why.push(`Fase <b>${info.n}</b> (${Math.max(1,Math.round((daysBetween(cp.start,cp.end)+1)/7))} sem) camino de ${esc(cp.ev.nombre)}`);
  why.push(`Esta semana: ${nBox}/${info.box} box · ${runs.length}/${info.runs} carreras`);
  if(done.length && done.every(s=>s.cat==="futbol")) return {k:"done", c:"var(--ok)", t:"Fútbol hecho", d:`${done.map(s=>esc(s.name)).join(" + ")} · ${fMin(done.reduce((a,s)=>a+s.min,0))}. Estira gemelos e isquios, hidrátate y cena con hidratos y proteína.${tomorrow==="partido"?"":" Mañana, si te toca correr, que sea suave."}`, why};
  if(done.length) return {k:"done", c:"var(--ok)", t:"Entreno de hoy hecho", d:`${done.map(s=>esc(s.name)).join(" + ")} · ${fMin(done.reduce((a,s)=>a+s.min,0))}. Hidrátate, come algo con proteína e hidratos y estira 5 minutos.`, why};
  if(ck && ck.sintoma==="si") return {k:"rest", c:"var(--bad)", t:"Hoy, descanso", d:"Has marcado mareo o molestia. Descansa, hidrátate y, si se repite, coméntaselo a tu médico antes de volver a la intensidad.", why:["Chequeo de hoy: mareo o molestia"]};
  const tired = ck && (ck.energia==="baja" || (ck.sueno==="mal" && ck.piernas==="cargadas"));
  if(tired || (A && A>1.5)){ why.unshift(tired ? "Chequeo de hoy: poca energía o mala noche con piernas cargadas" : `Carga alta: ${A.toFixed(2)} (más de 1,5)`);
    return {k:"easy", c:"var(--warn)", t:"Recuperación activa", d:`20–30 min de caminar, bici suave o movilidad. Si te encuentras bien, como mucho 25 min muy suaves a ${fPace(P.p5+110)}/km o más lento.`, why}; }
  if(role && !done.some(s=>s.cat==="futbol")){
    why.unshift(role==="partido" ? "Hoy es tu día de partido" : "Hoy tienes entreno de fútbol");
    return {k:"foot", c:"var(--foot)", role, t: role==="partido" ? "Partido de fútbol" : "Entreno de fútbol",
      d: role==="partido" ? "Calienta 10 min con trote, movilidad y unos sprints cortos. Al terminar, apúntalo con los minutos jugados." : "Entreno con el equipo. Si quieres sumar, 10 min de core al acabar. Apúntalo al terminar.", why}; }
  if(tomorrow==="partido"){ why.unshift("Mañana tienes partido");
    return boxDays().includes(di) && boxLeft>0
      ? {k:"box", c:"var(--box)", t:"Box suave", d:"Mañana juegas: ve al box pero sin apretar en pierna (escala cargas y evita saltos en exceso).", why}
      : {k:"easy", c:"var(--warn)", t:"Suave o descanso", d:`Mañana juegas. Como mucho 30 min muy suaves a ${P.z2}/km o descanso con movilidad.`, why}; }
  if(boxDays().includes(di) && boxLeft>0){
    const hx = cp && ["construccion","especifico"].includes(cp.key);
    why.unshift(`Sueles ir al box los ${boxDays().map(i=>DIAS[i]).join(" y ")}`);
    return {k:"box", c:"var(--box)", t:"Box", d: hx ? "Tu sesión de box. Si el WOD lo permite, mete trabajo de estaciones HYROX: farmers 2 × 16 kg, sled o wall balls de 4 kg." : "Tu sesión de box. Apunta el WOD al terminar (o sube la captura de AimHarder).", why};
  }
  if(runsLeft>0){
    if(sinceRun>=10){ why.unshift(`Llevas ${sinceRun} días sin correr`);
      return {k:"run", c:"var(--run)", t:"Rodaje suave de vuelta", d:`35–40 min a ${P.z2}/km. Sin mirar el ritmo: que puedas hablar en frases completas.`, why}; }
    if(info.runs>=3 && !longDone && (di>=5 || runsLeft>=daysLeft)){ why.unshift(`Falta la tirada larga de la semana (${longKm} km)`);
      return {k:"run", c:"var(--run)", t:`Tirada larga · ${longKm} km`, d:`Suave, ${P.z2}/km.${cp?.key==="especifico" && P.hm ? ` Los últimos 4–5 km a ritmo de media (${fPace(P.hm)}/km).` : ""} Lleva agua si pasa de 75 minutos.`, why}; }
    if(!qualDone && !hardY && info.runs>=2){
      const q = !cp || cp.key==="base" ? `6–8 rectas de 20 s rápidas al final de 35 min suaves (${P.z2}/km)`
        : cp.key==="construccion" ? `Calentar 15 min y 3 × 10 min a ${P.z4}/km con 2 min suaves`
        : cp.key==="especifico" ? `2 × 5 km a ritmo objetivo de media${P.hm?` (${fPace(P.hm)}/km)`:""} o carrera comprometida: 4 × (1 km + estación HYROX)`
        : `Corto: 3 × 1 km a ritmo de carrera con 2 min suaves`;
      why.unshift(hardY ? "" : "Ayer no fue un día duro: buen día para calidad");
      return {k:"run", c:"var(--run)", t:"Carrera de calidad", d:q, why:why.filter(Boolean)}; }
    if(hardY) why.unshift("Ayer fue un día duro");
    return {k:"run", c:"var(--run)", t:"Rodaje suave", d:`35–50 min a ${P.z2}/km.`, why};
  }
  if(boxLeft>0 && !hardY) return {k:"box", c:"var(--box)", t:"Box o fuerza", d:"Te queda una sesión de box esta semana: hoy es buen día.", why};
  why.unshift("Has cumplido lo de la semana");
  return {k:"rest", c:"var(--muted)", t:"Descanso", d:"Descanso completo o un paseo. El descanso también entrena.", why};
}
const QI = {
  foot:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7l4 3-1.5 4.5h-5L8 10z"/></svg>',
  wod:'<svg viewBox="0 0 24 24"><path d="M2 12h20M5 8v8M19 8v8M8 6v12M16 6v12"/></svg>',
  share:'<svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6"/></svg>'
};
function todayCard(){
  const c = coachToday(), ck = checkinToday();
  const opt = (f, vals) => `<div class="ckrow"><span>${f[1]}</span><div class="ckseg">${vals.map(([v,l])=>`<button type="button" data-ck="${f[0]}" data-v="${v}" aria-pressed="${ck && ck[f[0]]===v}">${l}</button>`).join("")}</div></div>`;
  return `<div class="today" style="--c:${c.c}">
    <div class="row between"><span class="eyebrow">Hoy · ${DIAS[dow(new Date())]} ${fDate(new Date())}</span><span class="tk">${{run:"Correr",box:"Box",rest:"Descanso",easy:"Suave",done:"Hecho",foot:"Fútbol"}[c.k]}</span></div>
    <h2 class="tt">${c.t}</h2>
    <p class="td">${c.d}</p>
    ${c.k==="foot"?`<button class="addbtn foot" data-sheet="futbol" data-fmt="${c.role}">Apuntar ${c.role==="partido"?"partido":"entreno"}</button>`:""}
    ${(()=>{ const sc = readiness(ck), tips = readinessTips(ck); if(sc==null) return ""; return `<div class="form"><div class="formring">${ring(sc)}<span class="small"><b>Tu forma hoy</b><br><span class="muted">según tu chequeo</span></span></div>${tips.length?`<ul class="tips">${tips.map(t=>`<li>${t}</li>`).join("")}</ul>`:""}</div>`; })()}
    ${c.why.length?`<details class="whyd"><summary>Por qué</summary><ul class="why">${c.why.map(w=>`<li>${w}</li>`).join("")}</ul></details>`:""}
    <details class="ck" ${!ck || ["sueno","energia","piernas","sintoma"].some(k=>!ck[k]) ? "open" : ""}><summary>${ck ? `Chequeo hecho · sueño ${ck.sueno||"–"}, energía ${ck.energia||"–"}, piernas ${ck.piernas||"–"}${ck.sintoma==="si"?" · mareo/molestia":""}` : "¿Cómo estás hoy? (10 segundos)"}</summary>
      ${opt(["sueno","Sueño"], [["mal","Mal"],["normal","Normal"],["bien","Bien"]])}
      ${opt(["energia","Energía"], [["baja","Baja"],["normal","Normal"],["alta","Alta"]])}
      ${opt(["piernas","Piernas"], [["cargadas","Cargadas"],["normales","Normales"],["frescas","Frescas"]])}
      ${opt(["sintoma","Mareo o molestia"], [["no","No"],["si","Sí"]])}
    </details>
  </div>`;
}

/* =========================================================
   PLANIFICADOR HYROX EN PAREJA
   ========================================================= */
// Minutos de referencia por estación (estimación propia para un nivel intermedio en Doubles; editables)
const HX_DEF = [3.0, 2.3, 2.8, 3.2, 3.0, 1.3, 3.2, 4.0];
function hxGet(){
  if(S.hx) return S.hx;
  const r = logs().find(l=>l.tipo==="hyroxplan");
  if(r){ try{ S.hx = JSON.parse(r.json); return S.hx; }catch(e){} }
  const hm = bestEfforts()["half-marathon"];
  S.hx = {pace: hm ? Math.round(hm.t/21.0975 + 30) : 345, rox: 0.8, st: HX_DEF.map(m=>({min:m, pct:50}))};
  return S.hx;
}
function hxTotals(h){
  const run = 8*h.pace, st = h.st.reduce((t,s)=>t+s.min*60,0), rox = 8*h.rox*60, me = h.st.reduce((t,s)=>t+s.min*60*s.pct/100,0);
  return {run, st, rox, tot: run+st+rox, me, her: st-me};
}
function hxBar(h){
  const T = hxTotals(h).tot; let x = 0, g = "";
  for(let i=0;i<8;i++){
    const wr = 8*h.pace/8/T*100 + h.rox*60/T*100, ws = h.st[i].min*60/T*100;
    g += `<rect x="${x}%" y="0" width="${wr}%" height="100%" fill="var(--run)" opacity=".85"/>`; x += wr;
    g += `<rect x="${x}%" y="0" width="${ws*h.st[i].pct/100}%" height="100%" fill="var(--box)"/><rect x="${x+ws*h.st[i].pct/100}%" y="0" width="${ws*(100-h.st[i].pct)/100}%" height="100%" fill="var(--box)" opacity=".4"/>`; x += ws;
  }
  return `<svg class="hxbar" preserveAspectRatio="none" viewBox="0 0 100 10" role="img" aria-label="Reparto de la carrera">${g}</svg>
  <div class="legend"><span><i class="dot" style="background:var(--run)"></i>Carrera + transición</span><span><i class="dot" style="background:var(--box)"></i>Estación (tú)</span><span><i class="dot" style="background:var(--box);opacity:.4"></i>Tu compañera</span></div>`;
}
function hxSummary(h){
  const T = hxTotals(h);
  return `<div class="hxsum"><div><span class="eyebrow">Tiempo estimado</span><span class="num huge2">${fTime(T.tot)}</span></div>
    <div class="hxs"><div><b>${fTime(T.run)}</b><span>8 km a ${fPace(h.pace)}/km</span></div><div><b>${fTime(T.st)}</b><span>estaciones</span></div><div><b>${fTime(T.rox)}</b><span>transiciones</span></div></div>
    ${hxBar(h)}
    <p class="small">En estaciones trabajas <b>${fTime(T.me)}</b> y tu compañera <b>${fTime(T.her)}</b>${Math.abs(T.me-T.her)>90?` · <span class="muted">${T.me>T.her?"te llevas tú más trabajo":"se lleva ella más trabajo"}</span>`:""}.</p></div>`;
}
function hyroxSheet(){
  const h = hxGet();
  return ["Plan HYROX en pareja", `<div class="stack" style="gap:14px">
    <div id="hxsum">${hxSummary(h)}</div>
    <div class="hxrow"><span><b>Ritmo de carrera</b><small>por km, ya cansada</small></span><div class="stepper"><button type="button" data-hx="pace" data-d="-5">−</button><b id="hx_pace">${fPace(h.pace)}</b><button type="button" data-hx="pace" data-d="5">+</button></div></div>
    <div class="hxrow"><span><b>Transición</b><small>por estación (Roxzone y cambio)</small></span><div class="stepper"><button type="button" data-hx="rox" data-d="-0.1">−</button><b id="hx_rox">${h.rox.toFixed(1)}′</b><button type="button" data-hx="rox" data-d="0.1">+</button></div></div>
    <div class="stack" style="gap:8px">${HYROX.map((st,i)=>`<div class="hxst">
      <div class="row between"><span><b>${i+1}. ${st.n}</b> <small class="muted">${st.d}</small></span><div class="stepper sm"><button type="button" data-hx="min" data-i="${i}" data-d="-0.1">−</button><b id="hx_min_${i}">${h.st[i].min.toFixed(1)}′</b><button type="button" data-hx="min" data-i="${i}" data-d="0.1">+</button></div></div>
      <div class="row" style="gap:10px;flex-wrap:nowrap"><small class="muted" style="width:62px">Tú <b id="hx_pl_${i}">${h.st[i].pct}%</b></small><input type="range" min="0" max="100" step="10" value="${h.st[i].pct}" data-hxpct="${i}" aria-label="Tu parte en ${st.n}"><small class="muted" style="width:62px;text-align:right">Ella <b id="hx_pr_${i}">${100-h.st[i].pct}%</b></small></div>
    </div>`).join("")}</div>
    <p class="note">Tiempos de partida: estimación propia para un nivel intermedio en Doubles. El ritmo sale de tu media + 30 s/km (correr cansada entre estaciones). Ajústalos con tus simulaciones y tu compañera.</p>
    <button class="primary big" type="button" data-act="hxsave">Guardar plan</button>
  </div>`];
}
function hxUpdate(){ const h = S.hx; const el = document.getElementById("hxsum"); if(el) el.innerHTML = hxSummary(h);
  const set = (id,v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
  set("hx_pace", fPace(h.pace)); set("hx_rox", h.rox.toFixed(1)+"′");
  h.st.forEach((s,i)=>{ set("hx_min_"+i, s.min.toFixed(1)+"′"); set("hx_pl_"+i, s.pct+"%"); set("hx_pr_"+i, (100-s.pct)+"%"); }); }

/* =========================================================
   PLAN DE CARRERA (MEDIA)
   ========================================================= */
function hmSplits(goal, strat){
  const D = 21.0975, g = goal/D, out = [];
  let paceAt;
  if(strat==="neg"){ const p1 = g+6, p2 = g, p3 = (goal - 10*p1 - 8*p2)/(D-18); paceAt = km => km<=10 ? p1 : km<=18 ? p2 : p3; }
  else paceAt = () => g;
  let acc = 0;
  for(let k=1;k<=22;k++){ const d = Math.min(1, D-(k-1)); if(d<=0) break; const p = paceAt(k); acc += p*d; out.push({k, d, p, acc}); }
  return out;
}
function hmSheet(){
  const ev = futuros().find(e=>e.clase==="carrera" && Math.abs((+String(e.km).replace(",", "."))-21.1)<0.3);
  const pr = bestEfforts()["half-marathon"]?.t;
  const goal = S.hmGoal || parseTime(ev?.objetivo) || (pr ? Math.round(pr - 120) : 6600), strat = S.hmStrat || "neg";
  const sp = hmSplits(goal, strat), at = k => sp.find(s=>s.k===k)?.acc;
  return [ev ? ev.nombre : "Plan de media maratón", `<div class="stack" style="gap:14px">
    <div class="grid2">${field("hm_goal","Objetivo",`<input id="hm_goal" value="${fTime(goal)}" inputmode="numeric" placeholder="1:48:00">`)}
      <label>Estrategia<div class="seg" style="margin-top:2px"><button type="button" data-hmstrat="neg" aria-pressed="${strat==="neg"}">Parcial negativo</button><button type="button" data-hmstrat="even" aria-pressed="${strat==="even"}">Constante</button></div></label></div>
    <div class="hxsum"><div><span class="eyebrow">Ritmo medio</span><span class="num huge2">${fPace(goal/21.0975)}<small>/km</small></span></div>
      <div class="hxs"><div><b>${fTime(at(5))}</b><span>paso 5 km</span></div><div><b>${fTime(at(10))}</b><span>paso 10 km</span></div><div><b>${fTime(at(15))}</b><span>paso 15 km</span></div></div>
      ${pr?`<p class="small">Tu marca: <b>${fTime(pr)}</b> (${fPace(pr/21.0975)}/km). Objetivo ${goal<pr?`${fTime(pr-goal)} más rápido`:`${fTime(goal-pr)} más lento`}.</p>`:""}</div>
    <div class="kmgrid">${sp.map(s=>`<div class="kmc${s.k===8||s.k===15?" gel":""}"><span class="k">${s.k===22?"21,1":s.k}</span><b>${fPace(s.p)}</b><small>${fTime(s.acc)}</small></div>`).join("")}</div>
    <p class="small"><span class="gelmark"></span> Gel con agua en los km 8 y 15 (unos 40 y 75 minutos). Pruébalo antes en las tiradas largas.</p>
    <p class="note">${strat==="neg"?"Parcial negativo: primeros 10 km 6 s/km más lentos que el objetivo, del 10 al 18 a ritmo objetivo y el final más rápido. Suele ser la estrategia más eficaz para la media.":"Ritmo constante todo el recorrido."} Cálculo propio; ajusta por el perfil del recorrido.</p>
    ${ev?`<button class="primary big" type="button" data-act="hmsave">Guardar objetivo en la competición</button>`:""}
  </div>`];
}

/* =========================================================
   COMPARTIR LA SEMANA (imagen tipo story)
   ========================================================= */
async function weekStory(){
  haptic();
  try{ await document.fonts.ready; }catch(e){}
  const W = 1080, H = 1920, cv = document.createElement("canvas"); cv.width = W; cv.height = H; const x = cv.getContext("2d");
  const m = monday(new Date()), ss = allSessions().filter(s=>daysBetween(m,s.date)>=0 && daysBetween(m,s.date)<7);
  const wods = logs().filter(l=>l.tipo==="wod" && daysBetween(m, parseISO(l.fecha))>=0 && daysBetween(m, parseISO(l.fecha))<7);
  const mins = ss.reduce((t,s)=>t+s.min,0), km = ss.filter(s=>s.cat==="run").reduce((t,s)=>t+s.km,0);
  const g = x.createRadialGradient(W, 0, 100, W, 0, 1700); g.addColorStop(0, "#5B2440"); g.addColorStop(1, "#141C18");
  x.fillStyle = g; x.fillRect(0,0,W,H);
  const D = '"Barlow Condensed", "Arial Narrow", sans-serif', B = 'Inter, system-ui, sans-serif';
  x.fillStyle = "rgba(255,255,255,.7)"; x.font = `600 38px ${B}`; x.fillText(`SEMANA DEL ${m.getDate()} DE ${MESES[m.getMonth()].toUpperCase()}`, 90, 200);
  x.fillStyle = "#fff"; x.font = `800 230px ${D}`; x.fillText(fMin(mins).replace(" min","′"), 80, 440);
  x.font = `500 44px ${B}`; x.fillStyle = "rgba(255,255,255,.8)"; x.fillText(`de entreno · ${ss.length} ${ss.length===1?"sesión":"sesiones"}`, 90, 515);
  const stats = [[km.toFixed(1)+" km","corriendo"],[String(ss.filter(s=>s.cat==="box").length),"sesiones de box"],[String(ss.filter(s=>s.cat==="futbol").length),"de fútbol"]];
  stats.forEach(([v,l],i)=>{ const X = 90 + i*320; x.fillStyle = "#fff"; x.font = `800 96px ${D}`; x.fillText(v, X, 700); x.fillStyle = "rgba(255,255,255,.7)"; x.font = `500 34px ${B}`; x.fillText(l, X, 750); });
  // barras por día
  const byD = [0,0,0,0,0,0,0].map(()=>({run:0, box:0, foot:0})); ss.forEach(s=>{ const k = s.cat==="run"?"run":s.cat==="futbol"?"foot":"box"; byD[dow(s.date)][k] += s.min; });
  const mx = Math.max(60, ...byD.map(d=>d.run+d.box+d.foot)), bw = 96, base = 1180;
  byD.forEach((d,i)=>{ const X = 90 + i*(bw+40); let y = base;
    x.fillStyle = "rgba(255,255,255,.1)"; x.fillRect(X, base-300, bw, 300);
    [["run","#7C9BFF"],["box","#FF7FA4"],["foot","#4FD08F"]].forEach(([k,c])=>{ const h = d[k]/mx*300; if(h){ x.fillStyle = c; x.fillRect(X, y-h, bw, h); y -= h; } });
    x.fillStyle = "rgba(255,255,255,.75)"; x.font = `600 34px ${B}`; x.textAlign = "center"; x.fillText(DIAS[i].toUpperCase(), X+bw/2, base+50); x.textAlign = "left"; });
  // WODs
  let y = 1340; x.fillStyle = "rgba(255,255,255,.7)"; x.font = `600 36px ${B}`; x.fillText(wods.length ? "WODS" : "", 90, y);
  wods.slice(0,3).forEach(w=>{ y += 80; x.fillStyle = "#fff"; x.font = `600 40px ${B}`; let n = w.nombre; while(x.measureText(n).width > 560 && n.length>4) n = n.slice(0,-2).trim()+"…"; x.fillText(n, 90, y);
    if(w.resultado){ x.fillStyle = "#4FD08F"; x.font = `800 52px ${D}`; x.textAlign = "right"; x.fillText(w.resultado.slice(0,18), W-90, y); x.textAlign = "left"; } });
  const e = futuros()[0];
  if(e){ x.fillStyle = "rgba(255,255,255,.12)"; x.fillRect(90, 1640, W-180, 150);
    x.fillStyle = "#FF7FA4"; x.font = `800 110px ${D}`; x.fillText(String(daysBetween(new Date(), parseISO(e.fecha))), 130, 1752);
    x.fillStyle = "#fff"; x.font = `600 40px ${B}`; x.fillText("días para", 330, 1700); x.font = `700 46px ${B}`; let nm = e.nombre; while(x.measureText(nm).width > W-90-330-30 && nm.length>4) nm = nm.slice(0,-2).trim()+"…"; x.fillText(nm, 330, 1756); }
  const blob = await new Promise(r=>cv.toBlob(r, "image/png"));
  const file = new File([blob], "mi-semana.png", {type:"image/png"});
  if(navigator.canShare && navigator.canShare({files:[file]})){ try{ await navigator.share({files:[file], title:"Mi semana"}); return; }catch(err){ if(err && err.name==="AbortError") return; } }
  const url = URL.createObjectURL(blob);
  openSheet("story", url);
}

/* =========================================================
   FLUIDEZ: números que se animan y gestos entre pestañas
   ========================================================= */
// Las explicaciones largas se esconden: un botón ⓘ junto al título de la tarjeta las muestra
function decorateNotes(root){
  root.querySelectorAll(".card, .today").forEach(card=>{
    if(!card.querySelector(".note") || card.querySelector(":scope .nfo")) return;
    const h = card.querySelector("h2, h3"); if(!h) return;
    const b = document.createElement("button"); b.type = "button"; b.className = "nfo"; b.dataset.act = "notes"; b.setAttribute("aria-label", "Más información"); b.textContent = "i";
    h.appendChild(b);
    if(S.notesOpen && S.notesOpen.has(h.textContent.replace(/i$/,""))) card.classList.add("notes-on");
  });
}
function countUp(root){
  if(matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.querySelectorAll("[data-count]").forEach(el=>{ const end = +el.dataset.count; if(!isFinite(end) || end<=0) return;
    const t0 = performance.now(), dur = 700; const step = now => { const p = Math.min(1, (now-t0)/dur), e = 1-Math.pow(1-p,3); el.textContent = Math.round(end*e); if(p<1) requestAnimationFrame(step); }; requestAnimationFrame(step); });
}

/* =========================================================
   INICIO: saludo, panel de tarjetas (bento) y actividad
   ========================================================= */
function greet(){ const h = new Date().getHours(); return h<6 ? "Buenas noches" : h<14 ? "Buenos días" : h<21 ? "Buenas tardes" : "Buenas noches"; }
function avatar(){
  const a = S.athlete || {}, url = a.profile_medium || a.profile, ini = (a.firstname||"?").charAt(0).toUpperCase();
  return url && /^https:/.test(url) ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">` : `<span>${esc(ini)}</span>`;
}
function weekGoals(){
  const ss = allSessions(), m = monday(new Date()), wk = ss.filter(s=>daysBetween(m,s.date)>=0 && daysBetween(m,s.date)<7);
  const cp = currentPhase(), info = cp?.info || {box:2, runs:2}, fp = footPrefs();
  const n = info.box + info.runs + fp.entreno.length + fp.partido.length;
  const d = Math.min(info.box, wk.filter(s=>s.cat==="box").length) + Math.min(info.runs, wk.filter(s=>s.cat==="run").length) + Math.min(fp.entreno.length+fp.partido.length, wk.filter(s=>s.cat==="futbol").length);
  return {n, d};
}
function miniRing(p, col, label){
  const r = 30, c = 2*Math.PI*r;
  return `<svg class="mring" viewBox="0 0 76 76" aria-hidden="true"><circle cx="38" cy="38" r="${r}" fill="none" stroke="currentColor" stroke-opacity=".18" stroke-width="8"/><circle cx="38" cy="38" r="${r}" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c*Math.max(.02,Math.min(1,p))} ${c}" transform="rotate(-90 38 38)"/><text x="38" y="44" text-anchor="middle" style="font:800 19px var(--display);fill:currentColor">${label}</text></svg>`;
}
function bento(ss){
  const now = new Date(), e = futuros()[0], cp = currentPhase();
  const runs = ss.filter(s=>s.cat==="run"), m0 = new Date(now.getFullYear(), now.getMonth(), 1);
  const kmM = runs.filter(r=>r.date>=m0).reduce((t,r)=>t+r.km,0), lr = runs[0];
  const wod = logs().filter(l=>l.tipo==="wod").sort((a,b)=>b.fecha.localeCompare(a.fecha))[0];
  const fut = logs().filter(l=>l.tipo==="futbol"), ss0 = seasonStart(), goles = fut.filter(f=>parseISO(f.fecha)>=ss0).reduce((t,f)=>t+(+f.goles||0),0), nf = nextFoot();
  const wg = weekGoals(), L = bodyLoad(28), b = bestEfforts();
  const top = Object.entries(L.vec).sort((x,y)=>y[1]-x[1]).slice(0,2).map(([k])=>Body.MUSCLES[k].n);
  let phaseP = 0; if(cp){ phaseP = Math.min(1, (daysBetween(cp.start, now)+1)/(daysBetween(cp.start, cp.end)+1)); }
  const T = (href, cls, inner, label) => `<a class="bt ${cls}" href="${href}" aria-label="${label}">${inner}<span class="go" aria-hidden="true">›</span></a>`;
  return `<div class="bento">
    ${T("#objetivos", "b-goal wide", e ? `<span class="bl">Próximo objetivo</span><div class="brow"><span class="num bnum" data-count="${daysBetween(now, parseISO(e.fecha))}">${daysBetween(now, parseISO(e.fecha))}</span><span class="bcol"><b>días</b><span class="bname">${esc(e.nombre)}</span>${cp?`<span class="bsub">Fase ${cp.info.n} · ${Math.round(phaseP*100)}%</span>`:""}</span></div>` : `<span class="bl">Objetivos</span><span class="bname">Añade tu próxima competición</span>`, "Objetivos")}
    ${T("#plan", "b-week", `<span class="bl">Tu semana</span>${miniRing(wg.n? wg.d/wg.n : 0, "#fff", `${wg.d}/${wg.n}`)}<span class="bsub">sesiones del plan</span>`, "Plan de la semana")}
    ${T("#correr", "b-run", `<span class="bl">Correr</span><span class="bbig"><b data-count="${Math.round(kmM)}">${Math.round(kmM)}</b> km</span><span class="bsub">este mes</span>${lr && lr.poly ? `<span class="bthumb">${routeThumb(lr.poly, 44)}</span>` : ""}`, "Correr")}
    ${T("#box", "b-box", `<span class="bl">Último WOD</span>${wod ? `<span class="bname sm">${esc(wod.nombre.split("·")[0].trim())}</span>${wod.resultado?`<span class="bres">${esc(wod.resultado)}</span>`:""}<span class="bsub">${fDate(parseISO(wod.fecha))}</span>` : `<span class="bsub">Sube tu primera captura</span>`}`, "Box")}
    ${T("#futbol", "b-foot", `<span class="bl">Fútbol</span><span class="bbig"><b data-count="${goles}">${goles}</b> goles</span><span class="bsub">${nf ? (nf.i===0?"Hoy":nf.i===1?"Mañana":DIAS[dow(nf.d)])+" · "+nf.r : "esta temporada"}</span>`, "Fútbol")}
    ${T("#box", "b-body", `<span class="bl">Tu cuerpo · 4 sem</span><span class="bfig">${Body.figure("f", L.vec, {id:"bento"})}</span><span class="bsub">${top.length?top.join(" y "):"Sin datos"}</span>`, "Músculos trabajados")}
    ${T("#correr", "b-pr", `<span class="bl">Tus marcas</span><div class="prmini">${[["5k","5K"],["10k","10K"],["half-marathon","21K"]].map(([k,l])=>`<span><small>${l}</small><b>${b[k]?fTime(b[k].t):"–"}</b></span>`).join("")}</div>`, "Marcas")}
  </div>`;
}
function skeleton(){ return `<div class="sk sk-hoy"></div><div class="bento">${'<div class="sk sk-t"></div>'.repeat(4)}</div><div class="sk sk-card"></div>`; }
function vResumen(){
  const ss = allSessions(), now = new Date();
  if(!S.acts.length) return stravaBanner() + (S.busy.strava ? skeleton() : onboarding());
  const w = weekBuckets(ss, 12), cur = w[w.length-1];
  const sum = o => o.run+o.box+o.futbol+o.walk+o.otro;
  const runs = ss.filter(s=>s.cat==="run"), lastRun = runs[0], sinceRun = lastRun ? daysBetween(lastRun.date, now) : null;
  const cats = ["run","box","walk","futbol","otro"].filter(c=>w.some(x=>x[c]>0));
  return `
  ${stravaBanner()}
  ${footAsk()}
  ${todayCard()}
  ${bento(ss)}
  ${sinceRun!=null && sinceRun>=14 ? `<div class="banner info">Llevas <b>${sinceRun} días</b> sin correr. Vuelve con una salida suave de 30–40 min.</div>` : ""}
  <div class="sect"><h2>Actividad</h2><button class="linkbtn" data-act="story">Compartir semana</button></div>
  <div class="card">
    ${weekStrip(ss)}
    <div class="row between small"><span><b>${fMin(sum(cur))}</b> <span class="muted">esta semana</span></span><span><b>${cur.n}</b> <span class="muted">sesiones</span></span><span><b>${streak(ss).n}</b> <span class="muted">sem. de racha</span></span></div>
  </div>
  <div class="card"><h3>Minutos por semana</h3>${stackedWeeks(w)}${legend(cats)}</div>
  <div class="card"><div class="row between"><h3>Últimas sesiones</h3></div><div class="list">${ss.slice(0,5).map(sessionItem).join("")}</div></div>`;
}

/* =========================================================
   ACCIONES RÁPIDAS (botón central «+»)
   ========================================================= */
function quickSheet(){
  const A = (attr, ico, t, s, col) => `<${attr.startsWith("for=")?"label":"button"} class="act" ${attr}><span class="ico" style="background:${col}">${ico}</span><span><b>${t}</b><small>${s}</small></span></${attr.startsWith("for=")?"label":"button"}>`;
  return ["¿Qué quieres añadir?", `<div class="actlist">
    ${A('data-sheet="voice"', '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>', "Dictar por voz", "Cuéntalo y lo apunto: WOD, fútbol o marca", "#111827")}
    ${A('for="ocrFile"', ICON.cam, "Leer captura de WOD", "Una captura de AimHarder o foto de la pizarra", "var(--box)")}
    ${A('data-sheet="wod"', ICON.pen, "Apuntar WOD a mano", "Escribe el entreno y tu resultado", "var(--box)")}
    ${A('data-sheet="futbol"', QI.foot.replace('<svg','<svg style="stroke:#fff"'), "Fútbol", "Partido, entreno o pachanga", "var(--foot)")}
    ${A('data-sheet="marca"', ICON.bar, "Nueva marca", "RM, benchmark o ergómetro", "var(--run)")}
    ${A('data-sheet="evento"', '<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>', "Competición", "Añade una carrera o un HYROX", "var(--warn)")}
    ${A('data-act="story"', QI.share.replace('<svg','<svg style="stroke:#fff"'), "Compartir mi semana", "Imagen para tus stories", "#8B5CF6")}
  </div>`];
}

/* =========================================================
   BIENVENIDA (primera vez) y APARIENCIA
   ========================================================= */
const ONB = [
  ["Tu entreno, todo junto", "Carreras de Strava, WODs de AimHarder y fútbol en un solo sitio. Lo que Strava y Garmin no ven, aquí cuenta."],
  ["Un entrenador cada día", "Cada mañana te dice qué toca según tu plan, tu semana y cómo te encuentras. Con un chequeo de 10 segundos."],
  ["Prepara tus retos", "Plan por fases hasta tu carrera o HYROX, ritmos por km y reparto de estaciones con tu pareja."]
];
function onbOverlay(){
  const i = S.onbI || 0, [t, d] = ONB[i];
  return `<div class="onb" role="dialog" aria-label="Bienvenida">
    <div class="onb-art a${i}">${i===0?QI.wod:i===1?'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>':'<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>'}</div>
    <h1>${t}</h1><p>${d}</p>
    <div class="dots">${ONB.map((_,k)=>`<i class="${k===i?"on":""}"></i>`).join("")}</div>
    <button class="primary big" data-act="onbnext">${i<ONB.length-1?"Siguiente":"Empezar"}</button>
    <button class="ghost" data-act="onbskip">Saltar</button>
  </div>`;
}
function applyTheme(){ const t = LS.get("theme","auto"); if(t==="auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; }
function themeCard(){
  const t = LS.get("theme","auto");
  return `<div class="card"><h2>Apariencia</h2><div class="seg">${[["auto","Automático"],["light","Claro"],["dark","Oscuro"]].map(([v,l])=>`<button type="button" data-theme-set="${v}" aria-pressed="${t===v}">${l}</button>`).join("")}</div></div>`;
}

function onboarding(){
  return `<div class="card"><h2>Primeros pasos</h2>
  <div class="list">
    <div class="check"><span class="box ${S.tok?"done":""}">${S.tok?"✓":"1"}</span><div class="small"><b>Conecta Strava</b> en <a href="#ajustes">Ajustes</a> (necesitas crear una «app» gratuita en Strava, 2 minutos).</div></div>
    <div class="check"><span class="box ${S.cfg.ghToken?"done":""}">${S.cfg.ghToken?"✓":"2"}</span><div class="small"><b>Activa la sincronización</b> con GitHub para ver tus WODs en todos tus dispositivos.</div></div>
    <div class="check"><span class="box">3</span><div class="small"><b>Instálala:</b> en el móvil, menú del navegador → «Añadir a pantalla de inicio».</div></div>
  </div></div>`;
}
function riegel(t,d1,d2){ return t*Math.pow(d2/d1,1.06); }
/* =========================================================
   CORRER (rediseño)
   ========================================================= */
function runHero(runs){
  const now = new Date(), y0 = new Date(now.getFullYear(), 0, 1);
  const yr = runs.filter(r=>r.date>=y0), km = yr.reduce((t,r)=>t+r.km,0);
  const r90 = runs.filter(r=>daysBetween(r.date,now)<90 && r.pace), pace = r90.length ? r90.reduce((t,r)=>t+r.sec,0)/r90.reduce((t,r)=>t+r.km,0) : null;
  const longest = yr.reduce((m,r)=>r.km>m?r.km:m,0), since = runs[0] ? daysBetween(runs[0].date, now) : null;
  const hm = futuros().find(e=>e.clase==="carrera");
  return `<div class="hero runhero">
    <div class="row between"><span class="eyebrow">${now.getFullYear()} corriendo</span>${since!=null?`<span class="glass">${since===0?"Hoy has corrido":since===1?"Ayer corriste":`Última salida hace ${since} días`}</span>`:""}</div>
    <div class="hero-main"><span class="num huge" data-count="${Math.round(km)}">${Math.round(km)}</span><span class="hero-l"><b>km este año</b><span class="hname">${yr.length} carreras</span>${hm?`<span class="hdate">${daysBetween(now, parseISO(hm.fecha))} días para ${esc(hm.nombre)}</span>`:""}</span></div>
    <div class="hero-stats"><div><b>${pace?fPace(pace):"–"}</b><span>ritmo medio (90 d)</span></div><div><b>${longest?longest.toFixed(1)+" km":"–"}</b><span>tirada más larga</span></div><div><b>${r90.length}</b><span>salidas (90 d)</span></div></div>
  </div>`;
}
const MEDAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2h4l1 5-3 0zM17 2h-4l-1 5 3 0z" fill="currentColor" opacity=".55"/><circle cx="12" cy="15" r="6.2" fill="currentColor"/><circle cx="12" cy="15" r="3.6" fill="none" stroke="#fff" stroke-width="1.4" opacity=".85"/></svg>';
function prCard(){
  const b = bestEfforts();
  const runs = S.acts.filter(a=>catOf(a.sport||"")==="run"), missing = runs.filter(r=>!S.det[r.id] || S.det[r.id].v!==2).length;
  const withBE = runs.filter(r=>(S.det[r.id]?.be||[]).length).length;
  const tile = (k, dist, cls) => { const r = b[k], yrs = bestByYear(k);
    let delta = "";
    if(yrs.length>1){ const [y1,t1] = yrs[yrs.length-1], [y0,t0] = yrs[yrs.length-2]; if(t1<t0) delta = `<span class="delta">−${fTime(t0-t1)} vs ${y0}</span>`; }
    return `<div class="prt ${cls}"><div class="row between"><span class="dist">${BE[k][0]}</span><span class="medal">${MEDAL}</span></div>
      <span class="ptime${r && r.t>=3600?" long":""}">${r?fTime(r.t):"–"}</span>
      ${r?`<span class="psub">${fPace(r.t/dist)}/km · ${fDate(localDate(r.d))} ${String(r.d).slice(2,4)}</span>${delta}<span class="psrc">${r.src==="oficial"?"Oficial":r.src==="km"?"Por km (Strava)":"Strava"} · ${esc(r.act)}</span>`:`<span class="psub">${missing?"analizando…":"sin datos"}</span>`}
    </div>`; };
  const off = logs().filter(l=>l.tipo==="pr").sort((a,c)=>c.fecha.localeCompare(a.fecha));
  return `<div class="card">
    <div class="row between"><h2>Marcas</h2><button class="addbtn soft" data-sheet="pr">+ Oficial</button></div>
    <div class="prgrid">${tile("5k",5,"c5")}${tile("10k",10,"c10")}${tile("half-marathon",21.0975,"c21")}</div>
    ${b["1 mile"]?`<p class="small muted">Milla: <b>${fTime(b["1 mile"].t)}</b></p>`:""}
    <p class="note">Mejor tiempo dentro de cualquier carrera de Strava (sus «best efforts»; si Strava no los da, se calcula con tus parciales por km) o tu marca oficial si es mejor. Analizadas ${runs.length-missing} de ${runs.length} carreras · ${withBE} con marcas de Strava.</p>
    <div class="row between">${off.length?`<details><summary class="small">Marcas oficiales (${off.length})</summary><div class="list">${off.map(l=>`<div class="item"><span class="badge" style="background:var(--run)">${esc(l.dist)}</span><div style="min-width:0"><div class="t">${esc(l.tiempo)} · ${esc(l.carrera||"")}</div><div class="s">${fDate(parseISO(l.fecha))}</div></div>${delBtn(l.id)}</div>`).join("")}</div></details>`:"<span></span>"}
      <button class="ghost small" data-act="recalc">${S.recalc?"Recalculando…":"Recalcular desde Strava"}</button></div>
  </div>`;
}
function levelCard(){
  const b = bestEfforts();
  // Referencia: la mejor marca de los últimos 12 meses en la distancia más larga disponible
  const refK = ["half-marathon","10k","5k"].find(k=>b[k] && daysBetween(localDate(b[k].d), new Date())<365);
  if(!refK) return "";
  const ref = b[refK], D = {"5k":5,"10k":10,"half-marathon":21.0975};
  const rows = [["5k",5,"5K"],["10k",10,"10K"],["half-marathon",21.0975,"Media"],["marathon",42.195,"Maratón"]].map(([k,d,l])=>{
    const p = riegel(ref.t, D[refK], d), pr = b[k]?.t;
    return {l, p, pace:p/d, pr, diff: pr ? p-pr : null}; });
  const mx = Math.max(...rows.map(r=>r.pace)), mn = Math.min(...rows.map(r=>r.pace));
  return `<div class="card"><div class="row between"><h3>Tu nivel hoy</h3><span class="small muted">desde tu ${BE[refK][0]}</span></div>
    <div class="lvl">${rows.map(r=>`<div class="lvr"><span class="ll">${r.l}</span><span class="lb"><i style="width:${40+60*(mx-r.pace)/Math.max(1,mx-mn)}%"></i></span><span class="lt"><b>${fTime(r.p)}</b><small>${fPace(r.pace)}/km</small></span>${r.diff!=null?`<span class="ld ${r.diff<0?"up":""}">${r.diff<0?"−"+fTime(-r.diff):Math.abs(r.diff)<5?"= PR":"+"+fTime(r.diff)}</span>`:`<span class="ld"></span>`}</div>`).join("")}</div>
    <p class="note">Predicción con la fórmula de Riegel a partir de tu mejor marca reciente; la columna de la derecha la compara con tu marca actual en esa distancia. Para maratón suele ser optimista sin tiradas de 28–32 km.</p></div>`;
}
function paceChart(runs){
  const pts = runs.filter(r=>r.pace && r.km>=3 && r.pace<480 && daysBetween(r.date,new Date())<400).sort((a,b)=>a.date-b.date);
  if(pts.length<3) return `<p class="small muted">Aún no hay suficientes carreras para la tendencia.</p>`;
  const W=400,H=190,pl=36,pr=10,pt=14,pb=24;
  const t0=pts[0].date.getTime(), t1=pts[pts.length-1].date.getTime();
  let lo=Math.min(...pts.map(p=>p.pace)), hi=Math.max(...pts.map(p=>p.pace)); lo=Math.floor((lo-5)/15)*15; hi=Math.ceil((hi+5)/15)*15;
  const x=t=>pl+(W-pl-pr)*((t-t0)/Math.max(1,t1-t0)), y=p=>pt+(H-pt-pb)*((p-lo)/(hi-lo));
  // Tendencia (regresión lineal)
  const n=pts.length, xs=pts.map(p=>(p.date.getTime()-t0)/864e5), ys=pts.map(p=>p.pace), mx=xs.reduce((a,b)=>a+b,0)/n, my=ys.reduce((a,b)=>a+b,0)/n;
  const sl = xs.reduce((t,v,i)=>t+(v-mx)*(ys[i]-my),0)/Math.max(1e-6, xs.reduce((t,v)=>t+(v-mx)**2,0)), ic = my - sl*mx;
  const days = (t1-t0)/864e5, change = sl*Math.min(days,180);
  let g = `<defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--run)" stop-opacity=".28"/><stop offset="1" stop-color="var(--run)" stop-opacity="0"/></linearGradient></defs>`;
  for(let v=lo; v<=hi; v+=15) g+=`<line x1="${pl}" x2="${W-pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-dasharray="2 4"/><text x="${pl-6}" y="${y(v)+3}" text-anchor="end">${fPace(v)}</text>`;
  const line = pts.map(p=>`${x(p.date.getTime()).toFixed(1)},${y(p.pace).toFixed(1)}`);
  g += `<path d="M${line[0]} L${line.join(" L")} L${x(t1)},${H-pb} L${x(t0)},${H-pb} Z" fill="url(#pg)"/>`;
  g += `<polyline fill="none" stroke="var(--run)" stroke-width="2.2" stroke-linejoin="round" points="${line.join(" ")}"/>`;
  g += `<line x1="${x(t0)}" y1="${y(ic)}" x2="${x(t1)}" y2="${y(ic+sl*days)}" stroke="var(--box)" stroke-width="2" stroke-dasharray="5 4"/>`;
  pts.forEach((p,i)=>{ if(i===pts.length-1) g+=`<circle cx="${x(p.date.getTime())}" cy="${y(p.pace)}" r="5" fill="var(--run)" stroke="var(--surface)" stroke-width="2"/>`; });
  const seen=new Set(); let lastX=-99; pts.forEach(p=>{ const k=p.date.getFullYear()*12+p.date.getMonth(); if(seen.has(k)) return; seen.add(k); const d=new Date(p.date.getFullYear(),p.date.getMonth(),1), xx=x(Math.max(t0,d.getTime())); if(xx-lastX>30){ g+=`<text x="${xx}" y="${H-6}" text-anchor="middle">${MESES[d.getMonth()]}</text>`; lastX=xx; } });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Ritmo medio por salida">${g}</svg>
    <div class="trend ${change<0?"up":""}"><b>${change<0?"Mejorando":"Más lento"} ${Math.abs(Math.round(change))} s/km</b> en ${days>180?"los últimos 6 meses":"este periodo"} <span class="muted">(línea discontinua; arriba = más rápido)</span></div>`;
}
function monthlyKm(runs){
  const now=new Date(), months=[];
  for(let i=11;i>=0;i--){ const d=new Date(now.getFullYear(), now.getMonth()-i, 1); months.push({d, km:0}); }
  runs.forEach(r=>{ const m = months.find(m=>m.d.getFullYear()===r.date.getFullYear() && m.d.getMonth()===r.date.getMonth()); if(m) m.km+=r.km; });
  const W=400,H=160,pt=18,pb=22, max=Math.max(10,...months.map(m=>m.km)), bw=(W-8)/12, y=v=>pt+(H-pt-pb)*(1-v/max);
  let g=`<defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--run)"/><stop offset="1" stop-color="var(--run)" stop-opacity=".45"/></linearGradient></defs>`;
  months.forEach((m,i)=>{ const x=4+i*bw+bw*.18, w=bw*.64, cur=i===11;
    g+=`<rect x="${x}" y="${pt}" width="${w}" height="${H-pt-pb}" rx="${w/2}" fill="var(--surface-2)"/>`;
    if(m.km>0){ const h=Math.max(w, y(0)-y(m.km)); g+=`<rect x="${x}" y="${y(0)-h}" width="${w}" height="${h}" rx="${w/2}" fill="${cur?"var(--box)":"url(#mg)"}"/><text x="${x+w/2}" y="${y(0)-h-5}" text-anchor="middle" style="fill:var(--fg);font-weight:600">${Math.round(m.km)}</text>`; }
    g+=`<text x="${x+w/2}" y="${H-6}" text-anchor="middle"${cur?` style="fill:var(--fg);font-weight:700"`:""}>${MESES[m.d.getMonth()]}</text>`; });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Kilómetros por mes">${g}</svg>`;
}
function zonesCard(){
  const k5 = bestEfforts()["5k"]?.t; if(!k5) return "";
  const p5 = k5/5;
  const Z = [["Z1","Recuperación",p5+130,p5+100,"#8FB3FF"],["Z2","Aeróbico",p5+100,p5+65,"#4E86FF"],["Z3","Tempo",p5+65,p5+35,"#22B5A0"],["Z4","Umbral",p5+35,p5+15,"#F2A93B"],["Z5","VO₂máx",p5+15,p5-5,"#F0703A"],["Z6","Anaeróbico",p5-5,p5-25,"#E5484D"]];
  return `<div class="card"><h3>Tus ritmos de entreno</h3>
    <div class="zbar">${Z.map(z=>`<i style="background:${z[4]}"></i>`).join("")}</div>
    <div class="zlist">${Z.map((z,i)=>`<div class="zr"><span class="zd" style="background:${z[4]}">${z[0]}</span><span class="zn">${z[1]}</span><b>${i===0?`+${fPace(z[3])}`:i===5?`−${fPace(z[2])}`:`${fPace(z[2])}–${fPace(z[3])}`}</b></div>`).join("")}</div>
    <p class="note">Estimación propia a partir de tu mejor 5K (${fTime(k5)}): ritmos por km, de más lento a más rápido. No son las zonas oficiales de Strava; ajusta por sensaciones.</p></div>`;
}
function vCorrer(){
  const ss = allSessions(), runs = ss.filter(s=>s.cat==="run");
  return `
  ${stravaBanner()}
  ${runHero(runs)}
  ${prCard()}
  ${levelCard()}
  <div class="card"><h3>Evolución del ritmo</h3>${paceChart(runs)}</div>
  <div class="card"><div class="row between"><h3>Km por mes</h3><span class="small muted">${Math.round(runs.filter(r=>daysBetween(r.date,new Date())<365).reduce((t,r)=>t+r.km,0))} km en 12 meses</span></div>${monthlyKm(runs)}</div>
  ${zonesCard()}
  <div class="card"><div class="row between"><h2>Tus carreras</h2><span class="small muted">${runs.length}</span></div>
    <div class="runlist">${runs.slice(0, S.runAll?100:6).map(runCard).join("") || `<p class="muted">Sin carreras.</p>`}</div>
    ${runs.length>6?`<button class="ghost" data-act="runall" style="align-self:center">${S.runAll?"Ver menos":`Ver las ${runs.length}`}</button>`:""}</div>
  <div class="card"><div class="row between"><h3>Tus rutas</h3><span class="small muted">${runs.filter(r=>r.poly).length} recorridos</span></div><div id="routesmap" class="routesmap"></div><p class="note">Todas tus carreras superpuestas. Toca una línea para abrirla.</p></div>`;
}

/* =========================================================
   CARRERAS: rutas, mapa, parciales y perfil
   ========================================================= */
// Polilínea codificada de Strava/Google → [[lat,lng],…]
function decodePoly(s){
  const out = []; let i = 0, lat = 0, lng = 0;
  while(s && i < s.length){
    let b, sh = 0, r = 0; do{ b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; }while(b >= 32); lat += (r & 1) ? ~(r >> 1) : (r >> 1);
    sh = 0; r = 0; do{ b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; }while(b >= 32); lng += (r & 1) ? ~(r >> 1) : (r >> 1);
    out.push([lat/1e5, lng/1e5]);
  }
  return out;
}
function routeThumb(poly, size=56){
  const pts = decodePoly(poly); if(pts.length<2) return `<svg viewBox="0 0 ${size} ${size}" class="rthumb"><circle cx="${size/2}" cy="${size/2}" r="4" fill="var(--run)"/></svg>`;
  const k = Math.cos(pts[0][0]*Math.PI/180);
  const xs = pts.map(p=>p[1]*k), ys = pts.map(p=>-p[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sc = (size-8)/Math.max(x1-x0, y1-y0, 1e-6), ox = (size-(x1-x0)*sc)/2, oy = (size-(y1-y0)*sc)/2;
  const d = pts.map((p,i)=>`${i?"L":"M"}${(ox+(xs[i]-x0)*sc).toFixed(1)} ${(oy+(ys[i]-y0)*sc).toFixed(1)}`).join("");
  const last = pts.length-1;
  return `<svg viewBox="0 0 ${size} ${size}" class="rthumb" aria-hidden="true"><path d="${d}" fill="none" stroke="var(--run)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${(ox+(xs[0]-x0)*sc).toFixed(1)}" cy="${(oy+(ys[0]-y0)*sc).toFixed(1)}" r="2.6" fill="var(--ok)"/><circle cx="${(ox+(xs[last]-x0)*sc).toFixed(1)}" cy="${(oy+(ys[last]-y0)*sc).toFixed(1)}" r="2.6" fill="var(--box)"/></svg>`;
}
function runCard(r){
  return `<button class="runc" data-run="${r.id}">
    <span class="rmap">${routeThumb(r.poly||"")}</span>
    <span class="rbody"><span class="rname">${esc(r.name)}</span><span class="s muted">${DIAS[dow(r.date)]} ${fDate(r.date)} ${r.date.getFullYear()!==new Date().getFullYear()?r.date.getFullYear():""}</span>
      <span class="rstats"><b>${r.km.toFixed(1)}</b> km · <b>${fPace(r.pace)}</b>/km · ${fMin(r.min)}</span></span>
    ${r.prs?`<span class="pill">${r.prs} PR</span>`:"<span></span>"}
  </button>`;
}

/* --- Leaflet (mapa) bajo demanda --- */
let leafP = null;
function loadLeaflet(){
  if(window.L) return Promise.resolve();
  if(leafP) return leafP;
  leafP = new Promise((res, rej) => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"; document.head.appendChild(l);
    const s = document.createElement("script"); s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"; s.onload = res; s.onerror = () => { leafP = null; rej(new Error("leaflet")); }; document.head.appendChild(s);
  });
  return leafP;
}
const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;
function baseMap(el, opts={}){
  const m = L.map(el, {zoomControl:false, attributionControl:true, scrollWheelZoom:false, ...opts});
  // Teselas de OpenStreetMap (libres, sin clave). El estilo gris/oscuro se aplica con CSS sobre la capa.
  // OpenStreetMap exige saber desde qué web se pide (solo el dominio). Si falla, se cambia a Esri.
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:19, referrerPolicy:"strict-origin-when-cross-origin", attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'});
  let fails = 0, switched = false;
  osm.on("tileerror", () => { if(++fails < 3 || switched) return; switched = true; m.removeLayer(osm);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {maxZoom:19, attribution:"Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap"}).addTo(m); });
  // Un mosaico bloqueado llega como imagen (no da error), así que se comprueba antes con una petición
  osmOk().then(ok => { if(!m.getPane("tilePane") || !m._container || !document.body.contains(m._container)) return;   // el mapa ya se quitó
    if(ok) osm.addTo(m); else { switched = true; L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {maxZoom:19, attribution:"Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap"}).addTo(m); } });
  L.control.zoom({position:"bottomright"}).addTo(m);
  return m;
}
let osmP = null;
function osmOk(){
  if(!osmP) osmP = fetch("https://tile.openstreetmap.org/0/0/0.png", {referrerPolicy:"strict-origin-when-cross-origin", cache:"no-store"}).then(r => r.ok).catch(() => false);
  return osmP;
}
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
// Color por ritmo: lento → frío, rápido → caliente
function paceColor(t){ const stops = ["#5B7BFF","#4FB3D9","#F2C14E","#F08A4B","#E0436F"]; const i = Math.max(0, Math.min(stops.length-1, Math.round(t*(stops.length-1)))); return stops[i]; }

let routesMap = null, runMap = null;
async function mountRoutes(){
  const el = document.getElementById("routesmap"); if(!el) return;
  try{ await loadLeaflet(); }catch(e){ el.innerHTML = `<p class="small muted" style="padding:12px">No se pudo cargar el mapa. Revisa la conexión.</p>`; return; }
  if(!document.body.contains(el)) return;
  if(routesMap){ try{ routesMap.remove(); }catch(e){} routesMap = null; }
  const runs = allSessions().filter(s=>s.cat==="run" && s.poly);
  if(!runs.length){ el.innerHTML = `<p class="small muted" style="padding:12px">Tus rutas aparecerán aquí al sincronizar Strava.</p>`; return; }
  routesMap = baseMap(el);
  // Zona habitual: rutas cerca del punto de salida más frecuente
  const starts = runs.map(r=>decodePoly(r.poly)[0]).filter(Boolean);
  const home = starts.map(s=>[s, starts.filter(t=>Math.hypot(t[0]-s[0], t[1]-s[1])<0.15).length]).sort((a,b)=>b[1]-a[1])[0][0];
  const color = cssVar("--run") || "#2752D9", lines = [];
  runs.forEach(r => { const pts = decodePoly(r.poly); if(pts.length<2) return;
    const near = Math.hypot(pts[0][0]-home[0], pts[0][1]-home[1]) < 0.3;
    L.polyline(pts, {color:"#fff", weight:6, opacity:.55, interactive:false}).addTo(routesMap);
    const pl = L.polyline(pts, {color, weight:3, opacity:.75}).addTo(routesMap);
    pl.on("click", () => openSheet("run", r.id));
    if(near) lines.push(pl); });
  const grp = L.featureGroup(lines.length ? lines : []);
  if(lines.length) routesMap.fitBounds(grp.getBounds(), {padding:[16,16]});
}
async function runDetail(id){
  S.rx = S.rx || LS.get("rx", {});
  if(S.rx[id]) return S.rx[id];
  const d = await api("/activities/"+id);
  let st = null; try{ st = await api(`/activities/${id}/streams?keys=latlng,velocity_smooth,altitude,distance,heartrate&key_by_type=true`); }catch(e){}
  const n = st?.distance?.data?.length || 0, step = Math.max(1, Math.ceil(n/450)), idx = [];
  for(let i=0;i<n;i+=step) idx.push(i); if(n && idx[idx.length-1]!==n-1) idx.push(n-1);
  const take = (k, f) => st?.[k]?.data ? idx.map(i=>f(st[k].data[i])) : null;
  const out = {
    splits:(d.splits_metric||[]).map(s=>({d:s.distance, t:s.moving_time, e:s.elevation_difference, hr:s.average_heartrate||null})),
    poly: d.map?.polyline || d.map?.summary_polyline || "",
    cad: d.average_cadence || null, hr: d.average_heartrate || null, maxhr: d.max_heartrate || null, w: d.average_watts || null,
    cal: d.calories || 0, elev: d.total_elevation_gain || 0, desc: (d.description||"").slice(0,400),
    be: (d.best_efforts||[]).map(b=>({n:b.name, t:b.elapsed_time, pr:b.pr_rank||null})),
    s: n ? {ll: take("latlng", p=>[+p[0].toFixed(5), +p[1].toFixed(5)]), v: take("velocity_smooth", v=>+v.toFixed(2)), alt: take("altitude", a=>+a.toFixed(1)), dist: take("distance", x=>Math.round(x)), hr: take("heartrate", h=>h)} : null
  };
  S.rx[id] = out;
  const keys = Object.keys(S.rx); while(Object.keys(S.rx).length>12) delete S.rx[Object.keys(S.rx)[0]];
  LS.set("rx", S.rx);
  return out;
}
function splitsSvg(splits){
  const full = splits.filter(s=>s.d>=900);
  if(!full.length) return "";
  const pace = s => s.t/(s.d/1000), ps = full.map(pace), mn = Math.min(...ps), mx = Math.max(...ps), best = ps.indexOf(mn);
  const avg = ps.reduce((a,b)=>a+b,0)/ps.length;
  return `<div class="splits">${full.map((s,i)=>{ const p = ps[i], w = 35 + 65*((mx-p)/Math.max(1,mx-mn));
    return `<div class="split${i===best?" best":""}"><span class="k">${i+1}</span><span class="bar"><i style="width:${w}%"></i></span><span class="pv">${fPace(p)}</span><span class="el ${s.e>2?"up":s.e<-2?"down":""}">${s.e>0?"+":""}${Math.round(s.e)} m</span></div>`; }).join("")}</div>
  <p class="small muted">Media ${fPace(avg)}/km · km más rápido: el ${best+1} (${fPace(mn)}) · más lento ${fPace(mx)}</p>`;
}
function profileSvg(s){
  if(!s || !s.dist || !s.alt) return "";
  const W=400, H=150, pl=34, pr=34, pt=10, pb=22, D = s.dist[s.dist.length-1] || 1;
  const a0 = Math.min(...s.alt), a1 = Math.max(...s.alt), ar = Math.max(10, a1-a0);
  const x = d => pl + (W-pl-pr)*d/D, ya = a => pt + (H-pt-pb)*(1-(a-a0)/ar);
  let area = `M${x(0)} ${H-pb}` + s.dist.map((d,i)=>` L${x(d).toFixed(1)} ${ya(s.alt[i]).toFixed(1)}`).join("") + ` L${x(D)} ${H-pb} Z`;
  let g = `<path d="${area}" fill="var(--surface-2)" stroke="var(--muted)" stroke-width="1" stroke-opacity=".5"/>`;
  if(s.v){
    const sm = s.v.map((_,i)=>{ const w = s.v.slice(Math.max(0,i-6), i+7).filter(v=>v>0.8); return w.length ? w.reduce((a,b)=>a+b,0)/w.length : null; });
    const pace = sm.map(v=>v ? 1000/v : null), ok = pace.filter(Boolean), p0 = Math.min(...ok), p1 = Math.max(...ok), prg = Math.max(20, p1-p0);
    const yp = p => pt + (H-pt-pb)*((p-p0)/prg);
    const d = s.dist.map((dd,i)=> pace[i] ? `${i&&pace[i-1]?"L":"M"}${x(dd).toFixed(1)} ${yp(pace[i]).toFixed(1)}` : "").join("");
    g += `<path d="${d}" fill="none" stroke="var(--run)" stroke-width="1.8"/>`;
    g += `<text x="${W-pr+4}" y="${pt+8}">${fPace(p0)}</text><text x="${W-pr+4}" y="${H-pb}">${fPace(p1)}</text>`;
  }
  g += `<text x="${pl-4}" y="${pt+8}" text-anchor="end">${Math.round(a1)} m</text><text x="${pl-4}" y="${H-pb}" text-anchor="end">${Math.round(a0)} m</text>`;
  for(let k=0;k<=D/1000;k+= D>12000?5:D>6000?2:1) g += `<text x="${x(k*1000)}" y="${H-6}" text-anchor="middle">${k}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Perfil de altitud y ritmo">${g}</svg>
  <div class="legend"><span><i class="dot" style="background:var(--muted)"></i>Altitud</span><span><i class="dot" style="background:var(--run)"></i>Ritmo (arriba = más rápido)</span><span class="muted">km</span></div>`;
}
async function mountRunMap(id){
  const el = document.getElementById("runmap"); if(!el) return;
  try{ await loadLeaflet(); }catch(e){ el.innerHTML = `<p class="small muted" style="padding:12px">No se pudo cargar el mapa.</p>`; return; }
  const x = S.rx?.[id], r = S.acts.find(a=>a.id===id);
  if(!document.body.contains(el)) return;
  if(runMap){ try{ runMap.remove(); }catch(e){} runMap = null; }
  runMap = baseMap(el, {dragging:true});
  const ll = x?.s?.ll, v = x?.s?.v;
  if(ll && v && ll.length>2){
    const ok = v.filter(z=>z>0.8), v0 = Math.min(...ok), v1 = Math.max(...ok);
    L.polyline(ll, {color:"#fff", weight:9, opacity:.9, interactive:false}).addTo(runMap);
    for(let i=1;i<ll.length;i++){ const t = (v[i]-v0)/Math.max(.1, v1-v0); L.polyline([ll[i-1], ll[i]], {color:paceColor(t), weight:5, opacity:.95, lineCap:"round"}).addTo(runMap); }
    runMap.fitBounds(L.latLngBounds(ll), {padding:[18,18]});
    L.circleMarker(ll[0], {radius:6, color:"#fff", weight:2, fillColor:"#1B8A5A", fillOpacity:1}).addTo(runMap);
    L.circleMarker(ll[ll.length-1], {radius:6, color:"#fff", weight:2, fillColor:"#D23F6B", fillOpacity:1}).addTo(runMap);
  } else {
    const pts = decodePoly(x?.poly || r?.poly || "");
    if(pts.length>1){ L.polyline(pts, {color:"#fff", weight:8, opacity:.9}).addTo(runMap); L.polyline(pts, {color:cssVar("--run")||"#2752D9", weight:4}).addTo(runMap); runMap.fitBounds(L.latLngBounds(pts), {padding:[18,18]}); }
    else el.innerHTML = `<p class="small muted" style="padding:12px">Esta carrera no tiene ruta (cinta).</p>`;
  }
}
function runSheet(id){
  const r = allSessions().find(s=>s.id===id); if(!r) return ["Carrera","<p>No encontrada.</p>"];
  const x = S.rx?.[id], b = bestEfforts();
  const sp = x?.splits?.filter(s=>s.d>=900) || [];
  let neg = "";
  if(sp.length>=4){ const h = Math.floor(sp.length/2), p = a => a.reduce((t,s)=>t+s.t,0)/a.reduce((t,s)=>t+s.d/1000,0), p1 = p(sp.slice(0,h)), p2 = p(sp.slice(h));
    neg = p2 < p1 ? `<span class="pill ok">Parcial negativo · 2ª mitad ${Math.round(p1-p2)} s/km más rápida</span>` : `<span class="pill warn">2ª mitad ${Math.round(p2-p1)} s/km más lenta</span>`; }
  const prs = (x?.be||[]).filter(e=>["5k","10k","half-marathon","1k","1 mile","marathon"].includes(String(e.n).toLowerCase()));
  const stat = (v,l) => `<div><b>${v}</b><span>${l}</span></div>`;
  return [r.name, `<div class="stack" style="gap:14px">
    <span class="eyebrow">${DIAS[dow(r.date)]} ${fDate(r.date)} ${r.date.getFullYear()} · ${pad(r.date.getHours())}:${pad(r.date.getMinutes())}</span>
    <div id="runmap" class="runmap">${!x?`<p class="small muted" style="padding:12px">Cargando ruta…</p>`:""}</div>
    ${x?.s?.v?`<div class="pscale"><span>más lento</span><i></i><span>más rápido</span></div>`:""}
    <div class="rstatgrid">${stat(r.km.toFixed(2)+" km","distancia")}${stat(fPace(r.pace)+"/km","ritmo medio")}${stat(fTime(r.sec),"tiempo")}${stat(Math.round(r.elev)+" m","desnivel +")}${x?.cad?stat(Math.round(x.cad*2)+" ppm","cadencia"):""}${x?.hr?stat(Math.round(x.hr)+" ppm","FC media"):""}${x?.w?stat(Math.round(x.w)+" W","potencia"):""}${x?.cal?stat(x.cal+" kcal","calorías"):""}</div>
    ${neg}
    ${prs.length?`<div><span class="eyebrow">Mejores marcas en esta carrera</span><div class="mchips run" style="margin-top:6px">${prs.map(e=>{ const k = String(e.n).toLowerCase(), isPR = b[k] && b[k].t===e.t; return `<i class="${isPR?"pr":""}">${esc(BE[k]?BE[k][0]:e.n)} ${fTime(e.t)}${isPR?" · PR":""}</i>`; }).join("")}</div></div>`:""}
    ${sp.length?`<div class="stack" style="gap:8px"><h3>Parciales por km</h3>${splitsSvg(x.splits)}</div>`:x?"":`<p class="small muted">Cargando parciales…</p>`}
    ${x?.s?`<div class="stack" style="gap:6px"><h3>Perfil</h3>${profileSvg(x.s)}</div>`:""}
    ${x?.desc?`<p class="com">${esc(x.desc)}</p>`:""}
    <a class="small" href="https://www.strava.com/activities/${r.id}" target="_blank" rel="noopener">Ver en Strava</a>
  </div>`];
}
async function openRun(id){
  openSheet("run", id);
  try{
    if(!(S.rx && S.rx[id])){ await runDetail(id); if(S.sheetState?.kind==="run" && S.sheetState.data===id) renderSheet(); }
  }catch(e){ const el = document.getElementById("runmap"); if(el) el.innerHTML = `<p class="small muted" style="padding:12px">${esc(e.message||"No se pudo cargar el detalle de Strava.")}</p>`; }
  mountRunMap(id);
}

/* =========================================================
   CALENDARIO, EQUILIBRIO Y RADAR
   ========================================================= */
function calendarCard(){
  const weeks = 26, start = addDays(monday(new Date()), -7*(weeks-1)), t = today();
  const byDay = {}; allSessions().forEach(s=>{ const k = iso(s.date); (byDay[k] = byDay[k] || {run:0, box:0, foot:0, otro:0}); byDay[k][s.cat==="run"?"run":s.cat==="box"?"box":s.cat==="futbol"?"foot":"otro"] += s.min; });
  logs().filter(l=>l.tipo==="wod").forEach(w=>{ byDay[w.fecha] = byDay[w.fecha] || {run:0, box:0, foot:0, otro:0}; if(!byDay[w.fecha].box) byDay[w.fecha].box = 50; });
  const cell = 13, gap = 3, W = 22 + weeks*(cell+gap), H = 7*(cell+gap) + 18;
  let g = "", lastM = -1, active = 0;
  for(let w=0; w<weeks; w++){ const ws = addDays(start, 7*w);
    if(ws.getMonth()!==lastM){ lastM = ws.getMonth(); g += `<text x="${22+w*(cell+gap)}" y="10">${MESES[lastM]}</text>`; }
    for(let d=0; d<7; d++){ const day = addDays(ws, d), k = iso(day); if(k > t) continue;
      const v = byDay[k], tot = v ? v.run+v.box+v.foot+v.otro : 0; if(tot) active++;
      const fill = !tot ? "var(--surface-2)" : v.run && v.box ? "url(#both)" : v.foot ? "var(--foot)" : v.run ? "var(--run)" : v.box ? "var(--box)" : "var(--other)";
      const op = !tot ? 1 : Math.min(1, .45 + tot/120);
      g += `<rect x="${22+w*(cell+gap)}" y="${16+d*(cell+gap)}" width="${cell}" height="${cell}" rx="3" fill="${fill}" fill-opacity="${op}"${k===t?` stroke="var(--fg)" stroke-width="1.5"`:""}><title>${fDate(day)}${tot?` · ${Math.round(tot)} min`:""}</title></rect>`; } }
  ["L","","X","","V","","D"].forEach((l,i)=>{ if(l) g += `<text x="0" y="${16+i*(cell+gap)+10}">${l}</text>`; });
  return `<div class="card"><div class="row between"><h3>Constancia</h3><span class="small muted">${active} días activos en 6 meses</span></div>
    <div><svg class="cal" viewBox="0 0 ${W} ${H}" role="img" aria-label="Calendario de entrenamientos"><defs><linearGradient id="both" x1="0" y1="0" x2="1" y2="1"><stop offset=".5" stop-color="var(--run)"/><stop offset=".5" stop-color="var(--box)"/></linearGradient></defs>${g}</svg></div>
    <div class="legend"><span><i class="dot" style="background:var(--run)"></i>Carrera</span><span><i class="dot" style="background:var(--box)"></i>Box / WOD</span><span><i class="dot" style="background:var(--foot)"></i>Fútbol</span><span><i class="dot" style="background:linear-gradient(135deg,var(--run) 50%,var(--box) 50%)"></i>Carrera + box</span></div></div>`;
}
function balanceCard(){
  const L = bodyLoad(90), r = L.raw; if(!Object.keys(r).length) return "";
  const sum = ks => ks.reduce((t,k)=>t+(r[k]||0),0);
  const pairs = [
    ["Empuje","Tirón", sum(["pecho","hombros","triceps"]), sum(["dorsales","biceps","trapecio"])],
    ["Tren superior","Tren inferior", sum(["hombros","pecho","biceps","triceps","antebrazos","dorsales","trapecio"]), sum(["cuadriceps","isquios","gluteos","gemelos","aductores"])],
    ["Cadena anterior","Cadena posterior", sum(["cuadriceps","pecho","abdomen","oblicuos"]), sum(["isquios","gluteos","lumbar","dorsales"])]
  ].filter(([,,x,y]) => x+y > 0);
  if(!pairs.length) return "";
  const tips = [];
  pairs.forEach(([a,b,x,y])=>{ const p = x/(x+y||1); if(p>0.62) tips.push(`más ${b.toLowerCase()}`); if(p<0.38) tips.push(`más ${a.toLowerCase()}`); });
  return `<div class="card"><div class="row between"><h3>Equilibrio</h3><span class="small muted">últimos 3 meses</span></div>
    <div class="stack" style="gap:10px">${pairs.map(([a,b,x,y])=>{ const p = Math.round(100*x/(x+y||1)); return `<div class="bal"><div class="row between small"><span><b>${a}</b> ${p} %</span><span>${100-p} % <b>${b}</b></span></div><div class="balbar"><i style="width:${p}%"></i></div></div>`; }).join("")}</div>
    <p class="small">${tips.length?`Para compensar te vendría bien ${tips.join(" y ")}.`:"Bastante equilibrado: sigue así."} <span class="muted">Estimación propia a partir de los movimientos de tus WODs y tus carreras.</span></p></div>`;
}
function radarSvg(vals, labels){
  const N = vals.length, cx = 150, cy = 130, R = 92, ang = i => -Math.PI/2 + i*2*Math.PI/N;
  const pt = (i, f) => [cx + Math.cos(ang(i))*R*f, cy + Math.sin(ang(i))*R*f];
  let g = "";
  [.25,.5,.75,1].forEach(f => g += `<polygon points="${vals.map((_,i)=>pt(i,f).join(",")).join(" ")}" fill="none" stroke="var(--line)"/>`);
  vals.forEach((_,i)=>{ const [x,y] = pt(i,1); g += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--line)"/>`; });
  g += `<polygon points="${vals.map((v,i)=>pt(i, Math.max(.06,v)).join(",")).join(" ")}" fill="var(--box)" fill-opacity=".28" stroke="var(--box)" stroke-width="2"/>`;
  vals.forEach((v,i)=>{ const [x,y] = pt(i, Math.max(.06,v)); g += `<circle cx="${x}" cy="${y}" r="3.5" fill="var(--box)"/>`; });
  labels.forEach((l,i)=>{ const [x,y] = pt(i,1.2), a = Math.abs(x-cx)<10 ? "middle" : x>cx ? "start" : "end"; g += `<text x="${x}" y="${y+4}" text-anchor="${a}" style="fill:var(--fg);font-weight:600">${l}</text>`; });
  return `<svg class="chart radar" viewBox="0 0 300 260" role="img" aria-label="Preparación por estación">${g}</svg>`;
}

function syncHint(){ return S.cfg.ghToken ? "" : `<p class="note">Se guarda en este dispositivo. Activa la sincronización en <a href="#ajustes">Ajustes</a> para verlo también en el móvil u ordenador.</p>`; }
/* =========================================================
   LEER WOD DESDE FOTO (captura de AimHarder o pizarra)
   El texto se reconoce en el propio móvil con Tesseract.js; la foto no se sube a ningún sitio.
   ========================================================= */
const MESN = {enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,setiembre:9,octubre:10,noviembre:11,diciembre:12};
const LIFTS = [["back ?squat|sentadilla trasera","Back squat"],["front ?squat|sentadilla frontal","Front squat"],["dead ?lift|peso muerto","Deadlift"],["clean ?(?:and|&) ?jerk|c ?& ?j","Clean & jerk"],["power clean|squat clean|\\bclean\\b|cargada","Clean"],["power snatch|squat snatch|\\bsnatch\\b|arrancada","Snatch"],["push press","Push press"],["push jerk|split jerk","Jerk"],["strict press|shoulder press|press militar","Strict press"],["bench press|press banca","Bench press"],["\\bthrusters?\\b","Thruster"],["hip thrust","Hip thrust"],["overhead squat|\\bohs\\b","Overhead squat"]];
// Mes en español tolerando una letra mal leída por el OCR ("Fnero" → enero)
function monthOf(w){
  w = String(w||"").toLowerCase().normalize("NFD").replace(/[^a-z]/g,"");
  if(MESN[w]) return MESN[w];
  if(w.length<4) return 0;
  for(const [k,v] of Object.entries(MESN)){ if(Math.abs(k.length-w.length)>1) continue;
    const d = Array.from({length:k.length+1},(_,i)=>[i]); for(let j=1;j<=w.length;j++) d[0][j]=j;
    for(let i=1;i<=k.length;i++) for(let j=1;j<=w.length;j++) d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(k[i-1]===w[j-1]?0:1));
    if(d[k.length][w.length]<=1) return v; }
  return 0;
}
function parseWod(raw){
  const lines = String(raw).split(/\n/).map(l=>l.replace(/[|•·]+/g," ").replace(/\s+/g," ").trim()
    .replace(/^[^\p{L}\p{N}*]+/u,"").replace(/[\s\-–—·.,:;]+$/u,"").trim()).filter(l=>l.length>1);
  let fecha=null, titleDay=null, formato=null, nombre=null, resultado=null, inAcc=false, afterRes=false; const notas=[], body=[], acc=[];
  const fn = (S.athlete?.firstname||"").toLowerCase();
  for(const l of lines){
    let m;
    if((m = l.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})\b/))){ fecha = `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`; if(l.replace(m[0],"").trim().length<3) continue; }
    if(/^(crossfit|wod|hyrox|hybrid|open box|fuerza|strength)$/i.test(l) || (S.athlete?.firstname && l.toLowerCase()===S.athlete.firstname.toLowerCase())) continue;
    if((m = l.toLowerCase().match(/\b(\d{1,2})(?: de)? ([a-záéíóú]+)/)) && monthOf(m[2]) && l.length<28){
      const mo = monthOf(m[2]);
      if(!fecha){ const t = new Date(); let y = t.getFullYear(); if(new Date(y, mo-1, +m[1]) > t) y--; fecha = `${y}-${pad(mo)}-${pad(+m[1])}`; }
      continue;
    }
    if(/^(comentarios|resultados)\b/i.test(l)) break;   // fin del post: lo de abajo es el siguiente
    if((m = l.match(/^(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+(\d{1,2})$/i))){ titleDay = +m[1]; continue; }
    // Pie relativo de AimHarder en posts recientes: "12h", "45 min", "3d", "ayer"
    if((m = l.match(/^\W*(\d{1,2})\s*(h|min|d)\s*$/i)) || /^\W*ayer\s*$/i.test(l)){
      if(!fecha){ const n = m ? +m[1] : 1, u = m ? m[2].toLowerCase() : "d"; fecha = iso(new Date(Date.now() - n*(u==="d"?864e5:u==="h"?36e5:6e4))); }
      continue;
    }
    if(/^de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)$/i.test(l)) continue;
    // barra de estado del móvil, cabeceras de AimHarder y tu nombre
    if(/^\d{1,2}:\d{2}\s+\S/.test(l) || /mi perfil/i.test(l) || l.length<=3 || (fn && (l.toLowerCase().startsWith(fn) || l.toLowerCase().startsWith(fn.slice(1))) && l.length < fn.length+6)) continue;
    if(/^(me gusta|ver m[aá]s)\b/i.test(l) || /\b(c\d+\s+)?crossfit\s*[-–·:]?\s*(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/i.test(l)) continue;
    if(!resultado && (m = l.match(/^(\d+\s*R(?:ONDAS?|OUNDS?|DS)?\s*\+\s*\d+\s*(?:REPS?|R)?)$/i) || l.match(/^(?:tiempo|time|result(?:ado)?)?\s*:?\s*(\d{1,2}:\d{2}(?::\d{2})?)$/i) || l.match(/^(\d+\s*(?:RONDAS?|ROUNDS?|REPS?))$/i))){
      resultado = m[1].toUpperCase().replace(/\s+/g," ").replace(/\s*\+\s*/," + "); afterRes = true; inAcc = false; continue;
    }
    if(afterRes){
      if(/\b(inicio|perfil|men[uú])\b/i.test(l)) break;                      // barra inferior de la app
      if(((l.match(/\p{L}{3,}/gu)||[]).length >= 2) || /\d\s*(kg|lb|cm|m)\b/i.test(l)) notas.push(l);   // descarta iconos sueltos
      continue;
    }   // en AimHarder tu comentario va justo debajo del tiempo verde
    if(/\d\s*kg/i.test(l) && !/\d\s*[x×]\s*\d/i.test(l) && !/[()%]/.test(l) && !/^\d+\s/.test(l)){ notas.push(l); continue; }
    if(/^\*?\s*(accessor(?:y|ies|ios?)|accesorios?)\b/i.test(l)){ inAcc = true; acc.push(l); continue; }
    if(inAcc && /^(amrap|emom|for time|wod|metcon|strength|fuerza|skill|core|buy in|cash out)\b/i.test(l)) inAcc = false;
    if(inAcc){ acc.push(l); continue; }
    body.push(l);
    if(!formato){ if(/amrap/i.test(l)) formato="AMRAP"; else if(/\bemom|\be\d+mom/i.test(l)) formato="EMOM"; else if(/for time|\brft\b|\bft\b|chipper/i.test(l)) formato="For time"; else if(/hyrox|hybrid|h[ií]brido/i.test(l)) formato="Hyrox / Hybrid"; }
    if(!nombre && /amrap|emom|for time|\brft\b|tabata|chipper|hyrox|hybrid/i.test(l)) nombre = l.replace(/[´'`’]{2}/g,"″").replace(/[´'`’]/g,"′");
  }
  let fuerza = null;
  for(const [re,name] of LIFTS){
    const R = new RegExp(re,"i");
    const sch = body.find(l => R.test(l) && /\d\s*[x×]\s*\d/i.test(l));
    if(!sch) continue;
    const sm = sch.match(/(\d+)\s*[x×]\s*(\d+)/i), pm = sch.match(/(\d{2,3})\s*%/);
    const nl = notas.find(l => R.test(l)) || notas.find(l => !/\b(db|kb|wod|mancuerna)\b/i.test(l));
    const km = nl && (nl.match(new RegExp("(?:"+re+")\\D{0,14}(\\d+(?:[.,]\\d+)?)\\s*kg","i")) || nl.match(/(\d+(?:[.,]\d+)?)\s*kg/i));
    const kg = km ? parseFloat(km[km.length-1].replace(",", ".")) : null;
    fuerza = {ejercicio:name, series:+sm[1], reps:+sm[2], pct: pm ? +pm[1] : null, kg};
    if(kg) fuerza.rm = (+sm[2] <= 12) ? kg*36/(37 - +sm[2]) : (pm ? kg/(+pm[1]/100) : null);   // Brzycki con las reps hechas (no fiarse del %: a veces se carga más)
    break;
  }
  if(!formato) formato = fuerza ? "Fuerza" : null;
  if(!fecha && titleDay){ const t = new Date(); let d = new Date(t.getFullYear(), t.getMonth(), titleDay); if(d > t) d = new Date(t.getFullYear(), t.getMonth()-1, titleDay); fecha = iso(d); }  // "hace 12h": el título dice el día
  // Nombre genérico ("FOR TIME", "4 ROUNDS FOR TIME", "AMRAP 14′") → añade los ejercicios principales
  if(nombre && /^(\d+\s*rounds?\s*)?(for time|amrap\s*\d*\W*|emom\s*\d*\W*)\s*:?\s*(\(.*\))?\s*:?$/i.test(nombre)){
    const i0 = body.indexOf(body.find(l=>l.replace(/[´'`’]/g,"′")===nombre || l===nombre));
    const movs = [];
    body.slice(i0+1).forEach(l=>{ const m = l.replace(/\(.*?\)/g,"").replace(/^[\d\s+x×\/.,]*(?:cal|m|kg|reps?)?\b\s*/i,"").trim(); const t = m.toLowerCase().replace(/(^|\s)\S/g,c=>c.toUpperCase());
      if(t.length>2 && !movs.includes(t)) movs.push(t); });
    if(movs.length) nombre = nombre.replace(/:$/,"").trim().replace(/\s+/g," ") + " · " + movs.slice(0,3).join(" / ");
  }
  return { ok: body.length>0, fecha, formato, resultado, notas: notas.join(" · "), texto: body.join("\n"), accesorios: acc.join("\n"), fuerza,
    nombre: nombre || (fuerza ? `${fuerza.ejercicio} ${fuerza.series}×${fuerza.reps}` : (body[0]||"")) };
}
let tessP = null;
function loadTess(){
  if(window.Tesseract) return Promise.resolve();
  if(tessP) return tessP;
  tessP = new Promise((res,rej)=>{ const s=document.createElement("script"); s.src="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js"; s.onload=res; s.onerror=()=>{ tessP=null; rej(new Error("load")); }; document.head.appendChild(s); });
  return tessP;
}
async function ocrRead(src, fromStrava, fecha){
  S.ocr = {busy:true, msg:"Preparando el lector (la primera vez tarda unos segundos)…"}; render();
  let input = src;
  try{
    if(fromStrava){ const r = await fetch(src, {mode:"cors"}); if(!r.ok) throw new Error("cors"); input = await r.blob(); }
  }catch(e){
    S.ocr = {busy:false, msg:"Strava no deja leer esa foto directamente. Guárdala en el móvil (mantén pulsada la imagen) y usa «Leer WOD desde foto»."}; render(); return;
  }
  try{
    await loadTess();
    const worker = await Tesseract.createWorker(["spa","eng"], 1, {logger: m => { if(m.status==="recognizing text"){ S.ocr.msg = "Leyendo la foto… "+Math.round(m.progress*100)+" %"; const el=$("#ocrMsg"); if(el) el.textContent = S.ocr.msg; } }});
    const { data } = await worker.recognize(input);
    await worker.terminate();
    if(isPRScreen(data.text)){ const n = savePRs(parsePRs(data.text)); LS.set("recs", S.recs); schedulePush(); S.ocr = null; toast(`Pantalla de marcas: ${n} marca${n===1?"":"s"} guardada${n===1?"":"s"}`); render(); return; }
    const w = parseWod(data.text); if(!w.fecha && fecha) w.fecha = fecha;
    S.ocr = {busy:false, parsed:w, msg: w.ok ? "Listo. Revisa lo que he leído y pulsa «Guardar WOD»." : "No he podido leer bien la foto. Escribe o corrige el texto a mano."};
    if(location.hash!=="#box") location.hash = "box";
    render(); openSheet("wod", w);
  }catch(e){
    S.ocr = {busy:false, msg:"No se pudo leer la foto. Comprueba la conexión (la primera vez descarga el lector) e inténtalo de nuevo."}; render();
  }
}
/* ---------- Pantalla de PRs de AimHarder (Perfil → Fuerza) ---------- */
// El valor con el icono ⚛ es el 1RM estimado por AimHarder (cuadra con la fórmula de Brzycki); las series "3 x 42.0 Kg" son las registradas
const PR_UI = /^(buscar|fuerza|gimn[aá]stic|cardio|inicio|wod|perfil|men[uú]|mi perfil)\b/i;
const KGRE = /(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*K(?:g|q|K)?/gi;
const LIFT_DICT = ["front rack lunge","front rack lunges","front rack reverse lunges","front squat","back squat","overhead squat","box squat","pause squat","power snatch","hang power snatch","hang squat snatch","squat snatch","hang snatch","snatch","power clean","hang power clean","hang squat clean","hang clean","squat clean","clean and jerk","clean","push jerk","split jerk","jerk","push press","shoulder press","strict press","bench press","floor press","deadlift","sumo deadlift","romanian deadlift","stiff leg deadlift","sumo deadlift high pull","thruster","back reverse lunges","lunges back squat","walking lunges","overhead lunge","hip thrust","good morning","bulgarian split squat","clean pull","snatch pull","snatch balance"];
const words = t => String(t).toLowerCase().normalize("NFD").replace(/[^a-z\s]/g," ").split(/\s+/).filter(Boolean);
// Busca el levantamiento conocido más largo dentro del texto, tolerando una palabra "basura" en medio
function matchLift(txt){
  const tk = words(txt); let best = null;
  for(const d of LIFT_DICT){
    const dt = d.split(" ");
    for(let s0=0; s0<tk.length; s0++){
      if(tk[s0]!==dt[0]) continue;
      let i=1, gaps=0;
      for(let j=s0+1; j<tk.length && i<dt.length; j++){ if(tk[j]===dt[i]) i++; else if(++gaps>1) break; }
      if(i===dt.length && (!best || dt.length>best.split(" ").length)) best = d;
    }
  }
  return best;
}
const kgVal = raw => /[.,]/.test(raw) ? parseFloat(raw.replace(",", ".")) : (raw.length>=3 ? +raw/10 : +raw);  // AimHarder siempre muestra 1 decimal
function isPRScreen(raw){ return /gimn[aá]stic|cardio|fuerza/i.test(raw) && [...String(raw).matchAll(KGRE)].length >= 3 && !/amrap|emom|for time|rounds|comentarios/i.test(raw); }
function parsePRs(raw){
  const out = []; let names = [], cur = null;
  String(raw).split(/\n/).map(l=>l.replace(/\s+/g," ").trim()).filter(Boolean).forEach(l=>{
    if(PR_UI.test(l) || /^\d{1,2}:\d{2}\b/.test(l)) return;
    const vals = [...l.matchAll(KGRE)];
    const pre = vals.length ? l.slice(0, vals[0].index) : l;
    if(!vals.length){ names.push(l); names = names.slice(-3); return; }
    const lift = matchLift(names.concat(pre).join(" "));
    if(lift){ cur = {ejercicio: lift, rm:null, sets:[]}; out.push(cur); }
    else if(names.length){ cur = null; }   // nombre ilegible: mejor no inventar
    names = [];
    if(!cur) return;
    vals.forEach(v => { const kg = kgVal(v[2]); if(!kg || kg>400) return; if(v[1]) cur.sets.push(`${v[1]}×${kg}`); else if(cur.rm==null) cur.rm = kg; });
  });
  const seen = new Set();
  return out.filter(p=>(p.rm || p.sets.length) && !seen.has(p.ejercicio) && seen.add(p.ejercicio)).map(p=>{
    if(p.rm==null){ const [r,k] = p.sets[0].split("×").map(Number); p.rm = Math.round(k*36/(37-r)*10)/10; } return p; });
}
const cap1 = t => t.toLowerCase().replace(/(^|\s)\S/g, c=>c.toUpperCase());
function savePRs(list){
  let n = 0;
  const have = new Set(logs().filter(l=>l.tipo==="marca").map(l=>norm(l.ejercicio)+"|"+parseFloat(l.valor)));
  list.forEach(p => { const k = norm(p.ejercicio)+"|"+p.rm; if(have.has(k)) return; have.add(k);
    addRec({tipo:"marca", ejercicio:cap1(p.ejercicio), valor:String(p.rm), unidad:"kg", fecha:today(), nota:`1RM est. AimHarder${p.sets.length?" · series "+p.sets.join(", ")+" kg":""}`, origen:"aimharder"}, true); n++; });
  return n;
}

/* ---------- Importación masiva de capturas ---------- */
const norm = x => String(x||"").toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g,"");
const wodKey = w => (w.fecha||"")+"|"+norm(w.nombre)+"|"+norm(w.resultado)+"|"+norm(String(w.texto||"").slice(0,60));
const boxSessionOn = f => allSessions().find(s=>s.cat==="box" && iso(s.date)===f);
function wodFromParsed(w){
  const st = boxSessionOn(w.fecha);
  return {tipo:"wod", fecha:w.fecha, formato:w.formato||"Otro", nombre:w.nombre||"WOD", texto:w.texto||"", resultado:w.resultado||"", rx:"RX",
    notas:w.notas||"", accesorios:w.accesorios||"", accHecho:"", rpe:"", stravaId: st?st.id:"", origen:"foto"};
}
async function bulkImport(files){
  files = [...files].filter(f=>/^image\//.test(f.type) || /\.(jpe?g|png|heic|webp)$/i.test(f.name));
  if(!files.length) return;
  S.bulk = {total:files.length, done:0, saved:0, dup:0, items:[], busy:true, msg:"Preparando el lector (la primera vez tarda unos segundos)…"}; render();
  let worker;
  try{ await loadTess(); worker = await Tesseract.createWorker(["spa","eng"]); }
  catch(e){ S.bulk.busy=false; S.bulk.msg="No se pudo cargar el lector. Revisa la conexión e inténtalo otra vez."; render(); return; }
  let wake = null; try{ wake = await navigator.wakeLock?.request("screen"); }catch(e){}
  const keys = new Set(logs().filter(l=>l.tipo==="wod").map(wodKey));
  for(const f of files){
    const item = {file:f.name};
    try{
      const { data } = await worker.recognize(f);
      if(isPRScreen(data.text)){ const n = savePRs(parsePRs(data.text)); item.st = "pr"; S.bulk.prs = (S.bulk.prs||0) + n; S.bulk.items.push(item); S.bulk.done++; S.bulk.msg = `Leyendo ${S.bulk.done} de ${S.bulk.total}…`; render(); continue; }
      const w = parseWod(data.text); item.w = w;
      if(!w.ok) item.st = "ilegible";
      else if(!w.fecha) item.st = "sinfecha";
      else if(keys.has(wodKey(w))){ item.st = "dup"; S.bulk.dup++; }
      else { const r = wodFromParsed(w); addRec(r, true); keys.add(wodKey(w)); item.st = "ok"; item.match = !!r.stravaId; S.bulk.saved++; }
    }catch(e){ item.st = "error"; }
    S.bulk.items.push(item); S.bulk.done++; S.bulk.msg = `Leyendo ${S.bulk.done} de ${S.bulk.total}…`; render();
  }
  try{ await worker.terminate(); }catch(e){}
  try{ wake && wake.release(); }catch(e){}
  LS.set("recs", S.recs); schedulePush();
  S.bulk.busy = false;
  const rev = S.bulk.items.filter(i=>i.st==="sinfecha"||i.st==="ilegible"||i.st==="error").length;
  S.bulk.msg = `Listo: ${S.bulk.saved} WOD${S.bulk.saved===1?"":"s"} guardado${S.bulk.saved===1?"":"s"}${S.bulk.prs?` · ${S.bulk.prs} marcas de fuerza`:""}${S.bulk.dup?` · ${S.bulk.dup} ya estaban`:""}${rev?` · ${rev} para revisar abajo`:""}.`;
  render();
}
function bulkCard(){
  const b = S.bulk;
  const status = !b ? "" : `<div class="stack" style="gap:8px">
    <div class="meter"><i style="width:${b.total?b.done/b.total*100:0}%;background:var(--box)"></i></div>
    <p class="small"><b>${esc(b.msg)}</b></p>
    ${!b.busy && b.saved ? `<p class="small muted">${b.items.filter(i=>i.st==="ok"&&i.match).length} asociados a tu sesión de box en Strava de ese día · ${b.items.filter(i=>i.st==="ok"&&!i.match).length} sin sesión en Strava.</p>`:""}
    ${b.items.map((it,i)=> it.st==="ok"||it.st==="dup"||it.st==="pr" ? "" : `<div class="phrow"><span class="small"><b>${esc(it.file)}</b> · ${it.st==="sinfecha"?"no encuentro la fecha":it.st==="ilegible"?"no se lee bien":"error al leer"}</span>
      ${it.w && it.w.ok ? `<span class="small muted ell">${esc(it.w.nombre)}${it.w.resultado?" · "+esc(it.w.resultado):""}</span><div class="row"><input id="bk_${i}" type="date" style="width:auto;flex:1"><button type="button" data-bulk-save="${i}">Guardar</button></div>` : `<span class="small muted">Ábrela con «Leer WOD desde foto» y corrige a mano.</span>`}</div>`).join("")}
  </div>`;
  return `<div class="card">
    <div class="row between"><h3>Importando capturas</h3>${b && !b.busy?`<button class="ghost" data-act="bulkclose">Cerrar</button>`:""}</div>
    ${status}
  </div>`;
}
function topMoves(wods){
  const M = [["Wall balls","wall ?balls?"],["Burpees","burpees?"],["Toes to bar","toes ?to ?bar|t2b|ttb"],["Pull-ups","pull[ -]?ups?|dominadas?|c2b|chest to bar"],["Double unders","double ?unders?|\\bdu\\b|dobles"],["Box jumps","box ?jumps?|bjo"],["Thrusters","thrusters?"],["Deadlift","dead ?lifts?|peso muerto"],["Back squat","back ?squat"],["Front squat","front ?squat"],["Clean","\\bclean"],["Snatch","snatch"],["Remo","\\brow|remo"],["SkiErg","\\bski"],["Bike","bike"],["Carrera","\\brun\\b|\\bm run|carrera"],["KB swings","swings?"],["Devil press","devil ?press"],["Lunges","lunges?|zancadas?"],["Push press","push ?press"],["HSPU / pino","hspu|handstand|pino"],["Muscle-ups","muscle[ -]?ups?"],["Sled / trineo","sled|trineo"],["Farmer carry","farmer|carry"]];
  const c = {};
  wods.forEach(w=>{ const t = (w.texto||"")+(w.accHecho?"\n"+(w.accesorios||""):""); M.forEach(([n,re])=>{ if(new RegExp(re,"i").test(t)) c[n]=(c[n]||0)+1; }); });
  return Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,10);
}

function applyParsed(w){
  const set = (id,v) => { const el = document.getElementById(id); if(el && v!=null && v!=="") el.value = v; };
  set("w_fecha", w.fecha); set("w_nombre", w.nombre); set("w_texto", w.texto); set("w_res", w.resultado); set("w_notas", w.notas); set("w_acc", w.accesorios);
  const ah = document.getElementById("w_accH"); if(ah) ah.checked = false;
  if(w.formato){ const sel = document.getElementById("w_formato"); if(sel && [...sel.options].some(o=>o.value===w.formato)) sel.value = w.formato; }
  const f = document.getElementById("w_nombre"); if(f) f.scrollIntoView({block:"center", behavior:"smooth"});
}

/* ---------- RM de referencia y calculadora de cargas ---------- */
// RM que se deduce de un WOD: "BACKSQUAT 6 X 4 (75%)" + comentario "BackSquat 45 kg" → 45 / 0,75 = 60 kg
function wodLift(w){
  const lines = String(w.texto||"").split("\n"), notas = String(w.notas||"");
  // Línea de fuerza: un levantamiento con series × reps ("BACKSQUAT 4 X 6 (70%RM)", "DEADLIFT 5 X 5")
  let line = null, lift = null;
  for(const l of lines){ if(!/\d+\s*[x×]\s*\d+/i.test(l)) continue; const d = matchLift(l); if(d){ line = l; lift = d; break; } }
  if(!line) return null;
  const sm = line.match(/(\d+)\s*[x×]\s*(\d+)/i), reps = +sm[2], pm = line.match(/(\d{2,3})\s*%/);
  const re = lift.split(" ").join("\\s*");
  let km = notas.match(new RegExp(re+"\\D{0,14}(\\d+(?:[.,]\\d+)?)\\s*kg","i"));
  if(!km) km = notas.match(/^\D{0,3}(\d+(?:[.,]\d+)?)\s*kg/i);   // "35 kg Wod con…": el primer peso es el de fuerza
  if(!km || reps>12 || reps<1) return null;
  const kg = parseFloat(km[1].replace(",", ".").replace("'", "."));
  return {ejercicio: cap1(lift), kg, reps, pct: pm ? +pm[1] : null, rm: kg*36/(37-reps)};
}
function rmTable(){
  const by = {};
  const push = (name, rm, fecha, src) => { if(!rm || !isFinite(rm)) return; const k = norm(name).replace(/s$/,"");
    (by[k] = by[k] || {name, list:[]}).list.push({rm:Math.round(rm*10)/10, fecha, src}); };
  logs().filter(l=>l.tipo==="marca" && /kg/i.test(l.unidad||"")).forEach(l=>{
    const v = parseFloat(String(l.valor).replace(",", ".")), m = String(l.nota||"").match(/1RM est\.?\s*(\d+(?:[.,]\d+)?)/i);
    if(/aimharder/i.test(l.nota||"")) push(l.ejercicio, v, l.fecha, "PR de AimHarder");
    else if(m) push(l.ejercicio, parseFloat(m[1].replace(",", ".")), l.fecha, "estimado de "+(l.nota||"").split("·")[0].trim());
    else push(l.ejercicio, v, l.fecha, "marca apuntada");
  });
  logs().filter(l=>l.tipo==="wod").forEach(w=>{ const x = wodLift(w); if(x) push(x.ejercicio, x.rm, w.fecha, `WOD del ${fDate(parseISO(w.fecha))}: ${x.kg} kg × ${x.reps}${x.pct?` (marcaba ${x.pct} %)`:""}`); });
  Object.values(by).forEach(e=>{ e.list.sort((a,b)=>b.rm-a.rm); e.best = e.list[0]; });
  return by;
}
function calcCard(){
  const t = rmTable(), keys = Object.keys(t).sort((a,b)=>t[a].name.localeCompare(t[b].name));
  if(!keys.length) return "";
  const k = keys.includes(S.calcEx) ? S.calcEx : (keys.find(x=>x==="backsquat") || keys[0]);
  const e = t[k], rm = e.best.rm, pcts = [50,60,65,70,75,80,85,90,95];
  return `<div class="card"><h3>¿Cuánto me pongo?</h3>
    <p class="note">Elige el ejercicio y mira los kilos para el porcentaje que marque el WOD. Uso tu RM más alto conocido: el PR de AimHarder o el que sale de los kilos y repeticiones que apuntas en tus WODs (fórmula de Brzycki), sin fiarme del % que marcaba.</p>
    ${field("calc_ex","Ejercicio",`<select id="calc_ex">${keys.map(x=>`<option value="${x}" ${x===k?"selected":""}>${esc(t[x].name)}</option>`).join("")}</select>`)}
    <div class="row" style="align-items:baseline;gap:8px"><span class="num" style="font-size:40px;line-height:1">${rm}</span><span class="small">kg de RM · <span class="muted">${esc(e.best.src)}</span></span></div>
    <div class="pcts">${pcts.map(p=>`<div class="pct${p===70||p===75?" hl":""}"><span class="lab">${p} %</span><span class="num">${Math.round(rm*p/100)}</span></div>`).join("")}</div>
    <p class="note">Redondeado a 1 kg. Si a ese peso te sobran 2 o más repeticiones, tu RM real es más alto: súbelo un 5 % y apunta la marca para que la app lo use.</p>
    ${e.list.length>1?`<details><summary class="small">De dónde sale (${e.list.length} referencias)</summary><div class="list">${e.list.map(x=>`<div class="item"><span class="num" style="width:44px">${x.rm}</span><div class="s">${esc(x.src)}</div><span></span></div>`).join("")}</div></details>`:""}
  </div>`;
}

function heroCard(ss){
  const ev = futuros(), st = streak(ss), w = weekBuckets(ss,1)[0], mins = w.run+w.box+w.futbol+w.walk+w.otro, cp = currentPhase(), e = ev[0];
  return `<div class="hero">
    <div class="row between"><span class="eyebrow">${e?"Próximo objetivo":"Esta semana"}</span><span class="glass">Racha ${st.n} sem</span></div>
    ${e?`<a class="hero-main" href="#objetivos"><span class="num huge" data-count="${daysBetween(new Date(), parseISO(e.fecha))}">${daysBetween(new Date(), parseISO(e.fecha))}</span><span class="hero-l"><b>días para</b><span class="hname">${esc(e.nombre)}</span><span class="hdate">${DIAS[dow(parseISO(e.fecha))]} ${fDate(parseISO(e.fecha))}</span></span></a>`:`<a class="hero-main" href="#objetivos"><span class="hero-l"><b>Sin competición</b><span>Añade una en Objetivos</span></span></a>`}
    ${ev[1]?`<div class="hero-next">Después: <b>${esc(ev[1].nombre)}</b> · ${daysBetween(new Date(), parseISO(ev[1].fecha))} días</div>`:""}
    <div class="hero-stats"><div><b>${fMin(mins)}</b><span>esta semana</span></div><div><b>${w.n}</b><span>sesiones</span></div><div><b>${cp? cp.info.n : "—"}</b><span>fase</span></div></div>
  </div>`;
}
function countdownStrip(){
  const ev = futuros(); if(!ev.length) return "";
  return `<div class="cd-row">${ev.map(e=>{ const d = daysBetween(new Date(), parseISO(e.fecha));
    return `<a class="cd" href="#objetivos" style="--c:${e.clase==="hibrida"?"var(--box)":"var(--run)"}"><span class="num">${d}</span><span class="cd-l"><b>${esc(e.nombre)}</b><span class="muted">${d===0?"¡Hoy!":d===1?"día · mañana":"días · "+fDate(parseISO(e.fecha))}</span></span></a>`; }).join("")}</div>`;
}
/* =========================================================
   FORMULARIOS (se abren en un panel desde abajo)
   ========================================================= */
const val = v => esc(v==null ? "" : v);
const opt = (list, cur) => list.map(o => `<option ${o===cur?"selected":""}>${o}</option>`).join("");
function fmWod(p={}){ return `<form data-form="wod">
  <div class="grid2">${field("w_fecha","Fecha",`<input id="w_fecha" name="fecha" type="date" value="${val(p.fecha||today())}" required>`)}
  ${field("w_formato","Formato",`<select id="w_formato" name="formato">${opt(["AMRAP","For time","EMOM","Fuerza","Hyrox / Hybrid","Intervalos","Otro"], p.formato)}</select>`)}</div>
  ${field("w_nombre","Nombre del WOD",`<input id="w_nombre" name="nombre" value="${val(p.nombre)}" placeholder="AMRAP 14′, Fran, WOD del día" required>`)}
  ${field("w_texto","Entreno",`<textarea id="w_texto" name="texto" placeholder="BACKSQUAT 4 X 6 (70%RM)&#10;AMRAP 14′&#10;12 cal echo bike…">${val(p.texto)}</textarea>`)}
  <div class="grid2">${field("w_res","Resultado",`<input id="w_res" name="resultado" value="${val(p.resultado)}" placeholder="3R + 18 reps · 8:42">`)}
  ${field("w_rx","Nivel",`<select id="w_rx" name="rx">${opt(["RX","Scaled","Adaptado"], p.rx)}</select>`)}</div>
  ${field("w_notas","Comentario (cargas, notas)",`<input id="w_notas" name="notas" value="${val(p.notas)}" placeholder="Backsquat 45 kg · DB de 10 kg">`)}
  <details ${p.accesorios?"open":""}><summary class="small">Accesorios</summary>
    ${field("w_acc","No cuentan salvo que los marques",`<textarea id="w_acc" name="accesorios" style="min-height:56px">${val(p.accesorios)}</textarea>`)}
    <label class="chk" for="w_accH"><input id="w_accH" name="accHecho" type="checkbox" value="1"> Hice los accesorios</label>
  </details>
  <button class="primary big" type="submit">Guardar WOD</button></form>`; }
function fmMarca(p={}){ return `<form data-form="marca">
  ${field("m_ej","Ejercicio",`<input id="m_ej" name="ejercicio" list="ejercicios" value="${val(p.ejercicio)}" placeholder="Back squat" required>`)}
  <datalist id="ejercicios">${LIFT_DICT.map(x=>`<option value="${cap1(x)}">`).join("")}${["Pull-ups máx","Toes to bar máx","Fran","Cindy","Grace","Wall balls 2 min","Remo 500 m","Remo 2 km","SkiErg 1 km","High Box Jump"].map(x=>`<option value="${x}">`).join("")}</datalist>
  <div class="grid2">${field("m_val","Valor",`<input id="m_val" name="valor" inputmode="decimal" value="${val(p.valor)}" placeholder="60 · 7:45 · 12" required>`)}
  ${field("m_un","Unidad",`<select id="m_un" name="unidad">${opt(["kg","reps","tiempo","rondas","m","cm","cal"], p.unidad)}</select>`)}</div>
  <div class="grid2">${field("m_fecha","Fecha",`<input id="m_fecha" name="fecha" type="date" value="${val(p.fecha||today())}" required>`)}
  ${field("m_nota","Nota",`<input id="m_nota" name="nota" value="${val(p.nota)}" placeholder="1RM real · 3×42">`)}</div>
  <button class="primary big" type="submit">Guardar marca</button></form>`; }
function fmEvento(){ return `<form data-form="evento">
  ${field("e_n","Nombre",`<input id="e_n" name="nombre" placeholder="Medio Maratón de Madrid" required>`)}
  <div class="grid2">${field("e_f","Fecha",`<input id="e_f" name="fecha" type="date" required>`)}
  ${field("e_c","Tipo",`<select id="e_c" name="clase"><option value="carrera">Carrera a pie</option><option value="hibrida">Híbrida / Hyrox</option><option value="otra">Otra</option></select>`)}</div>
  <div class="grid2">${field("e_km","Distancia (km)",`<input id="e_km" name="km" inputmode="decimal" placeholder="21.0975">`)}
  ${field("e_o","Tiempo objetivo",`<input id="e_o" name="objetivo" placeholder="1:45:00">`)}</div>
  ${field("e_no","Notas",`<input id="e_no" name="notas" placeholder="Pareja, categoría, estaciones…">`)}
  <button class="primary big" type="submit">Guardar competición</button></form>`; }
function fmPR(){ return `<form data-form="pr">
  <div class="grid2">${field("pr_dist","Distancia",`<select id="pr_dist" name="dist"><option>5K</option><option>10K</option><option selected>21K</option><option>42K</option></select>`)}
  ${field("pr_t","Tiempo de chip",`<input id="pr_t" name="tiempo" placeholder="1:45:00" required>`)}</div>
  <div class="grid2">${field("pr_f","Fecha",`<input id="pr_f" name="fecha" type="date" value="${today()}" required>`)}
  ${field("pr_c","Carrera",`<input id="pr_c" name="carrera" placeholder="Nombre de la carrera">`)}</div>
  <button class="primary big" type="submit">Guardar marca oficial</button></form>`; }

/* =========================================================
   CUERPO: músculos trabajados
   ========================================================= */
const wodText = w => (w.texto||"") + (w.accHecho ? "\n"+(w.accesorios||"") : "");
function bodyLoad(days){
  const now = new Date(), vec = {}, by = {}; let nW = 0, nR = 0;
  const add = (k,v) => vec[k] = (vec[k]||0) + v;
  logs().filter(l=>l.tipo==="wod" && (!days || daysBetween(parseISO(l.fecha), now) < days)).forEach(w => {
    nW++; const a = Body.analyze(wodText(w));
    Object.entries(a.vec).forEach(([k,v]) => add(k,v));
    Object.keys(a.moves).forEach(m => { const mv = Body.MOVES.find(x=>x[0]===m); Object.entries(mv[2]).forEach(([k,w8]) => { if(w8>=.5){ by[k] = by[k]||{}; by[k][m] = (by[k][m]||0)+1; } }); });
  });
  allSessions().filter(s=>s.cat==="futbol" && (!days || daysBetween(s.date, now) < days)).forEach(f => {
    const k0 = Math.min(1.5, f.min/60);
    Object.entries(FUT).forEach(([k,v]) => { add(k, v*k0); if(v>=.5){ by[k] = by[k]||{}; by[k]["Fútbol"] = (by[k]["Fútbol"]||0)+1; } });
  });
  allSessions().filter(s=>s.cat==="run" && (!days || daysBetween(s.date, now) < days)).forEach(r => {
    nR++; const f = Math.min(1.5, r.km/8);
    Object.entries(Body.RUN).forEach(([k,v]) => { add(k, v*f); if(v>=.5){ by[k] = by[k]||{}; by[k]["Carrera (Strava)"] = (by[k]["Carrera (Strava)"]||0)+1; } });
  });
  const raw = {...vec}, mx = Math.max(0, ...Object.values(vec));
  if(mx) Object.keys(vec).forEach(k => vec[k] /= mx);
  return {vec, raw, by, nW, nR};
}
function bodyCard(compact){
  const days = S.bodyDays ?? 28, L = bodyLoad(days), sel = S.selMus;
  const ranked = Object.keys(Body.MUSCLES).map(k=>[k, L.vec[k]||0]).sort((a,b)=>b[1]-a[1]);
  const top = ranked.filter(x=>x[1]>0).slice(0,4), low = ranked.filter(x=>x[1]<.25).slice(-3).reverse();
  const info = sel ? (()=>{ const v = L.vec[sel]||0, mv = Object.entries(L.by[sel]||{}).sort((a,b)=>b[1]-a[1]);
      return `<div class="stack" style="gap:6px"><span class="eyebrow">Músculo</span><h3 style="font-size:24px">${Body.MUSCLES[sel].n}</h3>
        <div class="meter"><i style="width:${v*100}%;background:var(--box)"></i></div><span class="small muted">${Math.round(v*100)} % respecto al más trabajado</span>
        ${mv.length?`<div class="stack" style="gap:3px">${mv.slice(0,6).map(([m,c])=>`<div class="row between small"><span>${esc(m)}</span><b>${c}×</b></div>`).join("")}</div>`:`<p class="small muted">Sin trabajo en este periodo.</p>`}
        <button class="ghost" data-act="mus-clear" style="align-self:flex-start">Ver todos</button></div>`; })()
    : `<div class="stack" style="gap:6px"><span class="eyebrow">Más trabajado</span>
        ${top.length?top.map(([k,v])=>`<button class="musrow" data-mus="${k}"><span>${Body.MUSCLES[k].n}</span><span class="meter"><i style="width:${v*100}%;background:var(--box)"></i></span></button>`).join(""):`<p class="small muted">Sin entrenos en este periodo.</p>`}
        ${low.length && top.length?`<span class="eyebrow" style="margin-top:6px">Menos trabajado</span><p class="small">${low.map(([k])=>Body.MUSCLES[k].n).join(", ")}</p>`:""}</div>`;
  return `<div class="card bodycard">
    <div class="row between"><h2>${compact?"Tu cuerpo":"Músculos trabajados"}</h2>
      <div class="seg" role="group" aria-label="Periodo">${[[28,"4 sem"],[90,"3 meses"],[0,"Todo"]].map(([d,t])=>`<button type="button" data-days="${d}" aria-pressed="${days===d}">${t}</button>`).join("")}</div></div>
    <div class="bodygrid">
      <div class="stack" style="gap:6px;align-items:center">${Body.flipper(L.vec, {sel, side:S.bodyBack?"b":"f", id:"main"})}
        <button class="ghost flipbtn" data-act="flip"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>${S.bodyBack?"Ver de frente":"Ver de espaldas"}</button></div>
      ${info}
    </div>
    <div class="row between"><div class="ramp"><span>menos</span>${[0,1,2,3,4].map(i=>`<i class="r${i}"></i>`).join("")}<span>más</span></div><span class="small muted">${L.nW} WOD${L.nW===1?"":"s"} · ${L.nR} carrera${L.nR===1?"":"s"}</span></div>
    ${compact?"":`<p class="note">Estimación propia: cada movimiento de tus WODs (sin accesorios) y tus carreras de Strava suma a los músculos que trabaja. Toca un músculo para ver con qué lo has trabajado.</p>`}
  </div>`;
}
const sideOf = vec => { let f=0, b=0; Object.entries(vec).forEach(([k,v])=>{ const s = Body.MUSCLES[k].v; if(s.includes("f")) f+=v; if(s.includes("b")) b+=v; }); return b>f*1.1 ? "b" : "f"; };
const topMus = vec => Object.entries(vec).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k])=>Body.MUSCLES[k].n);

/* =========================================================
   BOX
   ========================================================= */
function photoCard(box){
  const withPh = box.filter(s=>s.photos>0 && daysBetween(s.date,new Date())<90).slice(0,12);
  if(!withPh.length) return "";
  const need = withPh.filter(s=>!S.ph[s.id]).map(s=>s.id);
  if(need.length) setTimeout(()=>fetchPhotos(need), 30);
  return `<details class="card fold"><summary><h3>Fotos de tus WODs en Strava</h3><span class="muted small">${withPh.length}</span></summary>
    <div class="list">${withPh.map(s=>{ const ph = S.ph[s.id]; const done = logs().some(l=>l.tipo==="wod" && l.fecha===iso(s.date));
      return `<div class="phrow"><div class="row between"><span class="small"><b>${DIAS[dow(s.date)]} ${fDate(s.date)}</b> · ${esc(s.name)}</span>${done?`<span class="pill ok">apuntado</span>`:""}</div>
      <div class="thumbs">${ph? ph.map(u=>`<div class="thumb"><a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Foto del entreno" loading="lazy" referrerpolicy="no-referrer"></a><button class="ghost" data-ocr-url="${esc(u)}" data-date="${iso(s.date)}">Leer</button></div>`).join("") : `<span class="muted small">Cargando fotos…</span>`}</div></div>`; }).join("")}</div></details>`;
}
function wodCard(w){
  const d = parseISO(w.fecha), a = Body.analyze(wodText(w));
  return `<button class="wodc" data-wod="${w.id}">
    <span class="wdate"><b>${d.getDate()}</b><span>${MESES[d.getMonth()]}</span></span>
    <span class="wbody"><span class="wname">${esc(w.nombre)}</span>
      ${w.resultado?`<span class="res">${esc(w.resultado)}</span>`:""}
      ${w.notas?`<span class="com">${esc(w.notas)}</span>`:""}
      <span class="mchips">${topMus(a.vec).map(n=>`<i>${n}</i>`).join("")}</span></span>
    <span class="wmini">${Body.figure(sideOf(a.vec), a.vec, {id:w.id})}</span>
  </button>`;
}
function marcasGrid(){
  const by = {}; logs().filter(l=>l.tipo==="marca").forEach(m=>{ const k = norm(m.ejercicio).replace(/s$/,""); (by[k]=by[k]||[]).push(m); });
  const rm = rmTable();
  const items = Object.entries(by).map(([k,arr])=>{ arr.sort((a,b)=>a.fecha.localeCompare(b.fecha)||(a.creado||0)-(b.creado||0)); const l = arr[arr.length-1];
    const best = rm[k]?.best; return {k, name:l.ejercicio, v:best && /kg/.test(l.unidad) ? best.rm : l.valor, u:l.unidad, n:arr.length, est: best && /kg/.test(l.unidad) && best.src!=="PR de AimHarder" && best.src!=="marca apuntada"}; })
    .sort((a,b)=>a.name.localeCompare(b.name));
  if(!items.length) return `<p class="note">Aún no hay marcas. Pulsa «+» para añadir una o importa la pantalla de PR de AimHarder.</p>`;
  return `<div class="mgrid">${items.map(i=>`<button class="mtile" data-marca="${i.k}"><span class="mname">${esc(i.name)}</span><span class="mval"><b>${esc(i.v)}</b> ${esc(i.u)}</span>${i.est?`<span class="mtag">desde WOD</span>`:""}</button>`).join("")}</div>`;
}
function vBox(){
  const ss = allSessions(), now = new Date();
  const box = ss.filter(s=>s.cat==="box");
  const last90 = box.filter(s=>daysBetween(s.date,now)<90);
  const wods = logs().filter(l=>l.tipo==="wod").sort((a,b)=>b.fecha.localeCompare(a.fecha));
  const shown = S.wodAll ? wods : wods.slice(0,8);
  const o = S.ocr || {};
  return `
  ${o.busy || (o.msg && !S.sheetState) ? `<div class="banner ${o.busy?"info":""}" id="ocrMsg">${esc(o.msg)}</div>`:""}
  ${S.bulk ? bulkCard() : ""}
  <div class="statrow">
    <div><span class="num">${(last90.length/(90/7)).toFixed(1)}</span><span class="lab">sesiones / semana</span></div>
    <div><span class="num">${last90.length? Math.round(last90.reduce((t,s)=>t+s.min,0)/last90.length):0}′</span><span class="lab">duración media</span></div>
    <div><span class="num">${wods.length}</span><span class="lab">WODs</span></div>
  </div>
  ${bodyCard(false)}
  ${balanceCard()}
  <div class="card">
    <div class="row between"><h2>Tus WODs</h2><button class="addbtn" data-sheet="add">+ Añadir</button></div>
    ${wods.length ? `<div class="wodlist">${shown.map(wodCard).join("")}</div>${wods.length>8?`<button class="ghost" data-act="wodall" style="align-self:center">${S.wodAll?"Ver menos":`Ver los ${wods.length}`}</button>`:""}`
      : `<p class="small muted">Aún no hay WODs. Pulsa «+ Añadir» para leer una captura de AimHarder o apuntarlo a mano.</p>`}
  </div>
  <div class="card">
    <div class="row between"><h2>Marcas</h2><button class="addbtn" data-sheet="marca">+ Marca</button></div>
    ${marcasGrid()}
  </div>
  ${calendarCard()}
  ${calcCard()}
  ${(()=>{ const tm = topMoves(wods); if(tm.length<3) return ""; const mx = tm[0][1];
    return `<details class="card fold"><summary><h3>Movimientos más frecuentes</h3><span class="muted small">${wods.length} WODs</span></summary><div class="stack" style="gap:6px">${tm.map(([n,v])=>`<div class="row" style="gap:8px;flex-wrap:nowrap"><span class="small" style="width:108px;flex:none">${n}</span><div class="meter" style="flex:1"><i style="width:${v/mx*100}%;background:var(--box)"></i></div><span class="num" style="width:26px;text-align:right">${v}</span></div>`).join("")}</div></details>`; })()}
  ${photoCard(box)}`;
}

/* =========================================================
   PANEL INFERIOR (sheet)
   ========================================================= */
const SHEETS = {
  add: () => ["Añadir a Box", `<div class="actlist">
      <label class="act" for="ocrFile"><span class="ico">${ICON.cam}</span><span><b>Leer captura</b><small>Una captura de AimHarder o foto de la pizarra</small></span></label>
      <label class="act" for="bulkFiles"><span class="ico">${ICON.stack}</span><span><b>Importar varias</b><small>Selecciona muchas capturas a la vez (WODs y PRs)</small></span></label>
      <button class="act" data-sheet="wod"><span class="ico">${ICON.pen}</span><span><b>Apuntar a mano</b><small>Escribe el WOD y tu resultado</small></span></button>
      <button class="act" data-sheet="marca"><span class="ico">${ICON.bar}</span><span><b>Nueva marca</b><small>RM, benchmark o ergómetro</small></span></button>
    </div>${syncHint()}`],
  wod: p => [p && p.nombre ? "Revisa el WOD" : "Nuevo WOD", `${p && p.fuerza && p.fuerza.kg ? `<div class="banner info small"><b>${esc(p.fuerza.ejercicio)} ${p.fuerza.series}×${p.fuerza.reps} con ${p.fuerza.kg} kg</b> → 1RM estimado ≈ <b>${Math.round(p.fuerza.rm)} kg</b> (Brzycki). <button class="ghost" data-act="sug-marca">Guardar en marcas</button></div>`:""}${fmWod(p||{})}`],
  marca: p => ["Nueva marca", fmMarca(p||{})],
  evento: () => ["Nueva competición", fmEvento()],
  pr: () => ["Marca oficial", fmPR()],
  run: id => runSheet(id),
  quick: () => quickSheet(),
  voice: () => voiceSheet(),
  futfill: () => futFillSheet(),
  futbol: p => ["Fútbol", fmFutbol(p||{})],
  futDetail: id => futSheet(id),
  hyrox: () => hyroxSheet(),
  hmplan: () => hmSheet(),
  story: url => ["Tu semana", `<div class="stack" style="gap:10px;align-items:center"><img src="${url}" alt="Resumen de tu semana" class="storyimg"><p class="small muted">Mantén pulsada la imagen para guardarla o compartirla.</p></div>`],
  wodDetail: id => { const w = logs().find(l=>l.id===id); if(!w) return ["WOD", "<p>Ya no existe.</p>"];
    const a = Body.analyze(wodText(w)), st = boxSessionOn(w.fecha), d = parseISO(w.fecha);
    return [w.nombre, `<div class="stack" style="gap:12px">
      <span class="eyebrow">${DIAS[dow(d)]} ${fDate(d)} ${w.fecha.slice(0,4)} · ${esc(w.formato||"")} · ${esc(w.rx||"")}</span>
      <div class="row between" style="align-items:flex-end">${w.resultado?`<span class="res big">${esc(w.resultado)}</span>`:"<span></span>"}${st?`<a class="small" href="https://www.strava.com/activities/${st.id}" target="_blank" rel="noopener">Strava · ${fMin(st.min)}</a>`:""}</div>
      ${w.notas?`<span class="com">${esc(w.notas)}</span>`:""}
      <div class="twin"><div><span class="eyebrow">Delante</span>${Body.figure("f", a.vec, {id:"df"})}</div><div><span class="eyebrow">Detrás</span>${Body.figure("b", a.vec, {id:"db"})}</div></div>
      <div class="mchips">${Object.entries(a.vec).sort((x,y)=>y[1]-x[1]).slice(0,7).map(([k])=>`<i>${Body.MUSCLES[k].n}</i>`).join("")}</div>
      <div class="pre wtext">${esc(w.texto||"")}</div>
      ${w.accesorios?`<div class="acc"><div class="row between"><b class="small">Accesorios</b><label class="chk small" for="accT"><input id="accT" type="checkbox" data-acc="${w.id}" ${w.accHecho?"checked":""}> Hechos</label></div><div class="pre small muted">${esc(w.accesorios)}</div></div>`:""}
      <div class="row between">${delBtn(w.id, "Borrar WOD")}<button class="ghost" data-act="close">Cerrar</button></div></div>`]; },
  marcaDetail: k => { const arr = logs().filter(m=>m.tipo==="marca" && norm(m.ejercicio).replace(/s$/,"")===k).sort((a,b)=>b.fecha.localeCompare(a.fecha)||(b.creado||0)-(a.creado||0));
    const r = rmTable()[k]; if(!arr.length) return ["Marca","<p>Ya no existe.</p>"];
    return [arr[0].ejercicio, `<div class="stack" style="gap:12px">
      ${r?`<div class="row" style="align-items:baseline;gap:8px"><span class="num" style="font-size:44px;line-height:1">${r.best.rm}</span><span class="small">kg de RM · <span class="muted">${esc(r.best.src)}</span></span></div>
      <div class="pcts">${[60,65,70,75,80,85,90].map(p=>`<div class="pct${p===70||p===75?" hl":""}"><span class="lab">${p} %</span><span class="num">${Math.round(r.best.rm*p/100)}</span></div>`).join("")}</div>`:""}
      <div class="list">${arr.map(m=>`<div class="item"><span class="num" style="min-width:52px;font-size:20px">${esc(m.valor)}<small class="muted"> ${esc(m.unidad)}</small></span><div style="min-width:0"><div class="s">${fDate(parseISO(m.fecha))} ${m.fecha.slice(0,4)}</div>${m.nota?`<div class="s">${esc(m.nota)}</div>`:""}</div>${delBtn(m.id)}</div>`).join("")}</div>
      ${r && r.list.length>1?`<details><summary class="small">Referencias de RM (${r.list.length})</summary><div class="list">${r.list.map(x=>`<div class="item"><span class="num" style="width:44px">${x.rm}</span><div class="s">${esc(x.src)}</div><span></span></div>`).join("")}</div></details>`:""}
      <button class="primary" data-sheet="marca" data-ej="${esc(arr[0].ejercicio)}" data-un="${esc(arr[0].unidad)}">+ Añadir marca de ${esc(arr[0].ejercicio)}</button></div>`]; }
};
const ICON = {
  cam:'<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  stack:'<svg viewBox="0 0 24 24"><rect x="6" y="3" width="13" height="15" rx="2"/><path d="M4 7v12a2 2 0 0 0 2 2h10"/></svg>',
  pen:'<svg viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16z"/></svg>',
  bar:'<svg viewBox="0 0 24 24"><path d="M2 12h20M5 8v8M19 8v8M8 6v12M16 6v12"/></svg>'
};
function openSheet(kind, data){
  S.sheetState = {kind, data}; renderSheet();
  const el = $("#sheet"); el.hidden = false; document.body.classList.add("noscroll");
  requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add("open")));
}
function closeSheet(){
  const el = $("#sheet"); if(el.hidden) return;
  if(rec){ try{ rec.abort(); }catch(e){} rec = null; } S.voice = null;
  el.classList.remove("open"); document.body.classList.remove("noscroll");
  setTimeout(()=>{ if(runMap){ try{ runMap.remove(); }catch(e){} runMap = null; } el.hidden = true; $("#sheetBody").innerHTML = ""; S.sheetState = null; S.confirmDel = null; }, 260);
}
let sheetBusy = false;
function renderSheet(){
  if(!S.sheetState || sheetBusy) return;
  sheetBusy = true; try{ renderSheetNow(); } finally { sheetBusy = false; }
}
function renderSheetNow(){
  const [title, html] = SHEETS[S.sheetState.kind](S.sheetState.data);
  $("#sheetTitle").textContent = title; $("#sheetBody").innerHTML = html;
}

function timelineSvg(ps){
  if(!ps.length) return "";
  const t0 = ps[0].start, t1 = ps[ps.length-1].end, span = Math.max(1, daysBetween(t0,t1)+1);
  const W=400, H=58, x = d => 4 + (W-8)*daysBetween(t0,d)/span;
  let g = "";
  ps.forEach(p => { g += `<rect x="${x(p.start)}" y="10" width="${Math.max(2, x(addDays(p.end,1))-x(p.start)-1.5)}" height="16" rx="4" fill="${PH[p.key].c}"><title>${PH[p.key].n}: ${fDate(p.start)} – ${fDate(p.end)}</title></rect>`; });
  futuros().forEach(e => { const xx = x(addDays(parseISO(e.fecha),1))-1; g += `<line x1="${xx}" x2="${xx}" y1="4" y2="32" stroke="var(--fg)" stroke-width="2"/><text x="${Math.min(W-4,xx)}" y="46" text-anchor="end" style="fill:var(--fg);font-weight:600">${fDate(parseISO(e.fecha))}</text>`; });
  g += `<text x="4" y="46">hoy</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Fases hasta tus competiciones">${g}</svg>`;
}
/* ---------- HYROX: 8 × (1 km de carrera + estación). Pesos Doubles Women Open (pesos oficiales publicados) ---------- */
const HYROX = [
  {n:"SkiErg", d:"1000 m", mv:["SkiErg"], mk:/ski/i},
  {n:"Sled push", d:"50 m · 102 kg", mv:["Trineo"], mk:/sled|trineo/i},
  {n:"Sled pull", d:"50 m · 78 kg", mv:["Trineo"], mk:/sled pull|arrastre/i},
  {n:"Burpee broad jumps", d:"80 m", mv:["Burpees"], mk:/broad|bbj|burpee/i},
  {n:"Remo", d:"1000 m", mv:["Remo (ergómetro)"], mk:/remo|row/i},
  {n:"Farmers carry", d:"200 m · 2 × 16 kg", mv:["Farmer carry"], mk:/farmer|carry/i},
  {n:"Sandbag lunges", d:"100 m · 10 kg", mv:["Zancadas"], mk:/lunge|zancada/i},
  {n:"Wall balls", d:"100 reps · 4 kg", mv:["Wall balls"], mk:/wall ?ball/i}
];
function hyroxBlock(){
  const now = new Date(), wods = logs().filter(l=>l.tipo==="wod" && daysBetween(parseISO(l.fecha),now)<90);
  const cnt = {}; wods.forEach(w=>Object.keys(Body.analyze(wodText(w)).moves).forEach(m=>cnt[m]=(cnt[m]||0)+1));
  const marcas = logs().filter(l=>l.tipo==="marca");
  const runs = allSessions().filter(s=>s.cat==="run" && daysBetween(s.date,now)<28);
  const vals = HYROX.map(st => { const c = st.mv.reduce((t,m)=>t+(cnt[m]||0),0), mk = marcas.some(m=>st.mk.test(m.ejercicio)); return Math.min(1, c/4 + (mk?.15:0)); });
  return `<div class="hyx">
    ${radarSvg(vals, ["Ski","Sled push","Sled pull","BBJ","Remo","Farmers","Lunges","Wall balls"])}
    <p class="small muted" style="text-align:center;margin-top:-6px">Preparación por estación (veces entrenada en 90 días; 4+ = lleno)</p>
    <div class="hyx-run"><b>8 × 1 km</b> de carrera, una antes de cada estación. En dobles corréis las dos todos los kilómetros; las estaciones os las repartís como queráis (trabaja una cada vez).</div>
    <div class="hyx-list">${HYROX.map((st,i)=>{ const c = st.mv.reduce((t,m)=>t+(cnt[m]||0),0), mk = marcas.filter(m=>st.mk.test(m.ejercicio)).sort((a,b)=>b.fecha.localeCompare(a.fecha))[0];
      const lv = c>=4 ? "ok" : c>=1 ? "warn" : "bad";
      return `<div class="hyx-st"><span class="hyx-n">${i+1}</span><div style="min-width:0"><b>${st.n}</b><span class="small muted"> · ${st.d}</span>${mk?`<div class="small">Tu marca: <b>${esc(mk.valor)} ${esc(mk.unidad)}</b> <span class="muted">(${esc(mk.ejercicio.replace(/^hybrid\s*·\s*/i,""))})</span></div>`:""}</div><span class="pill ${lv}">${c ? `${c}× en 90 d` : "sin entrenar"}</span></div>`; }).join("")}</div>
    <p class="note">Veces que aparece cada estación en tus WODs de los últimos 90 días (estimación por los nombres de los ejercicios). Carreras en 28 días: ${runs.length}. Pesos oficiales de Doubles Women Open; confirma el reglamento 26/27 en la web de HYROX.</p>
    <details><summary class="small"><b>Cómo repartir en pareja</b></summary><div class="list small">
      <div class="check"><span class="box">·</span><div>Wall balls y burpee broad jumps: relevos cortos (10–15 reps o 20 m) para no llegar al fallo. Si un día no te encuentras bien, bloques aún más cortos en los burpees.</div></div>
      <div class="check"><span class="box">·</span><div>Trineos: tramos de 12,5 m (un largo) y que empuje más quien tenga más fuerza de pierna.</div></div>
      <div class="check"><span class="box">·</span><div>SkiErg y remo: cambios cada 200–250 m o cada minuto, manteniendo un ritmo que podáis sostener.</div></div>
      <div class="check"><span class="box">·</span><div>Ensayad los cambios: en dobles se pierde mucho tiempo en las transiciones.</div></div>
    </div></details>
  </div>`;
}
function eventCard(e){
  const d = daysBetween(new Date(), parseISO(e.fecha)), wk = Math.floor(d/7);
  const hib = e.clase==="hibrida", km = +String(e.km||"").replace(",",".");
  let extra = "";
  if(!hib && km){
    const goal = parseTime(e.objetivo), b = bestEfforts();
    const ref = b["half-marathon"] || b["10k"];
    const refDist = b["half-marathon"] ? 21.0975 : 10;
    const pred = ref ? riegel(ref.t, refDist, km) : null;
    extra = `<div class="grid2">
      <div class="tile"><span class="num">${goal?fTime(goal):"–"}</span><span class="lab">${goal?`objetivo · ${fPace(goal/km)}/km`:"pon un tiempo objetivo"}</span></div>
      <div class="tile"><span class="num">${pred?fTime(pred):"–"}</span><span class="lab">${pred?`predicción hoy · ${fPace(pred/km)}/km`:"sin marcas aún"}</span></div></div>
      ${goal&&pred?`<p class="small">${goal<pred?`Te faltan <b>${fTime(pred-goal)}</b> (${Math.round((pred-goal)/km)} s/km) para tu objetivo. Con ${wk} semanas es ${ (pred-goal)/km <= 12 ? "realista" : (pred-goal)/km <= 20 ? "exigente pero posible" : "muy ambicioso; quizá un objetivo intermedio"}.`:`Tu predicción actual ya está por debajo del objetivo: puedes subir la ambición.`}</p>`:""}
      <p class="note">Predicción con la fórmula de Riegel desde tu mejor ${refDist===10?"10K":"media"}; es un cálculo propio, no de Strava.</p>`;
  } else if(hib && (e.hyrox || /hyrox/i.test(e.nombre))){
    extra = hyroxBlock();
  } else if(hib){
    extra = `<div class="list">
      <div class="check"><span class="box">1</span><div class="small"><b>Revisa el reglamento:</b> estaciones, pesos de la categoría femenina y cómo se reparte el trabajo en parejas. Apúntalo en las notas.</div></div>
      <div class="check"><span class="box">2</span><div class="small"><b>Carrera comprometida</b> una vez por semana desde enero: 1 km + estación, repetido 4–6 veces.</div></div>
      <div class="check"><span class="box">3</span><div class="small"><b>Simulación con tu pareja</b> cada 2 semanas en febrero y marzo, y ensayad los relevos.</div></div>
      <div class="check"><span class="box">4</span><div class="small"><b>Registra en Marcas</b> remo, SkiErg, wall balls y burpees para ver tu progreso hacia el día.</div></div>
    </div>`;
  }
  return `<div class="card ev" style="--c:${hib?"var(--box)":"var(--run)"}">
    <div class="row between" style="align-items:flex-start;flex-wrap:nowrap"><div class="stack" style="gap:2px;min-width:0;flex:1"><span class="eyebrow">${hib?"Híbrida":"Carrera"} · ${DIAS[dow(parseISO(e.fecha))]} ${fDate(parseISO(e.fecha))} ${e.fecha.slice(0,4)}</span><h3 style="font-size:22px">${esc(e.nombre)}</h3>${e.notas?`<span class="small muted">${esc(e.notas)}</span>`:""}</div>
    <div class="cdbig"><span class="num">${d}</span><span class="lab">días</span></div></div>
    ${extra}
    <div class="row between">${hib && (e.hyrox || /hyrox/i.test(e.nombre)) ? `<button class="addbtn" data-sheet="hyrox">Planificar la carrera</button>` : (!hib && Math.abs(km-21.1)<0.3) ? `<button class="addbtn" data-sheet="hmplan">Plan de carrera por km</button>` : "<span></span>"}${delBtn(e.id)}</div>
  </div>`;
}
function vObjetivos(){
  const ev = futuros(), ps = phases(), cp = currentPhase();
  const sugs = SUG.filter(s => !eventos().some(e=>e.nombre===s.nombre));
  const past = eventos().filter(e=>e.fecha<today());
  const gap = ev.length>1 ? daysBetween(parseISO(ev[0].fecha), parseISO(ev[1].fecha)) : null;
  return `
  <div class="row between"><h2>Competiciones</h2><button class="addbtn" data-sheet="evento">+ Competición</button></div>
  ${!ev.length?`<div class="card"><p class="small">Añade tus próximas pruebas y la app organiza las semanas hasta ellas.</p></div>`:""}
  ${sugs.length?`<div class="card"><h3>Añadir rápido</h3><div class="stack" style="gap:8px">${sugs.map(s=>`<button type="button" class="sugbtn" data-sug="${esc(s.nombre)}"><b>${esc(s.nombre)}</b><span class="muted small">${DIAS[dow(parseISO(s.fecha))]} ${fDate(parseISO(s.fecha))} ${s.fecha.slice(0,4)}</span></button>`).join("")}</div><p class="note">Comprueba la fecha en la web oficial; se puede borrar y volver a crear.</p></div>`:""}
  ${ev.map(eventCard).join("")}
  ${ps.length?`<div class="card">
    <div class="row between"><h3>Camino hasta ${ev.length>1?"tus pruebas":"la prueba"}</h3>${cp?`<span class="pill" style="color:${cp.info.c}"><i class="dot" style="background:${cp.info.c}"></i>${cp.info.n}</span>`:""}</div>
    ${timelineSvg(ps)}
    <div class="list">${ps.map(p=>{ const now = cp && p.start.getTime()===cp.start.getTime(); return `<div class="check"><span class="dot" style="background:${PH[p.key].c};width:12px;height:12px;margin-top:4px"></span><div class="small"><b>${PH[p.key].n}</b> <span class="muted">${fDate(p.start)} – ${fDate(p.end)} · ${Math.max(1,Math.round((daysBetween(p.start,p.end)+1)/7))} sem</span>${now?` <span class="pill ok">ahora</span>`:""}<div class="muted">${PH[p.key].d} Tirada larga ${PH[p.key].long[0]}–${PH[p.key].long[1]} km.</div></div></div>`; }).join("")}</div>
    ${gap!=null && gap<=21?`<p class="small">Entre tus dos pruebas hay solo <b>${gap} días</b>. La híbrida deja las piernas cargadas (sobre todo si hay trineos, zancadas o wall balls), así que la media se prepara de verdad antes de marzo; después de la híbrida toca recuperar y afinar, no entrenar más.</p>`:""}
  </div>`:""}
  ${past.length?`<div class="card"><h3>Pasadas</h3><div class="list">${past.reverse().map(e=>`<div class="item"><span class="badge" style="background:var(--other)">${e.clase==="hibrida"?"HYB":"RUN"}</span><div style="min-width:0"><div class="t">${esc(e.nombre)}</div><div class="s">${fDate(parseISO(e.fecha))} ${e.fecha.slice(0,4)}</div></div>${delBtn(e.id)}</div>`).join("")}</div></div>`:""}`;
}

function vPlan(){
  const ss = allSessions(), m = monday(new Date());
  const wk = ss.filter(s=>daysBetween(m,s.date)>=0 && daysBetween(m,s.date)<7);
  const nBox = wk.filter(s=>s.cat==="box").length, runsWk = wk.filter(s=>s.cat==="run");
  const longWk = runsWk.reduce((x,r)=>Math.max(x,r.km),0);
  const k5 = bestEfforts()["5k"]?.t, p5 = k5 ? k5/5 : 298;
  const z2 = `${fPace(p5+100)}–${fPace(p5+65)}`, z4 = `${fPace(p5+35)}–${fPace(p5+15)}`;
  const hmP = hmGoalPace();
  const cp = currentPhase();
  const info = cp?.info || {n:"Mantenimiento", box:2, runs:2, d:"Sin competición a la vista: 2 box y 2 carreras."};
  const longKm = cp?.longKm || 12;
  const q = !cp ? `3 × 8 min a ${z4}/km con 2 min suaves`
    : cp.key==="base" ? `6–8 rectas de 20 s rápidas al final de una carrera suave`
    : cp.key==="construccion" ? `alterna: 3 × 10 min a ${z4}/km, o 5 × 1 km${hmP?` a ${fPace(hmP-10)}/km`:""} con 90 s suaves`
    : cp.key==="especifico" ? `${hmP?`2 × 5 km a ritmo objetivo de media (${fPace(hmP)}/km)`:"2 × 5 km a ritmo de media"} o simulación híbrida con tu pareja`
    : cp.key==="taper" ? `corta: 3 × 1 km${hmP?` a ${fPace(hmP)}/km`:" a ritmo de carrera"}`
    : `2 × 3 km${hmP?` a ${fPace(hmP)}/km`:" a ritmo de media"}`;
  const goals = [
    {k:"box", t:"Box / HIIT", n:info.box, done:nBox, d: cp && ["construccion","especifico"].includes(cp.key) ? "Una de ellas con estaciones híbridas (remo, SkiErg, wall balls, burpees, carries)." : "Tus sesiones habituales."},
    {k:"run", t:"Carrera suave (Z2)", n:1, done:Math.min(1,runsWk.length), d:`35–50 min a ${z2}/km. Debes poder hablar en frases completas.`},
    {k:"run", t:"Calidad", n:1, done:Math.min(1,Math.max(0,runsWk.length-1)), d:q[0].toUpperCase()+q.slice(1)+"."}
  ];
  const fp = footPrefs(), nF = fp.entreno.length + fp.partido.length;
  if(nF) goals.unshift({k:"futbol", t:"Fútbol", n:nF, done: wk.filter(s=>s.cat==="futbol").length, d:`${fp.entreno.length?`Entreno ${fp.entreno.map(i=>DIAS[i]).join(" y ")}`:""}${fp.entreno.length&&fp.partido.length?" · ":""}${fp.partido.length?`partido ${fp.partido.map(i=>DIAS[i]).join(" y ")}`:""}. Apúntalo al terminar.`});
  if(info.runs>=3) goals.push({k:"run", t:`Tirada larga · ${longKm} km`, n:1, done: longWk>=longKm*0.9?1:0, d:`Suave, ${z2}/km.${cp&&cp.key==="especifico"&&hmP?` Los últimos 4–5 km a ${fPace(hmP)}/km.`:""} Esta semana tu más larga: ${longWk?longWk.toFixed(1)+" km":"ninguna aún"}.`});
  return `
  ${countdownStrip()}
  <div class="card">
    <div class="row between"><h2>Esta semana</h2><span class="pill" style="color:${cp?.info.c||"var(--muted)"}"><i class="dot" style="background:${cp?.info.c||"var(--muted)"}"></i>${info.n}</span></div>
    <p class="small muted">${info.d}</p>
    <div class="list">${goals.map(g=>{ const ok = g.done>=g.n; return `<div class="check"><span class="box ${ok?"done":""}">${ok?"✓":""}</span><div><div class="row" style="gap:6px"><i class="dot" style="background:${COL[g.k]}"></i><b>${g.t}</b><span class="muted small">${Math.min(g.done,g.n)}/${g.n}</span></div><div class="small muted">${g.d}</div></div></div>`; }).join("")}</div>
    <p class="note">Se marca solo con lo que entra de Strava. Ritmos estimados a partir de tu mejor 5K${hmP?" y tu objetivo de media":""}. Deja al menos un día de descanso completo.</p>
  </div>
  ${!futuros().length?`<div class="banner info">Añade tus competiciones en <a href="#objetivos">Objetivos</a> y el plan se adapta a cada fase.</div>`:""}
  <div class="card">
    <h3>Pregunta a Claude</h3>
    <p class="note">Copia un resumen de tus datos (entrenos, WODs, marcas y competiciones) y pégalo en un chat con Claude junto a tu pregunta.</p>
    <button class="primary" type="button" data-act="copy">Copiar resumen de mis datos</button>
    <textarea id="copyArea" readonly hidden style="min-height:120px"></textarea>
  </div>`;
}

function vAjustes(){
  const conn = !!S.tok;
  return `
  ${S.athlete ? `<div class="profile"><span class="avatar big">${avatar()}</span><div><h2 style="text-transform:none">${esc((S.athlete.firstname||"")+" "+(S.athlete.lastname||""))}</h2><span class="small muted">${esc([S.athlete.city, S.athlete.country].filter(Boolean).join(", "))}</span></div></div>` : ""}
  ${themeCard()}
  <div class="card">
    <div class="row between"><h2>Strava</h2><span class="pill ${conn?"ok":""}">${conn?`<i class="dot" style="background:var(--ok)"></i>Conectado${S.athlete?.firstname?" · "+esc(S.athlete.firstname):""}`:"Sin conectar"}</span></div>
    ${S.err.strava?`<div class="banner bad">${esc(S.err.strava.message||"Error con Strava")}</div>`:""}
    <details ${S.cfg.clientId?"":"open"}><summary>Cómo obtener el Client ID y el Secret (una vez)</summary>
      <ol class="small" style="padding-left:18px;display:flex;flex-direction:column;gap:6px;margin:10px 0 0">
        <li>Entra en <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener">strava.com/settings/api</a> desde el ordenador.</li>
        <li>Crea una aplicación: nombre «Cuaderno de Entreno», categoría «Training», web <span class="num">${esc(location.origin)}</span>.</li>
        <li>En <b>Authorization Callback Domain</b> escribe exactamente: <span class="num" style="font-size:16px">${esc(location.hostname)}</span></li>
        <li>Copia aquí el <b>Client ID</b> y el <b>Client Secret</b>.</li>
      </ol>
    </details>
    <form data-form="strava">
      <div class="grid2">${field("cfg_id","Client ID",`<input id="cfg_id" name="clientId" inputmode="numeric" autocomplete="off" value="${esc(S.cfg.clientId||"")}" required>`)}
      ${field("cfg_sec","Client Secret",`<input id="cfg_sec" name="clientSecret" type="password" autocomplete="off" value="${esc(S.cfg.clientSecret||"")}" required>`)}</div>
      <div class="row"><button class="primary" type="submit">${conn?"Volver a conectar":"Conectar con Strava"}</button>
      ${conn?`<button type="button" data-act="refresh">${S.busy.strava?"Actualizando…":"Actualizar ahora"}</button><button type="button" class="ghost danger" data-act="logout">Desconectar</button>`:""}</div>
    </form>
    <p class="note">${conn?"La conexión se renueva sola: no tendrás que volver a conectar salvo que pulses Desconectar o quites el acceso desde Strava. ":""}${S.cfg.ghToken?"Con la sincronización activa, tus otros dispositivos se conectan solos (las claves viajan cifradas en tu Gist secreto). ":"El Client Secret y tus tokens se guardan en este dispositivo. "}${S.stravaAt?`Última actualización: ${fDate(new Date(S.stravaAt))} ${fClock(S.stravaAt)} · ${S.acts.length} actividades.`:""}</p>
  </div>
  <div class="card">
    <div class="row between"><h2>Sincronización</h2><span class="pill ${S.cfg.ghToken&&!S.err.sync?"ok":""}">${S.cfg.ghToken?(S.err.sync?"Error":`<i class="dot" style="background:var(--ok)"></i>Activa`):"Desactivada"}</span></div>
    <p class="small">Tus WODs, marcas y competiciones se guardan en un <b>Gist secreto</b> de tu cuenta de GitHub. Así los ves igual en el móvil y en el ordenador. También guarda la conexión con Strava (cifrada), así que en un dispositivo nuevo solo necesitas pegar este token.</p>
    ${S.err.sync?`<div class="banner bad">${esc(S.err.sync.message||"Error al sincronizar")}</div>`:""}
    <details ${S.cfg.ghToken?"":"open"}><summary>Cómo crear el token (una vez)</summary>
      <ol class="small" style="padding-left:18px;display:flex;flex-direction:column;gap:6px;margin:10px 0 0">
        <li>Abre <a href="https://github.com/settings/tokens/new?scopes=gist&description=Cuaderno%20de%20Entreno" target="_blank" rel="noopener">este enlace</a> (ya marca solo el permiso «gist»).</li>
        <li>En «Expiration» elige <b>«No expiration»</b> para que la app no se desconecte nunca, y pulsa «Generate token».</li>
        <li>Copia el token (empieza por <span class="num">ghp_</span>) y pégalo aquí. Haz lo mismo en cada dispositivo (puedes reutilizar el mismo token).</li>
      </ol>
    </details>
    <form data-form="gh">
      ${field("cfg_gh","Token de GitHub",`<input id="cfg_gh" name="ghToken" type="password" autocomplete="off" value="${esc(S.cfg.ghToken||"")}" required>`)}
      <div class="row"><button class="primary" type="submit">Guardar y sincronizar</button>
      ${S.cfg.ghToken?`<button type="button" data-act="sync">${S.busy.sync?"Sincronizando…":"Sincronizar ahora"}</button><button type="button" class="ghost danger" data-act="ghoff">Desactivar</button>`:""}</div>
    </form>
    <p class="note">${S.syncAt?`Última sincronización: ${fDate(new Date(S.syncAt))} ${fClock(S.syncAt)}. `:""}Se sincroniza al abrir la app, al volver a ella y cada vez que guardas.${S.cfg.gistId?` <a href="https://gist.github.com/${esc(S.cfg.gistId)}" target="_blank" rel="noopener">Ver el Gist</a>`:""}</p>
  </div>
  <div class="card">
    <h3>Copia de seguridad</h3>
    <div class="row"><button type="button" data-act="export">Exportar registros (.json)</button>
    <label class="ghost" style="flex-direction:row;align-items:center;gap:8px;cursor:pointer;border:1px solid var(--line);border-radius:10px;padding:10px 14px;color:var(--fg);font-size:15px">Importar<input id="importFile" type="file" accept="application/json,.json" hidden></label></div>
    <p class="note">${logs().length} registros guardados.</p>
  </div>`;
}

function summaryText(){
  const ss = allSessions().filter(s=>daysBetween(s.date,new Date())<120).slice(0,60);
  const b = bestEfforts();
  const lines = [];
  lines.push(`Eres mi entrenador/a de carrera y CrossFit/Hyrox. Estos son mis datos (Strava + mis registros), a ${today()}:`);
  lines.push(`\nMARCAS: ${Object.entries(b).map(([k,v])=>`${BE[k][0]} ${fTime(v.t)} (${v.d.slice(0,10)})`).join("; ")||"–"}`);
  lines.push(`\nSESIONES ÚLTIMOS 120 DÍAS (fecha hora · tipo · nombre · min · km · ritmo · ppm):`);
  ss.forEach(s=>lines.push(`${iso(s.date)} ${pad(s.date.getHours())}:${pad(s.date.getMinutes())} · ${s.cat} · ${s.name} · ${Math.round(s.min)}′${s.km?` · ${s.km.toFixed(1)} km`:""}${s.pace?` · ${fPace(s.pace)}/km`:""}${s.hr?` · ${Math.round(s.hr)} ppm`:""}`));
  const w = logs().filter(l=>l.tipo==="wod").slice(-15);
  if(w.length){ lines.push(`\nWODs:`); w.forEach(l=>lines.push(`${l.fecha} · ${l.nombre} (${l.formato}) · ${l.resultado||"–"} ${l.rx||""} · RPE ${l.rpe||"–"}${l.texto?` · ${l.texto.replace(/\s+/g," ").slice(0,200)}`:""}`)); }
  const mk = logs().filter(l=>l.tipo==="marca");
  if(mk.length){ lines.push(`\nMARCAS BOX:`); mk.forEach(l=>lines.push(`${l.fecha} · ${l.ejercicio}: ${l.valor} ${l.unidad}${l.nota?` (${l.nota})`:""}`)); }
  const fu = logs().filter(l=>l.tipo==="futbol").slice(-10);
  if(fu.length){ lines.push(`\nFÚTBOL:`); fu.forEach(l=>lines.push(`${l.fecha} · ${l.formato} · ${l.minutos}′ · esfuerzo ${l.rpe||"–"}${l.notas?` · ${l.notas}`:""}`)); }
  const ev = futuros();
  if(ev.length){ lines.push(`\nCOMPETICIONES:`); ev.forEach(e=>lines.push(`${e.fecha} · ${e.nombre} (${e.clase})${e.objetivo?` · objetivo ${e.objetivo}`:""}${e.notas?` · ${e.notas}`:""}`)); }
  const cp = currentPhase(); if(cp) lines.push(`Fase actual del plan: ${cp.info.n} (${fDate(cp.start)}–${fDate(cp.end)})`);
  lines.push(`\nMI PREGUNTA: `);
  return lines.join("\n");
}

/* =========================================================
   RENDER
   ========================================================= */
function current(){ const h = (location.hash||"").slice(1); return VIEWS.includes(h)? h : "resumen"; }
let renderBusy = false;
function render(){
  if(renderBusy) return; renderBusy = true;
  try{ renderNow(); } finally { renderBusy = false; }
}
function renderNow(){
  const v = current();
  document.querySelectorAll("nav.tabs a").forEach(a=>a.setAttribute("aria-current", a.dataset.v===v?"page":"false"));
  const titles = {resumen:"Inicio",correr:"Correr",box:"Box",futbol:"Fútbol",objetivos:"Objetivos",plan:"Plan",ajustes:"Ajustes"};
  const sub = ["objetivos","plan","ajustes"].includes(v);
  $("#hdrTitle").textContent = v==="resumen" ? `${greet()}${S.athlete?.firstname?", "+S.athlete.firstname:""}` : titles[v];
  $("#hdrEyebrow").textContent = v==="resumen" ? `${DIAS[dow(new Date())]} ${fDate(new Date())}` : sub ? "" : "Cuaderno de entreno";
  $("#back").hidden = !sub; $("#cbarTitle").textContent = v==="resumen" ? "Inicio" : titles[v];
  document.querySelectorAll("nav.tabs a").forEach(a=>{ if(sub && a.dataset.v==="resumen" && v!=="ajustes") a.setAttribute("aria-current","page"); });
  const onb = $("#onb"); if(!S.tok && !LS.get("onb", false)){ onb.innerHTML = onbOverlay(); onb.hidden = false; } else { onb.hidden = true; onb.innerHTML = ""; }
  const app = $("#app"); const sameView = app.dataset.v===v;
  const NAV = ["resumen","correr","box","futbol","objetivos","plan","ajustes"], dir = sameView ? "" : (NAV.indexOf(v) >= NAV.indexOf(app.dataset.v||"resumen") ? "from-right" : "from-left");
  if(sameView) app.querySelectorAll("input[id],select[id],textarea[id]").forEach(el=>{ if(el.type!=="file") S.form[el.id]=el.value; });
  else S.form = {};
  const focusId = document.activeElement?.id;
  app.innerHTML = `<div class="stack ${sameView?"":"view "+dir}">${({resumen:vResumen,correr:vCorrer,box:vBox,futbol:vFutbol,objetivos:vObjetivos,plan:vPlan,ajustes:vAjustes})[v]()}</div>`;
  app.dataset.v = v;
  if(v==="correr") setTimeout(mountRoutes, 0);
  if(!sameView) countUp(app);
  decorateNotes(app);
  if(sameView){ app.querySelectorAll("input[id],select[id],textarea[id]").forEach(el=>{ if(S.form[el.id]!=null && el.type!=="file") el.value=S.form[el.id]; }); if(focusId){ const f=document.getElementById(focusId); if(f) f.focus({preventScroll:true}); } }
  renderStatus();
}
function renderStatus(){
  const st = $("#status"); const parts = [];
  if(S.busy.strava || S.busy.sync) parts.push(`<span class="dot" style="background:var(--warn)"></span>Actualizando…`);
  else if(S.err.strava || S.err.sync) parts.push(`<span class="dot" style="background:var(--bad)"></span>Revisa Ajustes`);
  else if(S.stravaAt) parts.push(`<span class="dot" style="background:var(--ok)"></span>${fClock(S.stravaAt)}`);
  st.innerHTML = parts.join("") + ` <a href="#ajustes" class="avatar" aria-label="Perfil y ajustes">${avatar()}</a>`;
}
function toast(m){ const t=$("#toast"); t.textContent=m; t.hidden=false; clearTimeout(toast.t); toast.t=setTimeout(()=>t.hidden=true, 2600); }

/* =========================================================
   EVENTOS
   ========================================================= */
window.addEventListener("hashchange", ()=>{ window.scrollTo(0,0); S.confirmDel=null; render(); });
document.addEventListener("click", async e=>{
  if(Date.now()-swipedAt < 400 && e.target.closest("[data-flip]")) return;   // fue un deslizamiento, no un toque
  if(e.target.closest("[data-close]")){ closeSheet(); return; }
  const inSheet = !!e.target.closest("#sheet");
  const d = e.target.closest("[data-del]");
  if(d){ const id=d.dataset.del; if(!id){ S.confirmDel=null; render(); renderSheet(); return; }
    if(d.dataset.sure){ delRec(id); S.confirmDel=null; toast("Borrado"); if(inSheet) closeSheet(); } else S.confirmDel=id;
    render(); if(inSheet && S.confirmDel) renderSheet(); return; }
  const ckb = e.target.closest("[data-ck]");
  if(ckb){ haptic(); upsertRec("ck-"+today(), {tipo:"checkin", fecha:today(), [ckb.dataset.ck]: ckb.dataset.v});
    if(ckb.dataset.ck==="sintoma" && ckb.dataset.v==="si") toast("Hoy toca descansar. Si se repite, coméntaselo a tu médico."); render(); return; }
  const hxb = e.target.closest("[data-hx]");
  if(hxb){ const h = hxGet(), d = +hxb.dataset.d, k = hxb.dataset.hx;
    if(k==="pace") h.pace = Math.max(240, Math.min(480, h.pace + d));
    if(k==="rox") h.rox = Math.max(0.3, Math.min(3, Math.round((h.rox + d)*10)/10));
    if(k==="min"){ const s0 = h.st[+hxb.dataset.i]; s0.min = Math.max(0.5, Math.min(15, Math.round((s0.min + d)*10)/10)); }
    haptic(); hxUpdate(); return; }
  const hs = e.target.closest("[data-hmstrat]");
  if(hs){ const g = document.getElementById("hm_goal"); if(g) S.hmGoal = parseTime(g.value) || S.hmGoal; S.hmStrat = hs.dataset.hmstrat; renderSheet(); return; }
  const sh = e.target.closest("[data-sheet]");
  if(sh){ const k = sh.dataset.sheet; openSheet(k, k==="marca" && sh.dataset.ej ? {ejercicio:sh.dataset.ej, unidad:sh.dataset.un} : k==="futbol" ? {formato: sh.dataset.fmt || footRole(dow(new Date())) || "partido"} : null); return; }
  const fa = e.target.closest("[data-fask]");
  if(fa){ answerFoot(fa.dataset.fask==="si", fa.dataset.f, fa.dataset.r); return; }
  const th = e.target.closest("[data-theme-set]");
  if(th){ LS.set("theme", th.dataset.themeSet); applyTheme(); haptic(); render(); return; }
  const fu = e.target.closest("[data-fut]");
  if(fu){ openSheet("futDetail", fu.dataset.fut); return; }
  const fd = e.target.closest("[data-footday]");
  if(fd){ haptic(); cycleFootDay(+fd.dataset.footday); render(); return; }
  const rn = e.target.closest("[data-run]");
  if(rn){ e.preventDefault(); openRun(rn.dataset.run); return; }
  const wd = e.target.closest("[data-wod]");
  if(wd){ S.detBack = false; openSheet("wodDetail", wd.dataset.wod); return; }
  const mk = e.target.closest("[data-marca]");
  if(mk){ openSheet("marcaDetail", mk.dataset.marca); return; }
  const ms = e.target.closest("[data-mus]");
  if(ms && !inSheet){ S.selMus = S.selMus===ms.dataset.mus ? null : ms.dataset.mus; render(); return; }
  const dy = e.target.closest("[data-days]");
  if(dy){ S.bodyDays = +dy.dataset.days; render(); return; }
  const sg = e.target.closest("[data-sug]");
  if(sg){ const x = SUG.find(v=>v.nombre===sg.dataset.sug); if(x){ addRec({tipo:"evento", ...x}); toast("Competición añadida"); render(); } return; }
  const bs = e.target.closest("[data-bulk-save]");
  if(bs){ const i = +bs.dataset.bulkSave, it = S.bulk?.items[i], inp = document.getElementById("bk_"+i);
    if(it && inp && inp.value){ it.w.fecha = inp.value; addRec(wodFromParsed(it.w)); it.st = "ok"; it.match = !!boxSessionOn(inp.value); S.bulk.saved++; toast("WOD guardado"); render(); }
    else if(inp) inp.focus(); return; }
  const oc = e.target.closest("[data-ocr-url]");
  if(oc){ ocrRead(oc.dataset.ocrUrl, true, oc.dataset.date); return; }
  const a = e.target.closest("[data-act]"); if(!a) return;
  const act = a.dataset.act;
  if(act==="flip"){ S.bodyBack = !S.bodyBack; const c = a.closest(".bodycard"); c.querySelector(".flip-in").classList.toggle("back", S.bodyBack); a.lastChild.textContent = S.bodyBack ? "Ver de frente" : "Ver de espaldas"; return; }
  if(act==="flipd"){ S.detBack = !S.detBack; $("#sheet .flip-in").classList.toggle("back", S.detBack); return; }
  if(act==="mus-clear"){ S.selMus = null; render(); return; }
  if(act==="wodall"){ S.wodAll = !S.wodAll; render(); return; }
  if(act==="runall"){ S.runAll = !S.runAll; render(); return; }
  if(act==="recalc"){ if(S.recalc) return; S.recalc = true; S.acts.filter(x=>catOf(x.sport||"")==="run").forEach(x=>{ if(S.det[x.id]) S.det[x.id].v = 1; }); render();
    fetchDetails().then(()=>{ S.recalc = false; render(); toast(S.err.det || "Marcas recalculadas"); delete S.err.det; }); return; }
  if(act==="futall"){ S.futAll = !S.futAll; render(); return; }
  if(act==="close"){ closeSheet(); return; }
  if(act==="mic"){ micToggle(); return; }
  if(act==="vparse"){ S.voice = {text: document.getElementById("vtext")?.value || "", on:false}; renderSheet(); return; }
  if(act==="vuse"){ const txt = document.getElementById("vtext")?.value || S.voice?.text || ""; const pv = parseVoice(txt); S.voice = null; haptic(); openSheet(pv.kind, pv.p); return; }
  if(act==="dofill"){ const y = iso(addDays(new Date(), -1)), T = footTimes(), list = fillPlan(S.fillFrom || "2026-09-07", y, S.fillE!==false, !!S.fillP);
    list.forEach(x=>addRec({tipo:"futbol", fecha:x.fecha, formato:x.role, minutos:String(T[x.role].d), rpe:"7", origen:"relleno"}, true));
    LS.set("recs", S.recs); schedulePush(); haptic(); toast(`${list.length} sesiones de fútbol creadas`); closeSheet(); render(); return; }
  if(act==="back"){ if(history.length>1) history.back(); else location.hash = "resumen"; return; }
  if(act==="onbnext"){ S.onbI = (S.onbI||0)+1; if(S.onbI>=ONB.length){ LS.set("onb", true); location.hash = "ajustes"; } render(); return; }
  if(act==="onbskip"){ LS.set("onb", true); render(); return; }
  if(act==="notes"){ e.preventDefault(); const card = a.closest(".card, .today"); card.classList.toggle("notes-on"); S.notesOpen = S.notesOpen || new Set(); const key = a.parentElement.textContent.replace(/i$/,""); card.classList.contains("notes-on") ? S.notesOpen.add(key) : S.notesOpen.delete(key); return; }
  if(act==="story"){ weekStory(); return; }
  if(act==="hxsave"){ upsertRec("hyrox-plan", {tipo:"hyroxplan", fecha:today(), json:JSON.stringify(S.hx)}); haptic(); toast("Plan HYROX guardado"); closeSheet(); return; }
  if(act==="hmsave"){ const ev = futuros().find(x=>x.clase==="carrera" && Math.abs((+String(x.km).replace(",", "."))-21.1)<0.3); const g = parseTime(document.getElementById("hm_goal")?.value);
    if(ev && g){ upsertRec(ev.id, {objetivo: fTime(g)}); haptic(); toast("Objetivo guardado: "+fTime(g)); closeSheet(); render(); } return; }
  if(act==="bulkclose"){ S.bulk = null; render(); return; }
  if(act==="refresh") syncStrava(true);
  if(act==="sync") syncGist();
  if(act==="sug-marca"){ const f = S.ocr?.parsed?.fuerza; if(f){ addRec({tipo:"marca", ejercicio:f.ejercicio, valor:String(f.kg), unidad:"kg", fecha:S.ocr.parsed.fecha||today(), nota:`${f.series}×${f.reps}${f.pct?` al ${f.pct} %`:""} · 1RM est. ${Math.round(f.rm)} kg`}); S.ocr.parsed.fuerza = null; a.closest(".banner")?.remove(); toast("Marca guardada"); render(); } }
  if(act==="logout"){ S.tok=null; LS.del("stravaTok"); if(S.cfg.ghToken){ wipeCred=true; LS.set("wipeCred", true); syncGist(true); } toast("Strava desconectado en todos tus dispositivos"); render(); }
  if(act==="ghoff"){ delete S.cfg.ghToken; delete S.cfg.gistId; saveCfg(); render(); }
  if(act==="export"){ const blob = new Blob([JSON.stringify({v:1, registros:S.recs}, null, 1)], {type:"application/json"}); const u = URL.createObjectURL(blob); const l = document.createElement("a"); l.href=u; l.download=`cuaderno-entreno-${today()}.json`; document.body.appendChild(l); l.click(); l.remove(); setTimeout(()=>URL.revokeObjectURL(u), 2000); }
  if(act==="copy"){ const txt = summaryText(); try{ await navigator.clipboard.writeText(txt); toast("Copiado. Pégalo en Claude y añade tu pregunta."); }catch(err){ const ta=$("#copyArea"); ta.hidden=false; ta.value=txt; ta.select(); toast("Selecciona y copia el texto"); } }
});
document.addEventListener("change", async e=>{
  if(e.target.id==="ocrFile" && e.target.files[0]){ const f = e.target.files[0]; e.target.value = ""; closeSheet(); ocrRead(f, false); return; }
  if(e.target.id==="bulkFiles" && e.target.files.length){ const fs = [...e.target.files]; e.target.value = ""; closeSheet(); if(location.hash!=="#box") location.hash = "box"; bulkImport(fs); return; }
  if(e.target.id==="calc_ex"){ S.calcEx = e.target.value; render(); return; }
  if(e.target.id==="ff_from"){ S.fillFrom = e.target.value; renderSheet(); return; }
  if(e.target.id==="ff_e"){ S.fillE = e.target.checked; renderSheet(); return; }
  if(e.target.id==="ff_p"){ S.fillP = e.target.checked; renderSheet(); return; }
  if(e.target.dataset.ftime || e.target.dataset.fdur){ const k = e.target.dataset.ftime || e.target.dataset.fdur, p = footPrefs(), T = footTimes();
    if(e.target.dataset.ftime) T[k].h = e.target.value; else T[k].d = Math.max(15, Math.min(180, +e.target.value||T[k].d));
    upsertRec("pref-futbol", {tipo:"pref", fecha:today(), entreno:p.entreno.join(","), partido:p.partido.join(","), hEntreno:T.entreno.h, dEntreno:String(T.entreno.d), hPartido:T.partido.h, dPartido:String(T.partido.d)}); toast("Horario guardado"); return; }
  if(e.target.id==="hm_goal"){ const g = parseTime(e.target.value); if(g && g>3600 && g<14400 && g!==S.hmGoal){ S.hmGoal = g; setTimeout(renderSheet, 0); } return; }
  if(e.target.dataset.acc){ const r = S.recs.find(x=>x.id===e.target.dataset.acc); if(r){ r.accHecho = e.target.checked ? "1" : ""; r.mod = Date.now(); LS.set("recs", S.recs); schedulePush(); render(); toast(e.target.checked ? "Accesorios hechos" : "Accesorios sin hacer"); } return; }
  if(e.target.id!=="importFile" || !e.target.files[0]) return;
  try{ const j = JSON.parse(await e.target.files[0].text()); const rs = (j.registros||[]).filter(r=>r && r.id && r.tipo);
    S.recs = merge(S.recs, rs); LS.set("recs", S.recs); schedulePush(); toast(`${rs.length} registros importados`); render(); }
  catch(err){ toast("Ese archivo no es una copia válida"); }
});
document.addEventListener("submit", e=>{
  const f = e.target.closest("form[data-form]"); if(!f) return;
  e.preventDefault();
  const kind = f.dataset.form, data = Object.fromEntries(new FormData(f).entries());
  if(kind==="strava"){ wipeCred=false; LS.set("wipeCred", false); S.cfg.clientId = data.clientId.trim(); S.cfg.clientSecret = data.clientSecret.trim(); saveCfg(); location.href = stravaAuthUrl(); return; }
  if(kind==="gh"){ S.cfg.ghToken = data.ghToken.trim(); delete S.cfg.gistId; saveCfg(); delete S.err.sync; syncGist().then(()=>{ if(!S.err.sync) toast("Sincronización activada"); }); render(); return; }
  if(kind==="wod"){ const st = boxSessionOn(data.fecha); data.stravaId = st ? st.id : ""; data.accHecho = data.accHecho ? "1" : ""; }
  if(kind==="futbol" && data.id){ const id = data.id; delete data.id; upsertRec(id, {tipo:"futbol", ...data}); }
  else addRec({tipo:kind, ...data});
  if(kind==="wod") S.ocr = null;
  f.querySelectorAll("input[id],textarea[id],select[id]").forEach(el=>{ delete S.form[el.id]; });
  if(f.closest("#sheet")) closeSheet();
  haptic(); toast(kind==="wod" ? "WOD guardado" : kind==="evento" ? "Competición guardada" : kind==="futbol" ? "Fútbol guardado" : "Guardado"); render();
});
document.addEventListener("input", e=>{
  if(e.target.id==="f_rpe"){ const o = document.getElementById("f_rpe_v"); if(o) o.textContent = e.target.value+"/10"; }
  if(e.target.dataset && e.target.dataset.hxpct!=null){ const h = hxGet(); h.st[+e.target.dataset.hxpct].pct = +e.target.value; hxUpdate(); }
});
// Deslizar entre pestañas
let tX = null, tY = null, tOk = false;
document.addEventListener("touchstart", e=>{ const t = e.touches[0]; tX = t.clientX; tY = t.clientY;
  tOk = !!e.target.closest("#app") && !e.target.closest(".leaflet-container,.thumbs,.scroll,input,textarea,select,[data-flip],.hxst,.cal"); }, {passive:true});
document.addEventListener("touchend", e=>{ if(!tOk || tX==null) return; const t = e.changedTouches[0], dx = t.clientX - tX, dy = t.clientY - tY; tX = null;
  if(Math.abs(dx) > 80 && Math.abs(dy) < 50 && $("#sheet").hidden){ const tabs = ["resumen","correr","box","futbol"], i = tabs.indexOf(current()); const j = i + (dx<0 ? 1 : -1);
    if(i>=0 && j>=0 && j<tabs.length){ haptic(); location.hash = tabs[j]; } } }, {passive:true});
// Tirar hacia abajo para actualizar
let pY = null, pD = 0;
document.addEventListener("touchstart", e=>{ pY = (window.scrollY<=0 && $("#sheet").hidden && e.target.closest("#app")) ? e.touches[0].clientY : null; pD = 0; }, {passive:true});
document.addEventListener("touchmove", e=>{ if(pY==null) return; pD = Math.max(0, e.touches[0].clientY - pY); const ptr = $("#ptr"); ptr.style.transform = `translate(-50%, ${Math.min(80, pD*.5)}px) rotate(${pD*2}deg)`; ptr.style.opacity = Math.min(1, pD/90); }, {passive:true});
document.addEventListener("touchend", ()=>{ if(pY==null) return; const ptr = $("#ptr"); pY = null;
  if(pD > 110){ ptr.classList.add("spin"); haptic(); Promise.all([syncStrava(false), syncGist()]).finally(()=>{ ptr.classList.remove("spin"); ptr.style.opacity = 0; ptr.style.transform = "translate(-50%,0)"; toast("Actualizado"); }); }
  else { ptr.style.opacity = 0; ptr.style.transform = "translate(-50%,0)"; } pD = 0; }, {passive:true});
// Arrastrar el panel hacia abajo para cerrarlo
let sY = null, sD = 0;
document.addEventListener("touchstart", e=>{ const p = e.target.closest(".sheet-panel"); sY = p && p.scrollTop<=0 && !e.target.closest("input,textarea,select,.leaflet-container,input[type=range]") ? e.touches[0].clientY : null; sD = 0; }, {passive:true});
document.addEventListener("touchmove", e=>{ if(sY==null) return; sD = Math.max(0, e.touches[0].clientY - sY); const p = $(".sheet-panel"); p.style.transition = "none"; p.style.transform = `translateY(${sD}px)`; }, {passive:true});
document.addEventListener("touchend", ()=>{ if(sY==null) return; const p = $(".sheet-panel"); p.style.transition = ""; p.style.transform = ""; if(sD > 110) closeSheet(); sY = null; sD = 0; }, {passive:true});
// Cabecera compacta al hacer scroll
window.addEventListener("scroll", ()=>{ document.body.classList.toggle("scrolled", window.scrollY > 56); }, {passive:true});
document.addEventListener("keydown", e=>{ if(e.key==="Escape") closeSheet(); if((e.key==="Enter"||e.key===" ") && e.target.matches("[data-mus]")){ e.preventDefault(); e.target.click(); } });
// Girar el cuerpo deslizando el dedo
let swipeX = null, swipedAt = 0;
document.addEventListener("pointerdown", e=>{ if(e.target.closest("[data-flip]")) swipeX = e.clientX; });
document.addEventListener("pointerup", e=>{ if(swipeX==null) return; const dx = e.clientX - swipeX; swipeX = null;
  if(Math.abs(dx) > 40){ swipedAt = Date.now(); const inS = !!e.target.closest("#sheet"); const b = inS ? $('#sheet [data-act="flipd"]') : $('.bodycard [data-act="flip"]'); b && b.click(); } });
document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState==="visible"){ syncGist(); if(!S.stravaAt || Date.now()-S.stravaAt > 10*60*1000) syncStrava(false); } });
setInterval(()=>{ if(document.visibilityState==="visible") syncGist(); }, 60*1000);

/* ---------- arranque ---------- */
if(migrate()){ LS.set("recs", S.recs); schedulePush(); }
applyTheme();
render();
(async ()=>{
  await handleOAuthReturn();
  render();
  syncGist();
  const needFull = S.acts.length && S.acts.some(a=>a.poly===undefined);   // versión nueva: hace falta la ruta de cada actividad
  if(S.tok && (needFull || !S.stravaAt || Date.now()-S.stravaAt > 5*60*1000)) syncStrava(needFull);
})();
// Pide al navegador que no borre los datos de la app por falta de espacio
if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{});
if("serviceWorker" in navigator && location.protocol==="https:") navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
