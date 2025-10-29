// =======================
//  main.js (cliente Socket.IO solo polling)
// =======================

const API_BASE   = (window.CONFIG && window.CONFIG.API) || `${location.origin.replace(/\/$/,'')}/api`;
const DEVICE_ID  = (window.CONFIG && window.CONFIG.DEVICE_ID) || 1;
const SIO_BASE       = (window.CONFIG && window.CONFIG.SIO) || window.location.origin;
const SIO_NAMESPACE  = (window.CONFIG && window.CONFIG.SIO_NAMESPACE) || "/ws";
const SIO_EVENT_NAME = (window.CONFIG && window.CONFIG.SIO_EVENT) || "broadcast";

let sio = null;

function initSocket(){
  sio = io(`${SIO_BASE}${SIO_NAMESPACE}`, {
    transports: ["polling"],   // 👈 importante con Werkzeug/threading
    withCredentials: false
  });

  sio.on("connect", () => console.log("[SIO] conectado:", sio.id));
  sio.on("disconnect", (reason) => console.log("[SIO] desconectado:", reason));
  sio.on(SIO_EVENT_NAME, (payload) => {
    console.log("[PUSH]", payload);
    // appendPushToUI(payload);
  });
}

const $  = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>[...r.querySelectorAll(s)];
const wait = (ms)=>new Promise(r=>setTimeout(r,ms));

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
  loopActivo: false,
  loopToken: 0,
  cancelLoop: false
};

function setGrabUI(on){
  $("#btnGuardar").disabled=!on||state.pasos.length===0;
  $("#btnDetener").disabled=!on;
  const rs = $("#recStatus");
  rs.hidden = !on;
  rs.textContent = `Grabando: ${state.pasos.length} paso${state.pasos.length===1?"":"s"}…`;
}

window.addEventListener("DOMContentLoaded",()=>{
  const modeManual=$("#modeManual"),modeAuto=$("#modeAuto"),autoBar=$("#autoBar");
  const aplicarModo=m=>{
    state.modo=m;
    if(m==="AUTO")autoBar.classList.remove("d-none");
    else autoBar.classList.add("d-none");
  };
  modeManual.addEventListener("change",()=>{if(modeManual.checked){modeAuto.checked=false;aplicarModo("MANUAL");}});
  modeAuto.addEventListener("change",()=>{if(modeAuto.checked){modeManual.checked=false;aplicarModo("AUTO");}});

  $$("#flower .petal, #flower .leaf").forEach(b=>b.addEventListener("click",()=>handlePetal(b)));

  $("#btnGrabar").addEventListener("click",onGrabar);
  $("#btnGuardar").addEventListener("click",onGuardar);
  $("#btnCargar").addEventListener("click",onAbrirCargar);
  $("#btnDetener").addEventListener("click",onDetenerGrabacion);

  $("#btnReproducir").addEventListener("click",onReproducirSeleccion);
  $("#listaSecuencias").addEventListener("click",onSelectSecuencia);

  $("#btnSimObst").addEventListener("click",onObstaculo);
  $("#btnConfirmSi").addEventListener("click", ()=>{ state.pausa=false; });
  $("#btnConfirmNo").addEventListener("click", ()=>{});

  initSocket();
});

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

function onGrabar(){
  state.grabando=true;
  state.pasos=[];
  setGrabUI(true);
}
function onGuardar(){
  if(!state.grabando||state.pasos.length===0) return;
  const nombre=`DEMO ${new Date().toLocaleString()}`;
  apiPost("/secuencias/demo",{dispositivo_id:DEVICE_ID,nombre,pasos:state.pasos})
    .then(()=>{
      state.grabando=false;
      state.pasos=[];
      setGrabUI(false);
    })
    .catch(e=>console.error("Error guardando:",e.message));
}
function onDetenerGrabacion(){
  state.grabando=false;
  state.pasos=[];
  setGrabUI(false);
}

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
      if(state.pausa){ await wait(120); continue; }
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

async function onObstaculo(){
  const estaEnRun = !!(state.reproduciendo && state.run.run_id);
  try{
    await apiPost("/obstaculo/logica", {
      dispositivo_id: DEVICE_ID,
      obstaculo_clave: 1,
      modo:  estaEnRun ? "AUTO" : "MANUAL",
      run_id: estaEnRun ? state.run.run_id : null
    });
  }catch(e){
    console.error("Error obstáculo:", e.message);
  }
}
