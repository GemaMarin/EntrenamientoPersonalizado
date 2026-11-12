/* =========================================================
   Cuerpo: músculos, mapa movimiento → músculos y figura SVG (delante / detrás)
   ========================================================= */
(function(){
"use strict";

const MUSCLES = {
  hombros:   {n:"Hombros",      v:["f","b"]},
  pecho:     {n:"Pecho",        v:["f"]},
  biceps:    {n:"Bíceps",       v:["f"]},
  antebrazos:{n:"Antebrazos",   v:["f","b"]},
  abdomen:   {n:"Abdomen",      v:["f"]},
  oblicuos:  {n:"Oblicuos",     v:["f"]},
  cuadriceps:{n:"Cuádriceps",   v:["f"]},
  aductores: {n:"Aductores",    v:["f"]},
  gemelos:   {n:"Gemelos",      v:["f","b"]},
  trapecio:  {n:"Trapecio",     v:["f","b"]},
  dorsales:  {n:"Dorsales",     v:["b"]},
  triceps:   {n:"Tríceps",      v:["b"]},
  lumbar:    {n:"Lumbar",       v:["b"]},
  gluteos:   {n:"Glúteos",      v:["b"]},
  isquios:   {n:"Isquiotibiales", v:["b"]}
};

// Del más específico al más genérico: cada línea del WOD se asigna al primer patrón que encaja
const MOVES = [
  ["Sumo deadlift high pull", /sdhp|sumo deadlift high pull|high pull/i, {gluteos:.7,trapecio:.8,hombros:.6,isquios:.5,aductores:.4}],
  ["Peso muerto rumano", /roman|rumano|\brdl\b|stiff/i, {isquios:1,gluteos:.8,lumbar:.6}],
  ["Peso muerto sumo", /sumo dead/i, {gluteos:.9,aductores:.7,isquios:.7,lumbar:.6,cuadriceps:.4,antebrazos:.4}],
  ["Peso muerto", /dead ?lift|peso muerto/i, {isquios:1,gluteos:.9,lumbar:.8,trapecio:.4,antebrazos:.5}],
  ["Wall balls", /wall ?ball/i, {cuadriceps:.8,gluteos:.5,hombros:.7,triceps:.4}],
  ["Thrusters", /thruster/i, {cuadriceps:.9,gluteos:.6,hombros:.8,triceps:.5,abdomen:.3}],
  ["Overhead squat", /overhead squat|\bohs\b/i, {cuadriceps:.9,gluteos:.6,hombros:.6,abdomen:.6,trapecio:.4}],
  ["Kang squat", /kang/i, {isquios:.7,gluteos:.6,cuadriceps:.5,lumbar:.4}],
  ["Front squat", /front ?squat|front rack squat/i, {cuadriceps:1,gluteos:.6,abdomen:.5,aductores:.3}],
  ["Pistols", /pistol/i, {cuadriceps:1,gluteos:.7,abdomen:.3}],
  ["Zancadas", /lunge|zancada|split squat/i, {cuadriceps:.9,gluteos:.9,aductores:.4,isquios:.3}],
  ["Back squat", /squat|sentadilla/i, {cuadriceps:1,gluteos:.8,aductores:.5,lumbar:.4,abdomen:.3}],
  ["Snatch", /snatch|arrancada/i, {gluteos:.8,isquios:.6,cuadriceps:.7,trapecio:.8,hombros:.7,lumbar:.5}],
  ["Clean & jerk", /clean ?(and|&) ?jerk/i, {gluteos:.8,isquios:.6,cuadriceps:.7,trapecio:.7,hombros:.7,triceps:.5,lumbar:.4}],
  ["Clean", /clean|cargada/i, {gluteos:.8,isquios:.7,cuadriceps:.7,trapecio:.8,lumbar:.5,hombros:.3}],
  ["Devil press", /devil/i, {hombros:.7,gluteos:.6,isquios:.5,pecho:.4,triceps:.4,cuadriceps:.4}],
  ["Jerk / press", /jerk|push press|shoulder press|strict press|press militar|\bhspu\b|handstand push/i, {hombros:1,triceps:.8,trapecio:.4,abdomen:.3}],
  ["KB swings", /swing/i, {gluteos:1,isquios:.8,lumbar:.5,hombros:.3,antebrazos:.4}],
  ["Hip thrust", /hip thrust|glute bridge|puente/i, {gluteos:1,isquios:.4}],
  ["Good morning", /good morning/i, {isquios:.8,lumbar:.8,gluteos:.4}],
  ["Muscle-ups", /muscle[ -]?ups?/i, {dorsales:1,triceps:.7,pecho:.5,biceps:.5,abdomen:.4}],
  ["Dips", /dips?\b|fondos/i, {triceps:1,pecho:.7,hombros:.5}],
  ["Press banca / flexiones", /bench|floor press|press banca|push ?ups?|flexion/i, {pecho:1,triceps:.7,hombros:.5,abdomen:.2}],
  ["Remo con barra / anillas", /barbell row|supine row|ring row|gorila|gorilla|bent over|db row|kb row|pendlay/i, {dorsales:1,biceps:.6,trapecio:.5,antebrazos:.4,lumbar:.3}],
  ["Dominadas", /pull[ -]?ups?|chin[ -]?ups?|c2b|chest to bar|dominada/i, {dorsales:1,biceps:.7,antebrazos:.5,trapecio:.3,abdomen:.2}],
  ["Toes to bar", /toes ?to ?bar|t2b|ttb|knees ?to ?elbow|k2e/i, {abdomen:1,oblicuos:.5,dorsales:.4,antebrazos:.4}],
  ["Plancha lateral", /side plank|plancha lateral/i, {oblicuos:1,abdomen:.5,hombros:.3}],
  ["Abdominales", /sit[ -]?ups?|v[ -]?ups?|plank|plancha|hollow|crunch|ghd|l[ -]?sit|abmat/i, {abdomen:1,oblicuos:.5}],
  ["Comba", /double ?unders?|single ?unders?|\bdu\b|dobles|comba/i, {gemelos:1,hombros:.2,antebrazos:.2}],
  ["Box jumps", /box ?jump|bjo|salto al caj/i, {cuadriceps:.7,gluteos:.6,gemelos:.7}],
  ["Burpees", /burpee/i, {pecho:.5,cuadriceps:.5,hombros:.4,abdomen:.4,gemelos:.3,triceps:.3}],
  ["Wall climb", /wall climb|wall walk/i, {hombros:.9,abdomen:.6,triceps:.4,pecho:.3}],
  ["Remo (ergómetro)", /\d+\s*(m|cal)\s*row|\brow(ing)?\b|remo/i, {dorsales:.6,cuadriceps:.6,isquios:.4,lumbar:.3,biceps:.3}],
  ["SkiErg", /\bski/i, {dorsales:.7,triceps:.6,abdomen:.5,hombros:.3}],
  ["Bici", /bike|bici|assault|echo/i, {cuadriceps:.8,gluteos:.4,gemelos:.3,hombros:.2}],
  ["Trineo", /sled|trineo/i, {cuadriceps:.8,gluteos:.7,gemelos:.5}],
  ["Farmer carry", /farmer|carry|paseo/i, {antebrazos:1,trapecio:.8,abdomen:.4}],
  ["Face pull", /face ?pull/i, {hombros:.8,trapecio:.6}],
  ["Elevaciones de hombro", /raise|elevaci|fly/i, {hombros:1}],
  ["Curl de bíceps", /curl/i, {biceps:1,antebrazos:.5}],
  ["Tríceps", /tricep|skull|crush|crash|extension/i, {triceps:1}],
  ["Lanzamientos", /toss|slam|lanzamiento/i, {hombros:.5,abdomen:.5,pecho:.4}],
  ["Carrera", /\brun\b|\bm run|carrera|correr|sprint/i, {cuadriceps:.6,isquios:.6,gemelos:.8,gluteos:.5}]
];

// Músculos de un texto de WOD: {vector normalizado (máx 1), movimientos detectados}
function analyze(text){
  const vec = {}, moves = {};
  String(text||"").split(/\n/).forEach(line => {
    const l = line.trim(); if(!l || /^\*?\s*accessor/i.test(l) || /^rest\b|^descanso/i.test(l)) return;
    const mv = MOVES.find(([,re]) => re.test(l));
    if(!mv) return;
    moves[mv[0]] = (moves[mv[0]]||0) + 1;
    Object.entries(mv[2]).forEach(([k,w]) => vec[k] = (vec[k]||0) + w);
  });
  const mx = Math.max(0, ...Object.values(vec));
  if(mx) Object.keys(vec).forEach(k => vec[k] = vec[k]/mx);
  return {vec, moves};
}
const RUN = {cuadriceps:.7,isquios:.7,gemelos:1,gluteos:.6,abdomen:.15};

/* ---------- Figura ----------
   Medio cuerpo (lado izquierdo de la imagen, x ≤ 100) y se refleja. viewBox 200 × 440. */
const BASE = [
  "M100 18 a17 19 0 1 0 0.1 0 Z",                                                   // cabeza
  "M91 50 L109 50 L110 64 L90 64 Z",                                                 // cuello
  "M76 66 Q100 58 124 66 Q138 70 140 84 L134 116 Q129 146 126 166 Q130 184 130 200 L70 200 Q70 184 74 166 Q71 146 66 116 L60 84 Q62 70 76 66 Z", // torso
  "M64 74 Q50 78 49 98 Q46 128 46 150 Q42 178 40 204 Q41 212 47 214 Q52 214 54 206 Q60 178 64 152 Q70 124 70 100 Z", // brazo
  "M136 74 Q150 78 151 98 Q154 128 154 150 Q158 178 160 204 Q159 212 153 214 Q148 214 146 206 Q140 178 136 152 Q130 124 130 100 Z",
  "M72 196 L99 202 Q99 252 96 298 Q96 350 92 402 L77 402 Q72 350 73 300 Q66 250 72 196 Z",   // pierna
  "M128 196 L101 202 Q101 252 104 298 Q104 350 108 402 L123 402 Q128 350 127 300 Q134 250 128 196 Z",
  "M74 402 Q84 398 94 402 Q96 412 90 416 L72 416 Q68 410 74 402 Z",                 // pies
  "M126 402 Q116 398 106 402 Q104 412 110 416 L128 416 Q132 410 126 402 Z"
];
const FRONT = {
  trapecio:  ["M90 62 Q95 66 100 66 L100 72 Q88 72 76 76 Q82 66 90 62 Z"],
  hombros:   ["M75 75 Q61 75 55 91 Q53 103 57 111 Q65 101 75 96 Q81 86 75 75 Z"],
  pecho:     ["M78 79 Q90 75 99 78 L99 115 Q86 119 74 111 Q66 103 70 93 Q72 84 78 79 Z"],
  biceps:    ["M56 115 Q52 130 54 147 Q60 151 65 145 Q69 130 67 113 Q61 109 56 115 Z"],
  antebrazos:["M53 152 Q48 172 45 196 Q49 201 55 198 Q63 176 65 152 Q59 156 53 152 Z"],
  abdomen:   ["M85 120 Q92 118 99 120 L99 193 Q92 196 87 192 Q83 160 85 120 Z"],
  oblicuos:  ["M74 116 Q80 120 83 122 Q81 160 85 192 Q78 188 75 176 Q70 150 74 116 Z"],
  cuadriceps:["M75 206 Q86 203 94 210 Q97 250 92 288 Q84 294 77 288 Q69 250 75 206 Z"],
  aductores: ["M95 212 Q98 213 99 216 L99 250 Q97 266 94 274 Q97 244 95 212 Z"],
  gemelos:   ["M79 308 Q86 304 92 310 Q94 342 89 380 Q83 383 79 379 Q75 342 79 308 Z"]
};
const BACK = {
  trapecio:  ["M100 58 Q92 64 78 76 Q90 84 100 112 Z"],
  hombros:   ["M75 75 Q61 75 55 91 Q53 103 57 111 Q65 101 75 96 Q81 86 75 75 Z"],
  triceps:   ["M56 113 Q52 131 55 149 Q61 152 67 146 Q70 128 68 111 Q61 107 56 113 Z"],
  antebrazos:["M53 152 Q48 172 45 196 Q49 201 55 198 Q63 176 65 152 Q59 156 53 152 Z"],
  dorsales:  ["M73 92 Q86 96 99 114 L99 150 Q90 162 80 168 Q72 140 69 108 Q69 96 73 92 Z"],
  lumbar:    ["M86 160 Q93 156 99 156 L99 194 Q92 195 87 191 Q84 176 86 160 Z"],
  gluteos:   ["M74 197 Q88 193 99 199 L99 236 Q86 244 76 236 Q70 216 74 197 Z"],
  isquios:   ["M76 241 Q88 247 97 243 Q97 270 92 295 Q84 299 78 293 Q70 268 76 241 Z"],
  gemelos:   ["M77 304 Q86 299 94 305 Q96 330 90 352 Q82 356 76 350 Q72 328 77 304 Z"]
};
const LABEL = {f:{hombros:[57,92],pecho:[86,96],biceps:[60,130],abdomen:[92,156],cuadriceps:[85,250],gemelos:[85,345]}, b:{dorsales:[85,130],gluteos:[87,218],isquios:[86,270],triceps:[61,130]}};

function level(v){ return v<=0.001 ? 0 : v<.2 ? 1 : v<.4 ? 2 : v<.65 ? 3 : 4; }
function figure(side, vec, opts={}){
  const map = side==="f" ? FRONT : BACK, sel = opts.sel;
  const mus = Object.entries(map).map(([k,paths]) => {
    const lv = level(vec[k]||0), cls = `m l${lv}${sel===k?" sel":""}`;
    const p = paths.map(d => `<path d="${d}"/><path d="${d}" transform="translate(200 0) scale(-1 1)"/>`).join("");
    return `<g class="${cls}" data-mus="${k}" tabindex="0" role="button" aria-label="${MUSCLES[k].n}"><title>${MUSCLES[k].n}${vec[k]?` · ${Math.round(vec[k]*100)} %`:""}</title>${p}</g>`;
  }).join("");
  const gid = "g"+side+(opts.id||"");
  return `<svg class="bodysvg" viewBox="0 0 200 430" role="img" aria-label="Cuerpo ${side==="f"?"de frente":"de espaldas"}">
    <defs>
      <radialGradient id="${gid}" cx="50%" cy="38%" r="65%"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></radialGradient>
    </defs>
    <ellipse cx="100" cy="420" rx="46" ry="7" class="floor"/>
    <g class="base">${BASE.map(d=>`<path d="${d}"/>`).join("")}</g>
    ${mus}
    <g pointer-events="none" fill="url(#${gid})">${BASE.map(d=>`<path d="${d}"/>`).join("")}</g>
  </svg>`;
}
function flipper(vec, opts={}){
  const back = opts.side==="b";
  return `<div class="flip ${opts.small?"small":""}" data-flip>
    <div class="flip-in ${back?"back":""}">
      <div class="face front">${figure("f", vec, opts)}</div>
      <div class="face backf">${figure("b", vec, opts)}</div>
    </div></div>`;
}
window.Body = {MUSCLES, MOVES, analyze, RUN, figure, flipper, level};
})();
