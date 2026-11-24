/* ==========================================================================
   FROTA CORE — dados, regras e motor de simulação
   Usado em dois sítios:
     • no servidor (Node.js): é a "fonte da verdade" e grava tudo na base de dados;
     • no browser, em modo demonstração (sem servidor, ex.: no portfolio).
   Num sistema real o motor de simulação seria substituído pelos dados das caixas
   de telemática / tacógrafos digitais; as regras (desgaste, tempos de condução,
   ETA, alertas) mantinham-se.
   Todas as datas são números (milissegundos), para irem diretamente em JSON.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FrotaCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Utilitários ----------
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  function haversine(a, b) {
    const R = 6371, toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtHM = (min) => { min = Math.max(0, Math.round(min)); return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`; };
  const fmtKm = (km) => `${Math.round(km).toLocaleString('pt-PT')} km`;
  const fmtTime = (t) => new Date(t).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  const fmtDate = (t) => new Date(t).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short' });
  const fmtWhen = (t, now) => new Date(t).toDateString() === new Date(now).toDateString() ? fmtTime(t) : `${fmtDate(t)} ${fmtTime(t)}`;
  // euros: sem casas decimais se for redondo, senão com duas (412,80)
  const fmtEur = (n) => `${Number(n).toLocaleString('pt-PT', Number.isInteger(Number(n)) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const fmtDuration = (min) => {
    min = Math.max(0, Math.round(min));
    const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m} min`;
  };

  // ---------- Cidades: [nome, lat, lng, país] ----------
  const CITIES = [
    ['Porto', 41.1579, -8.6291, 'PT'], ['Braga', 41.5454, -8.4265, 'PT'], ['Maia', 41.2357, -8.6199, 'PT'],
    ['Aveiro', 40.6405, -8.6538, 'PT'], ['Coimbra', 40.2033, -8.4103, 'PT'], ['Pombal', 39.9159, -8.6280, 'PT'],
    ['Leiria', 39.7436, -8.8071, 'PT'], ['Santarém', 39.2369, -8.6850, 'PT'], ['Vila Franca de Xira', 38.9550, -8.9890, 'PT'],
    ['Lisboa', 38.7223, -9.1393, 'PT'], ['Amarante', 41.2717, -8.0820, 'PT'], ['Vila Real', 41.3006, -7.7441, 'PT'],
    ['Mirandela', 41.4850, -7.1810, 'PT'], ['Bragança', 41.8061, -6.7567, 'PT'], ['Viseu', 40.6566, -7.9125, 'PT'],
    ['Mangualde', 40.6040, -7.7610, 'PT'], ['Guarda', 40.5373, -7.2676, 'PT'], ['Vilar Formoso', 40.6100, -6.8350, 'PT'],
    ['Vendas Novas', 38.6770, -8.4560, 'PT'], ['Montemor-o-Novo', 38.6480, -8.2140, 'PT'], ['Évora', 38.5714, -7.9135, 'PT'],
    ['Estremoz', 38.8440, -7.5860, 'PT'], ['Elvas', 38.8800, -7.1630, 'PT'],
    ['Badajoz', 38.8794, -6.9707, 'ES'], ['Mérida', 38.9161, -6.3437, 'ES'], ['Trujillo', 39.4597, -5.8828, 'ES'],
    ['Navalmoral de la Mata', 39.8920, -5.5400, 'ES'], ['Talavera de la Reina', 39.9600, -4.8300, 'ES'], ['Madrid', 40.4168, -3.7038, 'ES'],
    ['Salamanca', 40.9701, -5.6635, 'ES'], ['Ávila', 40.6565, -4.6818, 'ES'], ['Valladolid', 41.6523, -4.7245, 'ES'],
    ['Burgos', 42.3439, -3.6969, 'ES'], ['Vitoria-Gasteiz', 42.8467, -2.6716, 'ES'], ['San Sebastián', 43.3183, -1.9812, 'ES'],
    ['Irún', 43.3390, -1.7890, 'ES'], ['Guadalajara', 40.6337, -3.1667, 'ES'], ['Medinaceli', 41.1700, -2.4300, 'ES'],
    ['Zaragoza', 41.6488, -0.8891, 'ES'], ['Barcelona', 41.3874, 2.1686, 'ES'], ['Girona', 41.9794, 2.8214, 'ES'],
    ['La Jonquera', 42.4196, 2.8746, 'ES'],
    ['Bayonne', 43.4929, -1.4748, 'FR'], ['Bordeaux', 44.8378, -0.5792, 'FR'], ['Poitiers', 46.5802, 0.3404, 'FR'],
    ['Tours', 47.3941, 0.6848, 'FR'], ['Orléans', 47.9030, 1.9093, 'FR'], ['Paris', 48.8566, 2.3522, 'FR'],
    ['Lille', 50.6292, 3.0573, 'FR'], ['Perpignan', 42.6887, 2.8948, 'FR'], ['Narbonne', 43.1844, 3.0039, 'FR'],
    ['Montpellier', 43.6108, 3.8767, 'FR'], ['Nîmes', 43.8367, 4.3601, 'FR'], ['Aix-en-Provence', 43.5297, 5.4474, 'FR'],
    ['Nice', 43.7102, 7.2620, 'FR'], ['Lyon', 45.7640, 4.8357, 'FR'], ['Besançon', 47.2378, 6.0241, 'FR'],
    ['Mulhouse', 47.7508, 7.3359, 'FR'], ['Strasbourg', 48.5734, 7.7521, 'FR'], ['Bourg-en-Bresse', 46.2052, 5.2255, 'FR'],
    ['Génova', 44.4056, 8.9463, 'IT'], ['Milão', 45.4642, 9.1900, 'IT'],
    ['Bruxelas', 50.8503, 4.3517, 'BE'], ['Antuérpia', 51.2194, 4.4025, 'BE'], ['Roterdão', 51.9244, 4.4777, 'NL'],
    ['Karlsruhe', 49.0069, 8.4037, 'DE'], ['Mannheim', 49.4875, 8.4660, 'DE'], ['Frankfurt', 50.1109, 8.6821, 'DE'],
  ];
  const COUNTRY = { PT: 'Portugal', ES: 'Espanha', FR: 'França', IT: 'Itália', BE: 'Bélgica', NL: 'Países Baixos', DE: 'Alemanha' };
  function nearestCityObj(p) {
    let best = null, bd = Infinity;
    for (const c of CITIES) { const d = haversine(p, [c[1], c[2]]); if (d < bd) { bd = d; best = c; } }
    return { name: best[0], cc: best[3], d: bd };
  }
  function nearestCity(p) {
    const c = nearestCityObj(p);
    const label = `${c.name} (${c.cc})`;
    return c.d < 4 ? label : `${Math.round(c.d)} km de ${label}`;
  }
  const P = Object.fromEntries(CITIES.map(c => [c[0], [c[1], c[2]]]));

  // ---------- Terreno ----------
  const TERRAIN = {
    plano:      { label: 'Plano',      tf: 0.0,  fuel: 1.00, vmax: 88 },
    misto:      { label: 'Misto',      tf: 0.25, fuel: 1.08, vmax: 82 },
    urbano:     { label: 'Urbano',     tf: 0.35, fuel: 1.18, vmax: 50 },
    montanhoso: { label: 'Montanhoso', tf: 0.6,  fuel: 1.28, vmax: 68 },
  };

  // ---------- Rotas (corredores reais, pontos aproximados) ----------
  // terrain[i] aplica-se ao troço entre path[i] e path[i+1]
  const ROUTES = {
    'A1 Porto → Lisboa': { path: [[41.1579,-8.6291],[40.86,-8.58],[40.6405,-8.6038],[40.2033,-8.4103],[39.9159,-8.6280],[39.7436,-8.8071],[39.2369,-8.6850],[38.9550,-8.9890],[38.7223,-9.1393]], terrain: ['urbano','plano','plano','misto','misto','plano','plano','urbano'] },
    'A4 Porto → Bragança': { path: [[41.1579,-8.6291],[41.2717,-8.0820],[41.3006,-7.7441],[41.4850,-7.1810],[41.8061,-6.7567]], terrain: ['misto','montanhoso','montanhoso','montanhoso'] },
    'Porto → Paris': { path: [P['Porto'], P['Aveiro'], P['Viseu'], P['Guarda'], P['Vilar Formoso'], P['Salamanca'], P['Valladolid'], P['Burgos'], P['Vitoria-Gasteiz'], P['San Sebastián'], P['Irún'], P['Bayonne'], P['Bordeaux'], P['Poitiers'], P['Tours'], P['Orléans'], P['Paris']],
      terrain: ['plano','montanhoso','montanhoso','misto','plano','plano','plano','montanhoso','montanhoso','misto','misto','plano','plano','plano','plano','urbano'] },
    'Mangualde → Zaragoza': { path: [P['Mangualde'], P['Guarda'], P['Vilar Formoso'], P['Salamanca'], P['Ávila'], P['Madrid'], P['Guadalajara'], P['Medinaceli'], P['Zaragoza']],
      terrain: ['montanhoso','misto','plano','misto','montanhoso','urbano','misto','plano'] },
    'Lisboa → Madrid': { path: [P['Lisboa'], P['Vendas Novas'], P['Montemor-o-Novo'], P['Évora'], P['Estremoz'], P['Elvas'], P['Badajoz'], P['Mérida'], P['Trujillo'], P['Navalmoral de la Mata'], P['Talavera de la Reina'], P['Madrid']],
      terrain: ['urbano','plano','plano','misto','plano','plano','plano','misto','misto','plano','urbano'] },
    'Barcelona → Milão': { path: [P['Barcelona'], P['Girona'], P['La Jonquera'], P['Perpignan'], P['Narbonne'], P['Montpellier'], P['Nîmes'], P['Aix-en-Provence'], P['Nice'], P['Génova'], P['Milão']],
      terrain: ['urbano','misto','montanhoso','plano','plano','plano','misto','montanhoso','montanhoso','misto'] },
    'Porto → Roterdão': { path: [P['Porto'], P['Aveiro'], P['Viseu'], P['Guarda'], P['Vilar Formoso'], P['Salamanca'], P['Valladolid'], P['Burgos'], P['Vitoria-Gasteiz'], P['San Sebastián'], P['Irún'], P['Bayonne'], P['Bordeaux'], P['Poitiers'], P['Tours'], P['Orléans'], P['Paris'], P['Lille'], P['Bruxelas'], P['Antuérpia'], P['Roterdão']],
      terrain: ['plano','montanhoso','montanhoso','misto','plano','plano','plano','montanhoso','montanhoso','misto','misto','plano','plano','plano','plano','urbano','plano','urbano','urbano','plano'] },
    'Frankfurt → Lyon': { path: [P['Frankfurt'], P['Mannheim'], P['Karlsruhe'], P['Strasbourg'], P['Mulhouse'], P['Besançon'], P['Bourg-en-Bresse'], P['Lyon']],
      terrain: ['plano','plano','plano','plano','misto','misto','urbano'] },
    'A1 Porto (oficina) → Coimbra': { path: [[41.1650,-8.6050],[40.86,-8.58],[40.6405,-8.6038],[40.2033,-8.4103]], terrain: ['urbano','plano','misto'] },
    'Bordeaux (oficina) → Paris': { path: [[44.8300,-0.6900], P['Poitiers'], P['Tours'], P['Orléans'], P['Paris']], terrain: ['plano','plano','plano','urbano'] },
  };

  // ---------- Peças e desgaste ----------
  // life: vida nominal em km · loadS: sensibilidade à carga · terrS: sensibilidade ao terreno
  const PARTS_DEF = [
    { key: 'pastilhas', name: 'Pastilhas de travão',       life: 80000,  loadS: 0.6, terrS: 1.2, cost: 420,  hours: 3 },
    { key: 'discos',    name: 'Discos de travão',          life: 200000, loadS: 0.5, terrS: 1.0, cost: 1100, hours: 5 },
    { key: 'pneus',     name: 'Pneus',                     life: 150000, loadS: 0.7, terrS: 0.6, cost: 3400, hours: 4 },
    { key: 'embraiagem',name: 'Embraiagem',                life: 350000, loadS: 0.5, terrS: 1.0, cost: 2600, hours: 10 },
    { key: 'oleo',      name: 'Óleo e filtro do motor',    life: 60000,  loadS: 0.3, terrS: 0.4, cost: 380,  hours: 2 },
    { key: 'filtroAr',  name: 'Filtro de ar',              life: 90000,  loadS: 0.1, terrS: 0.3, cost: 120,  hours: 1 },
    { key: 'suspensao', name: 'Amortecedores / suspensão', life: 300000, loadS: 0.6, terrS: 0.9, cost: 1800, hours: 6 },
    { key: 'correia',   name: 'Correia de acessórios',     life: 250000, loadS: 0.1, terrS: 0.2, cost: 260,  hours: 2 },
  ];
  const makeParts = (pcts) => PARTS_DEF.map(d => ({ ...d, used: d.life * ((pcts[d.key] ?? rand(10, 60)) / 100) }));
  const wearMult = (part, loadRatio, terrainKey) => (1 + part.loadS * loadRatio) * (1 + part.terrS * TERRAIN[terrainKey].tf);

  // ---------- Estados, categorias ----------
  const STATUS = {
    rota:    { label: 'Em rota',        color: '#16a34a', bg: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: 'navigation' },
    pausa:   { label: 'Em pausa',       color: '#d97706', bg: 'bg-amber-50 text-amber-700 border-amber-200',       icon: 'coffee' },
    parado:  { label: 'Carga/descarga', color: '#2563eb', bg: 'bg-blue-50 text-blue-700 border-blue-200',          icon: 'package' },
    oficina: { label: 'Em oficina',     color: '#dc2626', bg: 'bg-red-50 text-red-700 border-red-200',             icon: 'wrench' },
  };
  const CATS = { pecas: 'Peças', conducao: 'Condução', transito: 'Trânsito', carga: 'Carga', documentos: 'Documentos', oficina: 'Oficina', mensagens: 'Mensagens', motorista: 'App do motorista' };
  const DOC_NAMES = { ipo: 'Inspeção periódica (IPO)', seguro: 'Seguro', tacografo: 'Calibração do tacógrafo' };

  // ---------- Oficinas (própria e parceiras) ----------
  // Os nomes das oficinas externas são fictícios.
  const WORKSHOPS = [
    { id: 'porto',     name: 'Oficina Central — Porto',                         type: 'Própria', cc: 'PT', p: [41.1650, -8.6050] },
    { id: 'lisboa',    name: 'Oficina Norte Sul — Lisboa',                      type: 'Própria', cc: 'PT', p: [38.7800, -9.1000] },
    { id: 'salamanca', name: 'Talleres Castilla — Salamanca (ES)',              type: 'Externa', cc: 'ES', p: [40.9900, -5.6300] },
    { id: 'madrid',    name: 'Truck Center Coslada — Madrid (ES)',              type: 'Externa', cc: 'ES', p: [40.4250, -3.5500] },
    { id: 'barcelona', name: 'Tallers Vallès — Barcelona (ES)',                 type: 'Externa', cc: 'ES', p: [41.4900, 2.1400] },
    { id: 'bordeaux',  name: 'Garage Poids Lourds Mérignac — Bordeaux (FR)',    type: 'Externa', cc: 'FR', p: [44.8300, -0.6900] },
    { id: 'paris',     name: 'Garage PL Rungis — Paris (FR)',                   type: 'Externa', cc: 'FR', p: [48.7500, 2.3500] },
    { id: 'lyon',      name: 'Atelier Rhône Poids Lourds — Lyon (FR)',          type: 'Externa', cc: 'FR', p: [45.7200, 4.9000] },
    { id: 'milao',     name: 'Officina Veicoli Industriali — Milão (IT)',       type: 'Externa', cc: 'IT', p: [45.5000, 9.1000] },
    { id: 'antuerpia', name: 'Truck Repair Antwerpen — Antuérpia (BE)',         type: 'Externa', cc: 'BE', p: [51.2300, 4.4500] },
    { id: 'frankfurt', name: 'Nutzfahrzeug-Service Rhein-Main — Frankfurt (DE)', type: 'Externa', cc: 'DE', p: [50.0800, 8.6000] },
  ];
  const workshopById = (id) => WORKSHOPS.find(w => w.id === id) || null;
  const nearestWorkshop = (p) => WORKSHOPS.reduce((best, w) => { const d = haversine(p, w.p); return !best || d < best.d ? { w, d } : best; }, null).w;
  // fases de uma reparação
  const WS_PHASES = { diagnostico: 'Diagnóstico', pecas: 'Aguarda peças', reparacao: 'Em reparação', testes: 'Testes finais' };
  // anexos: faturas (PDF ou imagem) e fotos
  const ATTACH_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
  const ATTACH_KINDS = { fatura: 'Fatura', foto: 'Foto' };
  const ATTACH_MAX = 8 * 1024 * 1024;   // 8 MB por ficheiro
  const QUOTE_STATUS = { pendente: 'A aguardar aprovação', aprovado: 'Aprovado', recusado: 'Recusado' };
  const derivePhase = (ws) => {
    if (ws.waitingParts) return 'pecas';
    const pct = ws.elapsedH / Math.max(0.01, ws.elapsedH + ws.remainingH);
    return pct < 0.15 ? 'diagnostico' : pct < 0.85 ? 'reparacao' : 'testes';
  };
  // numa oficina externa, a reparação só começa depois de a central aprovar o orçamento
  const needsQuote = (ws) => ws.type === 'Externa' && !(ws.quote && ws.quote.status === 'aprovado');

  // ---------- Custos: tarifas por omissão (editáveis no painel) ----------
  // gasóleo profissional (€/L, sem IVA) e portagens/portagem eletrónica para camião 40 t (€/km)
  const TARIFFS_DEFAULT = {
    diesel: { PT: 1.62, ES: 1.48, FR: 1.71, IT: 1.78, BE: 1.85, NL: 1.80, DE: 1.72 },
    toll:   { PT: 0.21, ES: 0.12, FR: 0.24, IT: 0.20, BE: 0.15, NL: 0.17, DE: 0.35 },
    driverHour: 14.5,   // custo por hora de condução (salário + encargos + ajudas de custo)
    freightKm: 1.55,    // preço do frete por km de viagem carregada
    freightMin: 250,    // frete mínimo por entrega
  };
  const COST_CATS = { fuel: 'Combustível', toll: 'Portagens', driver: 'Motoristas', workshop: 'Oficina', other: 'Outros' };
  const EXPENSE_TYPES = { oficina: 'Oficina / reparação', pneus: 'Pneus', multa: 'Multa', lavagem: 'Lavagem', estacionamento: 'Estacionamento', portagem: 'Portagem (extra)', outros: 'Outros' };
  const expenseCat = (type) => type === 'oficina' || type === 'pneus' ? 'workshop' : 'other';
  const pad2 = (n) => String(n).padStart(2, '0');
  // dia (data local) de um instante: "2026-11-12"
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const newDaily = (day, vid, driver) => ({ day, vehicleId: vid, driver, km: 0, fuelL: 0, fuelCost: 0, tollCost: 0, driveMin: 0, driverCost: 0, revenue: 0, deliveries: 0, countries: {} });

  // ---------- Ocorrências de trânsito ----------
  const INCIDENT_POOL = [
    { type: 'Acidente', road: 'A1', place: 'Pombal', p: [39.93, -8.62], r: 6, delay: 35 },
    { type: 'Obras', road: 'A1', place: 'Santarém', p: [39.25, -8.69], r: 5, delay: 15 },
    { type: 'Nevoeiro', road: 'A4', place: 'Serra do Marão', p: [41.29, -7.92], r: 9, delay: 20 },
    { type: 'Obras', road: 'A25', place: 'Viseu', p: [40.665, -8.0], r: 6, delay: 15 },
    { type: 'Veículo avariado', road: 'A6', place: 'Montemor-o-Novo', p: [38.65, -8.25], r: 4, delay: 10 },
    { type: 'Acidente', road: 'A1', place: 'Aveiro Sul', p: [40.58, -8.58], r: 5, delay: 30 },
    { type: 'Obras', road: 'A-62', place: 'Salamanca', p: [41.10, -5.40], r: 8, delay: 20 },
    { type: 'Neve', road: 'AP-1', place: 'Desfiladeiro de Pancorbo', p: [42.63, -3.11], r: 15, delay: 60 },
    { type: 'Trânsito intenso', road: 'M-40', place: 'Madrid', p: [40.42, -3.75], r: 10, delay: 30 },
    { type: 'Vento forte', road: 'A-2', place: 'Medinaceli', p: [41.17, -2.43], r: 15, delay: 15 },
    { type: 'Acidente', road: 'A-5', place: 'Mérida', p: [38.95, -6.25], r: 6, delay: 30 },
    { type: 'Controlo fronteiriço', road: 'AP-7', place: 'La Jonquera', p: [42.42, 2.87], r: 6, delay: 40 },
    { type: 'Trânsito intenso', road: 'A63', place: 'Bayonne', p: [43.49, -1.47], r: 8, delay: 25 },
    { type: 'Trânsito intenso', road: 'Rocade', place: 'Bordeaux', p: [44.84, -0.58], r: 10, delay: 30 },
    { type: 'Obras', road: 'A10', place: 'Orléans', p: [47.90, 1.91], r: 8, delay: 20 },
    { type: 'Trânsito intenso', road: 'Périphérique', place: 'Paris', p: [48.85, 2.35], r: 12, delay: 45 },
    { type: 'Acidente', road: 'A8', place: 'Nice', p: [43.70, 7.15], r: 7, delay: 35 },
    { type: 'Greve / bloqueio', road: 'A9', place: 'Narbonne', p: [43.18, 3.00], r: 8, delay: 50 },
    { type: 'Obras', road: 'A7', place: 'Génova', p: [44.50, 8.95], r: 8, delay: 25 },
    { type: 'Trânsito intenso', road: 'R1', place: 'Antuérpia (túnel Kennedy)', p: [51.21, 4.38], r: 7, delay: 35 },
    { type: 'Obras', road: 'A5', place: 'Karlsruhe', p: [49.00, 8.42], r: 8, delay: 25 },
  ];

  // ---------- Geometria das rotas ----------
  function prepareVehicle(v) {
    const r = ROUTES[v.route];
    v.path = r.path; v.terrainSeg = r.terrain;
    v.segLens = v.path.slice(1).map((p, i) => haversine(v.path[i], p));
    v.totalLen = v.segLens.reduce((a, b) => a + b, 0);
    return v;
  }
  function posAtDist(v, dist) {
    let d = v.dir === 1 ? dist : v.totalLen - dist;
    const path = v.path;
    for (let i = 0; i < v.segLens.length; i++) {
      if (d <= v.segLens[i] || i === v.segLens.length - 1) {
        const t = v.segLens[i] ? clamp(d / v.segLens[i], 0, 1) : 0;
        return { pos: [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t], seg: v.dir === 1 ? i : i };
      }
      d -= v.segLens[i];
    }
    return { pos: path[0], seg: 0 };
  }
  function updatePos(v) { const r = posAtDist(v, v.dist); v.pos = r.pos; v.segIdx = r.seg; }
  const terrainOf = (v) => v.terrainSeg[v.segIdx ?? 0];
  const loadRatio = (v) => v.cargo.cap ? v.cargo.kg / v.cargo.cap : 0;
  const destination = (v) => nearestCity(v.dir === 1 ? v.path[v.path.length - 1] : v.path[0]);
  const origin = (v) => nearestCity(v.dir === 1 ? v.path[0] : v.path[v.path.length - 1]);
  const remainingKm = (v) => v.totalLen - v.dist;
  const partRemainingKm = (v, p) => Math.max(0, (p.life - p.used) / wearMult(p, loadRatio(v), terrainOf(v)));

  // a rota que falta percorrer passa perto da ocorrência?
  function incidentAhead(v, inc) {
    const km = remainingKm(v), steps = Math.max(30, Math.ceil(km / 5));
    for (let i = 0; i <= steps; i++) {
      if (haversine(posAtDist(v, v.dist + (km * i) / steps).pos, inc.p) < inc.r + 3) return true;
    }
    return false;
  }
  // hora prevista de chegada, com pausas (45 min / 4h30), descanso diário (11h / 9h) e trânsito
  function etaMs(v, now, incidents) {
    let min = remainingKm(v) / 78 * 60;
    const drive = min;
    const contLeft = Math.max(0, 270 - v.contDrive);
    if (drive > contLeft) min += 45 * Math.ceil((drive - contLeft) / 270);
    const dayLeft = Math.max(0, 540 - v.dayDrive);
    if (drive > dayLeft) min += 660 * Math.ceil((drive - dayLeft) / 540);
    if (v.status === 'pausa' || v.status === 'parado') min += v.pauseLeft;
    (incidents || []).forEach(inc => { if (incidentAhead(v, inc)) min += inc.delay; });
    return now + min * MIN;
  }

  // ---------- Estado inicial ----------
  function createInitialState(nowMs) {
    const start = new Date(nowMs || Date.now()); start.setHours(8, 30, 0, 0);
    const t0 = start.getTime();
    const addDays = (n) => t0 + n * DAY;
    const minsAgo = (n) => t0 - n * MIN;
    const vehicles = [
      { id: 'v1', plate: '45-AB-12', model: 'Volvo FH 500', driver: 'João Silva', phone: '+351 912 345 101', route: 'A1 Porto → Lisboa', km0: 120,
        cargo: { desc: 'Paletes alimentares (refrigerado)', kg: 18500, cap: 24000 }, contDrive: 232, dayDrive: 232, odometer: 412300,
        parts: { pastilhas: 72, oleo: 94.6, pneus: 61 }, docs: { ipo: addDays(140), seguro: addDays(210), tacografo: addDays(25) } },
      { id: 'v2', plate: '78-CD-34', model: 'Scania R450', driver: 'Maria Costa', phone: '+351 913 222 202', route: 'Porto → Paris', km0: 640,
        cargo: { desc: 'Materiais de construção', kg: 23800, cap: 24000 }, contDrive: 95, dayDrive: 95, odometer: 298100,
        parts: { pneus: 86.2, suspensao: 78 }, docs: { ipo: addDays(18), seguro: addDays(300), tacografo: addDays(400) } },
      { id: 'v3', plate: '12-EF-56', model: 'Mercedes-Benz Actros', driver: 'Rui Ferreira', phone: '+351 914 333 303', route: 'A4 Porto → Bragança', km0: 55,
        cargo: { desc: 'Maquinaria agrícola', kg: 21000, cap: 25000 }, contDrive: 140, dayDrive: 300, odometer: 515900,
        parts: { pastilhas: 84.7, discos: 88, embraiagem: 79 }, docs: { ipo: addDays(90), seguro: addDays(60), tacografo: addDays(500) } },
      { id: 'v4', plate: '90-GH-78', model: 'DAF XF 480', driver: 'Ana Santos', phone: '+351 915 444 404', route: 'Mangualde → Zaragoza', km0: 210,
        cargo: { desc: 'Componentes automóvel', kg: 12400, cap: 24000 }, contDrive: 60, dayDrive: 60, odometer: 187400,
        parts: { suspensao: 83.5, filtroAr: 92 }, docs: { ipo: addDays(200), seguro: addDays(12), tacografo: addDays(320) } },
      { id: 'v5', plate: '34-IJ-90', model: 'MAN TGX 18.510', driver: 'Pedro Almeida', phone: '+351 916 555 505', route: 'Lisboa → Madrid', km0: 230,
        cargo: { desc: 'Cortiça (exportação Espanha)', kg: 9800, cap: 24000 }, contDrive: 180, dayDrive: 180, odometer: 356700,
        parts: { correia: 55 }, docs: { ipo: addDays(300), seguro: addDays(150), tacografo: addDays(220) } },
      { id: 'v6', plate: '56-KL-12', model: 'Iveco S-Way', driver: 'Carla Rocha', phone: '+351 917 666 606', route: 'Barcelona → Milão', km0: 330,
        cargo: { desc: 'Têxteis', kg: 6200, cap: 18000 }, contDrive: 20, dayDrive: 20, odometer: 143200,
        parts: { pastilhas: 81 }, docs: { ipo: addDays(75), seguro: addDays(95), tacografo: addDays(600) } },
      { id: 'v7', plate: '11-QR-22', model: 'Scania S500', driver: 'Tiago Marques', phone: '+351 918 777 707', route: 'Porto → Roterdão', km0: 1230,
        cargo: { desc: 'Vinho do Porto (paletes)', kg: 22500, cap: 24000 }, contDrive: 270, dayDrive: 270, odometer: 266000, status: 'pausa', pauseLeft: 28,
        parts: { pneus: 79, oleo: 70 }, docs: { ipo: addDays(160), seguro: addDays(180), tacografo: addDays(90) } },
      { id: 'v8', plate: '23-MN-45', model: 'Volvo FM 460', driver: 'Luís Pereira', phone: '+351 919 888 808', route: 'A1 Porto (oficina) → Coimbra', km0: 0,
        cargo: { desc: '— (sem carga)', kg: 0, cap: 24000 }, contDrive: 0, dayDrive: 0, odometer: 601200, status: 'oficina',
        parts: { embraiagem: 99, discos: 64 }, docs: { ipo: addDays(45), seguro: addDays(250), tacografo: addDays(130) },
        workshop: { workshopId: 'porto', type: 'Própria', name: 'Oficina Central — Porto', reason: 'Substituição de embraiagem', parts: ['embraiagem'], enteredAt: minsAgo(26 * 60), totalH: 34, cost: 2900, waitingParts: false, quote: null,
          notes: [{ time: minsAgo(20 * 60), by: 'Oficina Central — Porto', text: 'Kit de embraiagem recebido.' }, { time: minsAgo(6 * 60), by: 'Oficina Central — Porto', text: 'Desmontagem da caixa concluída.' }] } },
      { id: 'v9', plate: '67-OP-89', model: 'Renault Trucks T480', driver: 'Sofia Nunes', phone: '+351 911 999 909', route: 'Bordeaux (oficina) → Paris', km0: 0,
        cargo: { desc: '— (sem carga)', kg: 0, cap: 24000 }, contDrive: 0, dayDrive: 0, odometer: 334800, status: 'oficina',
        parts: { pastilhas: 98, discos: 97, suspensao: 70 }, docs: { ipo: addDays(5), seguro: addDays(120), tacografo: addDays(250) },
        workshop: { workshopId: 'bordeaux', type: 'Externa', name: 'Garage Poids Lourds Mérignac — Bordeaux (FR)', reason: 'Travões (pastilhas + discos) e inspeção', parts: ['pastilhas', 'discos'], enteredAt: minsAgo(3 * 1440 + 200), totalH: 96, cost: 1850, waitingParts: true,
          quote: { amount: 1850, description: 'Pastilhas e discos do eixo dianteiro, mão de obra (6 h) e inspeção.', status: 'aprovado', sentAt: minsAgo(3 * 1440), by: 'Garage Poids Lourds Mérignac', decidedAt: minsAgo(3 * 1440 - 90), decidedBy: 'Gestor de Tráfego' },
          notes: [{ time: minsAgo(2 * 1440), by: 'Garage Poids Lourds Mérignac', text: 'Discos de travão encomendados ao fornecedor.' }, { time: minsAgo(400), by: 'Garage Poids Lourds Mérignac', text: 'Previsão de chegada das peças: amanhã de manhã.' }] } },
      { id: 'v10', plate: '89-ST-31', model: 'Mercedes-Benz Actros L', driver: 'Nuno Ribeiro', phone: '+351 912 101 010', route: 'Frankfurt → Lyon', km0: 150,
        cargo: { desc: 'Peças industriais (carga de retorno)', kg: 15800, cap: 24000 }, contDrive: 130, dayDrive: 310, odometer: 244900,
        parts: { oleo: 83, pneus: 66 }, docs: { ipo: addDays(110), seguro: addDays(26), tacografo: addDays(340) } },
    ];
    vehicles.forEach(v => {
      prepareVehicle(v);
      v.dist = Math.min(v.km0, v.totalLen - 1);
      v.dir = 1;
      v.status = v.status || 'rota';
      v.pauseLeft = v.pauseLeft || 0;
      v.speed = 0;
      v.kmToday = Math.min(v.km0, v.dayDrive / 60 * 76);
      v.fuelToday = v.kmToday * 0.31;
      v.parts = makeParts(v.parts);
      v.warnedCont = false;
      v.unread = 0;
      v.history = [];
      v.deliveries = [];
      v.deliveryPending = false;
      v.lastChecklist = null;
      if (v.workshop) {
        v.workshop.elapsedH = (t0 - v.workshop.enteredAt) / HOUR;
        v.workshop.remainingH = Math.max(1, v.workshop.totalH - v.workshop.elapsedH);
      }
      updatePos(v);
    });
    const threads = {};
    vehicles.forEach(v => threads[v.id] = []);
    let msgSeq = 0;
    threads.v3.push({ id: ++msgSeq, from: 'driver', text: 'Bom dia, já carreguei em Matosinhos. A caminho de Bragança.', time: minsAgo(140) });
    threads.v3.push({ id: ++msgSeq, from: 'base', text: 'Boa viagem Rui! Atenção ao nevoeiro no Marão.', time: minsAgo(135) });
    threads.v9.push({ id: ++msgSeq, from: 'driver', text: 'Deixei o camião na oficina em Bordeaux, dizem que os discos só chegam amanhã.', time: minsAgo(300) });
    vehicles.find(v => v.id === 'v3').unread = 1;
    return {
      simNow: t0, simSpeed: 60, paused: false, vehicles, incidents: [], alerts: [], alertKeys: [], threads,
      tariffs: JSON.parse(JSON.stringify(TARIFFS_DEFAULT)), daily: {}, expenses: [],
      seq: { alert: 0, incident: 0, message: msgSeq, expense: 0 },
    };
  }

  // ---------- Histórico inicial (últimos N dias), para os relatórios não começarem vazios ----------
  // Simulado como o resto: km por dia, países atravessados, combustível, portagens, horas, entregas e despesas.
  function routeCountryShare(route) {
    const r = ROUTES[route], share = {};
    let total = 0;
    r.path.slice(1).forEach((p, i) => {
      const a = r.path[i], len = haversine(a, p), steps = Math.max(1, Math.ceil(len / 25));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps, cc = nearestCityObj([a[0] + (p[0] - a[0]) * t, a[1] + (p[1] - a[1]) * t]).cc;
        share[cc] = (share[cc] || 0) + len / steps; total += len / steps;
      }
    });
    Object.keys(share).forEach(k => share[k] /= total);
    return { share, total };
  }
  function generateHistory(state, days) {
    days = days || 30;
    const T = state.tariffs, rows = [], expenses = [];
    const today0 = new Date(state.simNow); today0.setHours(12, 0, 0, 0);
    state.vehicles.forEach(v => {
      const { share, total } = routeCountryShare(v.route);
      const isWs = v.status === 'oficina';
      for (let d = days; d >= 1; d--) {
        const t = today0.getTime() - d * DAY, wd = new Date(t).getDay();
        const day = dayKey(t);
        if (isWs && d <= Math.ceil((v.workshop.elapsedH || 0) / 24)) continue;   // parado na oficina
        if (Math.random() < (wd === 0 ? 0.75 : wd === 6 ? 0.45 : 0.08)) continue;   // folga
        const km = rand(380, 720) * (wd === 6 ? 0.55 : 1);
        const r = newDaily(day, v.id, v.driver);
        r.km = km;
        Object.entries(share).forEach(([cc, f]) => {
          const k = km * f, l = k * rand(0.30, 0.36);
          r.countries[cc] = k; r.fuelL += l; r.fuelCost += l * T.diesel[cc]; r.tollCost += k * T.toll[cc] * rand(0.7, 1);
        });
        r.driveMin = km / rand(68, 76) * 60;
        r.driverCost = r.driveMin / 60 * T.driverHour;
        const trips = Math.floor(km / total + Math.random() * 0.9);
        for (let i = 0; i < trips; i++) {
          if (Math.random() < 0.15) continue;   // regresso vazio
          r.deliveries++;
          r.revenue += Math.max(T.freightMin, total * T.freightKm * rand(0.75, 0.98));
        }
        rows.push(r);
        // despesas avulsas
        const roll = Math.random();
        const add = (type, amount, description) => expenses.push({ id: ++state.seq.expense, time: t + rand(-4, 4) * HOUR, day, vehicleId: v.id, type, amount: Math.round(amount * 100) / 100, description, user: 'Sistema' });
        if (roll < 0.012) add('pneus', rand(2200, 3400), 'Substituição de pneus do eixo de tração');
        else if (roll < 0.03) add('oficina', rand(280, 1600), pick(['Revisão programada', 'Reparação de travões', 'Sensor ABS', 'Fuga de ar no circuito']));
        else if (roll < 0.075) add('lavagem', rand(45, 85), 'Lavagem completa');
        else if (roll < 0.095) add('estacionamento', rand(18, 42), 'Parque vigiado (descanso diário)');
        else if (roll < 0.1) add('multa', rand(150, 600), pick(['Excesso de velocidade', 'Estacionamento indevido']));
      }
    });
    return { daily: rows, expenses };
  }

  // ---------- Respostas simuladas dos motoristas (quando não estão na app) ----------
  const DRIVER_REPLIES = {
    default: ['Recebido 👍', 'Ok, entendido.', 'Combinado, obrigado.', 'Certo, vou tratar disso.'],
    pausa: ['Ok, paro na próxima área de serviço.', 'Já estava a pensar parar, obrigado.'],
    transito: ['Obrigado pelo aviso, vou ver alternativa.', 'Já estou a ver no GPS, sigo com atenção.'],
    entrega: ['Combinado, envio foto da guia assinada.', 'Ok, aviso assim que descarregar.'],
  };
  const DRIVER_SPONTANEOUS = [
    () => ['aviso', 'Muito trânsito aqui, vou atrasar uns 15 minutos.'],
    (v) => ['info', `Carga verificada, tudo ok. A seguir para ${destination(v)}.`],
    () => ['aviso', 'Estou a sentir uma vibração estranha ao travar, convém verificarem.'],
    () => ['info', 'Abasteci agora, depósito cheio.'],
  ];
  const CARGOS = [['Paletes mistas', 0.7], ['Retorno vazio', 0], ['Produtos químicos (ADR)', 0.8], ['Eletrodomésticos', 0.5], ['Papel e cartão', 0.9], ['Madeira', 1.02]];

  /* ==========================================================================
     MOTOR
     hooks (todos opcionais):
       onAlert(alerta) · onAlertPatch({id|all, read, resolved}) · onMessage(vid, msg)
       onDelivery(vid, entrega) · onChecklist(vid, checklist) · onPosition(veículo)
       onIncidents(lista)
     ========================================================================== */
  class Engine {
    constructor(state, hooks) {
      this.s = state;
      this.h = hooks || {};
      this.keys = new Set(state.alertKeys || []);
      this.online = new Set();      // veículos com o motorista ligado à app
      this.dailyKeepDays = 40;      // dias de custos guardados em memória (o servidor guarda tudo na base de dados)
      state.tariffs = state.tariffs || JSON.parse(JSON.stringify(TARIFFS_DEFAULT));
      state.daily = state.daily || {};
      state.expenses = state.expenses || [];
      state.seq.expense = state.seq.expense || 0;
      state.vehicles.forEach(v => { if (!v.segLens) prepareVehicle(v); updatePos(v); this.fixWorkshop(v); });
    }
    get now() { return this.s.simNow; }
    // dados antigos (antes do portal das oficinas): ligar à oficina certa e passar notas para o formato novo
    fixWorkshop(v) {
      const ws = v.workshop; if (!ws) return;
      if (!ws.workshopId) { const w = WORKSHOPS.find(x => x.name === ws.name) || nearestWorkshop(v.pos); ws.workshopId = w.id; ws.name = w.name; ws.type = w.type; }
      ws.notes = (ws.notes || []).map(n => typeof n === 'string' ? { time: null, by: ws.name, text: n } : n);
      if (ws.quote === undefined) ws.quote = null;
      if (!ws.repairId) ws.repairId = `${v.id}-${ws.enteredAt}`;
      if (!ws.attachments) ws.attachments = [];
      if (!ws.phase) ws.phase = derivePhase(ws);
    }
    wsNote(ws, by, text, extra) { ws.notes.push({ time: this.now, by, text, ...(extra || {}) }); if (ws.notes.length > 60) ws.notes.splice(0, ws.notes.length - 60); }
    byId(id) { return this.s.vehicles.find(v => v.id === id); }
    emit(name, ...args) { if (this.h[name]) try { this.h[name](...args); } catch (e) { console.error(e); } }

    // ---- alertas e mensagens ----
    raiseAlert({ key, sev, cat, vehicleId, title, text, toast = true, forceToast = false }) {
      if (key) { if (this.keys.has(key)) return null; this.keys.add(key); }
      const a = { id: ++this.s.seq.alert, key: key || null, sev, cat, vehicleId: vehicleId || null, title, text, time: this.now, read: false, resolved: false, toast: !!(forceToast || (toast && sev !== 'info')) };
      this.s.alerts.unshift(a);
      if (this.s.alerts.length > 500) this.s.alerts.length = 500;
      this.emit('onAlert', a);
      return a;
    }
    resolveAlert(id) { const a = this.s.alerts.find(x => x.id === id); if (a) { a.resolved = a.read = true; this.emit('onAlertPatch', { id, read: true, resolved: true }); } }
    markRead(id) { const a = this.s.alerts.find(x => x.id === id); if (a && !a.read) { a.read = true; this.emit('onAlertPatch', { id, read: true, resolved: a.resolved }); } }
    markAllRead() { this.s.alerts.forEach(a => a.read = true); this.emit('onAlertPatch', { all: true, read: true }); }

    addMessage(vid, from, text) {
      const v = this.byId(vid); if (!v) return;
      const m = { id: ++this.s.seq.message, from, text: String(text).slice(0, 500), time: this.now };
      this.s.threads[vid].push(m);
      if (this.s.threads[vid].length > 200) this.s.threads[vid].shift();
      if (from === 'driver') v.unread = (v.unread || 0) + 1;
      this.emit('onMessage', vid, m);
    }
    readThread(vid) { const v = this.byId(vid); if (v && v.unread) { v.unread = 0; this.emit('onMessage', vid, null); } }
    driverReply(vid, text) {
      if (this.online.has(vid)) return;   // motorista real na app: não simular
      const v = this.byId(vid);
      const t = text.toLowerCase();
      let r;
      if (/chega|previs|eta|hora/.test(t)) r = `Se o trânsito ajudar, chego a ${destination(v)} por volta de ${fmtWhen(etaMs(v, this.now, this.s.incidents), this.now)}.`;
      else if (/pausa|descans|parar/.test(t)) r = pick(DRIVER_REPLIES.pausa);
      else if (/tr[aâ]nsito|acidente|alternativ|obras/.test(t)) r = pick(DRIVER_REPLIES.transito);
      else if (/entreg|descarg|guia/.test(t)) r = pick(DRIVER_REPLIES.entrega);
      else r = pick(DRIVER_REPLIES.default);
      if (v.status === 'oficina') r = 'Estou na oficina, assim que tiver novidades aviso.';
      setTimeout(() => { if (!this.online.has(vid)) this.addMessage(vid, 'driver', r); }, rand(1500, 3500));
    }
    baseMessage(vid, text) {
      text = String(text || '').trim(); if (!text || !this.byId(vid)) return;
      this.addMessage(vid, 'base', text);
      this.driverReply(vid, text);
    }
    broadcast(text) {
      text = String(text || '').trim(); if (!text) return;
      this.s.vehicles.forEach(v => this.addMessage(v.id, 'base', '📢 ' + text));
    }

    // ---- custos ----
    accrue(v, d) {
      const day = dayKey(this.now), key = `${day}|${v.id}|${v.driver}`;
      const r = this.s.daily[key] || (this.s.daily[key] = newDaily(day, v.id, v.driver));
      ['km', 'fuelL', 'fuelCost', 'tollCost', 'driveMin', 'driverCost', 'revenue', 'deliveries'].forEach(k => { if (d[k]) r[k] += d[k]; });
      if (d.cc && d.km) r.countries[d.cc] = (r.countries[d.cc] || 0) + d.km;
      r._dirty = true;
    }
    addExpense({ vid, type, amount, description, user, repairId, attachments }) {
      amount = Math.round(Number(amount) * 100) / 100;
      if (!EXPENSE_TYPES[type] || !(amount > 0) || amount > 100000) return null;
      if (vid && !this.byId(vid)) return null;
      const e = { id: ++this.s.seq.expense, time: this.now, day: dayKey(this.now), vehicleId: vid || null, type, amount, description: String(description || '').trim().slice(0, 140), user: String(user || 'Gestor').slice(0, 60),
        repairId: repairId || null, attachments: attachments ? attachments.map(a => ({ ...a })) : [] };
      this.s.expenses.unshift(e);
      if (this.s.expenses.length > 2000) this.s.expenses.length = 2000;
      this.emit('onExpense', e);
      return e;
    }
    // apagar uma despesa registada à mão (as automáticas, da oficina, não se apagam)
    deleteExpense(id) {
      const i = this.s.expenses.findIndex(e => e.id === id);
      if (i >= 0 && this.s.expenses[i].user === 'Sistema') return false;
      if (i >= 0) this.s.expenses.splice(i, 1);
      this.emit('onExpenseDelete', id);
      return true;
    }
    setTariffs(t) {
      if (!t || typeof t !== 'object') return;
      const T = this.s.tariffs, num = (x, a, b) => { x = Number(x); return Number.isFinite(x) && x >= a && x <= b ? Math.round(x * 1000) / 1000 : null; };
      Object.keys(COUNTRY).forEach(cc => {
        const dz = num(t.diesel && t.diesel[cc], 0.5, 5); if (dz !== null) T.diesel[cc] = dz;
        const tl = num(t.toll && t.toll[cc], 0, 2); if (tl !== null) T.toll[cc] = tl;
      });
      const dh = num(t.driverHour, 0, 200); if (dh !== null) T.driverHour = dh;
      const fk = num(t.freightKm, 0, 20); if (fk !== null) T.freightKm = fk;
      const fm = num(t.freightMin, 0, 10000); if (fm !== null) T.freightMin = fm;
      this.emit('onTariffs', T);
    }
    pruneDaily() {
      const limit = dayKey(this.now - this.dailyKeepDays * DAY);
      Object.keys(this.s.daily).forEach(k => { if (this.s.daily[k].day < limit && !this.s.daily[k]._dirty) delete this.s.daily[k]; });
    }

    // ---- controlo da simulação ----
    setSpeed(n) { if ([1, 60, 300].includes(+n)) this.s.simSpeed = +n; }
    setPaused(p) { this.s.paused = !!p; }

    // ---- ciclo ----
    tick(dtRealSec) {
      if (this.s.paused) return;
      const dtSec = this.s.simSpeed * dtRealSec, dtMin = dtSec / 60;
      this.s.simNow += dtSec * 1000;
      const today = dayKey(this.s.simNow);
      if (this.s.today && this.s.today !== today) this.s.vehicles.forEach(v => { v.kmToday = 0; v.fuelToday = 0; });
      this.s.today = today;
      const hourBefore = Math.floor((this.s.simNow - dtSec * 1000) / HOUR);
      this.s.vehicles.forEach(v => this.stepVehicle(v, dtMin));
      if (Math.floor(this.s.simNow / HOUR) !== hourBefore) this.pruneDaily();

      // ocorrências: expirar e criar
      const before = this.s.incidents.length;
      this.s.incidents = this.s.incidents.filter(i => i.until > this.now);
      let changed = before !== this.s.incidents.length;
      if (this.s.incidents.length < 3 || (Math.random() < 0.004 * dtMin && this.s.incidents.length < 6)) {
        const free = INCIDENT_POOL.filter(t => !this.s.incidents.some(i => i.place === t.place));
        if (free.length) {
          const inc = this.addIncident(pick(free));
          this.raiseAlert({ sev: 'info', cat: 'transito', title: `${inc.type} na ${inc.road} (${inc.place})`, text: `Atraso estimado de ${inc.delay} min.`, toast: false });
          changed = true;
        }
      }
      if (changed) this.emit('onIncidents', this.s.incidents);

      // mensagens espontâneas (só de motoristas que não estão na app)
      if (Math.random() < 0.0025 * dtMin) {
        const v = pick(this.s.vehicles.filter(x => x.status === 'rota' && !this.online.has(x.id)));
        if (v) {
          const [sev, text] = pick(DRIVER_SPONTANEOUS)(v);
          this.addMessage(v.id, 'driver', text);
          this.raiseAlert({ sev, cat: 'mensagens', vehicleId: v.id, title: `Mensagem de ${v.driver}`, text, toast: sev === 'aviso' });
        }
      }
      this.checkDocs();
    }
    addIncident(tpl) {
      const inc = { ...tpl, id: 'i' + (++this.s.seq.incident), since: this.now, until: this.now + rand(90, 240) * MIN };
      this.s.incidents.push(inc);
      return inc;
    }

    stepVehicle(v, dtMin) {
      const terr = terrainOf(v);
      if (v.status === 'rota') {
        let target = TERRAIN[terr].vmax - loadRatio(v) * 6;
        if (this.s.incidents.some(inc => haversine(v.pos, inc.p) < inc.r)) target *= 0.35;
        v.speed += (target + rand(-4, 4) - v.speed) * 0.35;
        v.speed = clamp(v.speed, 0, 90);
        const dkm = v.speed * dtMin / 60;
        v.dist += dkm; v.kmToday += dkm; v.odometer += dkm;
        const fuelL = dkm / 100 * (27 + 10 * loadRatio(v)) * TERRAIN[terr].fuel;
        v.fuelToday += fuelL;
        v.contDrive += dtMin; v.dayDrive += dtMin;
        const T = this.s.tariffs, cc = nearestCityObj(v.pos).cc;
        this.accrue(v, { km: dkm, fuelL, fuelCost: fuelL * T.diesel[cc], tollCost: dkm * T.toll[cc], driveMin: dtMin, driverCost: dtMin / 60 * T.driverHour, cc });

        const lr = loadRatio(v);
        v.parts.forEach(p => {
          const b = p.used / p.life;
          p.used += dkm * wearMult(p, lr, terr);
          const a = p.used / p.life;
          if (b < 0.85 && a >= 0.85) this.raiseAlert({ key: `${v.id}-${p.key}-85`, sev: 'aviso', cat: 'pecas', vehicleId: v.id, title: `${v.plate}: ${p.name} a 85%`, text: `Restam ~${fmtKm(partRemainingKm(v, p))}. Recomenda-se agendar manutenção.` });
          if (b < 0.95 && a >= 0.95) this.raiseAlert({ key: `${v.id}-${p.key}-95`, sev: 'critico', cat: 'pecas', vehicleId: v.id, title: `${v.plate}: ${p.name} em fim de vida`, text: `${Math.round(a * 100)}% de desgaste. Restam ~${fmtKm(partRemainingKm(v, p))}.` });
        });

        this.s.incidents.forEach(inc => {
          const k = `${v.id}-${inc.id}`;
          if (!this.keys.has(k) && haversine(v.pos, inc.p) < inc.r + 25 && incidentAhead(v, inc)) {
            this.raiseAlert({ key: k, sev: 'aviso', cat: 'transito', vehicleId: v.id, title: `${v.plate}: ${inc.type} à frente`, text: `${inc.road} — ${inc.place}. Atraso estimado ${inc.delay} min. Motorista: ${v.driver}.` });
          }
        });

        // Reg. (CE) 561/2006: 4h30 contínuas, 9h diárias
        if (!v.warnedCont && v.contDrive >= 255) {
          v.warnedCont = true;
          this.raiseAlert({ key: `${v.id}-cont-${Math.floor(this.now / DAY)}-${Math.floor(v.dayDrive / 270)}`, sev: 'aviso', cat: 'conducao', vehicleId: v.id, title: `${v.plate}: pausa obrigatória em 15 min`, text: `${v.driver} conduz há ${fmtHM(v.contDrive)} seguidas (máx. 4h30).` });
        }
        if (v.contDrive >= 270) {
          v.status = 'pausa'; v.pauseLeft = 45; v.pauseStart = this.now; v.speed = 0;
          this.raiseAlert({ sev: 'info', cat: 'conducao', vehicleId: v.id, title: `${v.plate}: pausa de 45 min iniciada`, text: `${v.driver} parou em ${nearestCity(v.pos)}.`, toast: false });
        }
        if (v.dayDrive >= 540) {
          v.status = 'pausa'; v.pauseLeft = 11 * 60; v.pauseStart = this.now; v.speed = 0;
          this.raiseAlert({ key: `${v.id}-day-${Math.floor(this.now / DAY)}`, sev: 'aviso', cat: 'conducao', vehicleId: v.id, title: `${v.plate}: limite diário de 9h atingido`, text: `${v.driver} inicia descanso diário de 11h em ${nearestCity(v.pos)}.` });
        }
        if (v.dist >= v.totalLen) {
          v.dist = v.totalLen; v.status = 'parado'; v.pauseLeft = rand(35, 60); v.speed = 0; v.deliveryPending = true;
          updatePos(v);
          if (v.cargo.kg > 0) {
            const T = this.s.tariffs;
            const revenue = Math.round(Math.max(T.freightMin, v.totalLen * T.freightKm * (0.6 + 0.4 * Math.min(1, loadRatio(v)))));
            v.lastTripRevenue = revenue;
            this.accrue(v, { revenue, deliveries: 1 });
          }
          this.raiseAlert({ sev: 'info', cat: 'carga', vehicleId: v.id, title: `${v.plate} chegou a ${destination(v)}`, text: `Descarga de ${v.cargo.desc.toLowerCase()} em curso.`, toast: false });
        }
      } else if (v.status === 'pausa') {
        v.speed = 0; v.pauseLeft -= dtMin;
        if (v.pauseLeft <= 0) {
          if (v.dayDrive >= 540) v.dayDrive = 0;   // novo período de condução diária (Reg. 561/2006); os km "de hoje" contam por dia de calendário
          v.contDrive = 0; v.warnedCont = false; v.status = 'rota'; v.pauseLeft = 0; v.pauseStart = null;
        }
      } else if (v.status === 'parado') {
        v.speed = 0; v.pauseLeft = Math.max(0, v.pauseLeft - dtMin);
        // com a app ligada, o camião só parte depois de o motorista confirmar a entrega
        if (v.pauseLeft <= 0 && v.deliveryPending && this.online.has(v.id)) return;
        if (v.pauseLeft <= 0) {
          v.deliveryPending = false;
          v.dir *= -1; v.dist = 0; v.status = 'rota';
          const [desc, r] = pick(CARGOS);
          v.cargo = { desc, kg: Math.round(v.cargo.cap * r / 100) * 100, cap: v.cargo.cap };
          if (v.cargo.kg > v.cargo.cap) this.raiseAlert({ sev: 'critico', cat: 'carga', vehicleId: v.id, title: `${v.plate}: excesso de carga`, text: `${v.cargo.kg.toLocaleString('pt-PT')} kg para capacidade de ${v.cargo.cap.toLocaleString('pt-PT')} kg. Aumenta o desgaste e o risco de coima.` });
        }
      } else if (v.status === 'oficina') {
        v.speed = 0;
        const ws = v.workshop;
        ws.elapsedH += dtMin / 60;
        if (ws.managed) {
          // a oficina usa o portal: é ela que muda as fases e dá a reparação por concluída
          if (!ws.waitingParts && !needsQuote(ws)) ws.remainingH = Math.max(0, ws.remainingH - dtMin / 60);
          if (ws.remainingH <= 0 && !ws.overdue) {
            ws.overdue = true;
            this.raiseAlert({ sev: 'aviso', cat: 'oficina', vehicleId: v.id, title: `${v.plate}: previsão da oficina ultrapassada`, text: `${ws.name} ainda não deu a reparação por concluída.`, toast: false });
          }
        } else {
          // oficina sem portal: progresso simulado
          if (ws.waitingParts) {
            if (Math.random() < 0.004 * dtMin) {
              ws.waitingParts = false; this.wsNote(ws, ws.name, 'Peças recebidas, reparação retomada.');
              this.raiseAlert({ sev: 'info', cat: 'oficina', vehicleId: v.id, title: `${v.plate}: peças chegaram à oficina`, text: `${ws.name} retomou a reparação.`, toast: false });
            }
          } else ws.remainingH -= dtMin / 60;
          ws.phase = derivePhase(ws);
          if (ws.remainingH <= 0) this.finishWorkshop(v);
        }
      }
      updatePos(v);
      if (!v.lastPosLog || this.now - v.lastPosLog >= 5 * MIN) { v.lastPosLog = this.now; this.emit('onPosition', v); }
    }

    finishWorkshop(v) {
      const ws = v.workshop;
      v.parts.forEach(p => { if (ws.parts.includes(p.key)) { p.used = 0; ['85', '95'].forEach(l => this.keys.delete(`${v.id}-${p.key}-${l}`)); } });
      this.s.alerts.forEach(a => {
        if (a.vehicleId === v.id && a.cat === 'pecas' && !a.resolved && ws.parts.some(k => a.key && a.key.includes(`-${k}-`))) { a.resolved = true; this.emit('onAlertPatch', { id: a.id, read: a.read, resolved: true }); }
      });
      v.history.unshift({ workshopId: ws.workshopId, repairId: ws.repairId, name: ws.name, type: ws.type, reason: ws.reason, cost: ws.cost, enteredAt: ws.enteredAt, leftAt: this.now,
        invoice: ws.invoice || null, attachments: (ws.attachments || []).map(a => ({ ...a })) });
      this.addExpense({ vid: v.id, type: 'oficina', amount: ws.cost, description: `${ws.reason} — ${ws.name}${ws.invoice && ws.invoice.number ? ` (fatura ${ws.invoice.number})` : ''}`, user: 'Sistema', repairId: ws.repairId, attachments: ws.attachments });
      v.history = v.history.slice(0, 10);
      v.workshop = null;
      v.status = 'rota'; v.contDrive = 0; v.warnedCont = false;
      if (!v.cargo.kg) v.cargo = { desc: 'Paletes mistas', kg: 14000, cap: v.cargo.cap };
      this.raiseAlert({ sev: 'aviso', cat: 'oficina', vehicleId: v.id, title: `${v.plate} saiu da oficina`, text: `${ws.reason} concluída em ${ws.name} (${fmtEur(ws.cost)}). Veículo de volta ao serviço.` });
      this.addMessage(v.id, 'base', `O camião está pronto na ${ws.name}. Podes ir buscá-lo.`);
    }

    scheduleMaintenance(vid, partKeys) {
      const v = this.byId(vid);
      if (!v || v.status === 'oficina') return;
      partKeys = partKeys && partKeys.length ? partKeys : v.parts.filter(p => p.used / p.life >= 0.8).map(p => p.key);
      const parts = PARTS_DEF.filter(p => partKeys.includes(p.key));
      if (!parts.length) return;
      const hours = parts.reduce((a, p) => a + p.hours, 0) + 2;
      const w = nearestWorkshop(v.pos);
      v.status = 'oficina'; v.speed = 0; v.deliveryPending = false;
      v.workshop = {
        workshopId: w.id, type: w.type, name: w.name,
        reason: 'Manutenção preventiva: ' + parts.map(p => p.name.toLowerCase()).join(', '),
        parts: partKeys, enteredAt: this.now, totalH: hours, elapsedH: 0, remainingH: hours, phase: 'diagnostico',
        cost: parts.reduce((a, p) => a + p.cost, 0), waitingParts: false, quote: null, managed: false,
        repairId: `${v.id}-${this.now}`, attachments: [],
        notes: [{ time: this.now, by: 'Central', text: 'Entrada para manutenção preventiva (agendada no painel).' }],
      };
      this.emit('onWorkshopEvent', w.id, { title: `Novo camião: ${v.plate}`, text: `${v.workshop.reason}. Motorista: ${v.driver}.` });
      this.addMessage(vid, 'base', `Olá ${v.driver.split(' ')[0]}, o veículo foi agendado para manutenção na ${v.workshop.name}. Dirige-te lá assim que possível.`);
      this.driverReply(vid, 'ok');
      this.raiseAlert({ sev: 'info', cat: 'oficina', vehicleId: vid, title: `${v.plate} agendado para oficina`, text: `${v.workshop.reason}. Previsão: ${fmtDuration(hours * 60)}.`, toast: false });
    }

    workshopUpdate(vid) {
      const v = this.byId(vid);
      if (!v || !v.workshop) return;
      const ws = v.workshop;
      this.wsNote(ws, 'Central', 'Pedido de ponto de situação.', { request: true });
      if (ws.managed || this.workshopOnline(ws.workshopId)) {
        // a oficina tem o portal: é ela que responde
        this.emit('onWorkshopEvent', ws.workshopId, { title: `${v.plate}: a central pede ponto de situação`, text: ws.reason });
        return;
      }
      setTimeout(() => {
        if (v.workshop !== ws) return;
        this.wsNote(ws, ws.name, ws.waitingParts ? 'Ainda a aguardar peças do fornecedor.' : `Faltam cerca de ${fmtDuration(ws.remainingH * 60)}.`);
      }, 2500);
    }
    workshopOnline(wid) { return !!(this.workshopsOnline && this.workshopsOnline.has(wid)); }

    // ---- ações vindas do portal da oficina (devolvem uma mensagem de erro, ou null) ----
    workshopAction(wid, by, m) {
      const v = m && this.byId(m.vid);
      if (!v || v.status !== 'oficina' || !v.workshop || v.workshop.workshopId !== wid) return 'Este camião não está na tua oficina.';
      const ws = v.workshop;
      by = String(by || ws.name).slice(0, 60);
      const alert = (sev, title, text, extra) => this.raiseAlert({ sev, cat: 'oficina', vehicleId: v.id, title: `${v.plate}: ${title}`, text, ...(extra || {}) });
      const err = this.applyWorkshopAction(v, ws, by, m, alert);
      // a reparação passa a ser gerida pela oficina (e deixa de ser simulada) só quando uma ação é aceite
      if (!err) { ws.managed = true; ws.updatedAt = this.now; ws.updatedBy = by; }
      return err;
    }
    applyWorkshopAction(v, ws, by, m, alert) {
      switch (m.type) {
        case 'phase': {
          if (!WS_PHASES[m.phase]) return 'Fase inválida.';
          if ((m.phase === 'reparacao' || m.phase === 'testes') && needsQuote(ws)) return 'A reparação só começa depois de a central aprovar o orçamento.';
          if (ws.phase === m.phase) return null;
          ws.phase = m.phase; ws.waitingParts = m.phase === 'pecas';
          this.wsNote(ws, by, `Fase: ${WS_PHASES[m.phase]}.`);
          alert('info', `${WS_PHASES[m.phase].toLowerCase()} (${ws.name})`, `Atualizado por ${by}.`, { toast: false });
          return null;
        }
        case 'estimate': {
          const h = Number(m.hours);
          if (!(h >= 0.5 && h <= 720)) return 'Previsão entre 0,5 h e 720 h.';
          ws.remainingH = h; ws.overdue = false;
          this.wsNote(ws, by, `Nova previsão: faltam ~${fmtDuration(h * 60)}.`);
          alert('info', 'nova previsão da oficina', `Faltam ~${fmtDuration(h * 60)} (${ws.name}).`, { toast: false });
          return null;
        }
        case 'note': {
          const text = String(m.text || '').trim().slice(0, 300);
          if (!text) return 'Escreve a nota.';
          const answersRequest = ws.notes.some(n => n.request && !n.answered);
          ws.notes.forEach(n => { if (n.request) n.answered = true; });
          this.wsNote(ws, by, text);
          alert('info', answersRequest ? 'resposta da oficina' : 'nota da oficina', text.slice(0, 140), { forceToast: answersRequest });
          return null;
        }
        case 'quote': {
          const amount = Math.round(Number(m.amount) * 100) / 100;
          if (!(amount >= 1 && amount <= 200000)) return 'Valor do orçamento entre 1 € e 200 000 €.';
          const description = String(m.description || '').trim().slice(0, 400);
          if (description.length < 5) return 'Descreve o que inclui o orçamento.';
          if (ws.quote && ws.quote.status === 'aprovado') return 'O orçamento já foi aprovado.';
          ws.quote = { amount, description, status: 'pendente', sentAt: this.now, by };
          ws.cost = amount;
          this.wsNote(ws, by, `Orçamento enviado: ${fmtEur(amount)}.`);
          alert('aviso', `orçamento de ${fmtEur(amount)} a aguardar aprovação`, `${ws.name}: ${description.slice(0, 120)}`, { forceToast: true });
          return null;
        }
        case 'attach': {
          if (!this.allowInlineAttachments) return 'Os ficheiros enviam-se pela API.';
          if (typeof m.url !== 'string' || !m.url.startsWith('data:') || m.url.length > ATTACH_MAX * 1.4) return 'Ficheiro demasiado grande (máx. 8 MB).';
          return this.addAttachment(v.id, { kind: m.kind, mime: m.mime, url: m.url, name: m.name, size: m.size, number: m.number, amount: m.amount, by });
        }
        case 'detach': {
          if (!this.allowInlineAttachments) return 'Os ficheiros apagam-se pela API.';
          return this.removeAttachment(v.id, m.id) ? null : 'Anexo não encontrado.';
        }
        case 'finish': {
          if (needsQuote(ws)) return 'Falta a aprovação do orçamento pela central.';
          const cost = m.cost === undefined || m.cost === '' || m.cost === null || Number.isNaN(Number(m.cost)) ? ((ws.invoice && ws.invoice.amount) || ws.cost) : Math.round(Number(m.cost) * 100) / 100;
          if (!(cost >= 0 && cost <= 200000)) return 'Custo final inválido.';
          ws.cost = cost;
          const note = String(m.note || '').trim().slice(0, 300);
          this.wsNote(ws, by, `Reparação concluída${note ? ': ' + note : '.'}`);
          this.finishWorkshop(v);
          return null;
        }
      }
      return 'Ação desconhecida.';
    }

    // ---- anexos de uma reparação (o servidor guarda o ficheiro; aqui fica a referência) ----
    addAttachment(vid, att) {
      const v = this.byId(vid), ws = v && v.workshop;
      if (!ws || !ATTACH_KINDS[att.kind] || !ATTACH_MIME[att.mime]) return 'Anexo inválido.';
      if ((ws.attachments || []).length >= 40) return 'Esta reparação já tem demasiados anexos.';
      const a = {
        id: att.id || `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, kind: att.kind, mime: att.mime, url: att.url,
        name: String(att.name || (att.kind === 'fatura' ? 'fatura' : 'foto')).slice(0, 80), size: att.size || 0, by: String(att.by || ws.name).slice(0, 60), time: this.now,
        number: att.kind === 'fatura' ? String(att.number || '').trim().slice(0, 40) : undefined,
        amount: att.kind === 'fatura' && Number(att.amount) > 0 ? Math.round(Number(att.amount) * 100) / 100 : undefined,
      };
      ws.attachments.push(a);
      if (a.kind === 'fatura') {
        ws.invoice = { number: a.number || null, amount: a.amount || null, attachmentId: a.id };
        this.wsNote(ws, a.by, `Fatura anexada${a.number ? ` n.º ${a.number}` : ''}${a.amount ? ` (${fmtEur(a.amount)})` : ''}.`);
        this.raiseAlert({ sev: 'info', cat: 'oficina', vehicleId: vid, title: `${v.plate}: fatura da oficina`, text: `${ws.name}${a.number ? ` · n.º ${a.number}` : ''}${a.amount ? ` · ${fmtEur(a.amount)}` : ''}`, forceToast: true });
      } else {
        this.wsNote(ws, a.by, 'Foto anexada.');
      }
      return null;
    }
    removeAttachment(vid, id) {
      const v = this.byId(vid), ws = v && v.workshop;
      if (!ws) return false;
      const i = ws.attachments.findIndex(a => a.id === id);
      if (i < 0) return false;
      const [a] = ws.attachments.splice(i, 1);
      if (ws.invoice && ws.invoice.attachmentId === id) ws.invoice = null;
      this.wsNote(ws, a.by, `${ATTACH_KINDS[a.kind]} removida: ${a.name}.`);
      return true;
    }
    // anexo numa despesa já registada (modo demo; com servidor fica só na base de dados)
    attachToExpense(expenseId, att) {
      const e = this.s.expenses.find(x => x.id === expenseId);
      if (!e || !ATTACH_MIME[att.mime]) return false;
      (e.attachments = e.attachments || []).push({ ...att, id: att.id || `a${Date.now().toString(36)}`, time: this.now });
      this.emit('onExpense', e);
      return true;
    }

    // ---- decisão da central sobre um orçamento ----
    quoteDecision(vid, approve, reason, by) {
      const v = this.byId(vid);
      const ws = v && v.workshop;
      if (!ws || !ws.quote || ws.quote.status !== 'pendente') return;
      ws.quote.status = approve ? 'aprovado' : 'recusado';
      ws.quote.decidedAt = this.now; ws.quote.decidedBy = String(by || 'Central').slice(0, 60);
      ws.quote.reason = String(reason || '').trim().slice(0, 200);
      this.wsNote(ws, 'Central', approve ? 'Orçamento aprovado. Podem avançar com a reparação.' : `Orçamento recusado${ws.quote.reason ? ': ' + ws.quote.reason : '.'}`);
      this.emit('onWorkshopEvent', ws.workshopId, { title: `${v.plate}: orçamento ${approve ? 'aprovado' : 'recusado'}`, text: approve ? 'Podem avançar com a reparação.' : (ws.quote.reason || 'Enviem um novo orçamento.') });
      this.raiseAlert({ sev: 'info', cat: 'oficina', vehicleId: vid, title: `${v.plate}: orçamento ${approve ? 'aprovado' : 'recusado'}`, text: `${fmtEur(ws.quote.amount)} · ${ws.name}`, toast: false });
    }

    // o que o portal de uma oficina vê
    workshopSnapshot(wid) {
      const def = workshopById(wid);
      const vehicles = this.s.vehicles.filter(v => v.status === 'oficina' && v.workshop && v.workshop.workshopId === wid).map(v => ({
        id: v.id, plate: v.plate, model: v.model, driver: v.driver, phone: v.phone, odometer: v.odometer,
        parts: v.parts.map(p => ({ name: p.name, pct: p.used / p.life * 100 })).filter(p => p.pct >= 60).sort((a, b) => b.pct - a.pct),
        workshop: v.workshop,
      }));
      const history = this.s.vehicles.flatMap(v => (v.history || []).filter(h => h.workshopId === wid).map(h => ({ ...h, plate: v.plate, model: v.model })))
        .sort((a, b) => b.leftAt - a.leftAt).slice(0, 15);
      return { simNow: this.now, workshop: def, vehicles, history };
    }

    checkDocs() {
      this.s.vehicles.forEach(v => Object.entries(v.docs).forEach(([k, d]) => {
        const days = Math.ceil((d - this.now) / DAY);
        if (days > 30) return;
        // um alerta por nível: aviso a 30 dias, crítico a 7 dias e crítico outra vez quando expira
        const level = days <= 0 ? 'expirado' : days <= 7 ? '7' : '30';
        const base = `${v.id}-doc-${k}`, key = `${base}-${level}`;
        if (this.keys.has(key) || (level === '30' && this.keys.has(base))) return;   // (base = formato antigo)
        // o alerta anterior deste documento fica resolvido: há um novo, mais grave
        this.s.alerts.forEach(a => {
          if (!a.resolved && a.key && (a.key === base || a.key.startsWith(base + '-'))) { a.resolved = true; this.emit('onAlertPatch', { id: a.id, read: a.read, resolved: true }); }
        });
        this.emit('onResolveKeys', base);   // também os que já saíram da lista em memória (servidor: base de dados)
        const date = new Date(d).toLocaleDateString('pt-PT');
        this.raiseAlert({
          key, sev: level === '30' ? 'aviso' : 'critico', cat: 'documentos', vehicleId: v.id,
          title: days <= 0 ? `${v.plate}: ${DOC_NAMES[k]} expirou` : `${v.plate}: ${DOC_NAMES[k]} expira em ${days} dias`,
          text: days <= 0 ? `Expirou a ${date}. O camião não deve circular até estar regularizado.` : `Data limite: ${date}.`,
          toast: level !== '30',
        });
      }));
    }

    // alertas de partida (peças acima dos limites, documentos)
    initialAlerts() {
      this.s.vehicles.forEach(v => v.parts.forEach(p => {
        const pct = p.used / p.life;
        if (pct >= 0.95) this.raiseAlert({ key: `${v.id}-${p.key}-95`, sev: 'critico', cat: 'pecas', vehicleId: v.id, title: `${v.plate}: ${p.name} em fim de vida`, text: `${Math.round(pct * 100)}% de desgaste.${v.status === 'oficina' ? ' Em reparação.' : ''}`, toast: false });
        else if (pct >= 0.85) this.raiseAlert({ key: `${v.id}-${p.key}-85`, sev: 'aviso', cat: 'pecas', vehicleId: v.id, title: `${v.plate}: ${p.name} a ${Math.round(pct * 100)}%`, text: `Restam ~${fmtKm(partRemainingKm(v, p))}. Recomenda-se agendar manutenção.`, toast: false });
      }));
      this.checkDocs();
      INCIDENT_POOL.slice(0, 3).forEach(t => this.addIncident(t));
    }

    // ---- motorista: ligação e ações vindas da app ----
    driverConnected(vid) {
      const v = this.byId(vid); if (!v || this.online.has(vid)) return;
      this.online.add(vid);
      this.raiseAlert({ sev: 'info', cat: 'motorista', vehicleId: vid, title: `${v.driver} ligou-se à app`, text: `${v.plate} · ${nearestCity(v.pos)}`, toast: false });
    }
    driverDisconnected(vid) {
      const v = this.byId(vid); if (!v || !this.online.has(vid)) return;
      this.online.delete(vid);
      this.raiseAlert({ sev: 'info', cat: 'motorista', vehicleId: vid, title: `${v.driver} saiu da app`, text: v.plate, toast: false });
    }
    driverAction(vid, m) {
      const v = this.byId(vid);
      if (!v || !m) return;
      const now = this.now;
      if (m.type === 'msg') {
        const text = String(m.text || '').trim().slice(0, 500); if (!text) return;
        this.addMessage(vid, 'driver', text);
        this.raiseAlert({ sev: 'info', cat: 'mensagens', vehicleId: vid, title: `Mensagem de ${v.driver}`, text: text.slice(0, 140), forceToast: true });
      } else if (m.type === 'pausa' && v.status === 'rota') {
        v.status = 'pausa'; v.pauseLeft = 45; v.pauseStart = now; v.speed = 0;
        this.raiseAlert({ sev: 'info', cat: 'conducao', vehicleId: vid, title: `${v.plate}: pausa iniciada pelo motorista`, text: `${v.driver} parou em ${nearestCity(v.pos)} (45 min).`, toast: false });
      } else if (m.type === 'retomar' && v.status === 'pausa') {
        const taken = v.pauseStart ? (now - v.pauseStart) / MIN : 45;
        if (taken >= 45) { v.contDrive = 0; v.warnedCont = false; }
        else this.raiseAlert({ sev: 'aviso', cat: 'conducao', vehicleId: vid, title: `${v.plate}: pausa interrompida`, text: `${v.driver} retomou a condução após ${Math.round(taken)} min (mínimo 45 min). O tempo contínuo não foi reposto.` });
        v.status = 'rota'; v.pauseLeft = 0; v.pauseStart = null;
      } else if (m.type === 'entrega' && v.deliveryPending) {
        const d = { receiver: String(m.receiver || '').slice(0, 80), notes: String(m.notes || '').slice(0, 300), photo: m.photo || null, signature: m.signature || null, time: now, place: nearestCity(v.pos), cargo: v.cargo.desc };
        v.deliveries.unshift(d); v.deliveries = v.deliveries.slice(0, 5);
        v.deliveryPending = false;
        this.emit('onDelivery', vid, d);
        this.raiseAlert({ sev: 'info', cat: 'carga', vehicleId: vid, title: `${v.plate}: entrega confirmada`, text: `${d.cargo} em ${d.place}. Recebido por ${d.receiver || '—'}.`, forceToast: true });
        this.addMessage(vid, 'driver', `✅ Entrega confirmada em ${d.place}. Recebido por ${d.receiver || '—'}.`);
      } else if (m.type === 'checklist') {
        const items = (Array.isArray(m.items) ? m.items : []).slice(0, 20).map(i => ({ name: String(i.name || '').slice(0, 80), ok: !!i.ok, note: String(i.note || '').slice(0, 120) }));
        const issues = items.filter(i => !i.ok);
        v.lastChecklist = { time: now, items, issues };
        this.emit('onChecklist', vid, v.lastChecklist);
        if (issues.length) this.raiseAlert({ sev: 'aviso', cat: 'motorista', vehicleId: vid, title: `${v.plate}: checklist com ${issues.length} problema(s)`, text: issues.map(i => i.name + (i.note ? ` (${i.note})` : '')).join(' · ').slice(0, 200), forceToast: true });
        else this.raiseAlert({ sev: 'info', cat: 'motorista', vehicleId: vid, title: `${v.plate}: checklist sem problemas`, text: `Verificação pré-viagem feita por ${v.driver}.`, toast: false });
      } else if (m.type === 'sos') {
        const kinds = { avaria: 'Avaria', acidente: 'Acidente', saude: 'Problema de saúde', seguranca: 'Segurança / roubo' };
        const k = kinds[m.kind] || 'Emergência';
        const text = String(m.text || '').slice(0, 160);
        if (v.status === 'rota') { v.status = 'pausa'; v.pauseLeft = 60; v.pauseStart = now; v.speed = 0; }
        this.raiseAlert({ sev: 'critico', cat: 'motorista', vehicleId: vid, title: `🆘 ${v.plate}: ${k}`, text: `${v.driver} em ${nearestCity(v.pos)} (${v.pos[0].toFixed(4)}, ${v.pos[1].toFixed(4)}). ${text}` });
        this.addMessage(vid, 'driver', `🆘 ${k}${text ? ': ' + text : ''}`);
      }
    }

    // ---- motorista atribuído ao camião (gestão de utilizadores) ----
    setDriver(vid, info) {
      const v = this.byId(vid); if (!v) return;
      v.driver = info ? info.name : '— (sem motorista)';
      v.phone = info ? (info.phone || '') : '';
    }

    // ---- ações do gestor (vindas do painel) ----
    managerAction(m) {
      switch (m && m.type) {
        case 'msg': return this.baseMessage(m.vid, m.text);
        case 'broadcast': return this.broadcast(m.text);
        case 'readThread': return this.readThread(m.vid);
        case 'schedule': return this.scheduleMaintenance(m.vid);
        case 'wsUpdate': return this.workshopUpdate(m.vid);
        case 'resolve': return this.resolveAlert(+m.id);
        case 'read': return this.markRead(+m.id);
        case 'readAll': return this.markAllRead();
        case 'speed': return this.setSpeed(m.value);
        case 'pause': return this.setPaused(m.value);
        case 'expense': return this.addExpense({ vid: m.vid, type: m.expenseType, amount: m.amount, description: m.description, user: m.user });
        case 'tariffs': return this.setTariffs(m.tariffs);
        case 'deleteExpense': return this.deleteExpense(+m.id);
        case 'quoteDecision': return this.quoteDecision(m.vid, !!m.approve, m.reason, m.user);
      }
    }

    // ---- vistas do estado ----
    // camião sem a geometria fixa da rota (vai em cada atualização)
    vehicleLite(v) {
      const { path, terrainSeg, segLens, ...rest } = v;
      return rest;
    }
    fullState() {
      return {
        simNow: this.s.simNow, simSpeed: this.s.simSpeed, paused: this.s.paused,
        vehicles: this.s.vehicles, incidents: this.s.incidents, alerts: this.s.alerts.slice(0, 300),
        threads: this.s.threads, online: [...this.online],
      };
    }
    tickState() {
      return { simNow: this.s.simNow, simSpeed: this.s.simSpeed, paused: this.s.paused, vehicles: this.s.vehicles.map(v => this.vehicleLite(v)), incidents: this.s.incidents, online: [...this.online] };
    }
    // o que a app do motorista precisa de saber sobre o seu camião
    driverSnapshot(v) {
      const incs = this.s.incidents;
      const ahead = v.status === 'oficina' ? [] : incs.filter(i => incidentAhead(v, i)).map(i => ({ type: i.type, road: i.road, place: i.place, delay: i.delay, km: Math.round(haversine(v.pos, i.p)) }));
      return {
        id: v.id, plate: v.plate, model: v.model, driver: v.driver, status: v.status, statusLabel: STATUS[v.status].label,
        pos: v.pos, path: v.path, dir: v.dir, speed: Math.round(v.speed), contDrive: v.contDrive, dayDrive: v.dayDrive, pauseLeft: v.pauseLeft,
        kmToday: v.kmToday, odometer: v.odometer, cargo: v.cargo, location: nearestCity(v.pos), terrain: TERRAIN[terrainOf(v)].label,
        origin: origin(v), destination: destination(v), eta: v.status === 'oficina' ? null : etaMs(v, this.now, incs), remainingKm: remainingKm(v), totalLen: v.totalLen,
        deliveryPending: !!v.deliveryPending, ahead,
        parts: v.parts.map(p => ({ name: p.name, pct: p.used / p.life * 100, km: partRemainingKm(v, p) })).sort((a, b) => b.pct - a.pct),
        docs: Object.fromEntries(Object.entries(v.docs).map(([k, d]) => [k, Math.ceil((d - this.now) / DAY)])),
        workshop: v.workshop ? { name: v.workshop.name, reason: v.workshop.reason, remainingH: v.workshop.remainingH, waitingParts: v.workshop.waitingParts } : null,
        lastChecklist: v.lastChecklist ? { time: v.lastChecklist.time, issues: v.lastChecklist.issues.length } : null,
      };
    }
    // estado completo para gravar
    exportState() { return { ...this.s, alertKeys: [...this.keys] }; }
  }

  return {
    ATTACH_MIME, ATTACH_KINDS, ATTACH_MAX,
    WORKSHOPS, WS_PHASES, QUOTE_STATUS, workshopById, nearestWorkshop, needsQuote,
    TARIFFS_DEFAULT, COST_CATS, EXPENSE_TYPES, expenseCat, dayKey, generateHistory, routeCountryShare,
    fmtEur, MIN, HOUR, DAY, clamp, rand, pick, haversine, fmtHM, fmtKm, fmtTime, fmtDate, fmtWhen, fmtDuration,
    CITIES, COUNTRY, nearestCity, nearestCityObj, TERRAIN, ROUTES, PARTS_DEF, STATUS, CATS, DOC_NAMES, INCIDENT_POOL,
    prepareVehicle, posAtDist, updatePos, terrainOf, loadRatio, destination, origin, remainingKm, partRemainingKm, wearMult,
    incidentAhead, etaMs, createInitialState, Engine,
  };
});
