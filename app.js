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

const VIEWS = ["resumen","correr","box","objetivos","plan","ajustes"];
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
    watts:a.average_watts||null, kj:a.kilojoules||null, trainer:!!a.trainer, race:a.workout_type===1, photos:a.total_photo_count||0 };
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
  const runs = S.acts.filter(a => catOf(a.sport||"")==="run" && !S.det[a.id]);
  const rest = S.acts.filter(a => catOf(a.sport||"")!=="run" && !S.det[a.id] && daysBetween(localDate(a.start), now)<120);
  const pending = [...runs, ...rest].slice(0,40);
  let n = 0;
  for(const a of pending){
    try{
      const d = await api("/activities/"+a.id);
      S.det[a.id] = { cal: d.calories||0, desc: (d.description||"").slice(0,500), be: (d.best_efforts||[]).map(b=>({n:b.name, t:b.elapsed_time, d:b.start_date_local})) };
      if(++n % 5 === 0){ LS.set("det", S.det); render(); }
    }catch(e){ if(e.code==="rate") break; }
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
    S.recs = merged; LS.set("recs", S.recs);
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
  }).filter(s=>s.cat!=="walk").sort((a,b)=>b.date-a.date);   // senderismo y caminatas fuera
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
  S.acts.filter(a=>catOf(a.sport||"")==="run").forEach(a => (S.det[a.id]?.be||[]).forEach(b => {
    const k = String(b.n).toLowerCase(); if(BE[k]) put(k, {t:b.t, d:b.d, act:a.name, id:a.id, src:"strava"});
  }));
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
  {nombre:"Hybrid Madrid Open · Femenino parejas", fecha:"2027-03-21", clase:"hibrida", km:"", objetivo:"", notas:""},
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
function paceChart(runs){
  const pts = runs.filter(r=>r.pace && r.km>=3 && r.pace<480 && daysBetween(r.date,new Date())<400).sort((a,b)=>a.date-b.date);
  if(pts.length<2) return `<p class="muted small">Aún no hay suficientes carreras para la tendencia.</p>`;
  const W=400,H=210,pl=40,pr=12,pt=14,pb=26;
  const t0=pts[0].date.getTime(), t1=pts[pts.length-1].date.getTime();
  let lo=Math.min(...pts.map(p=>p.pace)), hi=Math.max(...pts.map(p=>p.pace));
  lo=Math.floor((lo-5)/15)*15; hi=Math.ceil((hi+5)/15)*15;
  const x=t=>pl+(W-pl-pr)*((t-t0)/Math.max(1,t1-t0)), y=p=>pt+(H-pt-pb)*((p-lo)/(hi-lo));
  const rmax = Math.max(...pts.map(p=>p.km));
  let g="";
  for(let v=lo; v<=hi; v+=15){ g+=`<line x1="${pl}" x2="${W-pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pl-6}" y="${y(v)+3}" text-anchor="end">${fPace(v)}</text>`; }
  const months = new Set(); let lastX=-99;
  pts.forEach(p=>{ const k=p.date.getFullYear()*12+p.date.getMonth(); if(!months.has(k)){ months.add(k); const d=new Date(p.date.getFullYear(),p.date.getMonth(),1); const xx=x(d.getTime()); if(d.getTime()>=t0 && xx-lastX>26){ g+=`<text x="${xx}" y="${H-8}" text-anchor="middle">${MESES[d.getMonth()]}</text>`; lastX=xx; } } });
  g+=`<polyline fill="none" stroke="var(--run)" stroke-opacity=".35" stroke-width="2" points="${pts.map(p=>x(p.date.getTime())+","+y(p.pace)).join(" ")}"/>`;
  pts.forEach((p,i)=>{ const r = 3+5*(p.km/rmax); const last=i===pts.length-1; g+=`<circle cx="${x(p.date.getTime())}" cy="${y(p.pace)}" r="${r}" fill="var(--run)" fill-opacity="${last?1:.75}" stroke="var(--surface)" stroke-width="1.5"><title>${fDate(p.date)} · ${p.km.toFixed(1)} km · ${fPace(p.pace)}/km</title></circle>`; });
  const lp = pts[pts.length-1];
  g+=`<text x="${Math.min(W-pr-4,x(lp.date.getTime()))}" y="${y(lp.pace)-12}" text-anchor="end" style="fill:var(--fg);font-weight:600">${fPace(lp.pace)}/km</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Ritmo medio por carrera">${g}</svg><p class="muted small">Arriba = más rápido. El tamaño del punto es la distancia.</p>`;
}
function monthlyKm(runs){
  const now=new Date(), months=[];
  for(let i=11;i>=0;i--){ const d=new Date(now.getFullYear(), now.getMonth()-i, 1); months.push({d, km:0}); }
  runs.forEach(r=>{ const m = months.find(m=>m.d.getFullYear()===r.date.getFullYear() && m.d.getMonth()===r.date.getMonth()); if(m) m.km+=r.km; });
  const W=400,H=170,pl=30,pr=6,pt=16,pb=22, max=Math.max(10,...months.map(m=>m.km)), top=Math.ceil(max/10)*10;
  const bw=(W-pl-pr)/12, y=v=>pt+(H-pt-pb)*(1-v/top);
  let g="";
  for(let v=0; v<=top; v+=top>40?20:10) g+=`<line x1="${pl}" x2="${W-pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pl-5}" y="${y(v)+3}" text-anchor="end">${v}</text>`;
  months.forEach((m,i)=>{ const x=pl+i*bw+bw*.2, w=bw*.6; if(m.km>0){ g+=`<rect x="${x}" y="${y(m.km)}" width="${w}" height="${y(0)-y(m.km)}" rx="3" fill="var(--run)" fill-opacity="${i===11?1:.7}"/><text x="${x+w/2}" y="${y(m.km)-4}" text-anchor="middle" style="fill:var(--fg)">${Math.round(m.km)}</text>`; } g+=`<text x="${x+w/2}" y="${H-6}" text-anchor="middle">${MESES[m.d.getMonth()]}</text>`; });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Kilómetros por mes">${g}</svg>`;
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
  return `<a class="item" href="https://www.strava.com/activities/${s.id}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit"><span class="badge" style="background:${COL[s.cat]}">${tag}</span><div style="min-width:0"><div class="t">${esc(s.name)}</div><div class="s">${DIAS[dow(s.date)]} ${fDate(s.date)} · ${det}${hr}</div></div>${s.prs?`<span class="pill">${s.prs} PR</span>`:"<span></span>"}</a>`;
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
function vResumen(){
  const ss = allSessions(), now = new Date();
  if(!S.acts.length) return stravaBanner() + (S.busy.strava?`<div class="card"><p class="muted">Descargando tus actividades de Strava…</p></div>`:"") + onboarding();
  const w = weekBuckets(ss, 12), cur = w[w.length-1], prev = w.slice(0,-1);
  const sum = o => o.run+o.box+o.futbol+o.walk+o.otro;
  const avg = prev.reduce((t,x)=>t+sum(x),0)/prev.length;
  const runs = ss.filter(s=>s.cat==="run"), lastRun = runs[0];
  const sinceRun = lastRun ? daysBetween(lastRun.date, now) : null;
  const A = acwr(ss), st = streak(ss);
  const sc = A.ratio==null ? ["","Sin datos"] : A.ratio<0.8 ? ["warn","Por debajo de tu media"] : A.ratio<=1.3 ? ["ok","En tu zona habitual"] : A.ratio<=1.5 ? ["warn","Subida rápida"] : ["bad","Pico de carga"];
  const box28 = ss.filter(s=>s.cat==="box" && daysBetween(s.date,now)<28).length;
  const alerts = [];
  if(sinceRun!=null && sinceRun>=14) alerts.push(`<div class="banner info">Llevas <b>${sinceRun} días</b> sin correr desde «${esc(lastRun.name)}». Para no perder el nivel, vuelve con una salida suave de 30–40 min.</div>`);
  const cats = ["run","box","walk","futbol","otro"].filter(c=>w.some(x=>x[c]>0));
  return `
  ${heroCard(ss)}${stravaBanner()}${alerts.join("")}
  <div class="card">
    <div class="row between"><h2>Esta semana</h2><span class="pill"><i class="dot" style="background:${st.ongoing?"var(--ok)":"var(--warn)"}"></i>Racha ${st.n} semana${st.n===1?"":"s"}</span></div>
    ${weekStrip(ss)}
    <div class="grid4">
      <div class="tile"><span class="num">${fMin(sum(cur))}</span><span class="lab">entrenado</span></div>
      <div class="tile"><span class="num">${cur.n}</span><span class="lab">sesiones</span></div>
      <div class="tile"><span class="num">${fMin(avg)}</span><span class="lab">media semanal (11 sem)</span></div>
      <div class="tile"><span class="num">${sinceRun ?? "–"}</span><span class="lab">días sin correr</span></div>
    </div>
  </div>
  <div class="card">
    <div class="row between"><h3>Carga aguda : crónica</h3><span class="pill ${sc[0]}">${sc[1]}</span></div>
    <div class="row" style="align-items:baseline;gap:6px"><span class="num" style="font-size:44px;line-height:1">${A.ratio==null?"–":A.ratio.toFixed(2)}</span><span class="muted small">últimos 7 días ÷ media semanal de 28 días</span></div>
    <div class="meter"><i style="width:${Math.min(100,(A.ratio||0)/2*100)}%;background:var(--${sc[0]==="ok"?"ok":sc[0]==="bad"?"bad":"warn"})"></i></div>
    <p class="muted small">Estimación propia: minutos × esfuerzo. Como Strava no guarda tu RPE, uso valores por defecto (box 7, carrera 6, carreras largas o de competición 8). Orientativo, no predice lesiones.</p>
  </div>
  ${bodyCard(true)}
  <div class="card"><h3>Minutos por semana</h3>${stackedWeeks(w)}${legend(cats)}</div>
  <div class="card">
    <div class="row between"><h3>Últimas sesiones</h3><span class="muted small">${box28} de box en 28 días</span></div>
    <div class="list">${ss.slice(0,6).map(sessionItem).join("")}</div>
  </div>`;
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
function vCorrer(){
  const ss = allSessions(), runs = ss.filter(s=>s.cat==="run");
  const b = bestEfforts();
  const hm = b["half-marathon"]?.t, k5 = b["5k"]?.t;
  const last365 = runs.filter(r=>daysBetween(r.date,new Date())<365);
  const kmY = last365.reduce((t,r)=>t+r.km,0), longest = runs.reduce((m,r)=>r.km>m.km?r:m,{km:0});
  // zonas estimadas desde el 5K (s/km): desplazamientos sobre el ritmo de 5K
  const p5 = k5 ? k5/5 : null;
  const zones = p5 ? [["Z1 Recuperación",`más lento de ${fPace(p5+100)}`],["Z2 Aeróbico",`${fPace(p5+100)} – ${fPace(p5+65)}`],["Z3 Tempo",`${fPace(p5+65)} – ${fPace(p5+35)}`],["Z4 Umbral",`${fPace(p5+35)} – ${fPace(p5+15)}`],["Z5 VO₂máx",`${fPace(p5+15)} – ${fPace(p5-5)}`],["Z6 Anaeróbico",`más rápido de ${fPace(p5-5)}`]] : [];
  return `
  ${stravaBanner()}
  ${prCard()}
  ${hm ? `<div class="card">
    <h3>Predicción desde tu media</h3>
    <div class="grid2">
      <div class="tile"><span class="num">${fTime(riegel(hm,21.0975,10))}</span><span class="lab">10K estimado</span></div>
      <div class="tile"><span class="num">${fTime(riegel(hm,21.0975,42.195))}</span><span class="lab">Maratón estimado</span></div>
    </div>
    <p class="muted small">Fórmula de Riegel (T₂ = T₁ × (D₂/D₁)^1,06), cálculo propio. Para maratón suele ser optimista sin tiradas de 28–32 km.</p>
  </div>`:""}
  <div class="card"><h3>Ritmo medio por salida</h3>${paceChart(runs)}</div>
  <div class="card">
    <div class="row between"><h3>Kilómetros por mes</h3><span class="muted small">${Math.round(kmY)} km en 12 meses · tirada más larga ${longest.km.toFixed(1)} km</span></div>
    ${monthlyKm(runs)}
  </div>
  ${zones.length? `<div class="card">
    <h3>Ritmos de entreno</h3>
    <div class="scroll"><table><thead><tr><th>Zona</th><th class="r">Ritmo /km</th></tr></thead><tbody>
    ${zones.map(z=>`<tr><td>${z[0]}</td><td class="r num" style="font-size:17px">${z[1]}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="muted small">Estimación propia a partir de tu mejor 5K (${fTime(k5)}), no son las zonas oficiales de Strava. Úsalas como guía y ajusta por sensaciones.</p>
  </div>`:""}
  <div class="card"><h3>Todas tus carreras</h3><div class="list">${runs.slice(0,20).map(sessionItem).join("") || `<p class="muted">Sin carreras.</p>`}</div></div>`;
}
function syncHint(){ return S.cfg.ghToken ? "" : `<p class="muted small">Se guarda en este dispositivo. Activa la sincronización en <a href="#ajustes">Ajustes</a> para verlo también en el móvil u ordenador.</p>`; }
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
    <p class="muted small">Elige el ejercicio y mira los kilos para el porcentaje que marque el WOD. Uso tu RM más alto conocido: el PR de AimHarder o el que sale de los kilos y repeticiones que apuntas en tus WODs (fórmula de Brzycki), sin fiarme del % que marcaba.</p>
    ${field("calc_ex","Ejercicio",`<select id="calc_ex">${keys.map(x=>`<option value="${x}" ${x===k?"selected":""}>${esc(t[x].name)}</option>`).join("")}</select>`)}
    <div class="row" style="align-items:baseline;gap:8px"><span class="num" style="font-size:40px;line-height:1">${rm}</span><span class="small">kg de RM · <span class="muted">${esc(e.best.src)}</span></span></div>
    <div class="pcts">${pcts.map(p=>`<div class="pct${p===70||p===75?" hl":""}"><span class="lab">${p} %</span><span class="num">${Math.round(rm*p/100)}</span></div>`).join("")}</div>
    <p class="muted small">Redondeado a 1 kg. Si a ese peso te sobran 2 o más repeticiones, tu RM real es más alto: súbelo un 5 % y apunta la marca para que la app lo use.</p>
    ${e.list.length>1?`<details><summary class="small">De dónde sale (${e.list.length} referencias)</summary><div class="list">${e.list.map(x=>`<div class="item"><span class="num" style="width:44px">${x.rm}</span><div class="s">${esc(x.src)}</div><span></span></div>`).join("")}</div></details>`:""}
  </div>`;
}

function heroCard(ss){
  const ev = futuros(), st = streak(ss), w = weekBuckets(ss,1)[0], mins = w.run+w.box+w.futbol+w.walk+w.otro, cp = currentPhase(), e = ev[0];
  return `<div class="hero">
    <div class="row between"><span class="eyebrow">${e?"Próximo objetivo":"Esta semana"}</span><span class="glass">Racha ${st.n} sem</span></div>
    ${e?`<a class="hero-main" href="#objetivos"><span class="num huge">${daysBetween(new Date(), parseISO(e.fecha))}</span><span class="hero-l"><b>días para</b><span class="hname">${esc(e.nombre)}</span><span class="hdate">${DIAS[dow(parseISO(e.fecha))]} ${fDate(parseISO(e.fecha))}</span></span></a>`:`<a class="hero-main" href="#objetivos"><span class="hero-l"><b>Sin competición</b><span>Añade una en Objetivos</span></span></a>`}
    ${ev[1]?`<div class="hero-next">Después: <b>${esc(ev[1].nombre)}</b> · ${daysBetween(new Date(), parseISO(ev[1].fecha))} días</div>`:""}
    <div class="hero-stats"><div><b>${fMin(mins)}</b><span>esta semana</span></div><div><b>${w.n}</b><span>sesiones</span></div><div><b>${cp? cp.info.n : "—"}</b><span>fase</span></div></div>
  </div>`;
}
function countdownStrip(){
  const ev = futuros(); if(!ev.length) return "";
  return `<div class="cd-row">${ev.map(e=>{ const d = daysBetween(new Date(), parseISO(e.fecha));
    return `<a class="cd" href="#objetivos" style="--c:${e.clase==="hibrida"?"var(--box)":"var(--run)"}"><span class="num">${d}</span><span class="cd-l"><b>${esc(e.nombre)}</b><span class="muted">${d===0?"¡Hoy!":d===1?"día · mañana":"días · "+fDate(parseISO(e.fecha))}</span></span></a>`; }).join("")}</div>`;
}
function prCard(){
  const b = bestEfforts();
  const runs = S.acts.filter(a=>catOf(a.sport||"")==="run"), missing = runs.filter(r=>!S.det[r.id]).length;
  const tile = (k,dist) => { const r = b[k], lab = BE[k][0];
    return `<div class="tile pr"><span class="eyebrow">${lab}</span><span class="num big">${r?fTime(r.t):"–"}</span>${r?`<span class="lab">${fPace(r.t/dist)}/km · ${fDate(localDate(r.d))} ${String(r.d).slice(0,4)}</span><span class="lab ell">${r.src==="oficial"?"Oficial · ":""}${esc(r.act)}</span>`:`<span class="lab">${missing?"analizando…":"sin datos"}</span>`}</div>`; };
  const prog = ["5k","10k","half-marathon"].map(k=>{ const yrs = bestByYear(k); return yrs.length>1 ? `<span class="pill">${BE[k][0]}: ${yrs.map(([y,t])=>`${y} ${fTime(t)}`).join(" → ")}</span>` : ""; }).join("");
  const off = logs().filter(l=>l.tipo==="pr").sort((a,c)=>c.fecha.localeCompare(a.fecha));
  return `<div class="card">
    <div class="row between"><h2>Marcas personales</h2>${b["1 mile"]?`<span class="pill">Milla ${fTime(b["1 mile"].t)}</span>`:""}</div>
    <div class="grid3">${tile("5k",5)}${tile("10k",10)}${tile("half-marathon",21.0975)}</div>
    ${prog?`<div class="row" style="gap:6px">${prog}</div>`:""}
    ${missing?`<p class="muted small">Analizando tus carreras en Strava: faltan ${missing}. Se completan solas al abrir la app (Strava limita las peticiones).</p>`:`<p class="muted small">Tiempos más rápidos dentro de cualquier carrera registrada en Strava, o tu marca oficial si la añades y es mejor.</p>`}
    <div class="row between"><button class="addbtn" data-sheet="pr">+ Marca oficial</button></div>
    ${off.length?`<details><summary class="small">Marcas oficiales (${off.length})</summary><div class="list">${off.map(l=>`<div class="item"><span class="badge" style="background:var(--run)">${esc(l.dist)}</span><div style="min-width:0"><div class="t">${esc(l.tiempo)} · ${esc(l.carrera||"")}</div><div class="s">${fDate(parseISO(l.fecha))}</div></div>${delBtn(l.id)}</div>`).join("")}</div></details>`:""}
  </div>`;
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
  <div class="grid2">${field("m_val","Valor",`<input id="m_val" name="valor" inputmode="decimal" placeholder="60 · 7:45 · 12" required>`)}
  ${field("m_un","Unidad",`<select id="m_un" name="unidad">${opt(["kg","reps","tiempo","rondas","m","cm","cal"], p.unidad)}</select>`)}</div>
  <div class="grid2">${field("m_fecha","Fecha",`<input id="m_fecha" name="fecha" type="date" value="${today()}" required>`)}
  ${field("m_nota","Nota",`<input id="m_nota" name="nota" placeholder="1RM real · 3×42">`)}</div>
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
  ${field("pr_t","Tiempo de chip",`<input id="pr_t" name="tiempo" placeholder="1:51:12" required>`)}</div>
  <div class="grid2">${field("pr_f","Fecha",`<input id="pr_f" name="fecha" type="date" value="${today()}" required>`)}
  ${field("pr_c","Carrera",`<input id="pr_c" name="carrera" placeholder="Media de Bilbao">`)}</div>
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
  allSessions().filter(s=>s.cat==="run" && (!days || daysBetween(s.date, now) < days)).forEach(r => {
    nR++; const f = Math.min(1.5, r.km/8);
    Object.entries(Body.RUN).forEach(([k,v]) => { add(k, v*f); if(v>=.5){ by[k] = by[k]||{}; by[k]["Carrera (Strava)"] = (by[k]["Carrera (Strava)"]||0)+1; } });
  });
  const mx = Math.max(0, ...Object.values(vec));
  if(mx) Object.keys(vec).forEach(k => vec[k] /= mx);
  return {vec, by, nW, nR};
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
    ${compact?"":`<p class="muted small">Estimación propia: cada movimiento de tus WODs (sin accesorios) y tus carreras de Strava suma a los músculos que trabaja. Toca un músculo para ver con qué lo has trabajado.</p>`}
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
  if(!items.length) return `<p class="muted small">Aún no hay marcas. Pulsa «+» para añadir una o importa la pantalla de PR de AimHarder.</p>`;
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
  <div class="card">
    <div class="row between"><h2>Tus WODs</h2><button class="addbtn" data-sheet="add">+ Añadir</button></div>
    ${wods.length ? `<div class="wodlist">${shown.map(wodCard).join("")}</div>${wods.length>8?`<button class="ghost" data-act="wodall" style="align-self:center">${S.wodAll?"Ver menos":`Ver los ${wods.length}`}</button>`:""}`
      : `<p class="small muted">Aún no hay WODs. Pulsa «+ Añadir» para leer una captura de AimHarder o apuntarlo a mano.</p>`}
  </div>
  <div class="card">
    <div class="row between"><h2>Marcas</h2><button class="addbtn" data-sheet="marca">+ Marca</button></div>
    ${marcasGrid()}
  </div>
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
  el.classList.remove("open"); document.body.classList.remove("noscroll");
  setTimeout(()=>{ el.hidden = true; $("#sheetBody").innerHTML = ""; S.sheetState = null; S.confirmDel = null; }, 260);
}
function renderSheet(){
  if(!S.sheetState) return;
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
      <p class="muted small">Predicción con la fórmula de Riegel desde tu mejor ${refDist===10?"10K":"media"}; es un cálculo propio, no de Strava.</p>`;
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
    <div class="row" style="justify-content:flex-end">${delBtn(e.id)}</div>
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
  ${sugs.length?`<div class="card"><h3>Añadir rápido</h3><div class="stack" style="gap:8px">${sugs.map(s=>`<button type="button" class="sugbtn" data-sug="${esc(s.nombre)}"><b>${esc(s.nombre)}</b><span class="muted small">${DIAS[dow(parseISO(s.fecha))]} ${fDate(parseISO(s.fecha))} ${s.fecha.slice(0,4)}</span></button>`).join("")}</div><p class="muted small">Comprueba la fecha en la web oficial; se puede borrar y volver a crear.</p></div>`:""}
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
  if(info.runs>=3) goals.push({k:"run", t:`Tirada larga · ${longKm} km`, n:1, done: longWk>=longKm*0.9?1:0, d:`Suave, ${z2}/km.${cp&&cp.key==="especifico"&&hmP?` Los últimos 4–5 km a ${fPace(hmP)}/km.`:""} Esta semana tu más larga: ${longWk?longWk.toFixed(1)+" km":"ninguna aún"}.`});
  return `
  ${countdownStrip()}
  <div class="card">
    <div class="row between"><h2>Esta semana</h2><span class="pill" style="color:${cp?.info.c||"var(--muted)"}"><i class="dot" style="background:${cp?.info.c||"var(--muted)"}"></i>${info.n}</span></div>
    <p class="small muted">${info.d}</p>
    <div class="list">${goals.map(g=>{ const ok = g.done>=g.n; return `<div class="check"><span class="box ${ok?"done":""}">${ok?"✓":""}</span><div><div class="row" style="gap:6px"><i class="dot" style="background:${COL[g.k]}"></i><b>${g.t}</b><span class="muted small">${Math.min(g.done,g.n)}/${g.n}</span></div><div class="small muted">${g.d}</div></div></div>`; }).join("")}</div>
    <p class="muted small">Se marca solo con lo que entra de Strava. Ritmos estimados a partir de tu mejor 5K${hmP?" y tu objetivo de media":""}. Deja al menos un día de descanso completo.</p>
  </div>
  ${!futuros().length?`<div class="banner info">Añade tus competiciones en <a href="#objetivos">Objetivos</a> y el plan se adapta a cada fase.</div>`:""}
  <div class="card">
    <h3>Pregunta a Claude</h3>
    <p class="muted small">Copia un resumen de tus datos (entrenos, WODs, marcas y competiciones) y pégalo en un chat con Claude junto a tu pregunta.</p>
    <button class="primary" type="button" data-act="copy">Copiar resumen de mis datos</button>
    <textarea id="copyArea" readonly hidden style="min-height:120px"></textarea>
  </div>`;
}

function vAjustes(){
  const conn = !!S.tok;
  return `
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
    <p class="muted small">${conn?"La conexión se renueva sola: no tendrás que volver a conectar salvo que pulses Desconectar o quites el acceso desde Strava. ":""}${S.cfg.ghToken?"Con la sincronización activa, tus otros dispositivos se conectan solos (las claves viajan cifradas en tu Gist secreto). ":"El Client Secret y tus tokens se guardan en este dispositivo. "}${S.stravaAt?`Última actualización: ${fDate(new Date(S.stravaAt))} ${fClock(S.stravaAt)} · ${S.acts.length} actividades.`:""}</p>
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
    <p class="muted small">${S.syncAt?`Última sincronización: ${fDate(new Date(S.syncAt))} ${fClock(S.syncAt)}. `:""}Se sincroniza al abrir la app, al volver a ella y cada vez que guardas.${S.cfg.gistId?` <a href="https://gist.github.com/${esc(S.cfg.gistId)}" target="_blank" rel="noopener">Ver el Gist</a>`:""}</p>
  </div>
  <div class="card">
    <h3>Copia de seguridad</h3>
    <div class="row"><button type="button" data-act="export">Exportar registros (.json)</button>
    <label class="ghost" style="flex-direction:row;align-items:center;gap:8px;cursor:pointer;border:1px solid var(--line);border-radius:10px;padding:10px 14px;color:var(--fg);font-size:15px">Importar<input id="importFile" type="file" accept="application/json,.json" hidden></label></div>
    <p class="muted small">${logs().length} registros guardados.</p>
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
function render(){
  const v = current();
  document.querySelectorAll("nav.tabs a").forEach(a=>a.setAttribute("aria-current", a.dataset.v===v?"page":"false"));
  const titles = {resumen:"Tu semana",correr:"Correr",box:"Box",objetivos:"Objetivos",plan:"Plan",ajustes:"Ajustes"};
  $("#hdrTitle").textContent = v==="resumen" ? `Hola${S.athlete?.firstname?", "+S.athlete.firstname:""}` : titles[v];
  $("#hdrEyebrow").textContent = v==="resumen" ? `${DIAS[dow(new Date())]} ${fDate(new Date())}` : "Cuaderno de entreno";
  const app = $("#app"); const sameView = app.dataset.v===v;
  if(sameView) app.querySelectorAll("input[id],select[id],textarea[id]").forEach(el=>{ if(el.type!=="file") S.form[el.id]=el.value; });
  else S.form = {};
  const focusId = document.activeElement?.id;
  app.innerHTML = `<div class="stack ${sameView?"":"view"}">${({resumen:vResumen,correr:vCorrer,box:vBox,objetivos:vObjetivos,plan:vPlan,ajustes:vAjustes})[v]()}</div>`;
  app.dataset.v = v;
  if(sameView){ app.querySelectorAll("input[id],select[id],textarea[id]").forEach(el=>{ if(S.form[el.id]!=null && el.type!=="file") el.value=S.form[el.id]; }); if(focusId){ const f=document.getElementById(focusId); if(f) f.focus({preventScroll:true}); } }
  renderStatus();
}
function renderStatus(){
  const st = $("#status"); const parts = [];
  if(S.busy.strava || S.busy.sync) parts.push(`<span class="dot" style="background:var(--warn)"></span>Actualizando…`);
  else if(S.err.strava || S.err.sync) parts.push(`<span class="dot" style="background:var(--bad)"></span>Revisa Ajustes`);
  else if(S.stravaAt) parts.push(`<span class="dot" style="background:var(--ok)"></span>${fClock(S.stravaAt)}`);
  st.innerHTML = parts.join("") + ` <a href="#ajustes" class="gear" aria-label="Ajustes"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></a>`;
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
  const sh = e.target.closest("[data-sheet]");
  if(sh){ const k = sh.dataset.sheet; openSheet(k, k==="marca" && sh.dataset.ej ? {ejercicio:sh.dataset.ej, unidad:sh.dataset.un} : null); return; }
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
  if(act==="close"){ closeSheet(); return; }
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
  addRec({tipo:kind, ...data});
  if(kind==="wod") S.ocr = null;
  f.querySelectorAll("input[id],textarea[id],select[id]").forEach(el=>{ delete S.form[el.id]; });
  if(f.closest("#sheet")) closeSheet();
  toast(kind==="wod" ? "WOD guardado" : kind==="evento" ? "Competición guardada" : "Guardado"); render();
});
document.addEventListener("keydown", e=>{ if(e.key==="Escape") closeSheet(); if((e.key==="Enter"||e.key===" ") && e.target.matches("[data-mus]")){ e.preventDefault(); e.target.click(); } });
// Girar el cuerpo deslizando el dedo
let swipeX = null, swipedAt = 0;
document.addEventListener("pointerdown", e=>{ if(e.target.closest("[data-flip]")) swipeX = e.clientX; });
document.addEventListener("pointerup", e=>{ if(swipeX==null) return; const dx = e.clientX - swipeX; swipeX = null;
  if(Math.abs(dx) > 40){ swipedAt = Date.now(); const inS = !!e.target.closest("#sheet"); const b = inS ? $('#sheet [data-act="flipd"]') : $('.bodycard [data-act="flip"]'); b && b.click(); } });
document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState==="visible"){ syncGist(); if(!S.stravaAt || Date.now()-S.stravaAt > 10*60*1000) syncStrava(false); } });
setInterval(()=>{ if(document.visibilityState==="visible") syncGist(); }, 60*1000);

/* ---------- arranque ---------- */
render();
(async ()=>{
  await handleOAuthReturn();
  render();
  syncGist();
  if(S.tok && (!S.stravaAt || Date.now()-S.stravaAt > 5*60*1000)) syncStrava(false);
})();
// Pide al navegador que no borre los datos de la app por falta de espacio
if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{});
if("serviceWorker" in navigator && location.protocol==="https:") navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
