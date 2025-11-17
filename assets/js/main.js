// =======================
//  main.js (WebSocket nativo + control IoT)
// =======================

const API_BASE  = (window.CONFIG && window.CONFIG.API) || `http://34.196.181.221:5500/api`;
const WS_TARGET = (window.CONFIG && window.CONFIG.WS)  || `ws://34.196.181.221:5501/ws`;
const DEVICE_ID = 1;

const $  = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>[...r.querySelectorAll(s)];
const wait = (ms)=>new Promise(r=>setTimeout(r,ms));

// ---- Presets de TIEMPO (ms por paso al GRABAR) ----
const SPEED = {
  snail:   { label: "Caracol",  ms: 3000, pwm:  80 },
  fox:     { label: "Zorro",    ms: 2000, pwm: 150 },
  cheetah: { label: "Guepardo", ms: 1000, pwm: 255 }
};

// ---- Presets de velocidad (0–9 y 'q' = MAX) mapeados a 0–255 ----
const VEL_PRESETS = {
  "0": 0,
  "1": 28,
  "2": 56,
  "3": 84,
  "4": 112,
  "5": 140,
  "6": 168,
  "7": 196,
  "8": 224,
  "9": 240,
  "q": 255
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
  secuenciaSeleccionada: null,

  // Velocidad actual (preset 0–9 o 'q' y valor 0–255)
  velPreset: "5",
  velocidad: VEL_PRESETS["5"],

  // Reproducción AUTO
  reproduciendo: false,

  // WebSocket
  ws: null,
  wsReady: false,
  wsRetry: 0
};

// ---------- UI helpers ----------
function setGrabUI(on){
  $("#btnGuardar").disabled = !on || state.pasos.length === 0;
  $("#btnDetener").disabled = !on;
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
  const el = $("#wsLast"); // opcional, puede no existir
  if(!el) return;
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

// ---------- Velocidad presets ----------
function setVelocidadPreset(preset){
  if (!(preset in VEL_PRESETS)) preset = "5";
  state.velPreset = preset;
  state.velocidad = VEL_PRESETS[preset];

  // actualizar estilos de los botones
  $$("#speedPresets .speed-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.speed === preset);
  });
}

// ---------- INIT ----------
let modalCargar;

window.addEventListener("DOMContentLoaded",()=>{
  // Conmutar modos
  const modeManual   = $("#modeManual");
  const modeAuto     = $("#modeAuto");
  const autoControls = $("#autoControls");

  const aplicarModo = m => {
    state.modo = m;
    if(m === "AUTO") autoControls.classList.remove("d-none");
    else autoControls.classList.add("d-none");
  };

  modeManual.addEventListener("change",()=>{
    if(modeManual.checked){
      modeAuto.checked=false;
      aplicarModo("MANUAL");
    }
  });
  modeAuto.addEventListener("change",()=>{
    if(modeAuto.checked){
      modeManual.checked=false;
      aplicarModo("AUTO");
    }
  });
  aplicarModo("MANUAL"); // estado inicial

  // Flor
  $$("#flower .petal, #flower .leaf").forEach(b =>
    b.addEventListener("click",()=>handlePetal(b))
  );

  // Selector de velocidad TIEMPO -> actualiza msInput (solo lectura)
  const sel = $("#speedMode");
  const msInput = $("#msInput");
  const applySpeed = () => {
    if (!sel || !msInput) return;
    const key = sel.value in SPEED ? sel.value : "fox";
    msInput.value = SPEED[key].ms;
  };
  if (sel && msInput) {
    sel.addEventListener("change", applySpeed);
    applySpeed(); // default
  }

  // Presets de VELOCIDAD (0–9, MAX) – siempre visibles
  const speedButtons = $$("#speedPresets .speed-btn");
  if (speedButtons.length){
    speedButtons.forEach(btn => {
      btn.addEventListener("click", () => setVelocidadPreset(btn.dataset.speed));
    });
    setVelocidadPreset(state.velPreset || "5");
  }

  // Botonera AUTO (grabación)
  $("#btnGrabar").addEventListener("click", onGrabar);
  $("#btnGuardar").addEventListener("click", onGuardar);
  $("#btnCargar").addEventListener("click", onAbrirCargar);
  $("#btnDetener").addEventListener("click", onDetenerGrabacion);

  // Modal Cargar/Reproducir
  $("#btnReproducir").addEventListener("click", onReproducirSeleccion);
  $("#listaSecuencias").addEventListener("click", onSelectSecuencia);

  // Modal Player: al cerrar, detenemos reproducción
  const modalPlayerEl = $("#modalPlayer");
  modalPlayerEl.addEventListener("hidden.bs.modal", () => {
    state.reproduciendo = false;
    const car = $("#carAnim");
    if (car) car.classList.remove("moving");
  });
  $("#btnExitRun").addEventListener("click", () => {
    state.reproduciendo = false;
  });

  // WS
  connectWS();
});

// --- Pétalos ---
async function handlePetal(btn){
  const status = Number(btn.dataset.status);

  if (state.modo === "MANUAL") {
    try{
      await apiPost("/movimientos", {
        dispositivo_id: DEVICE_ID,
        status_clave: status,
        modo: "MANUAL",
        velocidad: typeof state.velocidad === "number" ? state.velocidad : 0,
        duracion_ms: 0
      });
    }catch(e){
      console.error("Error movimiento manual:", e.message);
    }

  } else if (state.grabando) {
    const ms = Math.max(50, Number($("#msInput").value || 200));
    const velocidad = typeof state.velocidad === "number" ? state.velocidad : 0;

    // ahora cada paso lleva status, ms y velocidad (0–255)
    state.pasos.push({ status, ms, velocidad });

    const rs = $("#recStatus");
    rs.hidden = false;
    rs.textContent = `Grabando: ${state.pasos.length} paso${state.pasos.length===1?"":"s"}…`;
    $("#btnGuardar").disabled = state.pasos.length === 0;
  }
}

// --- Grabar / Guardar / Detener (grabación AUTO) ---
function onGrabar(){
  state.grabando = true;
  state.pasos = [];
  setGrabUI(true);
}

function onGuardar(){
  if (!state.grabando || state.pasos.length === 0) return;

  const nombre = `DEMO ${new Date().toLocaleString()}`;

  apiPost("/secuencias/demo", {
    dispositivo_id: DEVICE_ID,
    nombre,
    pasos: state.pasos
  })
  .then(() => {
    state.grabando = false;
    state.pasos = [];
    setGrabUI(false);
  })
  .catch(e => console.error("Error guardando:", e.message));
}

function onDetenerGrabacion(){
  state.grabando = false;
  state.pasos = [];
  setGrabUI(false);
}

// --- Cargar / Seleccionar secuencia ---
function onAbrirCargar(){
  $("#listaSecuencias").innerHTML = `<div class="list-group-item">Cargando…</div>`;

  apiGet(`/secuencias/demo/ultimas20/${DEVICE_ID}`)
    .then(r => {
      const lista = r?.data?.[0] || [];
      if (lista.length === 0) {
        $("#listaSecuencias").innerHTML = `<div class="list-group-item">Sin secuencias</div>`;
        return;
      }

      $("#listaSecuencias").innerHTML = lista.map(s => `
        <button type="button"
                class="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
                data-id="${s.secuencia_id}">
          <span>#${s.secuencia_id ?? "-"} – ${s.nombre || "DEMO"}</span>
          <span class="badge bg-secondary">DEMO</span>
        </button>
      `).join("");
    })
    .catch(e => {
      $("#listaSecuencias").innerHTML = `<div class="list-group-item">Error: ${e.message}</div>`;
    });

  modalCargar = bootstrap.Modal.getOrCreateInstance($("#modalCargar"));
  modalCargar.show();
}

function onSelectSecuencia(ev){
  const item = ev.target.closest(".list-group-item");
  if (!item) return;
  $$("#listaSecuencias .list-group-item").forEach(li => li.classList.remove("active"));
  item.classList.add("active");
  state.secuenciaSeleccionada = Number(item.dataset.id);
  $("#btnReproducir").disabled = false;
}

// --- Reproducir secuencia en cliente (llamando /movimientos paso a paso) ---
async function onReproducirSeleccion(){
  if (!state.secuenciaSeleccionada) return;

  if (modalCargar) modalCargar.hide();

  const modalPlayer = bootstrap.Modal.getOrCreateInstance($("#modalPlayer"));
  modalPlayer.show();

  const car = $("#carAnim");
  if (car) car.classList.add("moving");

  state.reproduciendo = true;

  try {
    const r = await apiGet(`/secuencias/demo/${state.secuenciaSeleccionada}`);
    const pasos = r?.data?.[1] || [];

    for (const paso of pasos) {
      if (!state.reproduciendo) break;

      const status_clave = Number(paso.status_clave);
      const ms = Math.max(50, Number(paso.ms || 200));
      const velocidad = Math.max(
        0,
        Math.min(255, Number(paso.velocidad ?? state.velocidad ?? 0))
      );

      await apiPost("/movimientos", {
        dispositivo_id: DEVICE_ID,
        status_clave,
        modo: "AUTO",
        velocidad,
        duracion_ms: ms
      });

      await wait(ms);
    }

  } catch (e) {
    console.error("Error al reproducir:", e.message);
  } finally {
    state.reproduciendo = false;
    if (car) car.classList.remove("moving");
    modalPlayer.hide();
  }
}
