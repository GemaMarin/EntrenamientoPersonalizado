(function(){
"use strict";
/* =========================================================
   Cuaderno de Entreno · app independiente
   - Strava: API oficial con OAuth (credenciales solo en este dispositivo)
   - Registros (WODs, marcas, salud): local + Gist privado de GitHub
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
  busy: {strava:false, sync:false}, err: {}, form: {}, confirmDel: null, toast: ""
};
const saveCfg = () => LS.set("cfg", S.cfg);

const VIEWS = ["resumen","correr","box","salud","plan","ajustes"];
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
  S.tok = {access_token:j.access_token, refresh_token:j.refresh_token, expires_at:j.expires_at};
  if(j.athlete){ S.athlete = j.athlete; LS.set("athlete", j.athlete); }
  LS.set("stravaTok", S.tok);
}
async function ensureToken(){
  if(!S.tok) throw {code:"no_token"};
  if(S.tok.expires_at*1000 - Date.now() < 120000) await tokenRequest({grant_type:"refresh_token", refresh_token:S.tok.refresh_token});
}
async function api(path){
  await ensureToken();
  let r = await fetch("https://www.strava.com/api/v3"+path, {headers:{Authorization:"Bearer "+S.tok.access_token}});
  if(r.status===401){ await tokenRequest({grant_type:"refresh_token", refresh_token:S.tok.refresh_token}); r = await fetch("https://www.strava.com/api/v3"+path, {headers:{Authorization:"Bearer "+S.tok.access_token}}); }
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
    watts:a.average_watts||null, kj:a.kilojoules||null, trainer:!!a.trainer, race:a.workout_type===1 };
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
// Detalles: calorías y mejores marcas (best_efforts) por actividad. Máx. 25 por sesión para respetar el límite de Strava.
async function fetchDetails(){
  const pending = S.acts.filter(a => !S.det[a.id] && (a.km>0 || daysBetween(localDate(a.start), new Date())<180)).slice(0,25);
  for(const a of pending){
    try{
      const d = await api("/activities/"+a.id);
      S.det[a.id] = { cal: d.calories||0, be: (d.best_efforts||[]).map(b=>({n:b.name, t:b.elapsed_time, d:b.start_date_local})) };
    }catch(e){ if(e.code==="rate") break; }
  }
  LS.set("det", S.det);
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
  if(!f) return [];
  let txt = f.content;
  if(f.truncated){ txt = await (await fetch(f.raw_url)).text(); }
  try{ return JSON.parse(txt).registros || []; }catch(e){ return []; }
}
function merge(a, b){
  const m = new Map();
  [...a, ...b].forEach(r => { const o = m.get(r.id); if(!o || (r.mod||0) > (o.mod||0)) m.set(r.id, r); });
  return [...m.values()];
}
let pushTimer = null, dirty = LS.get("dirty", false);
async function syncGist(){
  if(!S.cfg.ghToken || S.busy.sync) return;
  S.busy.sync = true; delete S.err.sync; renderStatus();
  try{
    if(!S.cfg.gistId) await findOrCreateGist();
    const remote = await readGist();
    const merged = merge(remote, S.recs);
    const changedRemote = JSON.stringify(sortRecs(merged)) !== JSON.stringify(sortRecs(remote));
    S.recs = merged; LS.set("recs", S.recs);
    if(changedRemote || dirty){
      await gh("/gists/"+S.cfg.gistId, {method:"PATCH", body: JSON.stringify({files:{[GIST_FILE]:{content: JSON.stringify({v:1, registros:sortRecs(S.recs)}, null, 1)}}})});
    }
    dirty = false; LS.set("dirty", false);
    S.syncAt = Date.now(); LS.set("syncAt", S.syncAt);
  }catch(e){ S.err.sync = e; }
  S.busy.sync = false; render();
}
const sortRecs = rs => [...rs].sort((a,b)=>a.id.localeCompare(b.id));
function schedulePush(){ dirty = true; LS.set("dirty", true); clearTimeout(pushTimer); pushTimer = setTimeout(syncGist, 600); }

const logs = () => S.recs.filter(r=>!r.borrado);
function addRec(r){ const now = Date.now(); S.recs.push({id:uid(), creado:now, mod:now, ...r}); LS.set("recs", S.recs); schedulePush(); }
function delRec(id){ const r = S.recs.find(x=>x.id===id); if(r){ Object.keys(r).forEach(k=>{ if(!["id","tipo","fecha"].includes(k)) delete r[k]; }); r.borrado = true; r.mod = Date.now(); LS.set("recs", S.recs); schedulePush(); } }

/* =========================================================
   MODELO
   ========================================================= */
function allSessions(){
  return S.acts.map(a => {
    const c = catOf(a.sport||"");
    return { ...a, cat:c, date:localDate(a.start), kcal:S.det[a.id]?.cal||0,
      rpe: a.race || (c==="run" && a.km>=18) ? 8 : RPE_DEF[c], rpeEst:true };
  }).sort((a,b)=>b.date-a.date);
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
const BE = {"1 mile":["Milla",1.609],"5K":["5K",5],"10K":["10K",10],"Half-Marathon":["Media maratón",21.0975],"Marathon":["Maratón",42.195]};
function bestEfforts(){
  const out = {};
  S.acts.filter(a=>catOf(a.sport||"")==="run").forEach(a => (S.det[a.id]?.be||[]).forEach(b => {
    if(BE[b.n] && (!out[b.n] || b.t < out[b.n].t)) out[b.n] = {...b, act:a.name};
  }));
  return out;
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
  return `<div class="week">${Array.from({length:7},(_,i)=>{ const d=addDays(m,i); const ss=sessions.filter(s=>iso(s.date)===iso(d)); const sal = logs().some(l=>l.tipo==="salud" && l.fecha===iso(d) && l.sintoma && l.sintoma!=="ninguno");
    return `<div class="day ${iso(d)===t?"today":""}"><span class="muted">${DIAS[i]}</span><b>${d.getDate()}</b><div class="chips">${ss.map(s=>`<span class="chip" title="${esc(NAME[s.cat])}" style="background:${COL[s.cat]}"></span>`).join("")}${sal?`<span class="chip" title="Síntoma registrado" style="background:var(--health);border-radius:50%"></span>`:""}</div></div>`; }).join("")}</div>`;
}
function legend(cats){ return `<div class="legend">${cats.map(c=>`<span><i class="dot" style="background:${COL[c]}"></i>${NAME[c]}</span>`).join("")}</div>`; }
function stravaBanner(){
  if(!S.cfg.clientId || !S.tok) return `<div class="banner info">Conecta tu cuenta de Strava en <a href="#ajustes">Ajustes</a> para ver tus entrenos.</div>`;
  if(S.err.strava) return `<div class="banner bad">${esc(S.err.strava.message||"No se pudo leer Strava.")} ${S.err.strava.code==="auth"?`<a href="#ajustes">Ir a Ajustes</a>`:""}</div>`;
  return "";
}
function delBtn(id){ return S.confirmDel===id ? `<span class="row" style="gap:4px"><button class="ghost danger" data-del="${id}" data-sure="1">Borrar</button><button class="ghost" data-del="">No</button></span>` : `<button class="ghost" data-del="${id}" aria-label="Borrar">✕</button>`; }
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
  const lastSym = logs().filter(l=>l.tipo==="salud" && l.sintoma && l.sintoma!=="ninguno").sort((a,b)=>b.fecha.localeCompare(a.fecha))[0];
  const alerts = [];
  if(lastSym && daysBetween(parseISO(lastSym.fecha), now)<=7) alerts.push(`<div class="banner">Registraste <b>${esc(symName(lastSym.sintoma))}</b> el ${fDate(parseISO(lastSym.fecha))}. Mira la pestaña <a href="#salud">Salud</a> antes de tu próxima sesión intensa.</div>`);
  if(sinceRun!=null && sinceRun>=14) alerts.push(`<div class="banner info">Llevas <b>${sinceRun} días</b> sin correr desde «${esc(lastRun.name)}». Para no perder el nivel, vuelve con una salida suave de 30–40 min.</div>`);
  const cats = ["run","box","walk","futbol","otro"].filter(c=>w.some(x=>x[c]>0));
  return `
  ${stravaBanner()}${alerts.join("")}
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
  const hm = b["Half-Marathon"]?.t, k5 = b["5K"]?.t;
  const last365 = runs.filter(r=>daysBetween(r.date,new Date())<365);
  const kmY = last365.reduce((t,r)=>t+r.km,0), longest = runs.reduce((m,r)=>r.km>m.km?r:m,{km:0});
  const prRow = k => b[k]? `<tr><td>${BE[k][0]}</td><td class="r num" style="font-size:18px">${fTime(b[k].t)}</td><td class="r muted">${fPace(b[k].t/BE[k][1])}/km</td><td class="r muted">${fDate(localDate(b[k].d))}</td></tr>` : "";
  const missingDet = runs.filter(r=>!S.det[r.id]).length;
  // zonas estimadas desde el 5K (s/km): desplazamientos sobre el ritmo de 5K
  const p5 = k5 ? k5/5 : null;
  const zones = p5 ? [["Z1 Recuperación",`más lento de ${fPace(p5+100)}`],["Z2 Aeróbico",`${fPace(p5+100)} – ${fPace(p5+65)}`],["Z3 Tempo",`${fPace(p5+65)} – ${fPace(p5+35)}`],["Z4 Umbral",`${fPace(p5+35)} – ${fPace(p5+15)}`],["Z5 VO₂máx",`${fPace(p5+15)} – ${fPace(p5-5)}`],["Z6 Anaeróbico",`más rápido de ${fPace(p5-5)}`]] : [];
  return `
  ${stravaBanner()}
  <div class="card">
    <h2>Marcas personales</h2>
    ${Object.keys(b).length ? `<div class="scroll"><table><thead><tr><th>Distancia</th><th class="r">Tiempo</th><th class="r">Ritmo</th><th class="r">Fecha</th></tr></thead><tbody>${["1 mile","5K","10K","Half-Marathon","Marathon"].map(prRow).join("")}</tbody></table></div>` : `<p class="muted small">Calculando a partir del detalle de tus carreras…</p>`}
    ${missingDet? `<p class="muted small">Faltan ${missingDet} carreras por analizar; se completan solas en las próximas aperturas (Strava limita las peticiones).</p>`:""}
  </div>
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
function fmWod(){ return `<form data-form="wod">
  <div class="grid2">${field("w_fecha","Fecha",`<input id="w_fecha" name="fecha" type="date" value="${today()}" required>`)}
  ${field("w_formato","Formato",`<select id="w_formato" name="formato"><option>For time</option><option>AMRAP</option><option>EMOM</option><option>Fuerza</option><option>Hyrox / Hybrid</option><option>Intervalos</option><option>Otro</option></select>`)}</div>
  ${field("w_nombre","Nombre del WOD",`<input id="w_nombre" name="nombre" placeholder="p. ej. Fran, Cindy, WOD del día" required>`)}
  ${field("w_texto","Entreno (pégalo de AimHarder)",`<textarea id="w_texto" name="texto" placeholder="21-15-9&#10;Thrusters 30 kg&#10;Pull-ups"></textarea>`)}
  <div class="grid2">${field("w_res","Resultado",`<input id="w_res" name="resultado" placeholder="8:42 · 5+12 · 60 kg">`)}
  ${field("w_rx","Nivel",`<select id="w_rx" name="rx"><option>RX</option><option>Scaled</option><option>Adaptado</option></select>`)}</div>
  ${field("w_rpe","Esfuerzo percibido (1–10)",`<input id="w_rpe" name="rpe" type="number" min="1" max="10" value="7">`)}
  <button class="primary" type="submit">Guardar WOD</button></form>`; }
function fmMarca(){ return `<form data-form="marca">
  <div class="grid2">${field("m_ej","Ejercicio",`<input id="m_ej" name="ejercicio" list="ejercicios" placeholder="Back squat" required>`)}
  ${field("m_fecha","Fecha",`<input id="m_fecha" name="fecha" type="date" value="${today()}" required>`)}</div>
  <datalist id="ejercicios">${["Back squat","Front squat","Deadlift","Clean","Snatch","Clean & jerk","Push press","Strict press","Pull-ups máx","Toes to bar máx","Fran","Cindy","Grace","Wall balls 2 min","Remo 500 m","Remo 2 km","SkiErg 1 km","Burpees 3 min"].map(x=>`<option value="${x}">`).join("")}</datalist>
  <div class="grid2">${field("m_val","Valor",`<input id="m_val" name="valor" inputmode="decimal" placeholder="60 · 7:45 · 12" required>`)}
  ${field("m_un","Unidad",`<select id="m_un" name="unidad"><option>kg</option><option>reps</option><option>tiempo</option><option>rondas</option><option>m</option><option>cal</option></select>`)}</div>
  <button class="primary" type="submit">Guardar marca</button></form>`; }
function fmSalud(){ return `<form data-form="salud">
  <div class="grid2">${field("s_fecha","Fecha",`<input id="s_fecha" name="fecha" type="date" value="${today()}" required>`)}
  ${field("s_sint","¿Qué notaste?",`<select id="s_sint" name="sintoma"><option value="ninguno">Nada, todo bien</option><option value="tension">Bajada de tensión</option><option value="mareo">Mareo</option><option value="nauseas">Náuseas</option><option value="dolor">Dolor / molestia</option><option value="fatiga">Fatiga extrema</option><option value="otro">Otro</option></select>`)}</div>
  <div class="grid2">${field("s_mom","¿Cuándo?",`<select id="s_mom" name="momento"><option>Durante el entreno</option><option>Al terminar</option><option>Al ponerme de pie</option><option>Horas después</option><option>Sin entreno</option></select>`)}
  ${field("s_sueno","Horas de sueño",`<input id="s_sueno" name="sueno" type="number" step="0.5" min="0" max="14" placeholder="7">`)}</div>
  <div class="grid2">${field("s_comida","Comida antes",`<select id="s_comida" name="comida"><option>Comí 2–3 h antes</option><option>Comí poco / snack</option><option>En ayunas &gt;4 h</option></select>`)}
  ${field("s_agua","Hidratación del día",`<select id="s_agua" name="agua"><option>Buena</option><option>Normal</option><option>Escasa</option></select>`)}</div>
  ${field("s_tension","Tensión si la mediste (opcional)",`<input id="s_tension" name="tension" placeholder="90/60">`)}
  ${field("s_notas","Notas",`<textarea id="s_notas" name="notas" placeholder="Qué estabas haciendo, cuánto duró, cómo se pasó…"></textarea>`)}
  <button class="primary" type="submit">Guardar registro</button></form>`; }
function syncHint(){ return S.cfg.ghToken ? "" : `<p class="muted small">Se guarda en este dispositivo. Activa la sincronización en <a href="#ajustes">Ajustes</a> para verlo también en el móvil u ordenador.</p>`; }

function vBox(){
  const ss = allSessions(), now = new Date();
  const box = ss.filter(s=>s.cat==="box");
  const b12 = weekBuckets(box, 12).map(w=>w.n);
  const last90 = box.filter(s=>daysBetween(s.date,now)<90);
  const avgMin = last90.length? last90.reduce((t,s)=>t+s.min,0)/last90.length : 0;
  const withCal = last90.filter(s=>s.kcal);
  const avgKcal = withCal.length? withCal.reduce((t,s)=>t+s.kcal,0)/withCal.length : 0;
  const perWk = last90.length/(90/7);
  const types = {}; box.forEach(s=>{ const k = /Weight/.test(s.sport)?"Pesas":"HIIT / CrossFit"; types[k]=(types[k]||0)+1; });
  const wods = logs().filter(l=>l.tipo==="wod").sort((a,b)=>b.fecha.localeCompare(a.fecha));
  const byEx = {}; logs().filter(l=>l.tipo==="marca").forEach(m=>{ (byEx[m.ejercicio]=byEx[m.ejercicio]||[]).push(m); });
  return `
  <div class="card">
    <h2>Box · HIIT · Hybrid</h2>
    <div class="grid4">
      <div class="tile"><span class="num">${perWk.toFixed(1)}</span><span class="lab">sesiones/semana (90 d)</span></div>
      <div class="tile"><span class="num">${Math.round(avgMin)}′</span><span class="lab">duración media</span></div>
      <div class="tile"><span class="num">${avgKcal?Math.round(avgKcal):"–"}</span><span class="lab">kcal medias*</span></div>
      <div class="tile"><span class="num">${box.length}</span><span class="lab">sesiones en Strava</span></div>
    </div>
    <div class="row" style="gap:4px;align-items:flex-end;height:46px">${b12.map(n=>`<div title="${n} sesiones" style="flex:1;background:var(--box);opacity:${n?0.35+0.65*Math.min(1,n/3):.12};height:${8+n*12}px;border-radius:4px"></div>`).join("")}</div>
    <p class="muted small">Barras: sesiones por semana (últimas 12). *Calorías estimadas por Strava/Garmin; sin pulsómetro son poco fiables.</p>
    <p class="small">${Object.entries(types).map(([k,v])=>`<span class="pill" style="margin-right:6px">${k}: ${v}</span>`).join("")}</p>
  </div>
  <div class="card"><h3>¿Qué días vas al box?</h3>${dowBars(box,"var(--box)")}</div>
  <div class="card">
    <h3>Apuntar WOD</h3>
    <p class="muted small">Copia el entreno de AimHarder y apunta tu resultado. Aparece junto a la sesión de Strava de ese día.</p>
    ${fmWod()}${syncHint()}
  </div>
  ${wods.length? `<div class="card"><h3>Tus WODs</h3><div class="list">${wods.slice(0,30).map(w=>{ const st = box.find(s=>iso(s.date)===w.fecha);
    return `<div class="item" style="align-items:start"><span class="badge" style="background:var(--box)">${esc((w.rx||"").slice(0,2).toUpperCase())}</span><div style="min-width:0"><div class="t">${esc(w.nombre)} <span class="muted" style="font-weight:400">· ${esc(w.formato)}</span></div><div class="s">${fDate(parseISO(w.fecha))}${w.resultado?" · <b>"+esc(w.resultado)+"</b>":""}${w.rpe?" · RPE "+esc(w.rpe):""}${st?" · "+fMin(st.min)+" en Strava":""}</div>${w.texto?`<details><summary class="small muted">Ver entreno</summary><div class="pre small">${esc(w.texto)}</div></details>`:""}</div>${delBtn(w.id)}</div>`; }).join("")}</div></div>`:""}
  <div class="card">
    <h3>Marcas y benchmarks</h3>
    <p class="muted small">RM, benchmarks (Fran, Cindy…) y pruebas de ergómetro. Cada ejercicio muestra tu progreso.</p>
    ${fmMarca()}
    ${Object.keys(byEx).length? `<div class="list">${Object.entries(byEx).map(([ex,arr])=>{ arr.sort((a,b)=>a.fecha.localeCompare(b.fecha)); const l=arr[arr.length-1], f=arr[0];
      return `<div class="item"><span class="badge" style="background:var(--fg);color:var(--bg)">${arr.length}</span><div style="min-width:0"><div class="t">${esc(ex)}</div><div class="s">${arr.length>1?`${esc(f.valor)} → `:""}<b>${esc(l.valor)} ${esc(l.unidad)}</b> · ${fDate(parseISO(l.fecha))}</div></div>${delBtn(l.id)}</div>`; }).join("")}</div>`:""}
  </div>`;
}
const symName = s => ({tension:"bajada de tensión",mareo:"mareo",nauseas:"náuseas",dolor:"dolor",fatiga:"fatiga extrema",otro:"otro síntoma",ninguno:"sin síntomas"}[s]||s);
const cap = s => s.charAt(0).toUpperCase()+s.slice(1);
function vSalud(){
  const ss = allSessions();
  const ls = logs().filter(l=>l.tipo==="salud").sort((a,b)=>b.fecha.localeCompare(a.fecha));
  const sym = ls.filter(l=>l.sintoma!=="ninguno");
  return `
  <div class="card">
    <h2>Salud y sensaciones</h2>
    <p class="small">Un registro rápido después de entrenar. Con varias entradas verás si los síntomas coinciden con poco sueño, poca comida, calor o sesiones largas.</p>
    ${fmSalud()}${syncHint()}
  </div>
  ${sym.length? `<div class="card"><h3>Episodios registrados</h3><div class="list">${sym.map(l=>{ const act = ss.filter(s=>iso(s.date)===l.fecha);
    return `<div class="item" style="align-items:start"><span class="badge" style="background:var(--health)">!</span><div style="min-width:0"><div class="t">${esc(cap(symName(l.sintoma)))} · ${fDate(parseISO(l.fecha))}</div>
    <div class="s">${esc(l.momento||"")}${l.sueno?" · "+esc(l.sueno)+" h de sueño":""}${l.comida?" · "+esc(l.comida):""}${l.agua?" · hidratación "+esc(String(l.agua).toLowerCase()):""}${l.tension?" · "+esc(l.tension)+" mmHg":""}</div>
    ${act.length? `<div class="s">Ese día: ${act.map(a=>`${esc(a.name)} (${fMin(a.min)}, ${pad(a.date.getHours())}:${pad(a.date.getMinutes())}${a.hr?`, ${Math.round(a.hr)} ppm`:""})`).join(" · ")}</div>`:""}
    ${l.notas?`<div class="s">${esc(l.notas)}</div>`:""}</div>${delBtn(l.id)}</div>`; }).join("")}</div></div>`:""}
  <div class="card">
    <h3>Si te baja la tensión entrenando</h3>
    <p class="small">La hipotensión después del ejercicio es un fenómeno descrito y frecuente: al parar de golpe, los vasos de las piernas siguen dilatados, la sangre se acumula abajo y llega menos a la cabeza. Influyen la deshidratación, el calor, haber comido poco y dormir mal (Halliwill, <i>Exerc. Sport Sci. Rev.</i> 2001; Halliwill et al., <i>Exp. Physiol.</i> 2013).</p>
    <div class="list">
      <div class="check"><span class="box">1</span><div class="small"><b>En el momento:</b> túmbate con las piernas en alto o siéntate con la cabeza entre las rodillas. No te levantes de golpe.</div></div>
      <div class="check"><span class="box">2</span><div class="small"><b>Vuelta a la calma:</b> 5–10 min de pedaleo, remo o caminar suave al acabar el WOD, en vez de tirarte al suelo.</div></div>
      <div class="check"><span class="box">3</span><div class="small"><b>Antes de entrenar por la tarde:</b> comida o merienda con hidratos 1,5–3 h antes y 400–600 ml de agua, con sal o electrolitos si sudas mucho.</div></div>
      <div class="check"><span class="box">4</span><div class="small"><b>Apunta cada episodio aquí:</b> con 3 o 4 registros se ve si hay patrón (horario, sueño, comida, tipo de WOD).</div></div>
    </div>
    <div class="banner bad small">Consulta a tu médico si te pasa más de una vez, si llegas a desmayarte, o si notas dolor en el pecho, palpitaciones, falta de aire desproporcionada o te ocurre en reposo. Esta app no diagnostica: solo te ayuda a llevar el registro para enseñárselo.</div>
    <p class="muted small">Si grabas el box con el Garmin y pulsómetro, aquí verás el pulso medio de cada sesión, un dato objetivo para entender estos episodios.</p>
  </div>
  ${ls.filter(l=>l.sintoma==="ninguno").length? `<div class="card"><h3>Días sin síntomas</h3><div class="list">${ls.filter(l=>l.sintoma==="ninguno").slice(0,10).map(l=>`<div class="item"><span class="badge" style="background:var(--ok)">OK</span><div><div class="t">${fDate(parseISO(l.fecha))}</div><div class="s">${l.sueno?esc(l.sueno)+" h sueño · ":""}${esc(l.comida||"")}</div></div>${delBtn(l.id)}</div>`).join("")}</div></div>`:""}`;
}
function vPlan(){
  const ss = allSessions(), m = monday(new Date());
  const wk = ss.filter(s=>daysBetween(m,s.date)>=0 && daysBetween(m,s.date)<7);
  const nBox = wk.filter(s=>s.cat==="box").length, runsWk = wk.filter(s=>s.cat==="run");
  const k5 = bestEfforts()["5K"]?.t, p5 = k5 ? k5/5 : 298;
  const z2 = `${fPace(p5+100)}–${fPace(p5+65)}`, z4 = `${fPace(p5+35)}–${fPace(p5+15)}`;
  const goals = [
    {k:"box", t:"Box / HIIT", n:2, done:nBox, d:"Tus dos sesiones habituales (mar y jue)."},
    {k:"run", t:"Carrera suave (Z2)", n:1, done:Math.min(1,runsWk.length), d:`35–50 min a ${z2}/km. Debes poder hablar en frases completas.`},
    {k:"run", t:"Carrera de calidad", n:1, done:Math.max(0,runsWk.length-1), d:`Ej.: 3 × 8 min a ${z4}/km con 2 min suaves, o 6 × 400 m a ritmo de 5K. Mejor no el día después de un WOD duro.`}
  ];
  return `
  <div class="card">
    <div class="row between"><h2>Esta semana</h2><span class="muted small">desde el lunes ${fDate(m)}</span></div>
    <div class="list">${goals.map(g=>{ const ok = g.done>=g.n; return `<div class="check"><span class="box ${ok?"done":""}">${ok?"✓":""}</span><div><div class="row" style="gap:6px"><i class="dot" style="background:${COL[g.k]}"></i><b>${g.t}</b><span class="muted small">${Math.min(g.done,g.n)}/${g.n}</span></div><div class="small muted">${g.d}</div></div></div>`; }).join("")}</div>
    <p class="muted small">Semana tipo: 2 box + 2 carreras (una suave, una de calidad) y al menos un día de descanso completo. Se marca sola con lo que entra de Strava.</p>
  </div>
  <div class="card">
    <h3>Ideas de objetivo</h3>
    <div class="list">
      <div class="check"><span class="box">A</span><div class="small"><b>Bajar tu 10K.</b> Si tu mejor 10K salió dentro de una media, en un 10K dedicado hay margen; con una sesión de calidad semanal, 6–8 semanas.</div></div>
      <div class="check"><span class="box">B</span><div class="small"><b>Hyrox o una prueba híbrida.</b> Ya combinas carrera y box. Registra remo, SkiErg y wall balls como marcas para medir el progreso.</div></div>
      <div class="check"><span class="box">C</span><div class="small"><b>Mejorar tu media.</b> Tiradas de 16–18 km y un bloque a ritmo objetivo cada 2 semanas.</div></div>
    </div>
  </div>
  <div class="card">
    <h3>Pregunta a Claude</h3>
    <p class="muted small">Copia un resumen de tus datos y pégalo en un chat con Claude junto a tu pregunta (plan, análisis de la semana, etc.).</p>
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
    <p class="muted small">El Client Secret y tus tokens se guardan solo en este dispositivo, nunca en GitHub. ${S.stravaAt?`Última actualización: ${fDate(new Date(S.stravaAt))} ${fClock(S.stravaAt)} · ${S.acts.length} actividades.`:""}</p>
  </div>
  <div class="card">
    <div class="row between"><h2>Sincronización</h2><span class="pill ${S.cfg.ghToken&&!S.err.sync?"ok":""}">${S.cfg.ghToken?(S.err.sync?"Error":`<i class="dot" style="background:var(--ok)"></i>Activa`):"Desactivada"}</span></div>
    <p class="small">Tus WODs, marcas y registros de salud se guardan en un <b>Gist secreto</b> de tu cuenta de GitHub. Así los ves igual en el móvil y en el ordenador.</p>
    ${S.err.sync?`<div class="banner bad">${esc(S.err.sync.message||"Error al sincronizar")}</div>`:""}
    <details ${S.cfg.ghToken?"":"open"}><summary>Cómo crear el token (una vez)</summary>
      <ol class="small" style="padding-left:18px;display:flex;flex-direction:column;gap:6px;margin:10px 0 0">
        <li>Abre <a href="https://github.com/settings/tokens/new?scopes=gist&description=Cuaderno%20de%20Entreno" target="_blank" rel="noopener">este enlace</a> (ya marca solo el permiso «gist»).</li>
        <li>En «Expiration» elige «No expiration» o 1 año, y pulsa «Generate token».</li>
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
  if(mk.length){ lines.push(`\nMARCAS BOX:`); mk.forEach(l=>lines.push(`${l.fecha} · ${l.ejercicio}: ${l.valor} ${l.unidad}`)); }
  const sa = logs().filter(l=>l.tipo==="salud").slice(-15);
  if(sa.length){ lines.push(`\nSALUD:`); sa.forEach(l=>lines.push(`${l.fecha} · ${symName(l.sintoma)} · ${l.momento||""} · sueño ${l.sueno||"–"} h · ${l.comida||""} · hidratación ${l.agua||""}${l.tension?` · ${l.tension}`:""}${l.notas?` · ${l.notas}`:""}`)); }
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
  const titles = {resumen:"Tu semana",correr:"Correr",box:"Box",salud:"Salud",plan:"Plan",ajustes:"Ajustes"};
  $("#hdrTitle").textContent = v==="resumen" ? `Hola${S.athlete?.firstname?", "+S.athlete.firstname:""}` : titles[v];
  $("#hdrEyebrow").textContent = v==="resumen" ? `${DIAS[dow(new Date())]} ${fDate(new Date())}` : "Cuaderno de entreno";
  const app = $("#app"); const sameView = app.dataset.v===v;
  if(sameView) app.querySelectorAll("input[id],select[id],textarea[id]").forEach(el=>{ if(el.type!=="file") S.form[el.id]=el.value; });
  else S.form = {};
  const focusId = document.activeElement?.id;
  app.innerHTML = `<div class="stack ${sameView?"":"view"}">${({resumen:vResumen,correr:vCorrer,box:vBox,salud:vSalud,plan:vPlan,ajustes:vAjustes})[v]()}</div>`;
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
  const d = e.target.closest("[data-del]");
  if(d){ const id=d.dataset.del; if(!id){ S.confirmDel=null; render(); return; }
    if(d.dataset.sure){ delRec(id); S.confirmDel=null; toast("Borrado"); } else S.confirmDel=id;
    render(); return; }
  const a = e.target.closest("[data-act]"); if(!a) return;
  const act = a.dataset.act;
  if(act==="refresh") syncStrava(true);
  if(act==="sync") syncGist();
  if(act==="logout"){ S.tok=null; LS.del("stravaTok"); toast("Strava desconectado"); render(); }
  if(act==="ghoff"){ delete S.cfg.ghToken; delete S.cfg.gistId; saveCfg(); render(); }
  if(act==="export"){ const blob = new Blob([JSON.stringify({v:1, registros:S.recs}, null, 1)], {type:"application/json"}); const u = URL.createObjectURL(blob); const l = document.createElement("a"); l.href=u; l.download=`cuaderno-entreno-${today()}.json`; document.body.appendChild(l); l.click(); l.remove(); setTimeout(()=>URL.revokeObjectURL(u), 2000); }
  if(act==="copy"){ const txt = summaryText(); try{ await navigator.clipboard.writeText(txt); toast("Copiado. Pégalo en Claude y añade tu pregunta."); }catch(err){ const ta=$("#copyArea"); ta.hidden=false; ta.value=txt; ta.select(); toast("Selecciona y copia el texto"); } }
});
document.addEventListener("change", async e=>{
  if(e.target.id!=="importFile" || !e.target.files[0]) return;
  try{ const j = JSON.parse(await e.target.files[0].text()); const rs = (j.registros||[]).filter(r=>r && r.id && r.tipo);
    S.recs = merge(S.recs, rs); LS.set("recs", S.recs); schedulePush(); toast(`${rs.length} registros importados`); render(); }
  catch(err){ toast("Ese archivo no es una copia válida"); }
});
document.addEventListener("submit", e=>{
  const f = e.target.closest("form[data-form]"); if(!f) return;
  e.preventDefault();
  const kind = f.dataset.form, data = Object.fromEntries(new FormData(f).entries());
  if(kind==="strava"){ S.cfg.clientId = data.clientId.trim(); S.cfg.clientSecret = data.clientSecret.trim(); saveCfg(); location.href = stravaAuthUrl(); return; }
  if(kind==="gh"){ S.cfg.ghToken = data.ghToken.trim(); delete S.cfg.gistId; saveCfg(); delete S.err.sync; syncGist().then(()=>{ if(!S.err.sync) toast("Sincronización activada"); }); render(); return; }
  addRec({tipo:kind, ...data});
  f.querySelectorAll("input[id],textarea[id],select[id]").forEach(el=>{ delete S.form[el.id]; });
  toast("Guardado"); render();
});
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
if("serviceWorker" in navigator && location.protocol==="https:") navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
