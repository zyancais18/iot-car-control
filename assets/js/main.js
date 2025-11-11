// =======================
//  main.js (WebSocket nativo + control IoT)
// =======================
// antes:
// const API_BASE  = (window.CONFIG && window.CONFIG.API) || `http://${location.hostname}:5500/api`;
// const WS_TARGET = (window.CONFIG && window.CONFIG.WS)  || `ws://${location.hostname}:5501/ws`;

// después (fallbacks seguros por si olvidas CONFIG):
const API_BASE  = (window.CONFIG && window.CONFIG.API) || `https://${location.hostname}/api`;
const WS_TARGET = (window.CONFIG && window.CONFIG.WS)  || `wss://${location.hostname}/ws`;

const DEVICE_ID = 1;

const $  = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>[...r.querySelectorAll(s)];
const wait = (ms)=>new Promise(r=>setTimeout(r,ms));

// ---- Mapeo de velocidades (ms por paso al GRABAR) ----
// Sugerencia firmware (PWM aprox.): snail=80/255, fox=150/255, cheetah=255/255
const SPEED = {
  snail:   { label: "Caracol", ms: 400, pwm:  80 },
  fox:     { label: "Zorro",   ms: 200, pwm: 150 },
  cheetah: { label: "Guepardo",ms:  80, pwm: 255 }
};

async function apiGet(path){
  const res = await fetch(`${API_BASE}${path}`);
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function apiPost(path, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let errText = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.error) errText += ` - ${j.error}`; } catch(_){}
    throw new Error(errText);
  }
  return res.json();
}

const state = {
  modo: "MANUAL",
  grabando: false,
  pasos: [],
  reproduciendo: false,
  pausa: false,
  run: { run_id: null, sesion_id: null },
  secuenciaSeleccionada: null,

  // WebSocket
  ws: null,
  wsReady: false,
  wsRetry: 0
};

// ---------- UI helpers ----------
function setGrabUI(on){
  $("#btnGuardar").disabled=!on||state.pasos.length===0;
  $("#btnDetener").disabled=!on;
  const rs = $("#recStatus");
  rs.hidden = !on;
  rs.textContent = `Grabando: ${state.pasos.length} paso${state.pasos.length===1?"":"s"}…`;
}
function flashPetalByStatus(status){
  const btn = document.querySelector(`[data-status="${status}"]`);
  if(!btn) return;
  const prev = btn.style.outline;
  btn.style.outline = "3px solid #ffcc00";
  setTimeout(()=> btn.style.outline = prev || "none", 300);
}
function updateWsLast(obj){
  const el = $("#wsLast");
  if(!el) return; // puede no existir en esta versión
  try{ el.textContent = JSON.stringify(obj, null, 2); }catch(_){ el.textContent = String(obj); }
}
function showObstacleToast(){
  const toastEl = $("#toastObstacle");
  if(!toastEl) return;
  const t = bootstrap.Toast.getOrCreateInstance(toastEl, { delay: 2500 });
  t.show();
}

// ---------- WebSocket nativo ----------
function connectWS(){
  const ws = new WebSocket(WS_TARGET);
  state.ws = ws;

  ws.onopen = () => {
    state.wsReady = true;
    state.wsRetry = 0;
    // opcional: quitar ping si no quieres ver "pong" en monitores
    // try{ ws.send(JSON.stringify({type:"ping"})); }catch(_){}
  };

  ws.onmessage = (ev) => {
    let msg = ev.data;
    try{ msg = JSON.parse(ev.data); }catch(_){}
    updateWsLast(msg);

    const t = (msg && msg.type) || "";

    // Resaltar pétalo si viene status_clave
    const s = msg?.status_clave ?? msg?.status ?? msg?.data?.status_clave;
    if (typeof s === "number") flashPetalByStatus(s);

    // Si llega un obstáculo, muestra toast
    // (aceptamos varios formatos: type que empiece con "obstaculo" o presencia de obstaculo_clave)
    if ((typeof t === "string" && t.startsWith("obstaculo")) || msg?.obstaculo_clave != null) {
      showObstacleToast();
    }
  };

  ws.onclose = () => {
    state.wsReady = false;
    retryWS();
  };

  ws.onerror = () => {
    // el onclose hará el retry
  };
}
function retryWS(){
  state.wsRetry = Math.min(state.wsRetry + 1, 6);
  const delay = Math.min(1000 * 2 ** (state.wsRetry - 1), 15000);
  setTimeout(connectWS, delay);
}

// ---------- INIT ----------
window.addEventListener("DOMContentLoaded",()=>{
  // Conmutar modos
  const modeManual=$("#modeManual"),modeAuto=$("#modeAuto"),autoBar=$("#autoBar");
  const aplicarModo=m=>{
    state.modo=m;
    if(m==="AUTO")autoBar.classList.remove("d-none");
    else autoBar.classList.add("d-none");
  };
  modeManual.addEventListener("change",()=>{if(modeManual.checked){modeAuto.checked=false;aplicarModo("MANUAL");}});
  modeAuto.addEventListener("change",()=>{if(modeAuto.checked){modeManual.checked=false;aplicarModo("AUTO");}});

  // Flor
  $$("#flower .petal, #flower .leaf").forEach(b=>b.addEventListener("click",()=>handlePetal(b)));

  // Selector de velocidad -> actualiza msInput (solo lectura)
  const sel = $("#speedMode");
  const msInput = $("#msInput");
  const applySpeed = () => {
    const key = sel.value in SPEED ? sel.value : "fox";
    msInput.value = SPEED[key].ms;
  };
  sel.addEventListener("change", applySpeed);
  applySpeed(); // default

  // Botonera AUTO
  $("#btnGrabar").addEventListener("click",onGrabar);
  $("#btnGuardar").addEventListener("click",onGuardar);
  $("#btnCargar").addEventListener("click",onAbrirCargar);
  $("#btnDetener").addEventListener("click",onDetenerGrabacion);

  // Modal Cargar/Reproducir
  $("#btnReproducir").addEventListener("click",onReproducirSeleccion);
  $("#listaSecuencias").addEventListener("click",onSelectSecuencia);

  // WS
  connectWS();
});

// --- Pétalos ---
async function handlePetal(btn){
  const status=Number(btn.dataset.status);
  if(state.modo==="MANUAL"){
    try{
      await apiPost("/movimientos",{dispositivo_id:DEVICE_ID,status_clave:status});
    }catch(e){ console.error("Error movimiento manual:",e.message); }
  }else if(state.grabando){
    const ms=Math.max(50,Number($("#msInput").value||200));
    state.pasos.push({status,ms});
    const rs = $("#recStatus");
    rs.hidden = false;
    rs.textContent = `Grabando: ${state.pasos.length} paso${state.pasos.length===1?"":"s"}…`;
    $("#btnGuardar").disabled=state.pasos.length===0;
  }
}

// --- Grabar / Guardar / Detener (grabación) ---
function onGrabar(){ state.grabando=true; state.pasos=[]; setGrabUI(true); }
function onGuardar(){
  if(!state.grabando||state.pasos.length===0) return;
  const nombre=`DEMO ${new Date().toLocaleString()}`;
  apiPost("/secuencias/demo",{dispositivo_id:DEVICE_ID,nombre,pasos:state.pasos})
    .then(()=>{ state.grabando=false; state.pasos=[]; setGrabUI(false); })
    .catch(e=>console.error("Error guardando:",e.message));
}
function onDetenerGrabacion(){ state.grabando=false; state.pasos=[]; setGrabUI(false); }

// --- Cargar / Reproducir ---
let modalCargar;
function onAbrirCargar(){
  $("#listaSecuencias").innerHTML=`<div class="list-group-item">Cargando…</div>`;
  apiGet(`/secuencias/demo/ultimas20/${DEVICE_ID}`)
    .then(r=>{
      const lista=r?.data?.[0]||[];
      if(lista.length===0){ $("#listaSecuencias").innerHTML=`<div class="list-group-item">Sin secuencias</div>`; return; }
      $("#listaSecuencias").innerHTML=lista.map(s=>`
        <button type="button" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" data-id="${s.secuencia_id}">
          <span>#${s.secuencia_id??"-"} – ${s.nombre||"DEMO"}</span>
          <span class="badge bg-secondary">DEMO</span>
        </button>`).join("");
    })
    .catch(e=>{ $("#listaSecuencias").innerHTML=`<div class="list-group-item">Error: ${e.message}</div>`; });
  modalCargar=bootstrap.Modal.getOrCreateInstance($("#modalCargar"));
  modalCargar.show();
}
function onSelectSecuencia(ev){
  const item=ev.target.closest(".list-group-item");
  if(!item) return;
  $$("#listaSecuencias .list-group-item").forEach(li=>li.classList.remove("active"));
  item.classList.add("active");
  state.secuenciaSeleccionada=Number(item.dataset.id);
  $("#btnReproducir").disabled=false;
}

async function onReproducirSeleccion(){
  if(!state.secuenciaSeleccionada) return;
  const modalPlayer = bootstrap.Modal.getOrCreateInstance($("#modalPlayer"));
  modalPlayer.show();
  $("#carAnim").classList.add("moving");

  try{
    const r = await apiPost("/secuencias/demo/reproducir", {
      secuencia_id: state.secuenciaSeleccionada,
      dispositivo_id: DEVICE_ID,
      abrir_run: true
    });
    const header = r?.data?.[0]?.[0] || {};
    if(!header.run_id) throw new Error("No hubo run_id en la respuesta");
    state.run.run_id = header.run_id;
    state.run.sesion_id = header.sesion_id;
    state.reproduciendo = true;
    state.pausa = false;

    await loopSiguientePaso();
  }catch(e){
    console.error("Error al reproducir:", e.message);
  }finally{
    $("#carAnim").classList.remove("moving");
    state.reproduciendo = false;
    state.run = { run_id:null, sesion_id:null };
  }
}

async function loopSiguientePaso(){
  try{
    while(state.reproduciendo){
      const r = await apiPost("/secuencia/run/siguiente_paso", {
        run_id: state.run.run_id,
        sesion_id: state.run.sesion_id
      });
      const payload = r?.data?.[0]?.[0] || {};
      if(payload.estado === "FINALIZADA") break;
      await wait(Math.max(120, Number(payload.v_ms || 200)));
    }
  }catch(e){
    console.warn("Reproducción detenida:", e.message);
  }
}

