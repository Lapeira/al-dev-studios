/* ==========================================================================
   PAINEL › CUSTOS E RELATÓRIOS
   Dados: linhas por dia/camião/motorista (km, gasóleo, portagens, horas, receita,
   entregas, km por país) + despesas avulsas. Com servidor vêm da base de dados
   (/api/relatorios); no modo demo vêm do motor que corre no browser.
   Usa as funções globais do painel.js ($, esc, api, icons, mode, action…).
   ========================================================================== */
const EUR0 = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const EUR2 = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const N0 = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 0 });
const N1 = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const eur = (x) => EUR0.format(x || 0);
const eurKm = (x) => `${EUR2.format(x || 0)}/km`;
const pct = (x) => `${N1.format(x || 0)}%`;
const MIN_KM = 50;   // abaixo disto o custo por km não é representativo (ex.: camião parado com uma despesa)
// categorias de custo: cor = papel fixo (ordem validada para daltonismo)
const CAT_ORDER = ['fuel', 'toll', 'driver', 'workshop', 'other'];
const CAT_COLOR = { fuel: 'var(--series-1)', toll: 'var(--series-2)', driver: 'var(--series-3)', workshop: 'var(--series-4)', other: 'var(--series-5)' };

let repPreset = '7d';
let repFrom = null, repTo = null;
let repData = null, repAgg = null;
let repSort = { key: 'total', dir: -1 };
let repLoading = false;

// ---------- datas (dias da simulação) ----------
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const addDaysKey = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return C.dayKey(d.getTime()); };
const dayLabel = (s) => parseDay(s).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short' });
const simToday = () => C.dayKey(simNow);
function presetRange(p) {
  const t = simToday();
  if (p === 'hoje') return [t, t];
  if (p === '7d') return [addDaysKey(t, -6), t];
  if (p === '30d') return [addDaysKey(t, -29), t];
  if (p === 'mes') return [t.slice(0, 8) + '01', t];
  return [repFrom || t, repTo || t];
}

// ---------- obter dados ----------
async function getReportData(from, to) {
  if (mode === 'servidor') return api(`/api/relatorios?de=${from}&ate=${to}`);
  const s = demoEngine.s;
  const inRange = (d) => d >= from && d <= to;
  return {
    from, to, today: C.dayKey(s.simNow), tariffs: JSON.parse(JSON.stringify(s.tariffs)),
    vehicles: s.vehicles.map(v => ({ id: v.id, plate: v.plate, model: v.model, driver: v.driver })),
    daily: Object.values(s.daily).filter(r => inRange(r.day)).map(r => ({ ...r, countries: { ...r.countries } })),
    expenses: s.expenses.filter(e => inRange(e.day)).map(e => ({ ...e })),
  };
}

async function loadReport() {
  if (repLoading || currentTab !== 'relatorios') return;
  repLoading = true;
  try {
    [repFrom, repTo] = presetRange(repPreset);
    repData = await getReportData(repFrom, repTo);
    repAgg = aggregate(repData);
    renderReport();
  } catch (e) {
    $('repKpis').innerHTML = `<div class="col-span-full text-sm text-red-600">${esc(e.message)}</div>`;
  } finally { repLoading = false; }
}

// ---------- agregação ----------
const zero = () => ({ km: 0, fuelL: 0, fuel: 0, toll: 0, driver: 0, workshop: 0, other: 0, revenue: 0, deliveries: 0, driveMin: 0 });
const costOf = (a) => a.fuel + a.toll + a.driver + a.workshop + a.other;
function aggregate(d) {
  const veh = {}, drv = {}, ctry = {}, days = {};
  d.vehicles.forEach(v => { veh[v.id] = { ...zero(), id: v.id, plate: v.plate, model: v.model }; });
  for (let k = d.from; k <= d.to; k = addDaysKey(k, 1)) days[k] = zero();
  const add = (o, r) => { o.km += r.km; o.fuelL += r.fuelL; o.fuel += r.fuelCost; o.toll += r.tollCost; o.driver += r.driverCost; o.revenue += r.revenue; o.deliveries += r.deliveries; o.driveMin += r.driveMin; };
  d.daily.forEach(r => {
    if (veh[r.vehicleId]) add(veh[r.vehicleId], r);
    add(drv[r.driver] || (drv[r.driver] = { ...zero(), name: r.driver, vehicles: new Set() }), r);
    drv[r.driver].vehicles.add(r.vehicleId);
    if (days[r.day]) add(days[r.day], r);
    Object.entries(r.countries || {}).forEach(([cc, km]) => {
      const c = ctry[cc] || (ctry[cc] = { cc, km: 0, fuel: 0, fuelL: 0, toll: 0 });
      const f = r.km > 0 ? km / r.km : 0;
      c.km += km; c.fuel += r.fuelCost * f; c.fuelL += r.fuelL * f; c.toll += r.tollCost * f;
    });
  });
  d.expenses.forEach(e => {
    const cat = C.expenseCat(e.type);
    if (e.vehicleId && veh[e.vehicleId]) veh[e.vehicleId][cat] += e.amount;
    if (days[e.day]) days[e.day][cat] += e.amount;
  });
  const total = zero();
  Object.values(veh).forEach(v => { Object.keys(total).forEach(k => total[k] += v[k]); });
  // despesas sem camião (ex.: gerais) contam no total
  d.expenses.filter(e => !e.vehicleId || !veh[e.vehicleId]).forEach(e => { total[C.expenseCat(e.type)] += e.amount; });
  return { veh: Object.values(veh), drv: Object.values(drv), ctry: Object.values(ctry).sort((a, b) => b.km - a.km), days, total };
}

// ---------- desenho ----------
function renderReport() {
  const a = repAgg, t = a.total, cost = costOf(t), margin = t.revenue - cost;
  $('repFromInput').value = repFrom; $('repToInput').value = repTo;
  $('repPresets').innerHTML = [['hoje', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['mes', 'Este mês']].map(([k, l]) =>
    `<button data-rpreset="${k}" class="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg ${repPreset === k ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}">${l}</button>`).join('');
  const nDays = Object.keys(a.days).length;
  $('printPeriod').textContent = `${dayLabel(repFrom)} a ${dayLabel(repTo)} (${nDays} dia${nDays > 1 ? 's' : ''}) · gerado ${new Date(simNow).toLocaleString('pt-PT')}`;

  const kpi = (label, value, sub, icon) => `<div class="bg-white p-4 rounded-2xl border border-zinc-200/80 shadow-sm">
    <div class="flex items-center justify-between mb-1.5"><span class="text-xs font-semibold text-zinc-500">${label}</span><i data-lucide="${icon}" class="w-4 h-4 text-zinc-400"></i></div>
    <div class="text-xl font-black">${value}</div><div class="text-[11px] text-zinc-500 mt-0.5">${sub}</div></div>`;
  $('repKpis').innerHTML = [
    kpi('Receita', eur(t.revenue), `${N0.format(t.deliveries)} entregas`, 'trending-up'),
    kpi('Custos', eur(cost), `gasóleo ${pct(cost ? t.fuel / cost * 100 : 0)} do total`, 'wallet'),
    kpi('Margem', `<span class="${margin < 0 ? 'text-red-600' : ''}">${eur(margin)}</span>`, `${pct(t.revenue ? margin / t.revenue * 100 : 0)} da receita`, margin < 0 ? 'trending-down' : 'percent'),
    kpi('Custo por km', eurKm(t.km ? cost / t.km : 0), `receita ${eurKm(t.km ? t.revenue / t.km : 0)}`, 'gauge'),
    kpi('Km percorridos', N0.format(t.km), `${N0.format(t.driveMin / 60)} h de condução`, 'route'),
    kpi('Consumo médio', `${N1.format(t.km ? t.fuelL / t.km * 100 : 0)} L/100 km`, `${N0.format(t.fuelL)} L de gasóleo`, 'fuel'),
  ].join('');

  $('repLegend').innerHTML = CAT_ORDER.map(k => `<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm" style="background:${CAT_COLOR[k]}"></span>${C.COST_CATS[k]}</span>`).join('') +
    '<span class="inline-flex items-center gap-1.5"><span class="w-4 h-0.5 rounded bg-zinc-900"></span><span class="w-2 h-2 -ml-3 rounded-full bg-zinc-900 ring-2 ring-white"></span>Receita</span>';
  renderDailyChart();
  renderCpkChart();
  renderVehTable();
  renderDriverTable();
  renderCountryTable();
  renderExpenses();
  renderTariffs();
  icons();
}

// arredondar o topo do eixo a um valor "redondo"
function niceMax(v) {
  if (v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
const axisEur = (v) => v >= 10000 ? `${N0.format(v / 1000)} mil €` : `${N0.format(v)} €`;
// barra com o topo arredondado (4px) e a base direita
function colPath(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function tooltip(host, html, x, y) {
  let tip = host.querySelector('.viz-tip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'viz-tip'; host.appendChild(tip); }
  tip.innerHTML = html; tip.style.display = 'block';
  const w = tip.offsetWidth, H = host.clientWidth;
  tip.style.left = `${Math.max(4, Math.min(H - w - 4, x - w / 2))}px`;
  tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
}
const hideTip = (host) => { const t = host.querySelector('.viz-tip'); if (t) t.style.display = 'none'; };

function buckets() {
  const keys = Object.keys(repAgg.days);
  const today = simToday();
  if (keys.length <= 45) return keys.map(k => ({ label: dayLabel(k), title: parseDay(k).toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' }) + (k === today ? ' (hoje, em curso)' : ''), ...repAgg.days[k] }));
  // períodos longos: somar por semana
  const out = [];
  keys.forEach((k, i) => {
    if (i % 7 === 0) out.push({ label: dayLabel(k), title: `Semana de ${dayLabel(k)}`, ...zero() });
    const b = out[out.length - 1], d = repAgg.days[k];
    Object.keys(zero()).forEach(f => b[f] += d[f]);
  });
  return out;
}

function renderDailyChart() {
  const host = $('chartDaily');
  const data = buckets();
  const W = Math.max(280, host.clientWidth), H = 260, ml = 56, mr = 10, mt = 12, mb = 28;
  const pw = W - ml - mr, ph = H - mt - mb;
  const max = niceMax(Math.max(1, ...data.map(b => Math.max(costOf(b), b.revenue))));
  const y = (v) => mt + ph - v / max * ph;
  const band = pw / data.length, bw = Math.max(3, Math.min(24, band * 0.62));
  let svg = '';
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4, yy = Math.round(y(v)) + 0.5;
    svg += `<line x1="${ml}" x2="${W - mr}" y1="${yy}" y2="${yy}" stroke="var(--grid)" stroke-width="1"/>`;
    svg += `<text x="${ml - 8}" y="${yy + 4}" text-anchor="end" class="viz-axis">${axisEur(v)}</text>`;
  }
  const every = Math.max(1, Math.ceil(data.length * 46 / pw));
  data.forEach((b, i) => {
    const cx = ml + band * (i + 0.5), x0 = cx - bw / 2;
    let base = mt + ph;
    const segs = CAT_ORDER.map(k => ({ k, v: b[k] })).filter(s => s.v > 0);
    segs.forEach((s, j) => {
      const h = s.v / max * ph, top = base - h;
      const gap = j > 0 ? 2 : 0;          // 2px de superfície entre segmentos
      const hh = Math.max(0, h - gap);
      if (hh > 0) {
        svg += j === segs.length - 1
          ? `<path d="${colPath(x0, top, bw, hh, 4)}" fill="${CAT_COLOR[s.k]}"/>`
          : `<rect x="${x0}" y="${top}" width="${bw}" height="${hh}" fill="${CAT_COLOR[s.k]}"/>`;
      }
      base = top;
    });
    if (i % every === 0) svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle" class="viz-axis">${esc(b.label)}</text>`;
  });
  // receita: linha 2px + pontos com anel da superfície
  const pts = data.map((b, i) => [ml + band * (i + 0.5), y(b.revenue)]);
  if (pts.length > 1) svg += `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  pts.forEach(p => { svg += `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="var(--ink)" stroke="var(--surface)" stroke-width="2"/>`; });
  // zonas de hover (a largura toda da coluna)
  data.forEach((b, i) => { svg += `<rect class="viz-hit" data-i="${i}" x="${ml + band * i}" y="${mt}" width="${band}" height="${ph}" fill="transparent"/>`; });
  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Custos por categoria e receita por dia"><rect class="viz-hover" x="0" y="${mt}" width="0" height="${ph}" fill="var(--hover)"/>${svg}</svg>`;
  const hover = host.querySelector('.viz-hover');
  host.querySelectorAll('.viz-hit').forEach(r => {
    r.addEventListener('mouseenter', () => {
      const b = data[+r.dataset.i], c = costOf(b), m = b.revenue - c;
      hover.setAttribute('x', r.getAttribute('x')); hover.setAttribute('width', r.getAttribute('width'));
      tooltip(host, `<div class="font-bold mb-1 capitalize">${esc(b.title)}</div>
        ${CAT_ORDER.slice().reverse().map(k => `<div class="flex justify-between gap-4"><span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-sm" style="background:${CAT_COLOR[k]}"></span>${C.COST_CATS[k]}</span><span>${eur(b[k])}</span></div>`).join('')}
        <div class="flex justify-between gap-4 border-t border-zinc-200 mt-1 pt-1 font-semibold"><span>Custos</span><span>${eur(c)}</span></div>
        <div class="flex justify-between gap-4"><span>Receita</span><span>${eur(b.revenue)}</span></div>
        <div class="flex justify-between gap-4 font-semibold"><span>Margem</span><span class="${m < 0 ? 'text-red-600' : ''}">${eur(m)}</span></div>
        <div class="text-zinc-500 mt-1">${N0.format(b.km)} km · ${N0.format(b.deliveries)} entregas</div>`, +r.getAttribute('x') + band / 2, mt + 20);
    });
  });
  host.querySelector('svg').addEventListener('mouseleave', () => { hover.setAttribute('width', 0); hideTip(host); });
}

function renderCpkChart() {
  const host = $('chartCpk');
  const rows = repAgg.veh.map(v => ({ ...v, cpk: v.km >= MIN_KM ? costOf(v) / v.km : null })).sort((a, b) => (b.cpk ?? -1) - (a.cpk ?? -1));
  const avg = repAgg.total.km ? costOf(repAgg.total) / repAgg.total.km : 0;
  const W = Math.max(260, host.clientWidth), rowH = 26, ml = 74, mr = 74, mt = 22, H = mt + rows.length * rowH + 6;
  const max = Math.max(0.01, ...rows.map(r => r.cpk || 0)) * 1.05;
  const x = (v) => ml + v / max * (W - ml - mr);
  let svg = '';
  rows.forEach((r, i) => {
    const cy = mt + i * rowH + rowH / 2;
    svg += `<text x="${ml - 8}" y="${cy + 4}" text-anchor="end" class="viz-label">${esc(r.plate)}</text>`;
    if (r.cpk == null) { svg += `<text x="${ml}" y="${cy + 4}" class="viz-axis">${r.km > 0 ? `só ${N0.format(r.km)} km — pouco para calcular` : 'sem km no período'}</text>`; return; }
    const w = Math.max(2, x(r.cpk) - ml), h = 14;
    svg += `<path d="M${ml},${cy - h / 2}H${ml + w - 4}Q${ml + w},${cy - h / 2} ${ml + w},${cy - h / 2 + 4}V${cy + h / 2 - 4}Q${ml + w},${cy + h / 2} ${ml + w - 4},${cy + h / 2}H${ml}Z" fill="var(--series-1)"/>`;
    svg += `<text x="${ml + w + 6}" y="${cy + 4}" class="viz-value">${EUR2.format(r.cpk)}</text>`;
    svg += `<rect class="viz-hit" data-i="${i}" x="0" y="${cy - rowH / 2}" width="${W}" height="${rowH}" fill="transparent"/>`;
  });
  if (avg) {
    const ax = Math.round(x(avg)) + 0.5;
    svg = `<line x1="${ax}" x2="${ax}" y1="${mt - 6}" y2="${H - 4}" stroke="var(--ink-2)" stroke-width="1"/><text x="${ax}" y="${mt - 10}" text-anchor="middle" class="viz-axis">média ${EUR2.format(avg)}</text>` + svg;
  }
  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Custo por km de cada camião">${svg}</svg>`;
  host.querySelectorAll('.viz-hit').forEach(el => el.addEventListener('mouseenter', () => {
    const r = rows[+el.dataset.i];
    tooltip(host, `<div class="font-bold mb-1">${esc(r.plate)} · ${esc(r.model)}</div>
      <div class="flex justify-between gap-4"><span>Custo por km</span><span class="font-semibold">${eurKm(r.cpk)}</span></div>
      <div class="flex justify-between gap-4"><span>Custos</span><span>${eur(costOf(r))}</span></div>
      <div class="flex justify-between gap-4"><span>Km</span><span>${N0.format(r.km)}</span></div>
      <div class="flex justify-between gap-4"><span>vs. média</span><span>${r.cpk >= avg ? '+' : ''}${pct((r.cpk / avg - 1) * 100)}</span></div>`, x(r.cpk) , +el.getAttribute('y') + 4);
  }));
  host.querySelector('svg').addEventListener('mouseleave', () => hideTip(host));
}

const th = (key, label, right = true) => `<th class="py-2 pr-3 ${right ? 'text-right' : 'text-left'} cursor-pointer select-none whitespace-nowrap hover:text-zinc-700" data-rsort="${key}">${label}${repSort.key === key ? (repSort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`;
function vehRows() {
  return repAgg.veh.map(v => {
    const total = costOf(v);
    return { ...v, total, cpk: v.km >= MIN_KM ? total / v.km : 0, cons: v.km > 1 ? v.fuelL / v.km * 100 : 0, margin: v.revenue - total };
  });
}
function renderVehTable() {
  const rows = vehRows().sort((a, b) => repSort.key === 'plate' ? a.plate.localeCompare(b.plate) * -repSort.dir : (a[repSort.key] - b[repSort.key]) * repSort.dir);
  const t = repAgg.total, tc = costOf(t);
  const td = (v, cls = '') => `<td class="py-2 pr-3 text-right tabular-nums ${cls}">${v}</td>`;
  $('repVehTable').innerHTML = `<thead class="text-[11px] uppercase tracking-wide text-zinc-400"><tr>
    ${th('plate', 'Camião', false)}${th('km', 'Km')}${th('cons', 'L/100 km')}${th('fuel', 'Gasóleo')}${th('toll', 'Portagens')}${th('driver', 'Motoristas')}${th('workshop', 'Oficina')}${th('other', 'Outros')}${th('total', 'Custos')}${th('cpk', '€/km')}${th('revenue', 'Receita')}${th('margin', 'Margem')}</tr></thead>
    <tbody class="divide-y divide-zinc-100">${rows.map(v => `<tr>
      <td class="py-2 pr-3"><div class="font-bold">${esc(v.plate)}</div><div class="text-[11px] text-zinc-400">${esc(v.model)}</div></td>
      ${td(N0.format(v.km))}${td(v.km > 1 ? N1.format(v.cons) : '—')}${td(eur(v.fuel))}${td(eur(v.toll))}${td(eur(v.driver))}${td(eur(v.workshop))}${td(eur(v.other))}
      ${td(eur(v.total), 'font-semibold')}${td(v.km >= MIN_KM ? EUR2.format(v.cpk) : '—')}${td(eur(v.revenue))}${td(eur(v.margin), v.margin < 0 ? 'text-red-600 font-semibold' : 'font-semibold')}</tr>`).join('')}</tbody>
    <tfoot class="border-t-2 border-zinc-200 font-bold"><tr><td class="py-2 pr-3">Frota</td>
      ${td(N0.format(t.km))}${td(t.km ? N1.format(t.fuelL / t.km * 100) : '—')}${td(eur(t.fuel))}${td(eur(t.toll))}${td(eur(t.driver))}${td(eur(t.workshop))}${td(eur(t.other))}
      ${td(eur(tc))}${td(t.km ? EUR2.format(tc / t.km) : '—')}${td(eur(t.revenue))}${td(eur(t.revenue - tc), t.revenue - tc < 0 ? 'text-red-600' : '')}</tr></tfoot>`;
}
function renderDriverTable() {
  const fleet = repAgg.total.km ? repAgg.total.fuelL / repAgg.total.km * 100 : 0;
  const rows = repAgg.drv.filter(d => d.km > 0).sort((a, b) => b.km - a.km);
  $('repDrvTable').innerHTML = `<thead class="text-[11px] uppercase tracking-wide text-zinc-400 text-right"><tr><th class="py-2 pr-3 text-left">Motorista</th><th class="py-2 pr-3">Km</th><th class="py-2 pr-3">Horas</th><th class="py-2 pr-3">L/100 km</th><th class="py-2 pr-3">Entregas</th><th class="py-2">Receita</th></tr></thead>
    <tbody class="divide-y divide-zinc-100">${rows.map(d => {
      const cons = d.fuelL / d.km * 100, diff = fleet ? (cons / fleet - 1) * 100 : 0;
      // indicador de condução: ícone + texto, nunca só cor
      const tag = Math.abs(diff) < 3 ? '' : diff < 0
        ? `<span class="ml-1 text-[10px] font-semibold text-emerald-700 inline-flex items-center gap-0.5"><i data-lucide="leaf" class="w-3 h-3"></i>${N0.format(-diff)}% abaixo</span>`
        : `<span class="ml-1 text-[10px] font-semibold text-amber-700 inline-flex items-center gap-0.5"><i data-lucide="triangle-alert" class="w-3 h-3"></i>${N0.format(diff)}% acima</span>`;
      return `<tr><td class="py-2 pr-3 font-semibold">${esc(d.name)}</td><td class="py-2 pr-3 text-right tabular-nums">${N0.format(d.km)}</td><td class="py-2 pr-3 text-right tabular-nums">${N1.format(d.driveMin / 60)}</td>
        <td class="py-2 pr-3 text-right tabular-nums whitespace-nowrap">${N1.format(cons)}${tag}</td><td class="py-2 pr-3 text-right tabular-nums">${d.deliveries}</td><td class="py-2 text-right tabular-nums">${eur(d.revenue)}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="py-6 text-center text-zinc-400">Sem condução neste período.</td></tr>'}</tbody>`;
  $('repDrvNote').textContent = fleet ? `Consumo comparado com a média da frota (${N1.format(fleet)} L/100 km). Depende também da carga e do terreno de cada rota.` : '';
}
function renderCountryTable() {
  const tk = repAgg.total.km || 1, T = repData.tariffs;
  $('repCtryTable').innerHTML = `<thead class="text-[11px] uppercase tracking-wide text-zinc-400 text-right"><tr><th class="py-2 pr-3 text-left">País</th><th class="py-2 pr-3">Km</th><th class="py-2 pr-3">% km</th><th class="py-2 pr-3">Gasóleo</th><th class="py-2 pr-3">€/L</th><th class="py-2">Portagens</th></tr></thead>
    <tbody class="divide-y divide-zinc-100">${repAgg.ctry.map(c => `<tr><td class="py-2 pr-3 font-semibold">${esc(C.COUNTRY[c.cc] || c.cc)}</td>
      <td class="py-2 pr-3 text-right tabular-nums">${N0.format(c.km)}</td><td class="py-2 pr-3 text-right tabular-nums">${pct(c.km / tk * 100)}</td>
      <td class="py-2 pr-3 text-right tabular-nums">${eur(c.fuel)}</td><td class="py-2 pr-3 text-right tabular-nums">${EUR2.format(T.diesel[c.cc] || 0)}</td>
      <td class="py-2 text-right tabular-nums">${eur(c.toll)}</td></tr>`).join('') || '<tr><td colspan="6" class="py-6 text-center text-zinc-400">Sem km neste período.</td></tr>'}</tbody>`;
}
// ---------- anexos (faturas e fotos) ----------
const attIcon = (a) => a.kind === 'fatura' ? 'receipt' : 'image';
// pequena lista de anexos com link (e apagar, para administradores)
function attachLinks(list, opts = {}) {
  return (list || []).map(a => `<span class="inline-flex items-center gap-0.5 mr-2 whitespace-nowrap">
    <a href="${esc(a.url)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-zinc-700 hover:underline" title="${esc(a.name)}"><i data-lucide="${attIcon(a)}" class="w-3.5 h-3.5"></i>${a.kind === 'fatura' ? `Fatura${a.number ? ' ' + esc(a.number) : ''}` : 'Foto'}</a>
    ${opts.canDelete ? `<button data-delatt="${esc(a.id)}" class="no-print p-0.5 rounded text-zinc-400 hover:text-red-600" title="Apagar anexo" aria-label="Apagar ${esc(a.name)}"><i data-lucide="x" class="w-3 h-3"></i></button>` : ''}</span>`).join('');
}
function attachThumbs(list) {
  return (list || []).map(a => `<a href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.name)}${a.number ? ' · n.º ' + esc(a.number) : ''}" class="relative block w-14 h-14 rounded-lg overflow-hidden border border-zinc-200 bg-zinc-50 shrink-0">
    ${a.mime.startsWith('image/') ? `<img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" class="w-full h-full object-cover">` : '<span class="w-full h-full flex flex-col items-center justify-center text-zinc-500"><i data-lucide="file-text" class="w-5 h-5"></i><span class="text-[8px] font-bold">PDF</span></span>'}
    ${a.kind === 'fatura' ? '<span class="absolute bottom-0.5 left-0.5 text-[8px] font-bold px-1 rounded bg-zinc-900/80 text-white">Fatura</span>' : ''}</a>`).join('');
}
// reduzir fotos antes de enviar; PDFs vão como estão
async function prepareUpload(file) {
  if (file.type === 'application/pdf') { if (file.size > C.ATTACH_MAX) throw new Error('PDF demasiado grande (máx. 8 MB).'); return { blob: file, mime: 'application/pdf', name: file.name }; }
  if (!file.type.startsWith('image/')) throw new Error('Só PDF ou imagens.');
  const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error('Não consegui ler a imagem.')); i.src = URL.createObjectURL(file); });
  const k = Math.min(1, 2200 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src);
  return { blob: await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.82)), mime: 'image/jpeg', name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
}
async function attachToExpense(expenseId, file, kind = 'fatura') {
  const f = await prepareUpload(file);
  if (mode === 'servidor') {
    const qs = new URLSearchParams({ papel: 'gestor', tipo: kind, despesa: expenseId, nome: f.name });
    const r = await fetch(`/api/anexos?${qs}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': f.mime }, body: f.blob });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || 'Não foi possível enviar.');
  } else {
    const url = await new Promise(ok => { const rd = new FileReader(); rd.onload = () => ok(rd.result); rd.readAsDataURL(f.blob); });
    demoEngine.attachToExpense(expenseId, { kind, mime: f.mime, url, name: f.name, size: f.blob.size, by: 'Gestor' });
  }
}
let attachTargetExpense = null;
const attachPicker = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/pdf,image/*' });
attachPicker.addEventListener('change', async () => {
  const file = attachPicker.files[0]; attachPicker.value = '';
  if (!file || !attachTargetExpense) return;
  try { await attachToExpense(attachTargetExpense, file); showToast({ sev: 'info', title: 'Fatura anexada', text: file.name }); loadReport(); }
  catch (err) { showToast({ sev: 'aviso', title: 'Não foi possível anexar', text: err.message }); }
});

function renderExpenses() {
  const plate = (id) => { const v = repData.vehicles.find(x => x.id === id); return v ? v.plate : 'Geral'; };
  const list = repData.expenses.slice(0, 60);
  $('repExpList').innerHTML = list.map(e => `<li class="py-2 flex items-start justify-between gap-3 text-xs">
    <div class="min-w-0"><div class="font-semibold">${esc(C.EXPENSE_TYPES[e.type] || e.type)} · ${esc(plate(e.vehicleId))}</div>
      <div class="text-zinc-500 truncate">${esc(e.description || '—')}</div>
      <div class="text-[10px] text-zinc-400">${dayLabel(e.day)} · ${esc(e.user || '')}</div>
      ${e.attachments && e.attachments.length ? `<div class="mt-1 text-[11px]">${attachLinks(e.attachments, { canDelete: mode === 'servidor' && isAdmin() })}</div>` : ''}</div>
    <div class="flex items-center gap-1"><span class="font-bold tabular-nums whitespace-nowrap">${EUR2.format(e.amount)}</span>
      <button data-attexp="${e.id}" class="no-print p-1 rounded-md hover:bg-zinc-100 text-zinc-500" title="Anexar fatura ou foto" aria-label="Anexar a esta despesa"><i data-lucide="paperclip" class="w-3.5 h-3.5"></i></button>
      ${(mode === 'demo' || isAdmin()) && e.user !== 'Sistema' ? `<button data-delexp="${e.id}" class="no-print p-1 rounded-md hover:bg-red-50 text-red-600" title="Apagar despesa"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>` : ''}</div></li>`).join('') || '<li class="py-6 text-center text-xs text-zinc-400">Sem despesas neste período.</li>';
  $('repExpTotal').textContent = repData.expenses.length ? `${repData.expenses.length} despesa(s) · ${eur(repData.expenses.reduce((a, e) => a + e.amount, 0))}` : '';
}

// ---------- tarifas ----------
const canEditTariffs = () => mode === 'demo' || isAdmin();
let tariffsDirty = false;
function renderTariffs() {
  if (tariffsDirty) return;   // não apagar o que o gestor está a escrever
  const T = repData.tariffs, ed = canEditTariffs();
  const inp = (name, val, step) => ed
    ? `<input data-tariff="${name}" type="number" step="${step}" min="0" value="${val}" class="w-20 px-2 py-1 text-right text-xs bg-zinc-100 rounded-md focus:outline-none focus:ring-2 focus:ring-zinc-300 tabular-nums" />`
    : `<span class="tabular-nums">${val}</span>`;
  $('repTariffs').innerHTML = `<table class="w-full text-xs"><thead class="text-[10px] uppercase tracking-wide text-zinc-400 text-right"><tr><th class="py-1.5 text-left">País</th><th class="py-1.5">Gasóleo €/L</th><th class="py-1.5">Portagem €/km</th></tr></thead>
    <tbody class="divide-y divide-zinc-100">${Object.keys(C.COUNTRY).map(cc => `<tr><td class="py-1.5">${C.COUNTRY[cc]}</td><td class="py-1.5 text-right">${inp('diesel.' + cc, T.diesel[cc], 0.01)}</td><td class="py-1.5 text-right">${inp('toll.' + cc, T.toll[cc], 0.01)}</td></tr>`).join('')}</tbody></table>
    <div class="grid grid-cols-3 gap-2 mt-3 text-xs">
      <label class="bg-zinc-50 rounded-lg p-2"><span class="block text-[10px] text-zinc-500 font-semibold mb-1">Motorista €/h</span>${inp('driverHour', T.driverHour, 0.5)}</label>
      <label class="bg-zinc-50 rounded-lg p-2"><span class="block text-[10px] text-zinc-500 font-semibold mb-1">Frete €/km</span>${inp('freightKm', T.freightKm, 0.05)}</label>
      <label class="bg-zinc-50 rounded-lg p-2"><span class="block text-[10px] text-zinc-500 font-semibold mb-1">Frete mínimo €</span>${inp('freightMin', T.freightMin, 10)}</label>
    </div>
    ${ed ? `<button id="saveTariffs" class="no-print mt-3 w-full py-2 rounded-lg bg-zinc-900 text-white text-xs font-bold disabled:opacity-40" disabled>Guardar tarifas</button>
      <p class="text-[10px] text-zinc-400 mt-1.5">Aplicam-se aos km feitos a partir de agora; o que já foi registado não muda.</p>`
      : '<p class="text-[10px] text-zinc-400 mt-2">Só um administrador pode mudar as tarifas.</p>'}`;
}
function collectTariffs() {
  const t = { diesel: {}, toll: {} };
  document.querySelectorAll('[data-tariff]').forEach(i => {
    const [a, b] = i.dataset.tariff.split('.');
    if (b) t[a][b] = +i.value; else t[a] = +i.value;
  });
  return t;
}

// ---------- despesas ----------
function openExpense() {
  $('expVehicle').innerHTML = '<option value="">Geral (sem camião)</option>' + vehicles.map(v => `<option value="${v.id}">${esc(v.plate)} — ${esc(v.driver)}</option>`).join('');
  $('expType').innerHTML = Object.entries(C.EXPENSE_TYPES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
  $('expAmount').value = ''; $('expDesc').value = ''; $('expFile').value = ''; $('expError').classList.add('hidden');
  if (selectedId) $('expVehicle').value = selectedId;
  $('expenseModal').classList.remove('hidden');
  setTimeout(() => $('expAmount').focus(), 30);
}
$('expenseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = parseFloat(String($('expAmount').value).replace(',', '.'));
  if (!(amount > 0) || amount > 100000) { $('expError').textContent = 'Valor entre 0,01 € e 100 000 €.'; $('expError').classList.remove('hidden'); return; }
  const body = { vid: $('expVehicle').value || null, expenseType: $('expType').value, amount, description: $('expDesc').value };
  const file = $('expFile').files[0];
  const btn = $('expSubmit'); btn.disabled = true;
  try {
    let id;
    if (mode === 'servidor') id = (await api('/api/despesas', { method: 'POST', body: JSON.stringify(body) })).expense.id;
    else { const ex = demoEngine.addExpense({ ...body, type: body.expenseType, user: 'Gestor' }); if (!ex) throw new Error('Despesa inválida.'); id = ex.id; }
    if (file) await attachToExpense(id, file);
    $('expenseModal').classList.add('hidden');
    showToast({ sev: 'info', title: 'Despesa registada', text: `${EUR2.format(amount)} · ${C.EXPENSE_TYPES[body.expenseType]}${file ? ' · com fatura' : ''}` });
    loadReport();
  } catch (err) {
    $('expError').textContent = err.message; $('expError').classList.remove('hidden');
  } finally { btn.disabled = false; }
});

// ---------- exportar CSV (abre no Excel em português: ; e vírgula decimal) ----------
function exportCsv() {
  const n = (x, d = 2) => (Math.round((x || 0) * 10 ** d) / 10 ** d).toFixed(d).replace('.', ',');
  // texto entre aspas; e se começar por = + - @ (ou tab/enter) o Excel trataria como fórmula: prefixar com '
  const q = (s) => { let t = String(s ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
  const lines = [];
  lines.push(q(`Relatório de custos ${repFrom} a ${repTo}`));
  lines.push('');
  lines.push(['Camião', 'Modelo', 'Km', 'Litros', 'L/100 km', 'Gasóleo €', 'Portagens €', 'Motoristas €', 'Oficina €', 'Outros €', 'Custos €', '€/km', 'Receita €', 'Margem €', 'Entregas'].map(q).join(';'));
  vehRows().forEach(v => lines.push([q(v.plate), q(v.model), n(v.km, 0), n(v.fuelL, 0), n(v.cons, 1), n(v.fuel), n(v.toll), n(v.driver), n(v.workshop), n(v.other), n(v.total), n(v.cpk), n(v.revenue), n(v.margin), v.deliveries].join(';')));
  lines.push('');
  lines.push(['Dia', 'Camião', 'Motorista', 'Km', 'Litros', 'Gasóleo €', 'Portagens €', 'Horas', 'Motorista €', 'Receita €', 'Entregas', 'Km por país'].map(q).join(';'));
  repData.daily.slice().sort((a, b) => a.day.localeCompare(b.day) || a.vehicleId.localeCompare(b.vehicleId)).forEach(r => {
    const v = repData.vehicles.find(x => x.id === r.vehicleId);
    lines.push([r.day, q(v ? v.plate : r.vehicleId), q(r.driver), n(r.km, 0), n(r.fuelL, 0), n(r.fuelCost), n(r.tollCost), n(r.driveMin / 60, 1), n(r.driverCost), n(r.revenue), r.deliveries,
      q(Object.entries(r.countries || {}).map(([cc, km]) => `${cc} ${Math.round(km)}`).join(', '))].join(';'));
  });
  lines.push('');
  lines.push(['Data', 'Camião', 'Tipo', 'Valor €', 'Descrição', 'Registado por'].map(q).join(';'));
  repData.expenses.forEach(e => { const v = repData.vehicles.find(x => x.id === e.vehicleId); lines.push([e.day, q(v ? v.plate : 'Geral'), q(C.EXPENSE_TYPES[e.type] || e.type), n(e.amount), q(e.description), q(e.user)].join(';')); });
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `custos_${repFrom}_${repTo}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- eventos ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, th[data-rsort]');
  if (!t) return;
  const d = t.dataset;
  if (d.rpreset) { repPreset = d.rpreset; loadReport(); }
  if (d.rsort) { repSort = repSort.key === d.rsort ? { key: d.rsort, dir: -repSort.dir } : { key: d.rsort, dir: d.rsort === 'plate' ? 1 : -1 }; renderVehTable(); }
  if (t.id === 'expenseBtn') openExpense();
  if (d.attexp) { attachTargetExpense = +d.attexp; attachPicker.click(); }
  if (d.delatt && confirm('Apagar este anexo? Não dá para desfazer.')) {
    fetch(`/api/anexos/${encodeURIComponent(d.delatt)}?papel=gestor`, { method: 'DELETE', credentials: 'same-origin' })
      .then(r => r.json().then(b => { if (!r.ok) throw new Error(b.error); }))
      .then(() => loadReport())
      .catch(err => showToast({ sev: 'aviso', title: 'Não foi possível apagar', text: err.message }));
  }
  if (d.delexp) {
    const ex = repData.expenses.find(x => x.id === +d.delexp);
    if (ex && confirm(`Apagar a despesa de ${EUR2.format(ex.amount)} (${C.EXPENSE_TYPES[ex.type]})?`)) { action({ type: 'deleteExpense', id: ex.id }); setTimeout(loadReport, 400); }
  }
  if (t.id === 'expClose') $('expenseModal').classList.add('hidden');
  if (t.id === 'csvBtn' && repData) exportCsv();
  if (t.id === 'printBtn') window.print();
  if (t.id === 'saveTariffs') {
    action({ type: 'tariffs', tariffs: collectTariffs() });
    tariffsDirty = false; t.disabled = true;
    showToast({ sev: 'info', title: 'Tarifas guardadas', text: 'Aplicam-se aos km feitos a partir de agora.' });
    setTimeout(loadReport, 400);
  }
});
document.addEventListener('input', (e) => {
  if (e.target.dataset && e.target.dataset.tariff) { tariffsDirty = true; const b = $('saveTariffs'); if (b) b.disabled = false; }
});
['repFromInput', 'repToInput'].forEach(id => $(id).addEventListener('change', () => {
  const f = $('repFromInput').value, t = $('repToInput').value;
  if (!f || !t) return;
  repPreset = 'custom'; repFrom = f <= t ? f : t; repTo = f <= t ? t : f;
  loadReport();
}));
$('expenseModal').addEventListener('click', (e) => { if (e.target === $('expenseModal')) $('expenseModal').classList.add('hidden'); });
let repResizeT = null;
window.addEventListener('resize', () => { clearTimeout(repResizeT); repResizeT = setTimeout(() => { if (repAgg && currentTab === 'relatorios') { renderDailyChart(); renderCpkChart(); } }, 150); });
// enquanto o separador está aberto, atualizar a cada 5 s (o dia de hoje continua a somar)
setInterval(() => { if (currentTab === 'relatorios' && !document.hidden && !tariffsDirty) loadReport(); }, 5000);
