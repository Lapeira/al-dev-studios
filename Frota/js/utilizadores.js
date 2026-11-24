/* ==========================================================================
   PAINEL › UTILIZADORES (só com servidor e só para administradores)
   + "A minha conta": qualquer gestor pode mudar a própria palavra-passe.
   Usa as funções globais do painel.js ($, esc, api, icons, currentUser…).
   ========================================================================== */
let usersData = { users: [], vehicles: [], me: null };
let usersFilter = '';
let auditData = [];

const isAdmin = () => mode === 'servidor' && currentUser && currentUser.isAdmin;
const initialsOf = (n) => String(n).split(' ').filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase();
const ago = (t) => {
  if (!t) return 'nunca';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  if (m < 1440) return `há ${Math.round(m / 60)} h`;
  return new Date(t).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' });
};
// gerar segredos: PIN de 6 algarismos (sem sequências) e palavra-passe legível
function genPin() {
  const a = new Uint32Array(6);
  for (;;) {
    crypto.getRandomValues(a);
    const p = [...a].map(x => x % 10).join('');
    if (!/^(\d)\1+$/.test(p) && !'0123456789'.includes(p) && !'9876543210'.includes(p)) return p;
  }
}
function genPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint32Array(12); crypto.getRandomValues(a);
  let p = [...a].map(x => chars[x % chars.length]).join('');
  if (!/\d/.test(p)) p = p.slice(0, 11) + '7';
  if (!/[A-Za-z]/.test(p)) p = 'k' + p.slice(1);
  return p;
}

// mostra/esconde o separador conforme o utilizador
function refreshUsersAccess() {
  $('tabUsers').classList.toggle('hidden', !isAdmin());
  $('myAccountBtn').classList.toggle('hidden', mode !== 'servidor');
  if (!isAdmin() && currentTab === 'utilizadores') showTab('mapa');
}

async function loadUsers() {
  if (!isAdmin()) return;
  try {
    const [d, a] = await Promise.all([api('/api/utilizadores'), api('/api/registo?limite=30')]);
    usersData = d; auditData = a;
    renderUsers();
  } catch (e) {
    $('usersTable').innerHTML = `<tr><td colspan="6" class="p-6 text-center text-sm text-red-600">${esc(e.message)}</td></tr>`;
  }
}

function renderUsers() {
  const q = $('usersSearch').value.trim().toLowerCase();
  const list = usersData.users.filter(u => (!usersFilter || u.role === usersFilter) &&
    (!q || [u.name, u.email, u.phone, u.plate, u.workshopName].some(s => s && s.toLowerCase().includes(q))));
  const cnt = (r) => usersData.users.filter(u => u.role === r).length;
  $('usersFilters').innerHTML = [['', 'Todos', usersData.users.length], ['gestor', 'Gestores', cnt('gestor')], ['motorista', 'Motoristas', cnt('motorista')], ['oficina', 'Oficinas', cnt('oficina')]].map(([k, l, n]) =>
    `<button data-ufilter="${k}" class="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg ${usersFilter === k ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}">${l} <span class="opacity-60">${n}</span></button>`).join('');

  $('usersTable').innerHTML = list.map(u => {
    const me = u.id === usersData.me;
    const badge = u.role === 'oficina' ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">Oficina</span>'
      : u.role === 'motorista' ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">Motorista</span>'
      : u.isAdmin ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-zinc-900 text-white">Administrador</span>'
      : '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700 border border-zinc-200">Gestor</span>';
    const truck = u.role === 'oficina' ? `<span class="text-xs">${esc(u.workshopName || '—')}</span>`
      : u.role !== 'motorista' ? '<span class="text-zinc-300">—</span>'
      : u.vehicleId ? `<span class="font-bold">${esc(u.plate)}</span>` : '<span class="text-amber-600 font-semibold">Sem camião</span>';
    return `<tr class="${u.active ? '' : 'opacity-50'}">
      <td class="py-3 pr-4"><div class="flex items-center gap-2.5">
        <span class="relative w-9 h-9 rounded-full ${u.role === 'motorista' ? 'bg-blue-600' : u.role === 'oficina' ? 'bg-violet-600' : 'bg-zinc-900'} text-white text-xs font-bold flex items-center justify-center shrink-0">${esc(initialsOf(u.name))}
          ${u.online ? '<span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-white" title="Ligado agora"></span>' : ''}</span>
        <div class="min-w-0"><div class="text-sm font-bold truncate">${esc(u.name)}${me ? ' <span class="text-[10px] font-semibold text-zinc-400">(tu)</span>' : ''}</div>
          <div class="text-[11px] text-zinc-500 truncate">${esc(u.email || u.phone || '—')}</div></div></div></td>
      <td class="py-3 pr-4">${badge}</td>
      <td class="py-3 pr-4 text-sm">${truck}</td>
      <td class="py-3 pr-4 text-xs">${u.active ? '<span class="text-emerald-700 font-semibold">Ativo</span>' : '<span class="text-zinc-500 font-semibold">Desativado</span>'}${u.online ? '<div class="text-[10px] text-emerald-600">ligado agora</div>' : ''}</td>
      <td class="py-3 pr-4 text-xs text-zinc-500 whitespace-nowrap">${ago(u.lastLogin)}</td>
      <td class="py-3 text-right whitespace-nowrap">
        <button data-uedit="${u.id}" class="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-600" title="Editar"><i data-lucide="pencil" class="w-4 h-4"></i></button>
        <button data-ucred="${u.id}" class="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-600" title="${u.role === 'motorista' ? 'Novo PIN' : 'Nova palavra-passe'}"><i data-lucide="key-round" class="w-4 h-4"></i></button>
        ${me ? '' : `<button data-utoggle="${u.id}" class="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-600" title="${u.active ? 'Desativar' : 'Ativar'}"><i data-lucide="${u.active ? 'user-x' : 'user-check'}" class="w-4 h-4"></i></button>
        <button data-udelete="${u.id}" class="p-1.5 rounded-lg hover:bg-red-50 text-red-600" title="Apagar"><i data-lucide="trash-2" class="w-4 h-4"></i></button>`}
      </td></tr>`;
  }).join('') || '<tr><td colspan="6" class="py-8 text-center text-sm text-zinc-400">Nenhum utilizador encontrado.</td></tr>';

  const free = usersData.vehicles.filter(v => !v.driverId);
  $('usersWarn').classList.toggle('hidden', !free.length);
  $('usersWarn').innerHTML = free.length ? `<i data-lucide="triangle-alert" class="w-4 h-4 shrink-0"></i><span><b>${free.length} camião(ões) sem motorista:</b> ${free.map(v => esc(v.plate)).join(', ')}. Atribui um motorista para poder usar a app.</span>` : '';

  $('auditList').innerHTML = auditData.map(a => `<li class="py-2 flex gap-3 text-xs">
    <span class="text-zinc-400 whitespace-nowrap w-28 shrink-0">${new Date(a.time).toLocaleString('pt-PT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
    <span class="min-w-0"><b>${esc(a.user || 'Sistema')}</b> · ${esc(a.action)}${a.details ? `<span class="text-zinc-500"> — ${esc(a.details)}</span>` : ''}</span></li>`).join('') || '<li class="py-4 text-center text-xs text-zinc-400">Sem alterações registadas.</li>';
  icons();
}

/* ---------- Janela (criar / editar / credencial / a minha conta) ---------- */
let modalCtx = null;
const field = (id, label, input, hint = '') => `<label class="block"><span class="text-xs font-semibold text-zinc-600">${label}</span>${input}${hint ? `<span class="block text-[10px] text-zinc-400 mt-1">${hint}</span>` : ''}</label>`;
const inputCls = 'mt-1 w-full px-3 py-2.5 text-sm bg-zinc-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-300';
const secretField = (id, label, kind) => field(id, label, `<div class="mt-1 flex gap-2"><input id="${id}" type="text" autocomplete="new-password" spellcheck="false" ${kind === 'pin' ? 'inputmode="numeric" maxlength="6"' : 'maxlength="128"'} class="${inputCls.replace('mt-1 ', '')} font-mono" />
  <button type="button" data-gen="${id}" data-kind="${kind}" class="px-3 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-xs font-semibold whitespace-nowrap">Gerar</button></div>`,
  kind === 'pin' ? '4 a 6 algarismos, sem sequências (1234) nem repetidos (1111).' : 'Pelo menos 8 caracteres, com letras e números.');

function vehicleOptions(selected, forUser) {
  return '<option value="">— Sem camião —</option>' + usersData.vehicles.map(v => {
    const taken = v.driverId && v.driverId !== forUser ? ` · atual: ${v.driverName}` : '';
    return `<option value="${esc(v.id)}" ${v.id === selected ? 'selected' : ''}>${esc(v.plate)} — ${esc(v.model)}${esc(taken)}</option>`;
  }).join('');
}

function openModal(kind, user) {
  modalCtx = { kind, user };
  const u = user || {};
  let title = '', body = '', submit = 'Guardar';
  if (kind === 'new-motorista' || (kind === 'edit' && u.role === 'motorista')) {
    title = kind === 'edit' ? `Editar motorista` : 'Novo motorista';
    body = field('', 'Nome', `<input id="mName" required maxlength="60" value="${esc(u.name || '')}" class="${inputCls}" />`) +
      field('', 'Telefone', `<input id="mPhone" maxlength="20" placeholder="+351 9xx xxx xxx" value="${esc(u.phone || '')}" class="${inputCls}" />`) +
      field('', 'Camião', `<select id="mVehicle" class="${inputCls}">${vehicleOptions(u.vehicleId || '', u.id)}</select>`, 'Se o camião já tiver motorista, esse fica sem camião.') +
      (kind === 'new-motorista' ? secretField('mSecret', 'PIN de entrada na app', 'pin') : '');
    submit = kind === 'edit' ? 'Guardar' : 'Criar motorista';
  } else if (kind === 'new-gestor' || (kind === 'edit' && u.role === 'gestor')) {
    title = kind === 'edit' ? 'Editar gestor' : 'Novo gestor';
    body = field('', 'Nome', `<input id="mName" required maxlength="60" value="${esc(u.name || '')}" class="${inputCls}" />`) +
      field('', 'Email', `<input id="mEmail" type="email" required value="${esc(u.email || '')}" class="${inputCls}" />`) +
      field('', 'Telefone (opcional)', `<input id="mPhone" maxlength="20" value="${esc(u.phone || '')}" class="${inputCls}" />`) +
      (kind === 'new-gestor' ? secretField('mSecret', 'Palavra-passe inicial', 'password') : '') +
      `<label class="flex items-start gap-2 text-xs"><input id="mAdmin" type="checkbox" class="mt-0.5" ${u.isAdmin ? 'checked' : ''} ${u.id === usersData.me ? 'disabled' : ''} />
        <span><b>Administrador</b><br><span class="text-zinc-500">Pode criar, editar e apagar utilizadores.</span></span></label>`;
    submit = kind === 'edit' ? 'Guardar' : 'Criar gestor';
  } else if (kind === 'new-oficina' || (kind === 'edit' && u.role === 'oficina')) {
    title = kind === 'edit' ? 'Editar acesso de oficina' : 'Novo acesso de oficina';
    body = field('', 'Oficina', `<select id="mWorkshop" class="${inputCls}">${(usersData.workshops || []).map(w => `<option value="${esc(w.id)}" ${w.id === u.workshopId ? 'selected' : ''}>${esc(w.name)} (${w.type.toLowerCase()})</option>`).join('')}</select>`) +
      field('', 'Nome do contacto', `<input id="mName" required maxlength="60" value="${esc(u.name || '')}" placeholder="Ex.: Pierre (receção)" class="${inputCls}" />`) +
      field('', 'Email', `<input id="mEmail" type="email" required value="${esc(u.email || '')}" class="${inputCls}" />`) +
      field('', 'Telefone (opcional)', `<input id="mPhone" maxlength="20" value="${esc(u.phone || '')}" class="${inputCls}" />`) +
      (kind === 'new-oficina' ? secretField('mSecret', 'Palavra-passe inicial', 'password') : '') +
      '<p class="text-[11px] text-zinc-500">Entra em <b>oficina.html</b> e só vê os camiões que estão nesta oficina.</p>';
    submit = kind === 'edit' ? 'Guardar' : 'Criar acesso';
  } else if (kind === 'cred') {
    const pw = u.role !== 'motorista';
    title = pw ? `Nova palavra-passe — ${u.name}` : `Novo PIN — ${u.name}`;
    body = secretField('mSecret', pw ? 'Nova palavra-passe' : 'Novo PIN', pw ? 'password' : 'pin') +
      `<p class="text-[11px] text-zinc-500">${esc(u.name)} vai ter de entrar outra vez com ${pw ? 'a nova palavra-passe' : 'o novo PIN'}. Passa-lho pessoalmente ou por telefone.</p>`;
    submit = 'Guardar';
  } else if (kind === 'mine') {
    title = 'A minha conta';
    body = `<p class="text-xs text-zinc-500">${esc(currentUser.name)} · ${esc(currentUser.email || '')}</p>` +
      field('', 'Palavra-passe atual', `<input id="mCurrent" type="password" required autocomplete="current-password" class="${inputCls}" />`) +
      field('', 'Nova palavra-passe', `<input id="mNew" type="password" required autocomplete="new-password" class="${inputCls}" />`, 'Pelo menos 8 caracteres, com letras e números.') +
      field('', 'Repetir a nova palavra-passe', `<input id="mNew2" type="password" required autocomplete="new-password" class="${inputCls}" />`) +
      '<p class="text-[11px] text-zinc-500">As tuas outras sessões (noutros computadores) são terminadas.</p>';
    submit = 'Mudar palavra-passe';
  }
  $('userModalTitle').textContent = title;
  $('userModalBody').innerHTML = body;
  $('userModalSubmit').textContent = submit;
  $('userModalError').classList.add('hidden');
  $('userModalDone').classList.add('hidden');
  $('userModalForm').classList.remove('hidden');
  $('userModal').classList.remove('hidden');
  if ($('mSecret') && !$('mSecret').value) $('mSecret').value = (kind === 'new-motorista' || (kind === 'cred' && u.role === 'motorista')) ? genPin() : genPassword();
  const first = $('userModalBody').querySelector('input:not([type=checkbox])');
  if (first) setTimeout(() => first.focus(), 30);
  icons();
}
const closeModal = () => { $('userModal').classList.add('hidden'); modalCtx = null; };

$('userModalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { kind, user } = modalCtx;
  const val = (id) => $(id) ? $(id).value : undefined;
  const btn = $('userModalSubmit'); btn.disabled = true;
  try {
    let secretShown = null;
    if (kind === 'new-motorista') {
      await api('/api/utilizadores', { method: 'POST', body: JSON.stringify({ role: 'motorista', name: val('mName'), phone: val('mPhone'), vehicleId: val('mVehicle'), pin: val('mSecret') }) });
      secretShown = ['PIN', val('mSecret')];
    } else if (kind === 'new-gestor') {
      await api('/api/utilizadores', { method: 'POST', body: JSON.stringify({ role: 'gestor', name: val('mName'), email: val('mEmail'), phone: val('mPhone'), password: val('mSecret'), isAdmin: $('mAdmin').checked }) });
      secretShown = ['Palavra-passe', val('mSecret')];
    } else if (kind === 'new-oficina') {
      await api('/api/utilizadores', { method: 'POST', body: JSON.stringify({ role: 'oficina', workshopId: val('mWorkshop'), name: val('mName'), email: val('mEmail'), phone: val('mPhone'), password: val('mSecret') }) });
      secretShown = ['Palavra-passe', val('mSecret')];
    } else if (kind === 'edit') {
      const body = { name: val('mName'), phone: val('mPhone') };
      if (user.role === 'motorista') {
        body.vehicleId = val('mVehicle');
        const v = usersData.vehicles.find(x => x.id === body.vehicleId);
        if (v && v.driverId && v.driverId !== user.id && !confirm(`O camião ${v.plate} é do(a) ${v.driverName}, que vai ficar sem camião. Continuar?`)) return;
      } else if (user.role === 'oficina') { body.email = val('mEmail'); body.workshopId = val('mWorkshop'); }
      else { body.email = val('mEmail'); body.isAdmin = $('mAdmin').checked; }
      await api(`/api/utilizadores/${user.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else if (kind === 'cred') {
      const key = user.role === 'motorista' ? 'pin' : 'password';
      await api(`/api/utilizadores/${user.id}/credencial`, { method: 'POST', body: JSON.stringify({ [key]: val('mSecret') }) });
      secretShown = [key === 'pin' ? 'PIN' : 'Palavra-passe', val('mSecret')];
    } else if (kind === 'mine') {
      if (val('mNew') !== val('mNew2')) throw new Error('As duas palavras-passe novas não são iguais.');
      await api('/api/me/password', { method: 'POST', body: JSON.stringify({ current: val('mCurrent'), password: val('mNew') }) });
    }
    if (secretShown) {
      // mostrar o segredo uma única vez (o servidor só guarda o hash)
      $('userModalForm').classList.add('hidden');
      $('userModalDone').classList.remove('hidden');
      $('userModalDone').innerHTML = `<div class="text-center space-y-3">
        <div class="w-11 h-11 mx-auto rounded-full bg-emerald-600 text-white flex items-center justify-center"><i data-lucide="check" class="w-5 h-5"></i></div>
        <p class="text-sm font-bold">Guardado</p>
        <p class="text-xs text-zinc-500">${secretShown[0]} (só aparece agora — o sistema guarda apenas uma versão cifrada):</p>
        <div class="font-mono text-xl font-black tracking-widest bg-zinc-100 rounded-xl py-3 select-all">${esc(secretShown[1])}</div>
        <button type="button" data-umodal-close class="w-full py-2.5 rounded-lg bg-zinc-900 text-white text-sm font-bold">Fechar</button></div>`;
      icons();
    } else {
      closeModal();
      if (kind === 'mine') showToast({ sev: 'info', title: 'Palavra-passe alterada', text: 'As outras sessões foram terminadas.' });
    }
    loadUsers();
  } catch (err) {
    $('userModalError').textContent = err.message; $('userModalError').classList.remove('hidden');
  } finally { btn.disabled = false; }
});

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  const find = (id) => usersData.users.find(u => u.id === +id);
  if (d.ufilter !== undefined) { usersFilter = d.ufilter; renderUsers(); }
  if (t.id === 'newDriverBtn') openModal('new-motorista');
  if (t.id === 'newManagerBtn') openModal('new-gestor');
  if (t.id === 'newWorkshopUserBtn') openModal('new-oficina');
  if (t.id === 'myAccountBtn') openModal('mine');
  if (d.uedit) openModal('edit', find(d.uedit));
  if (d.ucred) openModal('cred', find(d.ucred));
  if (d.umodalClose !== undefined || t.id === 'userModalClose') closeModal();
  if (d.gen) $(d.gen).value = d.kind === 'pin' ? genPin() : genPassword();
  if (d.utoggle) {
    const u = find(d.utoggle);
    if (u.active && !confirm(`Desativar ${u.name}? Deixa de conseguir entrar e as sessões abertas são terminadas.`)) return;
    try { await api(`/api/utilizadores/${u.id}`, { method: 'PATCH', body: JSON.stringify({ active: !u.active }) }); loadUsers(); }
    catch (err) { showToast({ sev: 'aviso', title: 'Não foi possível', text: err.message }); }
  }
  if (d.udelete) {
    const u = find(d.udelete);
    if (!confirm(`Apagar ${u.name} de vez? Não dá para desfazer.\n\nAs mensagens e entregas do camião ficam guardadas. Se só quiseres impedir o acesso, usa "Desativar".`)) return;
    try { await api(`/api/utilizadores/${u.id}`, { method: 'DELETE' }); loadUsers(); }
    catch (err) { showToast({ sev: 'aviso', title: 'Não foi possível apagar', text: err.message }); }
  }
});
$('usersSearch').addEventListener('input', renderUsers);
$('userModal').addEventListener('click', (e) => { if (e.target === $('userModal')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('userModal').classList.contains('hidden')) closeModal(); });
