/* ==========================================================================
   PAINEL DA CENTRAL
   Dois modos, com a mesma interface:
     • servidor — os dados vêm do servidor Node.js por WebSocket (login obrigatório);
     • demo     — sem servidor (ex.: portfolio ou ficheiro aberto do disco): o motor
                  de simulação corre aqui no browser e fala com a app do motorista
                  pelo BroadcastChannel.
   ========================================================================== */
const C = FrotaCore;
const { clamp, fmtHM, fmtKm, fmtTime, fmtDate, fmtDuration, nearestCity, TERRAIN, STATUS, CATS,
  terrainOf, loadRatio, destination, origin, remainingKm, partRemainingKm, wearMult } = C;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = () => lucide.createIcons({ nameAttr: 'data-lucide' });
const inIframe = window.self !== window.top;

// ---------- Estado no browser (cópia do que a central envia) ----------
let simNow = Date.now(), simSpeed = 60, paused = false;
let vehicles = [], incidents = [], alerts = [], threads = {};
let online = new Set();
let mode = null;                 // 'servidor' | 'demo'
let source = { send() {} };      // para onde vão as ações do gestor
let demoEngine = null;           // motor local (só no modo demo)
let currentUser = null;

const byId = (id) => vehicles.find(v => v.id === id);
const isOnline = (vid) => online.has(vid);
const etaDate = (v) => C.etaMs(v, simNow, incidents);
const fmtWhen = (t) => C.fmtWhen(t, simNow);
const action = (m) => source.send(m);

const SEV = {
  critico: { label: 'Crítico', cls: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-600', icon: 'octagon-alert' },
  aviso:   { label: 'Aviso',   cls: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500', icon: 'triangle-alert' },
  info:    { label: 'Info',    cls: 'bg-blue-50 text-blue-700 border-blue-200', dot: 'bg-blue-500', icon: 'info' },
};
const QUICK = ['Qual a tua previsão de chegada?', 'Faz a pausa na próxima área de serviço.', 'Atenção: trânsito à frente, considera rota alternativa.', 'Confirma a entrega quando terminares.'];
let browserNotif = false;

/* ==========================================================================
   MENSAGENS RECEBIDAS DA CENTRAL (iguais nos dois modos)
   ========================================================================== */
function handle(m) {
  switch (m.type) {
    case 'init': if (m.user) { currentUser = m.user; setModeBadge(); } applyInit(m.state); break;
    case 'users': if (currentTab === 'utilizadores') loadUsers(); break;
    case 'costs': if (currentTab === 'relatorios') loadReport(); break;
    case 'error': showToast({ sev: 'aviso', title: 'Não foi possível', text: m.error }); break;
    case 'tick': applyTick(m); break;
    case 'alert': onAlert(m.alert); break;
    case 'alertPatch': onAlertPatch(m); break;
    case 'thread': onThread(m); break;
  }
}

function applyInit(st) {
  simNow = st.simNow; simSpeed = st.simSpeed; paused = st.paused;
  vehicles = st.vehicles;
  vehicles.forEach(v => { if (!v.segLens) C.prepareVehicle(v); });
  incidents = st.incidents; alerts = st.alerts; threads = st.threads;
  online = new Set(st.online || []);
  if (!selectedId && !inIframe) selectedId = 'v1';
  setupMap();
  syncControls();
  render(); renderBell(); renderAlertsView();
  if (currentTab === 'mensagens') { renderThreads(); renderChat(); }
}

function applyTick(m) {
  simNow = m.simNow; simSpeed = m.simSpeed; paused = m.paused;
  m.vehicles.forEach(l => { const v = byId(l.id); if (v) Object.assign(v, l); });
  incidents = m.incidents;
  online = new Set(m.online || []);
  syncIncidents();
  syncControls();
  render();
}

function onAlert(a) {
  alerts.unshift(a);
  if (alerts.length > 500) alerts.length = 500;
  if (a.toast) showToast(a);
  if (browserNotif && a.sev !== 'info' && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(a.title, { body: a.text }); } catch (e) { /* ignorar */ }
  }
  renderBell(); renderAlertsView(); renderKPIs();
}
function onAlertPatch(p) {
  if (p.all) alerts.forEach(a => a.read = true);
  else { const a = alerts.find(x => x.id === p.id); if (a) { a.read = p.read; a.resolved = p.resolved; } }
  renderBell(); renderAlertsView();
}
function onThread(m) {
  threads[m.vid] = m.messages;
  const v = byId(m.vid);
  if (v) v.unread = m.unread || 0;
  // conversa aberta no ecrã: marcar como lida
  if (v && v.unread && currentTab === 'mensagens' && activeThread === m.vid) { v.unread = 0; action({ type: 'readThread', vid: m.vid }); }
  renderThreads(); if (activeThread === m.vid) renderChat(); renderMsgCount(); renderList();
}

/* ==========================================================================
   MODO SERVIDOR
   ========================================================================== */
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || 'Erro'), { status: r.status });
  return body;
}

function startServer(user) {
  mode = 'servidor'; currentUser = user;
  $('loginOverlay').classList.add('hidden');
  setModeBadge();
  let ws = null, retry = 0;
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=gestor`);
    ws.onopen = () => { retry = 0; setConn(true); };
    ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = async () => {
      setConn(false);
      // sessão expirada? volta ao login; senão tenta religar
      try { await api('/api/me?role=gestor'); } catch (err) { if (err.status === 401) return showLogin(); }
      setTimeout(open, Math.min(10000, 1000 * 2 ** retry++));
    };
  };
  open();
  source = { send: (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); } };
}

function showLogin() {
  $('loginOverlay').classList.remove('hidden');
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  $('loginHint').classList.toggle('hidden', !local);
  setTimeout(() => $('loginEmail').focus(), 50);
}
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').classList.add('hidden');
  const btn = $('loginBtn'); btn.disabled = true;
  try {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ role: 'gestor', email: $('loginEmail').value, password: $('loginPass').value }) });
    $('loginPass').value = '';
    startServer(r.user);
  } catch (err) {
    $('loginError').textContent = err.message; $('loginError').classList.remove('hidden');
  } finally { btn.disabled = false; }
});

async function logout() {
  try { await api('/api/logout', { method: 'POST', body: JSON.stringify({ role: 'gestor' }) }); } catch (e) { /* ignorar */ }
  location.reload();
}

/* ==========================================================================
   MODO DEMO (sem servidor)
   ========================================================================== */
function startDemo() {
  mode = 'demo';
  setModeBadge();
  // cópia profunda que partilha os textos: as fotos e PDFs (data URLs de vários MB) não são duplicados a cada 0,5 s
  const clone = (x) => x === null || typeof x !== 'object' ? x : Array.isArray(x) ? x.map(clone) : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clone(v)]));
  // portal da oficina: cada anexo só segue com o ficheiro uma vez por separador (depois vai sem url, e o portal usa a cópia que guardou)
  const sentAtt = {};   // oficina -> Set(ids de anexos já enviados)
  const slim = (wid, snap) => {
    const sent = sentAtt[wid] || (sentAtt[wid] = new Set());
    const strip = (a) => { if (sent.has(a.id)) return { ...a, url: null }; sent.add(a.id); return a; };
    return { ...snap,
      vehicles: snap.vehicles.map(v => ({ ...v, workshop: { ...v.workshop, attachments: (v.workshop.attachments || []).map(strip) } })),
      history: snap.history.map(h => ({ ...h, attachments: (h.attachments || []).map(strip) })) };
  };
  let ready = false;
  const bus = 'BroadcastChannel' in window ? new BroadcastChannel('frota-norte-sul') : null;
  const post = (m) => { if (bus) try { bus.postMessage(m); } catch (e) { /* ignorar */ } };
  const initial = C.createInitialState();
  // 30 dias de custos para os relatórios não começarem vazios
  const hist = C.generateHistory(initial, 30);
  hist.daily.forEach(r => { initial.daily[`${r.day}|${r.vehicleId}|${r.driver}`] = r; });
  initial.expenses = hist.expenses.sort((a, b) => b.time - a.time);
  const engine = demoEngine = new C.Engine(initial, {
    onAlert: (a) => { if (ready) handle({ type: 'alert', alert: clone(a) }); },
    onAlertPatch: (p) => { if (ready) handle({ type: 'alertPatch', ...p }); },
    onExpense: () => { if (ready) handle({ type: 'costs' }); },
    onExpenseDelete: () => { if (ready) handle({ type: 'costs' }); },
    onTariffs: () => { if (ready) handle({ type: 'costs' }); },
    onWorkshopEvent: (wid, n) => post({ type: 'oficinaNotify', workshopId: wid, ...n }),
    onMessage: (vid) => {
      if (!ready) return;
      handle({ type: 'thread', vid, messages: clone(engine.s.threads[vid]), unread: engine.byId(vid).unread });
      post({ type: 'thread', vid, messages: engine.s.threads[vid] });
    },
  });
  engine.initialAlerts();
  ready = true;
  handle({ type: 'init', state: clone(engine.fullState()) });
  source = { send: (m) => engine.managerAction(m) };

  // ligação à app do motorista e ao portal da oficina abertos noutros separadores do mesmo browser
  const seen = {};     // vid -> último sinal (ms reais)
  const wsSeen = {};   // oficina -> último sinal
  engine.workshopsOnline = new Set();
  engine.allowInlineAttachments = true;   // sem servidor, os ficheiros ficam em memória (data URL)
  if (bus) bus.onmessage = (e) => {
    const m = e.data;
    if (m && m.type === 'oficinaHello') {
      wsSeen[m.workshopId] = Date.now(); engine.workshopsOnline.add(m.workshopId);
      if (m.fresh) sentAtt[m.workshopId] = new Set();   // portal acabado de abrir: precisa dos ficheiros todos
      return;
    }
    if (m && m.type === 'oficinaAction') {
      wsSeen[m.workshopId] = Date.now(); engine.workshopsOnline.add(m.workshopId);
      const error = engine.workshopAction(m.workshopId, m.by, m.action);
      post({ type: 'oficinaResult', workshopId: m.workshopId, error });
      render();
      return;
    }
    if (!m || !m.vid || !engine.byId(m.vid)) return;
    if (m.type === 'bye') { delete seen[m.vid]; engine.driverDisconnected(m.vid); return; }
    seen[m.vid] = Date.now();
    engine.driverConnected(m.vid);
    if (m.type === 'hello') { if (m.sync) post({ type: 'thread', vid: m.vid, messages: engine.s.threads[m.vid] }); return; }
    engine.driverAction(m.vid, m);
  };

  setInterval(() => {
    engine.tick(0.5);
    // 75 s de margem: o browser abranda os separadores em segundo plano
    Object.keys(seen).forEach(vid => { if (Date.now() - seen[vid] > 75000) { delete seen[vid]; engine.driverDisconnected(vid); } });
    Object.keys(wsSeen).forEach(w => { if (Date.now() - wsSeen[w] > 75000) { delete wsSeen[w]; engine.workshopsOnline.delete(w); } });
    // só as oficinas com o portal aberto recebem o estado completo; as outras só a contagem (para o ecrã de escolha)
    const counts = Object.fromEntries(C.WORKSHOPS.map(w => [w.id, engine.s.vehicles.filter(v => v.status === 'oficina' && v.workshop && v.workshop.workshopId === w.id).length]));
    post({ type: 'oficinaState', counts, states: Object.fromEntries(Object.keys(wsSeen).map(w => [w, slim(w, engine.workshopSnapshot(w))])) });
    handle({ type: 'tick', ...clone(engine.tickState()) });
    post({ type: 'state', simNow: engine.s.simNow, simSpeed: engine.s.simSpeed, vehicles: engine.s.vehicles.map(v => engine.driverSnapshot(v)) });
  }, 500);
}

function setModeBadge() {
  $('modeBadge').innerHTML = mode === 'servidor'
    ? `<span class="inline-flex items-center gap-1"><span id="connDot" class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>Servidor · base de dados</span>`
    : `<span class="inline-flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-zinc-400"></span>Modo demonstração (sem servidor)</span>`;
  $('userBox').classList.toggle('hidden', mode !== 'servidor');
  if (currentUser) $('userName').textContent = currentUser.name + (currentUser.isAdmin ? ' · admin' : '');
  if (typeof refreshUsersAccess === 'function') refreshUsersAccess();
}
function setConn(ok) { const d = $('connDot'); if (d) d.className = `w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`; }
function syncControls() {
  const sel = $('simSpeed');
  if (document.activeElement !== sel) sel.value = String(simSpeed);
  const b = $('pauseBtn');
  const want = paused ? 'play' : 'pause';
  if (b.dataset.icon !== want) {
    b.dataset.icon = want;
    b.innerHTML = `<i data-lucide="${want}" class="w-4 h-4"></i>`;
    b.title = paused ? 'Retomar simulação' : 'Pausar simulação';
    icons();
  }
}

/* ==========================================================================
   NOTIFICAÇÕES NO ECRÃ
   ========================================================================== */
function showToast(a) {
  if (inIframe) return;   // miniatura no portfolio: sem pop-ups
  const s = SEV[a.sev];
  const el = document.createElement('div');
  el.className = `toast-in bg-white border rounded-xl shadow-lg p-3 flex gap-2.5 items-start ${a.sev === 'critico' ? 'border-red-200' : a.sev === 'info' ? 'border-blue-200' : 'border-amber-200'}`;
  el.innerHTML = `
    <span class="mt-0.5 w-7 h-7 shrink-0 rounded-lg flex items-center justify-center ${s.cls} border"><i data-lucide="${s.icon}" class="w-4 h-4"></i></span>
    <div class="flex-1 min-w-0">
      <p class="text-xs font-bold text-zinc-900">${esc(a.title)}</p>
      <p class="text-[11px] text-zinc-500 leading-snug">${esc(a.text)}</p>
    </div>
    <button class="text-zinc-400 hover:text-zinc-700" aria-label="Fechar"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>`;
  el.querySelector('button').onclick = () => el.remove();
  el.style.cursor = 'pointer';
  el.addEventListener('click', (e) => { if (!e.target.closest('button') && a.vehicleId) { showTab('mapa'); selectVehicle(a.vehicleId, true); el.remove(); } });
  const box = $('toasts');
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  icons();
  setTimeout(() => el.remove(), 7000);
}

/* ==========================================================================
   MAPA
   ========================================================================== */
const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([45.0, 0.5], 5);
// Fundo Esri (cinzento claro) — não precisa de chave de API
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
L.tileLayer(ESRI + 'World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 16,
  attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap',
}).addTo(map);
L.tileLayer(ESRI + 'World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 }).addTo(map);

let routeLayers = {}, markers = {}, incidentLayers = {};
let selectedId = null;
let trailLayer = null, trailFor = null;

const TRUCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>';
const WRENCH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';

const hasCritical = (v) => alerts.some(a => a.vehicleId === v.id && a.sev === 'critico' && !a.resolved);
function markerIcon(v) {
  const s = STATUS[v.status];
  return L.divIcon({
    className: 'truck-marker',
    html: `<div class="truck-pin ${selectedId === v.id ? 'sel' : ''}"><span class="truck-dot" style="background:${s.color}">${v.status === 'oficina' ? WRENCH_SVG : TRUCK_SVG}</span>${v.plate}${hasCritical(v) ? ' <span style="color:#dc2626">●</span>' : ''}</div>`,
    iconSize: null, iconAnchor: [12, 13],
  });
}

let mapFitted = false;
function setupMap() {
  Object.values(routeLayers).forEach(l => map.removeLayer(l));
  Object.values(markers).forEach(l => map.removeLayer(l));
  Object.values(incidentLayers).forEach(l => map.removeLayer(l));
  routeLayers = {}; markers = {}; incidentLayers = {};
  vehicles.forEach(v => {
    routeLayers[v.id] = L.polyline(v.path, { color: '#71717a', weight: 3, opacity: 0.25, dashArray: '4 6' }).addTo(map);
    markers[v.id] = L.marker(v.pos, { icon: markerIcon(v), riseOnHover: true }).addTo(map).on('click', () => selectVehicle(v.id));
    v._iconSig = '';
  });
  if (!mapFitted) { map.fitBounds(L.latLngBounds(vehicles.flatMap(v => v.path)), { padding: [20, 20] }); mapFitted = true; }
  syncIncidents();
}

function syncIncidents() {
  const ids = new Set(incidents.map(i => i.id));
  Object.keys(incidentLayers).forEach(id => { if (!ids.has(id)) { map.removeLayer(incidentLayers[id]); delete incidentLayers[id]; } });
  incidents.forEach(inc => {
    if (incidentLayers[inc.id]) return;
    const color = inc.type === 'Acidente' ? '#dc2626' : '#f59e0b';
    incidentLayers[inc.id] = L.layerGroup([
      L.circle(inc.p, { radius: inc.r * 1000, color, weight: 1, fillColor: color, fillOpacity: 0.15 }),
      L.circleMarker(inc.p, { radius: 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
        .bindTooltip(`<b>${esc(inc.type)}</b> · ${esc(inc.road)} ${esc(inc.place)}<br>Atraso ~${inc.delay} min`),
    ]).addTo(map);
  });
}

function updateMap() {
  vehicles.forEach(v => {
    const m = markers[v.id];
    if (!m) return;
    m.setLatLng(v.pos);
    if (routeLayers[v.id] && routeLayers[v.id]._dir !== v.dir) routeLayers[v.id]._dir = v.dir;
    const sig = `${v.status}|${selectedId === v.id}|${hasCritical(v)}`;
    if (sig !== v._iconSig) { m.setIcon(markerIcon(v)); v._iconSig = sig; }
    const sel = selectedId === v.id;
    routeLayers[v.id].setStyle(sel ? { color: '#18181b', opacity: 0.8, weight: 4, dashArray: null } : { color: '#71717a', opacity: 0.25, weight: 3, dashArray: '4 6' });
    if (sel) routeLayers[v.id].bringToFront();
  });
}

// percurso real gravado na base de dados (só no modo servidor)
async function toggleTrail(vid) {
  if (trailLayer) { map.removeLayer(trailLayer); trailLayer = null; }
  if (trailFor === vid) { trailFor = null; renderDetail(); return; }
  trailFor = vid;
  try {
    const r = await api(`/api/veiculos/${encodeURIComponent(vid)}/percurso?horas=24`);
    const pts = r.points.map(p => [p.lat, p.lng]);
    const v = byId(vid);
    if (v) pts.push(v.pos);
    trailLayer = L.layerGroup([
      L.polyline(pts, { color: '#2563eb', weight: 5, opacity: 0.85 }),
      ...r.points.filter((p, i) => i % 12 === 0).map(p => L.circleMarker([p.lat, p.lng], { radius: 3, color: '#2563eb', fillColor: '#fff', fillOpacity: 1, weight: 2 })
        .bindTooltip(`${fmtDate(p.time)} ${fmtTime(p.time)} · ${Math.round(p.speed)} km/h · ${STATUS[p.status] ? STATUS[p.status].label : p.status}`)),
    ]).addTo(map);
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  } catch (e) {
    trailFor = null;
    showToast({ sev: 'aviso', title: 'Não foi possível carregar o percurso', text: e.message });
  }
  renderDetail();
}

/* ==========================================================================
   RENDERIZAÇÃO
   ========================================================================== */
let statusFilter = '';
let currentTab = 'mapa';
let activeThread = null;

function bar(pct, cls) {
  return `<div class="h-1.5 w-full bg-zinc-100 rounded-full overflow-hidden"><div class="h-full rounded-full ${cls}" style="width:${clamp(pct, 0, 100)}%"></div></div>`;
}
const wearCls = (pct) => pct >= 95 ? 'bg-red-600' : pct >= 85 ? 'bg-amber-500' : pct >= 70 ? 'bg-yellow-400' : 'bg-emerald-500';
const wearText = (pct) => pct >= 95 ? 'text-red-600' : pct >= 85 ? 'text-amber-600' : 'text-zinc-500';

function renderKPIs() {
  const count = (s) => vehicles.filter(v => v.status === s).length;
  const km = vehicles.reduce((a, v) => a + v.kmToday, 0);
  const crit = alerts.filter(a => !a.resolved && a.sev === 'critico').length;
  const items = [
    ['Em rota', count('rota'), 'navigation', 'text-emerald-600'],
    ['Em pausa', count('pausa'), 'coffee', 'text-amber-600'],
    ['Carga/descarga', count('parado'), 'package', 'text-blue-600'],
    ['Em oficina', count('oficina'), 'wrench', 'text-red-600'],
    ['Km hoje (frota)', Math.round(km).toLocaleString('pt-PT'), 'route', 'text-zinc-700'],
    ['Alertas críticos', crit, 'octagon-alert', crit ? 'text-red-600' : 'text-zinc-700'],
  ];
  $('kpis').innerHTML = items.map(([l, n, ic, c]) => `
    <div class="bg-zinc-50 border border-zinc-200/70 rounded-xl px-3 py-2 flex items-center gap-2.5">
      <i data-lucide="${ic}" class="w-4 h-4 ${c} shrink-0"></i>
      <div class="min-w-0"><div class="text-base font-black leading-none ${c}">${n}</div><div class="text-[10px] text-zinc-500 font-semibold truncate">${l}</div></div>
    </div>`).join('');
}

function renderFilters() {
  const opts = [['', 'Todos', vehicles.length], ...Object.entries(STATUS).map(([k, s]) => [k, s.label, vehicles.filter(v => v.status === k).length])];
  $('statusFilters').innerHTML = opts.map(([k, l, n]) => `
    <button data-status="${k}" class="text-[11px] font-semibold px-2 py-1 rounded-md ${statusFilter === k ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}">${l} <span class="opacity-60">${n}</span></button>`).join('');
}

function renderList() {
  const q = $('searchInput').value.trim().toLowerCase();
  const list = vehicles.filter(v => (!statusFilter || v.status === statusFilter) &&
    (!q || [v.plate, v.driver, v.cargo.desc, v.model].some(s => s.toLowerCase().includes(q))));
  $('vehicleList').innerHTML = list.map(v => {
    const s = STATUS[v.status];
    const worst = Math.max(...v.parts.map(p => p.used / p.life * 100));
    const nAlerts = alerts.filter(a => a.vehicleId === v.id && !a.resolved && a.sev !== 'info').length;
    let sub;
    if (v.status === 'rota') sub = `${Math.round(v.speed)} km/h · ${nearestCity(v.pos)}`;
    else if (v.status === 'pausa') sub = `Pausa · retoma em ${fmtDuration(v.pauseLeft)}`;
    else if (v.status === 'parado') sub = `Descarga em ${destination(v)}`;
    else sub = `${v.workshop.type === 'Própria' ? 'Oficina própria' : 'Oficina externa'} · ${fmtDuration(v.workshop.remainingH * 60)} restantes`;
    return `
    <li>
      <button data-vid="${v.id}" class="w-full text-left px-3 py-2.5 flex gap-3 items-start hover:bg-zinc-50 ${selectedId === v.id ? 'bg-zinc-100' : ''}">
        <span class="mt-0.5 w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-white" style="background:${s.color}"><i data-lucide="${s.icon}" class="w-4 h-4"></i></span>
        <span class="flex-1 min-w-0">
          <span class="flex items-center justify-between gap-2">
            <span class="text-sm font-bold">${v.plate}${isOnline(v.id) ? ' <span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 align-middle" title="App ligada"></span>' : ''}</span>
            ${nAlerts ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700">${nAlerts} alerta${nAlerts > 1 ? 's' : ''}</span>` : ''}
          </span>
          <span class="block text-xs text-zinc-600 truncate">${esc(v.driver)}${v.unread ? ` <span class="text-blue-600 font-bold">· ${v.unread} msg</span>` : ''}</span>
          <span class="block text-[11px] text-zinc-400 truncate">${sub}</span>
          <span class="mt-1.5 flex items-center gap-2"><span class="text-[10px] text-zinc-400 w-14 shrink-0">Desgaste</span>${bar(worst, wearCls(worst))}</span>
        </span>
      </button>
    </li>`;
  }).join('') || '<li class="p-6 text-center text-sm text-zinc-400">Nenhum veículo encontrado.</li>';
}

function renderLegend() {
  $('legend').innerHTML = Object.values(STATUS).map(s => `<div class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full" style="background:${s.color}"></span>${s.label}</div>`).join('') +
    `<div class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-amber-400 ring-2 ring-amber-200"></span>Ocorrência de trânsito</div>`;
}

function stat(label, value, icon, extra = '') {
  return `<div class="bg-zinc-50 rounded-xl p-3 border border-zinc-100">
    <div class="flex items-center gap-1.5 text-[11px] text-zinc-500 font-semibold mb-1"><i data-lucide="${icon}" class="w-3.5 h-3.5"></i>${label}</div>
    <div class="text-sm font-bold text-zinc-900">${value}</div>${extra}</div>`;
}

// troca o HTML mas mantém os blocos [data-media] (fotos, miniaturas) que não mudaram:
// assim as imagens não são recriadas nem piscam a cada atualização
function setHtmlKeepingMedia(el, html) {
  const old = new Map();
  el.querySelectorAll('[data-media]').forEach(n => old.set(n.dataset.media, n));
  el.innerHTML = html;
  el.querySelectorAll('[data-media]').forEach(n => { const o = old.get(n.dataset.media); if (o) n.replaceWith(o); });
}

function renderDetail() {
  const el = $('detail');
  const v = byId(selectedId);
  if (!v) {
    el.innerHTML = `<div class="p-8 text-center text-zinc-400 flex flex-col items-center justify-center h-full gap-3">
      <i data-lucide="mouse-pointer-click" class="w-8 h-8"></i>
      <p class="text-sm font-semibold">Seleciona um veículo no mapa ou na lista</p>
      <p class="text-xs">para ver motorista, localização, tempos de condução, carga e desgaste das peças.</p></div>`;
    return;
  }
  const scroll = el.scrollTop;
  const s = STATUS[v.status];
  const lr = loadRatio(v);
  const terr = terrainOf(v);
  const contPct = v.contDrive / 270 * 100, dayPct = v.dayDrive / 540 * 100;
  const parts = [...v.parts].sort((a, b) => b.used / b.life - a.used / a.life);
  const docNames = { ipo: 'Inspeção (IPO)', seguro: 'Seguro', tacografo: 'Tacógrafo' };
  const vAlerts = alerts.filter(a => a.vehicleId === v.id && !a.resolved).slice(0, 4);
  const avgCons = v.kmToday > 1 ? v.fuelToday / v.kmToday * 100 : 0;
  const on = isOnline(v.id);

  let statusBox = '';
  if (v.status === 'oficina') {
    const ws = v.workshop;
    const pct = clamp(ws.elapsedH / (ws.elapsedH + ws.remainingH) * 100, 0, 100);
    statusBox = `<div class="rounded-xl border border-red-200 bg-red-50/60 p-3 space-y-1.5">
      <div class="text-xs font-bold text-red-700 flex items-center gap-1.5"><i data-lucide="wrench" class="w-3.5 h-3.5"></i>${esc(ws.name)} (${ws.type.toLowerCase()})</div>
      <div class="text-xs text-zinc-700">${esc(ws.reason)}</div>
      ${bar(pct, 'bg-red-500')}
      <div class="flex justify-between text-[11px] text-zinc-500"><span>Parado há ${fmtDuration(ws.elapsedH * 60)}</span><span>${ws.waitingParts ? 'A aguardar peças' : `Faltam ~${fmtDuration(ws.remainingH * 60)}`}</span></div>
    </div>`;
  } else if (v.status === 'pausa') {
    statusBox = `<div class="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-800 font-semibold flex items-center gap-2"><i data-lucide="coffee" class="w-4 h-4"></i>${v.pauseLeft > 60 ? 'Descanso diário' : 'Pausa obrigatória'} — retoma às ${fmtTime(simNow + v.pauseLeft * C.MIN)}</div>`;
  }

  const d = v.deliveries && v.deliveries[0];
  const deliveryBox = d ? `<div>
      <h3 class="text-xs font-bold text-zinc-500 uppercase tracking-wide mb-2 flex items-center gap-1.5"><i data-lucide="package-check" class="w-3.5 h-3.5"></i>Última entrega</h3>
      <div class="rounded-xl border border-zinc-100 bg-zinc-50 p-3 space-y-2">
        <div class="text-xs"><b>${esc(d.cargo)}</b><br><span class="text-zinc-500">${esc(d.place)} · ${fmtDate(d.time)} ${fmtTime(d.time)} · recebido por ${esc(d.receiver || '—')}</span></div>
        ${d.notes ? `<div class="text-[11px] text-zinc-600">“${esc(d.notes)}”</div>` : ''}
        <div class="grid grid-cols-2 gap-2" data-media="dlv-${v.id}-${d.time}">
          ${d.photo ? `<a href="${esc(d.photo)}" target="_blank" rel="noopener"><img src="${esc(d.photo)}" alt="Foto da entrega" class="w-full h-24 object-cover rounded-lg border border-zinc-200"></a>` : '<div class="h-24 rounded-lg border border-dashed border-zinc-200 flex items-center justify-center text-[10px] text-zinc-400">Sem foto</div>'}
          ${d.signature ? `<img src="${esc(d.signature)}" alt="Assinatura" class="w-full h-24 object-contain rounded-lg border border-zinc-200 bg-white">` : '<div class="h-24 rounded-lg border border-dashed border-zinc-200 flex items-center justify-center text-[10px] text-zinc-400">Sem assinatura</div>'}
        </div>
      </div></div>` : '';

  const chk = v.lastChecklist;
  const checklistBox = chk ? `<div>
      <h3 class="text-xs font-bold text-zinc-500 uppercase tracking-wide mb-2 flex items-center gap-1.5"><i data-lucide="list-checks" class="w-3.5 h-3.5"></i>Checklist pré-viagem</h3>
      <div class="text-[11px] text-zinc-500 mb-1.5">${fmtDate(chk.time)} ${fmtTime(chk.time)} · ${chk.issues.length ? `<b class="text-amber-600">${chk.issues.length} problema(s)</b>` : '<b class="text-emerald-600">tudo ok</b>'}</div>
      ${chk.issues.length ? `<ul class="space-y-1">${chk.issues.map(i => `<li class="text-xs rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5"><b>${esc(i.name)}</b>${i.note ? ` — ${esc(i.note)}` : ''}</li>`).join('')}</ul>` : ''}
    </div>` : '';

  setHtmlKeepingMedia(el, `
  <div class="p-4 border-b border-zinc-100 sticky top-0 bg-white z-10">
    <div class="flex items-start justify-between gap-2">
      <div>
        <div class="flex items-center gap-2"><h2 class="text-lg font-black">${v.plate}</h2><span class="text-[10px] font-bold px-2 py-0.5 rounded-full border ${s.bg}">${s.label}</span></div>
        <p class="text-xs text-zinc-500">${esc(v.model)} · ${fmtKm(v.odometer)}</p>
      </div>
      <button id="closeDetail" class="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-400" aria-label="Fechar"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="mt-3 flex items-center justify-between gap-2 bg-zinc-50 rounded-xl p-2.5">
      <div class="flex items-center gap-2.5 min-w-0">
        <span class="w-9 h-9 rounded-full bg-zinc-900 text-white text-xs font-bold flex items-center justify-center shrink-0">${v.driver.split(' ').map(n => n[0]).join('')}</span>
        <div class="min-w-0"><div class="text-sm font-bold truncate">${esc(v.driver)}</div><div class="text-[11px] text-zinc-500">${v.phone}</div>
          <div class="text-[10px] font-bold mt-0.5 ${on ? 'text-emerald-600' : 'text-zinc-400'} inline-flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full ${on ? 'bg-emerald-500' : 'bg-zinc-300'}"></span>${on ? 'App ligada' : 'App desligada'}</div></div>
      </div>
      <div class="flex gap-1.5">
        <button data-msg="${v.id}" class="p-2 rounded-lg bg-zinc-900 text-white" title="Enviar mensagem"><i data-lucide="message-square" class="w-4 h-4"></i></button>
        <a href="tel:${v.phone.replace(/\s/g, '')}" class="p-2 rounded-lg bg-zinc-200 text-zinc-800" title="Ligar"><i data-lucide="phone" class="w-4 h-4"></i></a>
        <a href="motorista.html${mode === 'demo' ? `?v=${v.id}` : ''}" target="_blank" rel="noopener" class="p-2 rounded-lg bg-zinc-200 text-zinc-800" title="Abrir a app do motorista"><i data-lucide="smartphone" class="w-4 h-4"></i></a>
      </div>
    </div>
  </div>

  <div class="p-4 space-y-4">
    ${statusBox}

    <div class="grid grid-cols-2 gap-2">
      ${stat('Localização', esc(nearestCity(v.pos)), 'map-pin', `<div class="text-[10px] text-zinc-400 mt-0.5">${v.pos[0].toFixed(4)}, ${v.pos[1].toFixed(4)}</div>`)}
      ${stat('Velocidade', `${Math.round(v.speed)} km/h`, 'gauge', `<div class="text-[10px] text-zinc-400 mt-0.5">Terreno: ${TERRAIN[terr].label}</div>`)}
      ${stat('Distância hoje', fmtKm(v.kmToday), 'route', `<div class="text-[10px] text-zinc-400 mt-0.5">Consumo: ${avgCons.toFixed(1)} L/100km</div>`)}
      ${v.status === 'oficina' ? stat('Viagem', '—', 'flag', '') : stat(`Destino: ${esc(destination(v))}`, `ETA ${fmtWhen(etaDate(v))}`, 'flag', `<div class="text-[10px] text-zinc-400 mt-0.5">Faltam ${fmtKm(remainingKm(v))} · de ${esc(origin(v))}</div>`)}
    </div>

    ${mode === 'servidor' ? `<button data-trail="${v.id}" class="w-full px-3 py-2 rounded-lg ${trailFor === v.id ? 'bg-blue-600 text-white' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-800'} text-xs font-semibold inline-flex items-center justify-center gap-1.5"><i data-lucide="history" class="w-3.5 h-3.5"></i>${trailFor === v.id ? 'Esconder percurso' : 'Ver percurso das últimas 24h'}</button>` : ''}

    <div>
      <h3 class="text-xs font-bold text-zinc-500 uppercase tracking-wide mb-2 flex items-center gap-1.5"><i data-lucide="timer" class="w-3.5 h-3.5"></i>Tempo de condução</h3>
      <div class="space-y-2.5">
        <div><div class="flex justify-between text-xs mb-1"><span class="text-zinc-600">Contínuo</span><span class="font-bold ${contPct >= 94 ? 'text-red-600' : contPct >= 85 ? 'text-amber-600' : ''}">${fmtHM(v.contDrive)} / 4h30</span></div>${bar(contPct, contPct >= 94 ? 'bg-red-500' : contPct >= 85 ? 'bg-amber-500' : 'bg-zinc-800')}</div>
        <div><div class="flex justify-between text-xs mb-1"><span class="text-zinc-600">Hoje</span><span class="font-bold">${fmtHM(v.dayDrive)} / 9h00</span></div>${bar(dayPct, dayPct >= 90 ? 'bg-amber-500' : 'bg-zinc-800')}</div>
      </div>
    </div>

    <div>
      <h3 class="text-xs font-bold text-zinc-500 uppercase tracking-wide mb-2 flex items-center gap-1.5"><i data-lucide="package" class="w-3.5 h-3.5"></i>Carga</h3>
      <div class="text-sm font-semibold">${esc(v.cargo.desc)}</div>
      <div class="flex justify-between text-xs text-zinc-500 mt-1 mb-1"><span>${v.cargo.kg.toLocaleString('pt-PT')} kg de ${v.cargo.cap.toLocaleString('pt-PT')} kg</span><span class="font-bold ${lr > 1 ? 'text-red-600' : ''}">${Math.round(lr * 100)}%</span></div>
      ${bar(lr * 100, lr > 1 ? 'bg-red-500' : lr > 0.9 ? 'bg-amber-500' : 'bg-blue-500')}
    </div>

    ${v.deliveryPending ? `<div class="rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-xs text-blue-800 font-semibold flex items-center gap-2"><i data-lucide="clipboard-signature" class="w-4 h-4"></i>A aguardar confirmação de entrega na app${on ? '' : ' (app desligada)'}</div>` : ''}
    ${deliveryBox}
    ${checklistBox}

    ${v.history && v.history.length ? `<div>
      <h3 class="text-xs font-bold text-zinc-500 uppercase tracking-wide mb-2 flex items-center gap-1.5"><i data-lucide="history" class="w-3.5 h-3.5"></i>Histórico de oficina</h3>
      <ul class="space-y-1.5">${v.history.slice(0, 5).map(h => `<li class="text-xs rounded-lg border border-zinc-100 bg-zinc-50 px-2.5 py-2">
        <div class="flex justify-between gap-2"><b class="min-w-0 truncate">${esc(h.reason)}</b><span class="font-semibold tabular-nums whitespace-nowrap">${C.fmtEur(h.cost || 0)}</span></div>
        <div class="text-[11px] text-zinc-500">${esc(h.name)} · ${fmtDate(h.enteredAt)} → ${fmtDate(h.leftAt)}</div>
        ${h.attachments && h.attachments.length ? `<div class="mt-1 text-[11px]">${attachLinks(h.attachments)}</div>` : ''}</li>`).join('')}</ul>
    </div>` : ''}

    <div>
      <h3 class="text-xs font-bold text-zinc-500 uppercase tracking-wide mb-1 flex items-center gap-1.5"><i data-lucide="cog" class="w-3.5 h-3.5"></i>Desgaste das peças</h3>
      <p class="text-[11px] text-zinc-400 mb-2">Ritmo atual: carga ${Math.round(lr * 100)}% · terreno ${TERRAIN[terr].label.toLowerCase()}</p>
      <ul class="space-y-2">
        ${parts.map(p => { const pct = p.used / p.life * 100; return `
          <li>
            <div class="flex justify-between text-xs mb-1"><span class="text-zinc-700">${p.name}</span><span class="font-bold ${wearText(pct)}">${pct.toFixed(1)}%</span></div>
            ${bar(pct, wearCls(pct))}
            <div class="text-[10px] text-zinc-400 mt-0.5">Restam ~${fmtKm(partRemainingKm(v, p))} ao ritmo atual (×${wearMult(p, lr, terr).toFixed(2)})</div>
          </li>`; }).join('')}
      </ul>
      ${v.status !== 'oficina' && parts.some(p => p.used / p.life >= 0.8) ? `<button data-schedule="${v.id}" class="mt-3 w-full px-3 py-2 rounded-lg bg-zinc-900 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5"><i data-lucide="calendar-plus" class="w-3.5 h-3.5"></i>Agendar manutenção (peças ≥ 80%)</button>` : ''}
    </div>

    <div>
      <h3 class="text-xs font-bold text-zinc-500 uppercase tracking-wide mb-2 flex items-center gap-1.5"><i data-lucide="file-check" class="w-3.5 h-3.5"></i>Documentos</h3>
      <div class="grid grid-cols-3 gap-2">
        ${Object.entries(v.docs).map(([k, dt]) => { const days = Math.ceil((dt - simNow) / C.DAY); return `
          <div class="rounded-lg border p-2 ${days <= 7 ? 'border-red-200 bg-red-50' : days <= 30 ? 'border-amber-200 bg-amber-50' : 'border-zinc-100 bg-zinc-50'}">
            <div class="text-[10px] text-zinc-500 font-semibold">${docNames[k]}</div>
            <div class="text-xs font-bold">${days} dias</div>
          </div>`; }).join('')}
      </div>
    </div>

    ${vAlerts.length ? `<div>
      <h3 class="text-xs font-bold text-zinc-500 uppercase tracking-wide mb-2 flex items-center gap-1.5"><i data-lucide="bell" class="w-3.5 h-3.5"></i>Alertas ativos</h3>
      <ul class="space-y-1.5">${vAlerts.map(a => `<li class="text-xs rounded-lg border px-2.5 py-1.5 ${SEV[a.sev].cls}"><b>${esc(a.title.replace(v.plate + ': ', ''))}</b><br><span class="opacity-80">${esc(a.text)}</span></li>`).join('')}</ul>
    </div>` : ''}
  </div>`);
  el.scrollTop = scroll;
}

function renderBell() {
  const unread = alerts.filter(a => !a.read && !a.resolved);
  const bc = $('bellCount');
  bc.textContent = unread.length > 99 ? '99+' : unread.length;
  bc.classList.toggle('hidden', !unread.length);
  const at = $('alertTabCount');
  const active = alerts.filter(a => !a.resolved && a.sev !== 'info').length;
  at.textContent = active; at.classList.toggle('hidden', !active);
  $('bellList').innerHTML = alerts.slice(0, 12).map(a => `
    <li><button data-alert="${a.id}" class="w-full text-left px-4 py-2.5 flex gap-2.5 hover:bg-zinc-50 ${a.read ? 'opacity-60' : ''}">
      <span class="mt-1.5 w-2 h-2 rounded-full shrink-0 ${SEV[a.sev].dot}"></span>
      <span class="min-w-0"><span class="block text-xs font-bold">${esc(a.title)}</span><span class="block text-[11px] text-zinc-500">${esc(a.text)}</span><span class="block text-[10px] text-zinc-400 mt-0.5">${fmtTime(a.time)} · ${CATS[a.cat]}</span></span>
    </button></li>`).join('') || '<li class="p-6 text-center text-xs text-zinc-400">Sem notificações.</li>';
}

function renderAlertsView() {
  if (currentTab !== 'alertas') return;
  const sev = $('alertSevFilter').value, cat = $('alertCatFilter').value, showRes = $('alertShowResolved').checked;
  const list = alerts.filter(a => (!sev || a.sev === sev) && (!cat || a.cat === cat) && (showRes || !a.resolved));
  $('alertList').innerHTML = list.map(a => {
    const s = SEV[a.sev]; const v = byId(a.vehicleId);
    return `<li class="p-4 flex flex-col sm:flex-row sm:items-center gap-3 ${a.resolved ? 'opacity-50' : ''}">
      <span class="w-9 h-9 shrink-0 rounded-xl border flex items-center justify-center ${s.cls}"><i data-lucide="${s.icon}" class="w-4 h-4"></i></span>
      <div class="flex-1 min-w-0">
        <div class="flex flex-wrap items-center gap-2"><span class="text-sm font-bold">${esc(a.title)}</span>
          <span class="text-[10px] font-bold px-1.5 py-0.5 rounded border ${s.cls}">${s.label}</span>
          <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">${CATS[a.cat]}</span></div>
        <p class="text-xs text-zinc-500 mt-0.5">${esc(a.text)}</p>
        <p class="text-[10px] text-zinc-400 mt-0.5">${fmtDate(a.time)} ${fmtTime(a.time)}${v ? ` · ${v.plate} · ${esc(v.driver)}` : ''}</p>
      </div>
      <div class="flex gap-1.5 shrink-0">
        ${v ? `<button data-locate="${v.id}" class="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200">Ver no mapa</button>
        <button data-msg="${v.id}" data-prefill="${a.cat === 'transito' ? 'Atenção: ' + esc(a.text) : ''}" class="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200">Avisar motorista</button>` : ''}
        ${!a.resolved ? `<button data-resolve="${a.id}" class="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-zinc-900 text-white">Resolver</button>` : ''}
      </div>
    </li>`;
  }).join('') || '<li class="p-10 text-center text-sm text-zinc-400">Sem alertas para estes filtros.</li>';
  icons();
}

const PHASES = ['Diagnóstico', 'Aguarda peças', 'Em reparação', 'Testes finais', 'Pronto'];
const PHASE_KEYS = ['diagnostico', 'pecas', 'reparacao', 'testes'];
function wsPhase(ws) {
  if (ws.phase && PHASE_KEYS.includes(ws.phase)) return PHASE_KEYS.indexOf(ws.phase);
  const pct = ws.elapsedH / (ws.elapsedH + ws.remainingH);
  if (ws.waitingParts) return 1;
  if (pct < 0.15) return 0;
  if (pct < 0.85) return 2;
  return 3;
}
const noteText = (n) => typeof n === 'string' ? n : `${n.time ? fmtTime(n.time) + ' — ' : ''}${n.by ? n.by + ': ' : ''}${n.text}`;
const EURq = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
function quoteBoxPanel(v) {
  const q = v.workshop.quote;
  if (!q) return v.workshop.type === 'Externa' && v.workshop.managed ? '<div class="rounded-lg bg-zinc-50 p-2.5 text-[11px] text-zinc-500">A oficina ainda não enviou orçamento.</div>' : '';
  if (q.status === 'pendente') return `<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
      <div class="text-xs font-bold text-amber-800 flex items-center gap-1.5"><i data-lucide="file-text" class="w-3.5 h-3.5"></i>Orçamento: ${EURq.format(q.amount)} — aguarda a tua aprovação</div>
      <div class="text-[11px] text-zinc-700">${esc(q.description)}</div>
      <div class="text-[10px] text-zinc-500">Enviado por ${esc(q.by)} · ${fmtDate(q.sentAt)} ${fmtTime(q.sentAt)}</div>
      <div class="flex gap-2"><button data-quote-ok="${v.id}" class="flex-1 text-[11px] font-bold px-2.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white inline-flex items-center justify-center gap-1"><i data-lucide="check" class="w-3.5 h-3.5"></i>Aprovar</button>
        <button data-quote-no="${v.id}" class="flex-1 text-[11px] font-bold px-2.5 py-2 rounded-lg bg-white border border-zinc-200 hover:bg-zinc-50 inline-flex items-center justify-center gap-1"><i data-lucide="x" class="w-3.5 h-3.5"></i>Recusar</button></div></div>`;
  return `<div class="rounded-lg ${q.status === 'aprovado' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'} p-2.5 text-[11px]"><b>Orçamento ${q.status}</b>: ${EURq.format(q.amount)}${q.decidedBy ? ` · ${esc(q.decidedBy)}` : ''}${q.reason ? ` — ${esc(q.reason)}` : ''}</div>`;
}
function renderWorkshops() {
  if (currentTab !== 'oficinas') return;
  const inWs = vehicles.filter(v => v.status === 'oficina');
  const totalStopped = inWs.reduce((a, v) => a + v.workshop.elapsedH, 0);
  const totalCost = inWs.reduce((a, v) => a + v.workshop.cost, 0);
  const summary = [
    ['Veículos parados', inWs.length, 'truck'],
    ['Oficina própria / externa', `${inWs.filter(v => v.workshop.type === 'Própria').length} / ${inWs.filter(v => v.workshop.type === 'Externa').length}`, 'warehouse'],
    ['Tempo parado acumulado', fmtDuration(totalStopped * 60), 'hourglass'],
    ['Custo estimado em curso', `${totalCost.toLocaleString('pt-PT')} €`, 'euro'],
  ];
  $('wsSummary').innerHTML = summary.map(([l, n, ic]) => `<div class="bg-white p-4 rounded-2xl border border-zinc-200/80 shadow-sm">
    <div class="flex items-center justify-between mb-2"><span class="text-xs font-semibold text-zinc-500">${l}</span><i data-lucide="${ic}" class="w-4 h-4 text-zinc-400"></i></div>
    <div class="text-xl font-black">${n}</div></div>`).join('');

  setHtmlKeepingMedia($('wsCards'), inWs.map(v => {
    const ws = v.workshop, ph = wsPhase(ws);
    const pct = clamp(ws.elapsedH / (ws.elapsedH + ws.remainingH) * 100, 0, 100);
    const exit = simNow + ws.remainingH * C.HOUR;
    return `<article class="bg-white rounded-2xl border border-zinc-200/80 shadow-sm p-5 flex flex-col gap-3">
      <div class="flex items-start justify-between gap-2">
        <div><div class="text-base font-black">${v.plate}</div><div class="text-xs text-zinc-500">${esc(v.model)}</div></div>
        <div class="flex flex-col items-end gap-1"><span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${ws.type === 'Própria' ? 'bg-zinc-900 text-white' : 'bg-violet-100 text-violet-700'}">Oficina ${ws.type.toLowerCase()}</span>
          ${ws.managed ? `<span class="text-[10px] font-semibold text-emerald-700 inline-flex items-center gap-1" title="A oficina atualiza esta reparação pelo portal"><i data-lucide="radio" class="w-3 h-3"></i>pela oficina${ws.updatedAt ? ' · ' + fmtTime(ws.updatedAt) : ''}</span>` : '<span class="text-[10px] text-zinc-400">estado simulado</span>'}</div>
      </div>
      <div class="text-xs"><div class="font-semibold flex items-center gap-1.5"><i data-lucide="map-pin" class="w-3.5 h-3.5 text-zinc-400"></i>${esc(ws.name)}</div><div class="text-zinc-500 mt-1">${esc(ws.reason)}</div></div>
      <ol class="flex items-center gap-1">${PHASES.map((p, i) => `<li class="flex-1"><div class="h-1.5 rounded-full ${i < ph ? 'bg-emerald-500' : i === ph ? (ws.waitingParts ? 'bg-amber-500' : 'bg-blue-500') : 'bg-zinc-200'}"></div><div class="text-[9px] mt-1 font-semibold ${i === ph ? 'text-zinc-900' : 'text-zinc-400'} truncate">${p}</div></li>`).join('')}</ol>
      <div class="grid grid-cols-3 gap-2 text-center">
        <div class="bg-zinc-50 rounded-lg p-2"><div class="text-[10px] text-zinc-500 font-semibold">Parado há</div><div class="text-sm font-bold">${fmtDuration(ws.elapsedH * 60)}</div></div>
        <div class="bg-zinc-50 rounded-lg p-2"><div class="text-[10px] text-zinc-500 font-semibold">Restante</div><div class="text-sm font-bold ${ws.waitingParts || C.needsQuote(ws) && ws.managed || ws.remainingH <= 0 ? 'text-amber-600' : ''}">${ws.waitingParts ? '? (peças)' : C.needsQuote(ws) && ws.managed ? '? (orçamento)' : ws.remainingH <= 0 ? 'ultrapassado' : fmtDuration(ws.remainingH * 60)}</div></div>
        <div class="bg-zinc-50 rounded-lg p-2"><div class="text-[10px] text-zinc-500 font-semibold">Custo est.</div><div class="text-sm font-bold">${C.fmtEur(ws.cost)}</div></div>
      </div>
      ${bar(pct, 'bg-zinc-900')}
      <div class="text-[11px] text-zinc-500 flex justify-between"><span>Entrada: ${fmtDate(ws.enteredAt)} ${fmtTime(ws.enteredAt)}</span><span>${ws.waitingParts ? 'Saída depende das peças' : C.needsQuote(ws) && ws.managed ? 'Previsão depois do orçamento' : `Previsão: ${fmtDate(exit)} ${fmtTime(exit)}`}</span></div>
      ${quoteBoxPanel(v)}
      ${(ws.attachments || []).length ? `<div><div class="text-[11px] font-semibold text-zinc-500 mb-1.5 flex items-center justify-between"><span>Faturas e fotos da oficina</span>${ws.invoice ? `<span class="text-emerald-700 inline-flex items-center gap-1"><i data-lucide="receipt" class="w-3.5 h-3.5"></i>${ws.invoice.number ? esc(ws.invoice.number) : 'Fatura'}${ws.invoice.amount ? ' · ' + C.fmtEur(ws.invoice.amount) : ''}</span>` : ''}</div>
        <div class="flex flex-wrap gap-2" data-media="ws-${v.id}-${ws.attachments.map(a => a.id).join('.')}">${attachThumbs(ws.attachments)}</div></div>` : ''}
      <ul class="text-[11px] text-zinc-600 bg-zinc-50 rounded-lg p-2.5 space-y-1">${ws.notes.slice(-4).map(n => `<li class="${n.request && !n.answered ? 'text-amber-700 font-semibold' : ''}">• ${esc(noteText(n))}</li>`).join('')}</ul>
      <div class="flex gap-2">
        <button data-wsupdate="${v.id}" class="flex-1 text-[11px] font-semibold px-2.5 py-2 rounded-lg bg-zinc-100 hover:bg-zinc-200">Pedir ponto de situação</button>
        <button data-locate="${v.id}" class="text-[11px] font-semibold px-2.5 py-2 rounded-lg bg-zinc-100 hover:bg-zinc-200">Ver no mapa</button>
      </div>
    </article>`;
  }).join('') || '<p class="text-sm text-zinc-400">Nenhum veículo em oficina neste momento.</p>');

  const rows = [];
  vehicles.forEach(v => v.parts.forEach(p => { const pct = p.used / p.life * 100; if (pct >= 80) rows.push({ v, p, pct }); }));
  rows.sort((a, b) => b.pct - a.pct);
  $('maintTable').innerHTML = rows.map(({ v, p, pct }) => `<tr>
    <td class="py-2.5 pr-4"><div class="font-bold">${v.plate}</div><div class="text-[11px] text-zinc-400">${STATUS[v.status].label}</div></td>
    <td class="py-2.5 pr-4">${p.name}</td>
    <td class="py-2.5 pr-4 w-40"><div class="flex items-center gap-2">${bar(pct, wearCls(pct))}<span class="text-xs font-bold ${wearText(pct)}">${pct.toFixed(0)}%</span></div></td>
    <td class="py-2.5 pr-4 text-xs">${fmtKm(partRemainingKm(v, p))}</td>
    <td class="py-2.5 text-right">${v.status === 'oficina' ? '<span class="text-[11px] text-zinc-400">Em oficina</span>' : `<button data-schedule="${v.id}" class="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-zinc-900 text-white">Agendar</button>`}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="py-6 text-center text-sm text-zinc-400">Nenhuma peça acima de 80%.</td></tr>';
}

function renderThreads() {
  if (currentTab !== 'mensagens') return;
  $('threadList').innerHTML = vehicles.map(v => {
    const t = threads[v.id] || [];
    const last = t[t.length - 1];
    return `<li><button data-thread="${v.id}" class="w-full text-left px-3 py-2.5 flex items-center gap-2.5 hover:bg-zinc-50 ${activeThread === v.id ? 'bg-zinc-100' : ''}">
      <span class="relative w-9 h-9 rounded-full bg-zinc-900 text-white text-xs font-bold flex items-center justify-center shrink-0">${v.driver.split(' ').map(n => n[0]).join('')}
        <span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white" style="background:${STATUS[v.status].color}"></span></span>
      <span class="flex-1 min-w-0"><span class="flex justify-between gap-2"><span class="text-sm font-bold truncate">${esc(v.driver)}</span>${v.unread ? `<span class="text-[10px] font-bold px-1.5 rounded-full bg-blue-600 text-white">${v.unread}</span>` : ''}</span>
      <span class="block text-[11px] text-zinc-400 truncate">${last ? esc((last.from === 'base' ? 'Tu: ' : '') + last.text) : `${v.plate} · ${STATUS[v.status].label}`}</span></span>
    </button></li>`;
  }).join('');
  icons();
}
function renderChat() {
  const v = byId(activeThread);
  if (!v) {
    $('chatHeader').innerHTML = '<span class="text-sm text-zinc-400">Seleciona um motorista</span>';
    $('chatBody').innerHTML = '<div class="h-full flex items-center justify-center text-sm text-zinc-400">As mensagens chegam à app do motorista.</div>';
    $('quickReplies').innerHTML = '';
    return;
  }
  $('chatHeader').innerHTML = `<div class="flex items-center justify-between gap-2"><div><div class="text-sm font-bold">${esc(v.driver)}</div><div class="text-[11px] text-zinc-500">${v.plate} · ${STATUS[v.status].label} · ${esc(nearestCity(v.pos))} · ${isOnline(v.id) ? '<b class="text-emerald-600">app ligada</b>' : 'resposta simulada'}</div></div>
    <button data-locate="${v.id}" class="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200">Ver no mapa</button></div>`;
  $('chatBody').innerHTML = (threads[v.id] || []).map(m => `
    <div class="flex ${m.from === 'base' ? 'justify-end' : 'justify-start'}">
      <div class="max-w-[80%] rounded-2xl px-3 py-2 text-sm ${m.from === 'base' ? 'bg-zinc-900 text-white rounded-br-sm' : 'bg-white border border-zinc-200 rounded-bl-sm'}">
        ${esc(m.text)}<div class="text-[10px] mt-0.5 text-zinc-400">${fmtDate(m.time)} ${fmtTime(m.time)}</div>
      </div>
    </div>`).join('') || '<div class="text-center text-xs text-zinc-400 py-6">Ainda sem mensagens com este motorista.</div>';
  $('chatBody').scrollTop = $('chatBody').scrollHeight;
  $('quickReplies').innerHTML = QUICK.map(q => `<button data-quick="${esc(q)}" class="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-zinc-100 hover:bg-zinc-200">${esc(q)}</button>`).join('');
}
function renderMsgCount() {
  const n = vehicles.reduce((a, v) => a + (v.unread || 0), 0);
  $('msgTabCount').textContent = n; $('msgTabCount').classList.toggle('hidden', !n);
}

function render() {
  $('simClock').textContent = `${fmtDate(simNow)} · ${fmtTime(simNow)}`;
  renderKPIs(); renderFilters(); renderList(); updateMap();
  if (currentTab === 'mapa') renderDetail();
  renderWorkshops(); renderMsgCount();
  if (currentTab === 'mensagens') renderThreads();
  icons();
}

/* ==========================================================================
   INTERAÇÃO
   ========================================================================== */
function selectVehicle(id, pan = false) {
  selectedId = id;
  const v = byId(id);
  if (v && pan) {
    const sz = map.getSize();
    if (sz.x && sz.y) map.flyTo(v.pos, Math.max(map.getZoom(), 9), { duration: 0.8 });
    else map.setView(v.pos, Math.max(map.getZoom(), 9), { animate: false });
  }
  render();
}
function openThread(vid) {
  activeThread = vid;
  const v = byId(vid);
  if (v && v.unread) { v.unread = 0; action({ type: 'readThread', vid }); }
  renderThreads(); renderChat(); renderMsgCount();
}
function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  ['mapa', 'oficinas', 'alertas', 'mensagens', 'relatorios', 'utilizadores'].forEach(t => $('view-' + t).classList.toggle('hidden', t !== tab));
  if (tab === 'utilizadores') loadUsers();
  if (tab === 'relatorios') loadReport();
  if (tab === 'mapa') map.invalidateSize();
  if (tab === 'mensagens' && vehicles.length) openThread(activeThread || vehicles[0].id);
  renderAlertsView();
  render();
}
function openChat(vid, prefill = '') {
  showTab('mensagens');
  openThread(vid);
  $('chatInput').value = prefill;
  $('chatInput').focus();
}
function sendChat(text) {
  text = text.trim();
  if (!text || !activeThread) return;
  action({ type: 'msg', vid: activeThread, text });
  $('chatInput').value = '';
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a');
  if (!t) {
    if (!e.target.closest('#bellPanel') && !e.target.closest('#bellBtn')) $('bellPanel').classList.add('hidden');
    return;
  }
  const d = t.dataset;
  if (d.tab) showTab(d.tab);
  if (d.goto) { $('bellPanel').classList.add('hidden'); showTab(d.goto); }
  if (d.vid) selectVehicle(d.vid, true);
  if (d.status !== undefined) { statusFilter = d.status; render(); }
  if (d.msg) openChat(d.msg, d.prefill || '');
  if (d.locate) { showTab('mapa'); selectVehicle(d.locate, true); }
  if (d.thread) openThread(d.thread);
  if (d.quick) sendChat(d.quick);
  if (d.resolve) action({ type: 'resolve', id: +d.resolve });
  if (d.schedule) action({ type: 'schedule', vid: d.schedule });
  if (d.wsupdate) action({ type: 'wsUpdate', vid: d.wsupdate });
  if (d.quoteOk) { const v = byId(d.quoteOk); if (v && confirm(`Aprovar o orçamento de ${EURq.format(v.workshop.quote.amount)} da ${v.workshop.name}?`)) action({ type: 'quoteDecision', vid: v.id, approve: true }); }
  if (d.quoteNo) { const reason = prompt('Motivo da recusa (a oficina vai ver):', 'Valor acima do habitual — enviem novo orçamento.'); if (reason !== null) action({ type: 'quoteDecision', vid: d.quoteNo, approve: false, reason }); }
  if (d.trail) toggleTrail(d.trail);
  if (d.alert) {
    const a = alerts.find(x => x.id === +d.alert);
    if (a) { if (!a.read) action({ type: 'read', id: a.id }); if (a.vehicleId) { showTab('mapa'); selectVehicle(a.vehicleId, true); } }
    $('bellPanel').classList.add('hidden');
  }
  if (t.id === 'closeDetail') { selectedId = null; render(); }
  if (t.id === 'bellBtn') $('bellPanel').classList.toggle('hidden');
  if (t.id === 'markAllRead') action({ type: 'readAll' });
  if (t.id === 'pauseBtn') action({ type: 'pause', value: !paused });
  if (t.id === 'logoutBtn') logout();
  if (t.id === 'browserNotifBtn') {
    if (!('Notification' in window)) { t.textContent = 'Não suportado'; return; }
    Notification.requestPermission().then(p => { browserNotif = p === 'granted'; t.textContent = browserNotif ? 'Browser: ativo' : 'Bloqueado'; });
  }
  if (t.id === 'broadcastBtn') {
    const text = prompt('Mensagem para todos os motoristas:');
    if (text && text.trim()) action({ type: 'broadcast', text: text.trim() });
  }
});

$('searchInput').addEventListener('input', renderList);
$('simSpeed').addEventListener('change', (e) => action({ type: 'speed', value: +e.target.value }));
$('chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('chatInput').value); });
['alertSevFilter', 'alertCatFilter', 'alertShowResolved'].forEach(id => $(id).addEventListener('change', renderAlertsView));
$('alertCatFilter').innerHTML += Object.entries(CATS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');

/* ==========================================================================
   ARRANQUE: há servidor? (se a página foi aberta pelo servidor Node.js)
   ========================================================================== */
renderLegend();
icons();
(async function boot() {
  let health = null;
  if (location.protocol.startsWith('http')) {
    try { const r = await fetch('/api/health', { cache: 'no-store' }); if (r.ok) health = await r.json(); } catch (e) { /* sem servidor */ }
  }
  if (!health || health.app !== 'gestao-frota') return startDemo();
  try { const r = await api('/api/me?role=gestor'); startServer(r.user); }
  catch (e) { mode = 'servidor'; setModeBadge(); showLogin(); }
})();
