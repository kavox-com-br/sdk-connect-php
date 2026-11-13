'use strict';
// Tela de teste do Kavox Connect: tudo passa por api.php, que guarda as chaves e chama o Connect. Cada
// chamada fica no Console com requisição e resposta como vieram.

// ---------- base ----------

const SCENARIOS = {
  search: ['ok', 'empty', 'non_refundable', 'card_only', 'credential', 'unavailable', 'timeout', 'slow'],
  quote: ['ok', 'no_availability', 'price_changed', 'rate_expired', 'non_refundable', 'notice_added', 'card_only', 'credential', 'unavailable', 'timeout', 'slow'],
  book: ['ok', 'no_availability', 'price_changed', 'rate_expired', 'validation', 'pending', 'pending_fail', 'pending_stuck', 'notice_added', 'card_only', 'card_only_refused', 'card_only_pending', 'card_only_vcn_refused', 'credential', 'unavailable', 'timeout', 'slow'],
  retrieve: ['ok', 'credential', 'unavailable', 'timeout', 'slow'],
  cancel: ['ok', 'validation', 'cancel_penalty', 'cancel_refused', 'credential', 'unavailable', 'timeout', 'slow'],
  modifyQuote: ['ok', 'no_availability', 'price_changed', 'credential', 'unavailable', 'timeout', 'slow'],
  modify: ['ok', 'no_availability', 'price_changed', 'validation', 'pending', 'credential', 'unavailable', 'timeout', 'slow'],
  vcnIssue: ['ok', 'validation', 'credential', 'unavailable', 'timeout', 'slow'],
};
const PAYMENT_METHODS = { invoice: 'faturado', voucher: 'voucher', prepay: 'pré-pagamento', deposit: 'depósito', credit_card: 'cartão de crédito' };
const BOOKING_WARNINGS = {
  price_changed_after_booking: 'O parceiro informou outro preço depois de reservar ou alterar.',
  penalty_above_max: 'O parceiro cobrou multa acima do máximo aceito.',
  vcn_update_failed: 'O emissor do cartão virtual não foi avisado da mudança da reserva (localizador, nova estadia ou novo limite). O cartão funciona.',
  vcn_cancel_failed: 'O cartão virtual da reserva deveria ter sido cancelado e continua ativo no emissor: alguém precisa cancelá-lo.',
  vcn_kept_for_penalty: 'Reserva cancelada com multa: o cartão virtual continua ativo, com o limite da multa, para o hotel cobrá-la.',
  modification_unconfirmed: 'Uma alteração foi enviada e o parceiro não respondeu com clareza: a reserva pode já estar alterada lá. Repita a alteração com a mesma Idempotency-Key.',
};
const CARD_SOURCES = { request: 'cartão do pedido', vcn: 'VCN', fixed: 'cartão fixo' };
const BOARDS = { room_only: 'Só hospedagem', breakfast: 'Café da manhã', half_board: 'Meia pensão', full_board: 'Pensão completa', all_inclusive: 'All inclusive', other: 'Outro' };
const STATUS_TONE = { active: 'green', confirmed: 'green', ok: 'green', paused: 'amber', pending: 'amber', needs_review: 'amber', invalid: 'red', failed: 'red', revoked: 'red', cancelled: '', expired: 'red' };

const S = { partnerHotels: {}, log: [], cfg: null, me: null, v1: null, products: null, suppliers: null, schemas: {}, facts: null, hotels: {}, hotel: null };

const $ = (sel, el = document) => el.querySelector(sel);

/** h('div', {class, onclick, ...}, ...filhos): monta o DOM sem innerHTML; texto vira texto. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}
/** Troca o conteúdo de el; aceita listas e ignora null/false, como h(). */
function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  return el;
}
/** Ícone do PrimeIcons (o mesmo conjunto do painel do Connect), decorativo. */
const ic = (name, cls) => h('i', { class: 'pi pi-' + name + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
/** Título de página ou de janela, com o ícone num selo na cor da marca. */
const title = (icon, ...text) => h('h1', { class: 'ptitle' }, h('span', { class: 'picon' }, ic(icon)), h('span', {}, ...text));
const opt = (value, label, selected) => h('option', { value, selected }, label ?? value);
const badge = (text, tone) => h('span', { class: 'badge ' + (tone ?? STATUS_TONE[text] ?? '') }, text);
const field = (label, input, cls) => h('label', { class: 'f ' + (cls || '') }, label, input);

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function money(m) {
  if (!m || m.amount === undefined) return '—';
  const n = Number(m.amount);
  return (Number.isFinite(n) ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : m.amount) + ' ' + m.currency;
}
const when = (s) => (s ? new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const day = (s) => (s ? new Date(s + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' }) : '—');
const iso = (d) => d.toISOString().slice(0, 10);
const uuid = () => crypto.randomUUID();
const list = (text) => String(text || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

// ---------- chamadas ----------

/** Chama o Connect pela ponte. Nunca lança por status: devolve {status, body, duration_ms, request_id, request}. */
async function api(method, path, opts = {}) {
  let r;
  try {
    const res = await fetch('api.php?action=call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, path, query: opts.query, body: opts.body, headers: opts.headers }),
    });
    r = await res.json();
  } catch (e) {
    r = { status: 0, body: null, error: 'a ponte (api.php) não respondeu: ' + e.message, request: { method, url: path } };
  }
  r.at = new Date();
  r.label = opts.label || '';
  S.log.unshift(r);
  if (S.log.length > 300) S.log.pop();
  $('#console-count').textContent = S.log.length;
  updateDock();
  if (location.hash === '#/console') render();
  return r;
}
const ok = (r) => r.status >= 200 && r.status < 300;
const mockHeader = (scenario) => (scenario && scenario !== 'ok' ? { 'X-Mock-Scenario': scenario } : {});

/** O erro como o Connect devolveu: código, mensagem, campos, parceiro e request_id. */
function errorBox(r, title) {
  const e = r.body && r.body.error;
  if (!e) {
    return h('div', { class: 'alert red' }, ic('exclamation-circle'), ' ', h('strong', {}, title || 'Falhou'), ' — ', r.error || ('HTTP ' + r.status), h('div', {}, callChip(r, 'ver chamada')));
  }
  return h('div', { class: 'alert red' },
    ic('exclamation-circle'), ' ', h('strong', {}, (title ? title + ': ' : '') + e.code), ' — ', e.message,
    e.retryable ? h('span', {}, ' ', badge('pode repetir', 'amber')) : null,
    e.details && e.details.length ? h('ul', {}, e.details.map((d) => h('li', {}, h('code', {}, d.field), ' ', d.code))) : null,
    e.supplier_code || e.supplier_message ? h('div', { class: 'small' }, 'Parceiro: ', h('code', {}, e.supplier_code || ''), ' ', e.supplier_message || '') : null,
    h('div', { class: 'row', style: 'align-items:center;margin-top:6px' }, h('span', { class: 'small mono' }, 'request_id ' + (e.request_id || r.request_id || '—')), callChip(r, 'ver chamada')));
}
const jsonBlock = (obj, label) => h('details', { class: 'json' }, h('summary', {}, label || 'JSON da resposta'), h('pre', {}, JSON.stringify(obj, null, 2)));
const busy = async (btn, fn) => {
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
};

// ---------- modal ----------

function openModal(...content) {
  const body = $('#modal-body');
  frame(body, content);
  const m = $('#modal');
  if (!m.open) m.showModal();
  return body;
}
/**
 * Monta a janela: o primeiro título (e a linha .sub logo depois dele) vai para o cabeçalho, com o botão de
 * fechar; o resto rola embaixo.
 */
function frame(body, ...content) {
  const kids = content.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false && k !== '');
  const i = kids.findIndex((k) => k instanceof Element && /^H[12]$/.test(k.tagName));
  const heading = i >= 0 ? kids[i] : null;
  const sub = heading && kids[i + 1] instanceof Element && kids[i + 1].classList.contains('sub') ? kids[i + 1] : null;
  const rest = kids.filter((k) => k !== heading && k !== sub);
  put(body,
    h('header', { class: 'modal-head' },
      h('div', { class: 'modal-titles' }, heading, sub),
      h('button', { type: 'button', class: 'icon-btn', onclick: closeModal, 'aria-label': 'Fechar janela', title: 'Fechar (Esc)' }, ic('times'))),
    h('div', { class: 'modal-content' }, rest));
  titleModal(body);
  body.querySelector('.modal-content').scrollTop = 0;
}
/** O primeiro título da janela vira o nome dela para leitor de tela. */
function titleModal(body) {
  const old = $('#modal-title');
  if (old) old.removeAttribute('id');
  const t = body.querySelector('h1, h2');
  if (t) t.id = 'modal-title';
}
function closeModal() { $('#modal').close(); }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

// ---------- dados compartilhados ----------

async function loadConfig() {
  const res = await fetch('api.php?action=config');
  S.cfg = await res.json();
}
async function loadMe() {
  const r = await api('GET', '/v1/me', { label: 'chave em uso' });
  S.me = ok(r) ? r.body : null;
  const who = $('#who');
  put(who);
  if (S.me) who.append(h('div', {}, badge(S.me.environment, S.me.environment === 'production' ? 'red' : 'blue'), ' ', h('span', { class: 'mono' }, S.cfg.product_key || '')), h('div', {}, S.cfg.url));
  else who.append(h('div', {}, badge('sem chave de produto', 'red')), h('div', {}, S.cfg.url || ''));
}
async function loadV1Integrations(force) {
  if (S.v1 && !force) return S.v1;
  const r = await api('GET', '/v1/integrations', { label: 'integrações da chave' });
  S.v1 = ok(r) ? r.body.integrations : [];
  return S.v1;
}
async function loadCatalog() {
  if (!S.products) {
    const [p, s] = await Promise.all([api('GET', '/v1/management/products'), api('GET', '/v1/management/suppliers')]);
    S.products = ok(p) ? p.body.data : [];
    S.suppliers = ok(s) ? s.body.data : [];
  }
}
async function schemaOf(code) {
  if (!S.schemas[code]) {
    const r = await api('GET', '/v1/management/suppliers/' + code);
    S.schemas[code] = ok(r) ? r.body : { code, credential_schema: [] };
  }
  return S.schemas[code];
}
async function factLabels() {
  if (!S.facts) {
    const r = await api('GET', '/v1/content/facts', { label: 'comodidades' });
    S.facts = {};
    for (const f of (ok(r) && r.body.facts) || []) S.facts[f.code] = (f.labels && f.labels['pt-BR']) || f.code;
  }
  return S.facts;
}
/** Nome, endereço e foto dos hotéis do catálogo, para a lista de resultados. */
async function hotelBasics(ids) {
  const missing = [...new Set(ids)].filter((id) => id && !S.hotels[id]);
  await Promise.all(chunk(missing, 200).map(async (part) => {
    const r = await api('POST', '/v1/content/hotels/batch', { body: { hotel_ids: part, fields: ['basic', 'images'] }, label: 'nomes dos hotéis' });
    for (const ht of (ok(r) && r.body.hotels) || []) S.hotels[ht.id] = ht;
  }));
}
function heroOf(ht) {
  const imgs = (ht && ht.images) || [];
  const hero = imgs.find((i) => i.hero) || imgs[0];
  if (!hero) return null;
  const small = (hero.sizes || []).find((s) => s.width >= 200) || hero;
  return small.url;
}
const stars = (n) => (n ? h('span', { class: 'stars', title: n + ' estrelas' }, '★'.repeat(Math.round(n))) : null);

// ---------- rotas ----------

const VIEWS = { hotel: viewHotel, reservas: viewBookings, cartoes: viewCards, credenciais: viewCredentials, chaves: viewKeys, console: viewConsole, config: viewConfig };
function tab() { return (location.hash.replace(/^#\//, '') || 'hotel').split('/')[0]; }
async function render() {
  const name = VIEWS[tab()] ? tab() : 'hotel';
  document.querySelectorAll('#tabs a').forEach((a) => (a.dataset.tab === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const view = $('#view');
  const el = await VIEWS[name]();
  if (tab() === name) put(view, el);
}
window.addEventListener('hashchange', () => { render(); $('#view').focus(); });

// ---------- Configuração ----------

async function viewConfig() {
  await loadConfig();
  const url = h('input', { value: S.cfg.url, placeholder: 'http://localhost:8290' });
  const product = h('input', { type: 'password', placeholder: S.cfg.product_key ? 'em uso: ' + S.cfg.product_key + ' (vazio mantém)' : 'kcx_test_… ou kcx_live_…', autocomplete: 'off' });
  const mgmt = h('input', { type: 'password', placeholder: S.cfg.mgmt_key ? 'em uso: ' + S.cfg.mgmt_key + ' (vazio mantém)' : 'kcx_mgmt_…', autocomplete: 'off' });
  const out = h('div');

  const check = async () => {
    put(out, h('p', { class: 'muted' }, 'Verificando…'));
    const [me, mg] = await Promise.all([api('GET', '/v1/me', { label: 'chave em uso' }), api('GET', '/v1/management/products')]);
    put(out, 
      h('h3', {}, 'Chave de produto'),
      ok(me) ? h('div', {},
        h('dl', { class: 'kv' }, h('dt', {}, 'Ambiente'), h('dd', {}, badge(me.body.environment, me.body.environment === 'production' ? 'red' : 'blue')),
          h('dt', {}, 'Conta'), h('dd', { class: 'mono' }, me.body.account_id), h('dt', {}, 'Chave'), h('dd', { class: 'mono' }, me.body.key_id)),
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Produto'), h('th', {}, 'Parceiro'), h('th', {}, 'Credencial'), h('th', {}, 'Operações'))),
          h('tbody', {}, (me.body.grants || []).map((g) => h('tr', {}, h('td', {}, g.product), h('td', {}, g.integration || 'todos'), h('td', { class: 'mono' }, g.credential || 'todas'), h('td', {}, g.operations.join(', '))))))) : errorBox(me),
      h('h3', {}, 'Chave de gestão'),
      ok(mg) ? h('div', { class: 'alert green' }, 'Responde. Os escopos aparecem quando uma rota falta (403 SCOPE_NOT_ALLOWED).') : errorBox(mg));
    S.v1 = null;
    loadMe();
  };

  const save = async (e) => {
    e.preventDefault();
    await fetch('api.php?action=config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.value, product_key: product.value, mgmt_key: mgmt.value }) });
    toast('Configuração salva nesta sessão');
    render();
  };
  const reset = async () => {
    await fetch('api.php?action=config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) });
    toast('Voltou para o .env');
    render();
  };
  check();
  return h('div', {},
    h('div', { class: 'card' },
      h('div', { class: 'head' }, h('div', {}, title('cog', 'Configuração'), h('p', { class: 'muted' }, 'O padrão vem do .env do SDK. O que você salvar aqui vale só nesta sessão do navegador; as chaves ficam no servidor PHP, nunca no navegador.')),
        S.cfg.overridden ? h('button', { onclick: reset }, 'Voltar para o .env') : null),
      h('form', { class: 'stack', onsubmit: save },
        h('div', { class: 'grid' }, field('Endereço do Connect', url), field('Chave de produto (/v1)', product), field('Chave de gestão (/v1/management)', mgmt)),
        h('div', { class: 'row' }, h('button', { class: 'primary' }, 'Salvar'), h('button', { type: 'button', onclick: check }, 'Testar de novo')))),
    h('div', { class: 'card' }, out));
}

// ---------- Credenciais ----------

async function viewCredentials() {
  const root = h('div', {}, h('p', { class: 'muted' }, 'Carregando…'));
  const load = async () => {
    await loadCatalog();
    const r = await api('GET', '/v1/management/integrations', { label: 'credenciais' });
    if (!ok(r)) { put(root, header(), errorBox(r)); return; }
    const integrations = r.body.data || [];
    put(root, header(), integrations.length ? integrations.map(integrationCard) : h('div', { class: 'card empty' }, emptyMark(), 'Nenhum parceiro ligado. Crie a primeira credencial.'));
  };
  const header = () => h('div', { class: 'card' }, h('div', { class: 'head' },
    h('div', {}, title('lock', 'Credenciais'), h('p', { class: 'muted' }, 'API de gestão: /v1/management/integrations e /credentials. Segredos voltam sempre mascarados.')),
    h('div', { class: 'row' }, h('button', { onclick: load }, ic('refresh'), 'Atualizar'), h('button', { class: 'primary', onclick: () => credentialForm(null, load) }, ic('plus'), 'Nova credencial'))));

  const integrationCard = (it) => {
    const sup = (S.suppliers || []).find((s) => s.code === it.integration);
    const toggle = async (e) => busy(e.target, async () => {
      const next = it.status === 'paused' ? 'active' : 'paused';
      const res = await api('PATCH', '/v1/management/integrations/' + it.integration, { body: { status: next } });
      if (ok(res)) { toast(next === 'paused' ? 'Parceiro pausado' : 'Parceiro reativado'); load(); } else openModal(errorBox(res));
    });
    return h('div', { class: 'card' },
      h('div', { class: 'head' },
        h('div', {}, h('h2', {}, (sup && sup.name) || it.integration, ' ', badge(it.status)), h('div', { class: 'muted small' }, h('code', {}, it.integration), sup ? ' · produtos: ' + sup.products.join(', ') : '')),
        h('button', { onclick: toggle }, it.status === 'paused' ? 'Reativar parceiro' : 'Pausar parceiro')),
      h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Credencial', 'Ambiente', 'Estado', 'Campos', 'Último teste', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, it.credentials.map((c) => credentialRow(c, load))))));
  };
  load();
  return root;
}

function credentialRow(c, reload) {
  const test = (e) => busy(e.target, async () => {
    const r = await api('POST', '/v1/management/credentials/' + c.id + '/test', { label: 'testar credencial' });
    if (ok(r)) { toast(r.body.last_test && r.body.last_test.ok ? 'Conexão ok' : 'O parceiro recusou: veja o último teste'); reload(); } else openModal(errorBox(r, 'Teste'));
  });
  const pause = (e) => busy(e.target, async () => {
    const r = await api('PATCH', '/v1/management/credentials/' + c.id, { body: { status: c.status === 'paused' ? 'active' : 'paused' } });
    if (ok(r)) reload(); else openModal(errorBox(r));
  });
  const remove = (e) => {
    if (!confirm('Excluir a credencial "' + c.name + '"? As permissões de chave que a citam saem junto.')) return;
    busy(e.target, async () => {
      const r = await api('DELETE', '/v1/management/credentials/' + c.id);
      if (ok(r)) { toast('Credencial excluída'); reload(); } else openModal(errorBox(r));
    });
  };
  const lt = c.last_test;
  return h('tr', {},
    h('td', {}, h('strong', {}, c.name), c.is_default ? ' ' : null, c.is_default ? badge('padrão', 'blue') : null, h('div', { class: 'mono small muted' }, c.id)),
    h('td', {}, badge(c.environment, c.environment === 'production' ? 'red' : 'blue')),
    h('td', {}, badge(c.status)),
    h('td', { class: 'small' }, Object.entries(c.fields || {}).map(([k, v]) => h('div', {}, h('span', { class: 'muted' }, k + ': '), h('span', { class: 'mono' }, String(v))))),
    h('td', { class: 'small' }, lt ? h('div', {}, badge(lt.ok ? 'ok' : 'falhou', lt.ok ? 'green' : 'red'), ' ', when(lt.at), lt.error ? h('div', { class: 'muted' }, lt.error) : null) : h('span', { class: 'muted' }, 'nunca')),
    h('td', { class: 'nowrap' },
      h('button', { class: 'sm', onclick: test }, ic('bolt'), 'Testar'), ' ',
      h('button', { class: 'sm', onclick: () => credentialForm(c, reload) }, ic('pencil'), 'Editar'), ' ',
      h('button', { class: 'sm', onclick: pause }, c.status === 'paused' ? 'Ativar' : 'Pausar'), ' ',
      h('button', { class: 'sm danger', onclick: remove }, ic('trash'), 'Excluir')));
}

/** Formulário de credencial montado pelo credential_schema do parceiro. c = null cria. */
async function credentialForm(c, reload) {
  await loadCatalog();
  const editing = !!c;
  const supplier = h('select', { disabled: editing }, (S.suppliers || []).map((s) => opt(s.code, s.name + ' (' + s.code + ')', c && c.integration === s.code)));
  const name = h('input', { value: c ? c.name : '', required: true });
  const env = h('select', { disabled: editing });
  const status = h('select', {}, ['active', 'paused'].map((s) => opt(s, s, c && c.status === s)));
  const fieldsBox = h('div', { class: 'grid' });
  const out = h('div');
  let inputs = {};

  const fill = async () => {
    const sch = await schemaOf(supplier.value);
    put(env, ...[sch.has_sandbox !== false ? opt('sandbox', 'sandbox', c && c.environment === 'sandbox') : null, sch.has_production ? opt('production', 'production', c && c.environment === 'production') : null].filter(Boolean));
    if (!editing && !name.value) name.value = (sch.name || supplier.value) + ' ' + env.value;
    inputs = {};
    // as credenciais da conta, para o campo que nomeia outra (o emissor do cartão virtual)
    let others = [];
    if ((sch.credential_schema || []).some((f) => f.type === 'credential')) {
      const r = await api('GET', '/v1/management/integrations', { label: 'credenciais' });
      if (ok(r)) others = (r.body.data || []).flatMap((it) => it.credentials.map((x) => ({ ...x, integration: it.integration })));
    }
    const serves = (code, product) => ((S.suppliers || []).find((x) => x.code === code) || { products: [] }).products.includes(product);
    const rows = (sch.credential_schema || []).map((f) => {
      const current = c && c.fields ? c.fields[f.key] : undefined;
      let input;
      if (f.type === 'select') {
        input = h('select', {}, f.required ? null : opt('', '—'), (f.options || []).map((o) => opt(o, o, (current ?? f.default) === o)));
      } else if (f.type === 'credential') {
        const choices = others.filter((x) => x.environment === env.value && serves(x.integration, f.product));
        input = h('select', {}, opt('', choices.length ? '—' : 'nenhuma credencial de ' + f.product + ' neste ambiente'), choices.map((x) => opt(x.id, x.name + ' · ' + x.integration, current === x.id)));
      } else {
        input = h('input', {
          type: f.secret ? 'password' : 'text', autocomplete: 'off',
          value: f.secret ? '' : (current ?? (editing && !f.show_when && !f.group ? '' : f.default ?? '')),
          placeholder: f.secret && editing ? 'vazio mantém o atual (' + (current || '••••') + ')' : (f.type === 'month' ? 'MM/AAAA' : f.default || ''),
          inputmode: f.type === 'card' || f.type === 'month' ? 'numeric' : undefined,
        });
      }
      inputs[f.key] = { input, f };
      const row = field(f.label_pt + (f.required ? ' *' : ''), input);
      if (f.help_pt) row.title = f.help_pt;
      return { f, row, input };
    });
    // campo condicional (show_when): só aparece, e só é enviado, quando os campos de que depende têm o valor pedido
    const applies = (f) => Object.entries(f.show_when || {}).every(([k, want]) => inputs[k] && inputs[k].input.value === want);
    const sync = () => rows.forEach(({ f, row, input }) => {
      const on = applies(f);
      row.hidden = !on;
      input.required = on && f.required && !(f.secret && editing && c.fields && c.fields[f.key]);
    });
    rows.forEach(({ input }) => input.addEventListener('change', sync));
    const groups = [...new Set(rows.map(({ f }) => f.group || ''))];
    const GROUPS = { card: 'Cartão na reserva (só para tarifa que só aceita cartão)' };
    put(fieldsBox, ...groups.flatMap((g) => [g ? h('h3', { style: 'grid-column:1/-1' }, ic('credit-card'), ' ', GROUPS[g] || g) : null, ...rows.filter(({ f }) => (f.group || '') === g).map(({ row }) => row)].filter(Boolean)));
    sync();
    fieldsBox.applies = applies;
  };
  supplier.addEventListener('change', () => { name.value = ''; fill(); });

  const submit = async (e) => {
    e.preventDefault();
    const fields = {};
    for (const [k, { input, f }] of Object.entries(inputs)) {
      if (fieldsBox.applies && !fieldsBox.applies(f)) continue; // campo que não vale não é enviado: o Connect não o guardaria
      const v = input.value.trim();
      if (v === '' && (editing || !f.required)) continue; // vazio: mantém (edição) ou não manda (opcional)
      fields[k] = v;
    }
    const btn = e.submitter;
    await busy(btn, async () => {
      const r = editing
        ? await api('PATCH', '/v1/management/credentials/' + c.id, { body: { name: name.value, status: status.value, fields } })
        : await api('POST', '/v1/management/credentials', { body: { integration: supplier.value, name: name.value, environment: env.value, fields } });
      if (ok(r)) { closeModal(); toast(editing ? 'Credencial alterada' : 'Credencial criada'); S.v1 = null; reload(); } else put(out, errorBox(r));
    });
  };
  openModal(title(editing ? 'pencil' : 'plus', editing ? 'Editar credencial' : 'Nova credencial'),
    h('div', { class: 'sub' }, 'Os campos mudam conforme o parceiro escolhido.'),
    h('form', { class: 'stack', onsubmit: submit },
      h('div', { class: 'grid' }, field('Parceiro', supplier), field('Ambiente', env), field('Nome', name), editing ? field('Estado', status) : null),
      h('h3', {}, ic('list'), ' Campos do parceiro'), fieldsBox,
      h('p', { class: 'muted small' }, 'Os valores vão direto para o Connect, que os guarda cifrados; nada fica nesta tela.'),
      out, h('div', { class: 'row' }, h('button', { class: 'primary' }, editing ? 'Salvar' : 'Criar'))));
  await fill();
}

// ---------- Chaves ----------

async function viewKeys() {
  const root = h('div', {}, h('p', { class: 'muted' }, 'Carregando…'));
  const load = async () => {
    await loadCatalog();
    const r = await api('GET', '/v1/management/keys', { label: 'chaves' });
    const head = h('div', { class: 'card' }, h('div', { class: 'head' },
      h('div', {}, title('key', 'Chaves de produto'), h('p', { class: 'muted' }, 'Quem chama a /v1. Negado por padrão: a chave só usa o produto, o parceiro e a operação que a permissão dela diz.')),
      h('div', { class: 'row' }, h('button', { onclick: load }, ic('refresh'), 'Atualizar'), h('button', { onclick: devKey }, ic('wrench'), 'Chave de desenvolvimento'), h('button', { class: 'primary', onclick: () => keyForm(load) }, ic('plus'), 'Nova chave'))));
    if (!ok(r)) { put(root, head, errorBox(r)); return; }
    const rows = (r.body.data || []).map((k) => {
      const st = k.revoked_at ? 'revoked' : k.expired ? 'expired' : k.status;
      const revoke = (e) => {
        if (!confirm('Revogar a chave "' + k.name + '"? Quem usa para de funcionar.')) return;
        busy(e.target, async () => { const x = await api('POST', '/v1/management/keys/' + k.id + '/revoke'); ok(x) ? load() : openModal(errorBox(x)); });
      };
      const drop = (e) => busy(e.target, async () => { const x = await api('DELETE', '/v1/management/keys/' + k.id); ok(x) ? load() : openModal(errorBox(x)); });
      return h('tr', {},
        h('td', {}, h('strong', {}, k.name), h('div', { class: 'mono small muted' }, k.prefix + '…')),
        h('td', {}, badge(k.environment, k.environment === 'production' ? 'red' : 'blue')),
        h('td', {}, badge(st)),
        h('td', { class: 'small' }, (k.grants || []).map((g) => h('div', {}, h('strong', {}, g.product), ' · ', g.integration || 'todos', g.credential ? ' · ' + g.credential : '', h('span', { class: 'muted' }, ' — ' + g.operations.join(', '))))),
        h('td', { class: 'small' }, k.last_used_at ? when(k.last_used_at) : h('span', { class: 'muted' }, 'nunca'), k.allowed_ips && k.allowed_ips.length ? h('div', { class: 'muted' }, 'IPs: ' + k.allowed_ips.join(', ')) : null),
        h('td', { class: 'nowrap' }, st === 'active' ? h('button', { class: 'sm danger', onclick: revoke }, 'Revogar') : h('button', { class: 'sm', onclick: drop }, 'Tirar da lista')));
    });
    put(root, head, h('div', { class: 'card' }, rows.length ? h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Chave', 'Ambiente', 'Estado', 'Permissões', 'Último uso', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows))) : h('div', { class: 'empty' }, emptyMark(), 'Nenhuma chave.')));
  };
  const devKey = async (e) => busy(e.target, async () => {
    const r = await api('POST', '/v1/management/keys/development', { label: 'chave de desenvolvimento' });
    if (ok(r)) { showSecret(r.body); load(); } else openModal(errorBox(r));
  });
  load();
  return root;
}

function showSecret(key) {
  const use = async (e) => busy(e.target, async () => {
    await fetch('api.php?action=config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product_key: key.secret }) });
    await loadConfig(); S.v1 = null; await loadMe();
    toast('Esta tela agora usa a chave "' + key.name + '"');
    closeModal();
  });
  openModal(title('key', 'Chave criada: ' + key.name),
    h('div', { class: 'alert amber' }, 'O valor aparece só agora. Copie e guarde; o Connect grava só o hash.'),
    h('div', { class: 'secret' }, key.secret),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { onclick: () => navigator.clipboard.writeText(key.secret).then(() => toast('Copiada')) }, 'Copiar'),
      h('button', { class: 'primary', onclick: use }, 'Usar como chave de produto desta tela')));
}

async function keyForm(reload) {
  await loadCatalog();
  const ints = await api('GET', '/v1/management/integrations', { label: 'credenciais para permissões' });
  const creds = ok(ints) ? ints.body.data.flatMap((i) => i.credentials) : [];
  const name = h('input', { required: true, value: 'Teste SDK' });
  const env = h('select', {}, opt('sandbox', 'sandbox (kcx_test_…)'), opt('production', 'production (kcx_live_…)'));
  const ips = h('input', { placeholder: '203.0.113.10, 10.0.0.0/24… (vazio = qualquer)', spellcheck: 'false', autocomplete: 'off' });
  const expires = h('input', { type: 'datetime-local' });
  const rowsBox = h('div', { class: 'stack' });
  const out = h('div');
  const rows = [];

  const addRow = (preset = {}) => {
    const product = h('select', {}, S.products.map((p) => opt(p.code, p.label_pt, preset.product === p.code)));
    const integ = h('select');
    const cred = h('select');
    const ops = h('div', { class: 'row' });
    const refresh = () => {
      const p = S.products.find((x) => x.code === product.value);
      const content = product.value === 'content';
      integ.disabled = cred.disabled = content;
      put(integ, opt('', content ? '— (conteúdo não é de parceiro)' : 'todos os parceiros'), ...(content ? [] : S.suppliers.filter((s) => s.products.includes(product.value)).map((s) => opt(s.code, s.name, preset.integration === s.code))));
      refreshCreds();
      put(ops, ...(p ? p.operations : []).map((o) => h('label', { class: 'f check' }, h('input', { type: 'checkbox', value: o.code, checked: !o.is_write || preset.write }), o.label_pt)));
    };
    const refreshCreds = () => put(cred, opt('', 'todas as credenciais'), ...creds.filter((c) => c.integration === integ.value && c.environment === env.value).map((c) => opt(c.id, c.name)));
    product.addEventListener('change', refresh);
    integ.addEventListener('change', refreshCreds);
    env.addEventListener('change', refreshCreds);
    const box = h('div', { class: 'room' }, field('Produto', product), field('Parceiro', integ), field('Credencial', cred), field('Operações', ops),
      h('button', { type: 'button', class: 'sm danger', onclick: () => { box.remove(); rows.splice(rows.indexOf(row), 1); } }, 'Tirar'));
    const row = { product, integ, cred, ops };
    rows.push(row);
    rowsBox.append(box);
    refresh();
  };
  addRow({ product: 'hotel', write: true });
  addRow({ product: 'content' });

  const submit = async (e) => {
    e.preventDefault();
    const grants = rows.map((r) => ({
      product: r.product.value,
      integration: r.integ.value || undefined,
      credential: r.cred.value || undefined,
      operations: [...r.ops.querySelectorAll('input:checked')].map((i) => i.value),
    }));
    const body = { name: name.value, environment: env.value, grants };
    if (list(ips.value).length) body.allowed_ips = list(ips.value);
    if (expires.value) body.expires_at = new Date(expires.value).toISOString();
    await busy(e.submitter, async () => {
      const r = await api('POST', '/v1/management/keys', { body, label: 'criar chave' });
      if (ok(r)) { showSecret(r.body); reload(); } else put(out, errorBox(r));
    });
  };
  openModal(title('key', 'Nova chave de produto'),
    h('div', { class: 'sub' }, 'Negado por padrão: a chave só faz o que as permissões abaixo liberam.'),
    h('form', { class: 'stack', onsubmit: submit },
      h('div', { class: 'grid' }, field('Nome', name), field('Ambiente', env), field('IPs permitidos', ips), field('Validade', expires)),
      h('div', { class: 'head' }, h('h3', {}, ic('shield'), ' Permissões'), h('button', { type: 'button', class: 'sm', onclick: () => addRow() }, 'Mais uma')),
      rowsBox, out, h('div', { class: 'row' }, h('button', { class: 'primary' }, 'Criar chave'))));
}

// ---------- Hotel ----------

function hotelState() {
  if (!S.hotel) {
    const inDays = new Date(Date.now() + 30 * 864e5);
    S.hotel = { mode: 'destination', dest: null, sdest: null, q: '', ids: '', integration: '', credential: '', checkIn: iso(inDays), nights: 2,
      rooms: [{ adults: 2, children: '' }], currency: '', country: '', rates: 5, max: 500, scenario: 'ok', quoteScenario: 'ok', result: null, filter: '', sort: 'supplier' };
  }
  return S.hotel;
}

async function viewHotel() {
  const st = hotelState();
  const ints = (await loadV1Integrations()).filter((i) => i.credentials.some((c) => c.allowed.some((a) => a.product === 'hotel')));
  if (!st.integration || !ints.some((i) => i.integration === st.integration)) st.integration = ints[0] ? ints[0].integration : '';

  const results = h('div');
  const integration = h('select', {}, ints.length ? ints.map((i) => opt(i.integration, i.integration + (i.status !== 'active' ? ' (' + i.status + ')' : ''), st.integration === i.integration)) : opt('', 'a chave não tem hotel'));
  const credential = h('select');
  const scenarioBox = h('span');
  const fillCreds = () => {
    st.integration = integration.value;
    const it = ints.find((i) => i.integration === st.integration);
    put(credential, opt('', 'padrão'), ...((it && it.credentials) || []).map((c) => opt(c.id, c.name + (c.is_default ? ' (padrão)' : ''), st.credential === c.id)));
    put(scenarioBox, st.integration === 'mock' ? field('Cenário do simulador', scenarioSelect('search', st.scenario, (v) => { st.scenario = v; })) : '');
    const caps = it && it.capabilities && it.capabilities.hotel;
    put(capsBox, caps ? h('div', { class: 'small muted' }, 'Capacidades: ', Object.entries(caps).map(([k, v]) => h('span', {}, ' ', badge((v === true ? '✓ ' : v === false ? '✕ ' : '') + k + (typeof v === 'boolean' ? '' : ': ' + v), v === true ? 'green' : v === false ? 'red' : 'blue')))) : '');
  };
  const capsBox = h('div');
  integration.addEventListener('change', () => { fillCreds(); st.sdest = null; drawHotels(); });
  credential.addEventListener('change', () => { st.credential = credential.value; });

  // hotéis
  const modes = [['destination', 'Destino'], ['name', 'Nome'], ['hotel_ids', 'hotel_id'], ['giata_hotel_ids', 'GIATA'], ['supplier_hotel_ids', 'Código do parceiro'], ['supplier_destination_id', 'Destino do parceiro']];
  const capsOf = () => { const it = ints.find((i) => i.integration === st.integration); return (it && it.capabilities && it.capabilities.hotel) || {}; };
  const hotelsBox = h('div');
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Identificar hotéis por' }, modes.map(([m, label]) => h('button', { type: 'button', 'aria-pressed': String(st.mode === m), onclick: () => { st.mode = m; drawHotels(); } }, label)));
  const drawHotels = () => {
    seg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(modes[i][0] === st.mode)));
    if (st.mode === 'destination') put(hotelsBox, h('div', { class: 'row' }, destinationInput(st), field('Máx. de hotéis', numberInput(st, 'max', 1, 2000))));
    else if (st.mode === 'supplier_destination_id') put(hotelsBox, capsOf().supplier_catalog
      ? h('div', { class: 'stack' },
        h('div', { class: 'row' }, supplierDestinationInput(st),
          h('button', { type: 'button', onclick: () => { if (st.sdest) supplierHotelsModal(st, () => { st.mode = 'supplier_hotel_ids'; drawHotels(); }); else toast('Escolha um destino do parceiro'); } }, ic('list'), 'Ver hotéis do parceiro neste destino')),
        h('p', { class: 'small muted' }, 'Destinos do catálogo do próprio parceiro (GET /v1/hotels/supplier-destinations), para parceiro fora do GIATA. O id só vale em ', h('strong', {}, st.integration), ': a busca manda supplier_destination_id.'))
      : h('div', { class: 'alert amber' }, ic('info-circle'), ' ', h('strong', {}, st.integration || 'esta integração'), ' não tem catálogo próprio para ler (capabilities.hotel.supplier_catalog). Use Destino, que vem do conteúdo do Connect.'));
    else if (st.mode === 'name') put(hotelsBox, h('div', { class: 'row' }, field('Nome do hotel (mín. 2 letras)', h('input', { value: st.q, oninput: (e) => { st.q = e.target.value; } })), field('Máx. de hotéis', numberInput(st, 'max', 1, 2000))));
    else put(hotelsBox, field(st.mode === 'giata_hotel_ids' ? 'Ids do GIATA (vírgula ou linha)' : st.mode === 'hotel_ids' ? 'hotel_id do catálogo (vírgula ou linha)' : 'Códigos do hotel no parceiro', h('textarea', { rows: 3, name: 'ids', spellcheck: 'false', autocomplete: 'off', translate: 'no', placeholder: st.mode === 'giata_hotel_ids' ? '10746, 527606…' : 'um por linha ou separados por vírgula…', oninput: (e) => { st.ids = e.target.value; } }, st.ids)));
  };

  // estadia
  const checkIn = h('input', { type: 'date', value: st.checkIn, oninput: (e) => { st.checkIn = e.target.value; outDay.textContent = checkoutLabel(); } });
  const nights = numberInput(st, 'nights', 1, 60, () => { outDay.textContent = checkoutLabel(); });
  const checkoutLabel = () => { const d = new Date(st.checkIn + 'T12:00:00'); d.setDate(d.getDate() + Number(st.nights || 1)); return 'saída ' + day(iso(d)); };
  const outDay = h('span', { class: 'muted small' }, checkoutLabel());
  const roomsBox = h('div', { class: 'stack' });
  const drawRooms = () => put(roomsBox, ...st.rooms.map((r, i) => h('div', { class: 'room' },
    h('strong', { class: 'small' }, 'Quarto ' + (i + 1)),
    field('Adultos', h('select', { onchange: (e) => { r.adults = Number(e.target.value); } }, [1, 2, 3, 4, 5, 6].map((n) => opt(n, n, r.adults === n)))),
    field('Idades das crianças', h('input', { value: r.children, placeholder: 'ex.: 7, 4…', size: 10, name: 'children', autocomplete: 'off', oninput: (e) => { r.children = e.target.value; } })),
    st.rooms.length > 1 ? h('button', { type: 'button', class: 'sm', onclick: () => { st.rooms.splice(i, 1); drawRooms(); } }, 'Tirar') : null)),
  st.rooms.length < 9 ? h('div', {}, h('button', { type: 'button', class: 'sm', onclick: () => { st.rooms.push({ adults: 2, children: '' }); drawRooms(); } }, 'Mais um quarto')) : '');

  const submit = async (e) => {
    e.preventDefault();
    await busy(e.submitter, () => runSearch(results));
  };
  const form = h('form', { class: 'card hero', onsubmit: submit },
    h('div', { class: 'head' }, h('div', {}, title('building', 'Hotel · buscar tarifas'), h('p', { class: 'muted' }, 'POST /v1/hotels/search: uma integração e uma lista de hotéis, sem máximo, numa chamada só. Parceiro fora do GIATA busca pelo código ou pelo destino dele mesmo.'))),
    h('div', { class: 'stack' },
      h('div', { class: 'row' }, field('Integração', integration), field('Credencial', credential), scenarioBox),
      capsBox,
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Hotéis por'), seg),
      hotelsBox,
      h('div', { class: 'row' }, field('Entrada', checkIn), field('Noites', nights), outDay),
      roomsBox,
      h('div', { class: 'row' },
        field('Moeda (opcional)', h('input', { value: st.currency, size: 5, maxlength: 3, placeholder: 'BRL…', name: 'currency', autocomplete: 'off', spellcheck: 'false', oninput: (e) => { st.currency = e.target.value; } })),
        field('País do hóspede (opcional)', h('input', { value: st.country, size: 5, maxlength: 2, placeholder: 'BR…', name: 'guest_country', autocomplete: 'off', spellcheck: 'false', oninput: (e) => { st.country = e.target.value; } })),
        field('Tarifas por hotel (0 = todas)', numberInput(st, 'rates', 0, 100)),
        h('button', { class: 'primary' }, ic('search'), 'Buscar tarifas'))));
  fillCreds(); drawHotels(); drawRooms();
  if (st.result) drawResults(results);
  return h('div', {}, form, results);
}

function numberInput(st, key, min, max, after) {
  return h('input', { type: 'number', min, max, value: st[key], style: 'width:90px', oninput: (e) => { st[key] = Number(e.target.value); if (after) after(); } });
}
function scenarioSelect(op, value, set) {
  return h('select', { onchange: (e) => set(e.target.value) }, SCENARIOS[op].map((s) => opt(s, s, value === s)));
}

/** Autocomplete de GET /v1/hotels/supplier-destinations: os destinos do próprio parceiro da integração. */
function supplierDestinationInput(st) {
  const input = h('input', { value: st.sdest ? st.sdest.name : '', placeholder: 'Acrelândia, São Paulo…', autocomplete: 'off', name: 'supplier_destination', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'sdest-list', 'aria-autocomplete': 'list' });
  const ul = h('ul', { hidden: true, id: 'sdest-list', role: 'listbox', 'aria-label': 'Destinos do parceiro' });
  let timer = 0;
  let items = [];
  let active = -1;
  const show = (open) => { ul.hidden = !open; input.setAttribute('aria-expanded', String(open)); };
  const pick = (it) => { st.sdest = it; input.value = it.name; show(false); };
  const mark = () => ul.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
  input.addEventListener('keydown', (e) => {
    if (ul.hidden || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      mark();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === 'Escape') show(false);
  });
  input.addEventListener('input', () => {
    st.sdest = null;
    clearTimeout(timer);
    if (input.value.trim().length < 2) { show(false); return; }
    timer = setTimeout(async () => {
      const r = await api('GET', '/v1/hotels/supplier-destinations', { query: { integration: st.integration, credential: st.credential || undefined, q: input.value.trim(), limit: 15 }, label: 'destinos do parceiro' });
      items = (ok(r) && r.body.destinations) || [];
      active = -1;
      if (!ok(r)) { put(ul, h('li', { class: 'muted small' }, (r.body && r.body.error && r.body.error.code) || 'falhou')); show(true); return; }
      put(ul, ...items.map((it) => h('li', { role: 'option', 'aria-selected': 'false', onmousedown: (e) => { e.preventDefault(); pick(it); } },
        badge(st.integration, 'blue'), ' ', h('strong', {}, it.name), h('span', { class: 'muted small' }, ' ' + [it.region, it.country].filter(Boolean).join(', ')),
        h('span', { class: 'mono small muted' }, ' ' + it.id))));
      show(items.length > 0);
    }, 300);
  });
  input.addEventListener('blur', () => setTimeout(() => show(false), 150));
  return field('Destino no parceiro', h('div', { class: 'suggest' }, input, ul));
}

/** Os hotéis do parceiro num destino dele (GET /v1/hotels/supplier-hotels), página a página. */
async function supplierHotels(st, destinationId, maxPages) {
  const out = [];
  let pages = 1;
  for (let page = 1; page <= pages && page <= maxPages; page++) {
    const r = await api('GET', '/v1/hotels/supplier-hotels', { query: { integration: st.integration, credential: st.credential || undefined, destination_id: destinationId, page }, label: 'hotéis do parceiro' });
    if (!ok(r)) throw r;
    out.push(...r.body.hotels);
    pages = r.body.pages || 1;
  }
  for (const ht of out) S.partnerHotels[st.integration + '/' + ht.supplier_hotel_id] = ht;
  return out;
}

async function supplierHotelsModal(st, use) {
  openModal(h('h2', {}, 'Hotéis de ' + st.sdest.name + ' em ' + st.integration), h('p', { class: 'sub' }, 'Catálogo do próprio parceiro · GET /v1/hotels/supplier-hotels'), h('p', { class: 'muted' }, 'Carregando…'));
  let hotels;
  try { hotels = await supplierHotels(st, st.sdest.id, 10); } catch (err) { openModal(errorBox(err, 'Hotéis do parceiro')); return; }
  openModal(h('h2', {}, 'Hotéis de ' + st.sdest.name + ' em ' + st.integration),
    h('p', { class: 'sub' }, h('span', {}, ic('building'), ' ', hotels.length + ' hotéis no catálogo do parceiro'), h('span', {}, ic('link'), ' GET /v1/hotels/supplier-hotels')),
    hotels.length ? h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Hotel', 'Endereço', 'Código no parceiro', 'hotel_id do Connect'].map((t) => h('th', {}, t)))),
      h('tbody', {}, hotels.map((ht) => h('tr', {},
        h('td', {}, h('strong', {}, ht.name || '—'), ' ', stars(ht.stars)),
        h('td', { class: 'small' }, [ht.address, ht.city].filter(Boolean).join(' · ')),
        h('td', { class: 'mono small', translate: 'no' }, ht.supplier_hotel_id),
        h('td', { class: 'mono small' }, ht.hotel_id || h('span', { class: 'muted' }, 'sem vínculo'))))))) : h('div', { class: 'empty' }, emptyMark(), 'O parceiro não tem hotel neste destino.'),
    h('div', { class: 'row' }, h('button', { class: 'primary', disabled: !hotels.length, onclick: () => { st.ids = hotels.map((x) => x.supplier_hotel_id).join('\n'); closeModal(); use(); toast('Códigos copiados para a busca'); } }, ic('search'), 'Buscar por estes códigos')));
}

/** Autocomplete de /v1/content/destinations: cidade, destino ou hotel. */
function destinationInput(st) {
  const input = h('input', { value: st.dest ? st.dest.name : '', placeholder: 'Gramado, Rio, Copacabana Palace…', autocomplete: 'off', name: 'destination', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'dest-list', 'aria-autocomplete': 'list' });
  const ul = h('ul', { hidden: true, id: 'dest-list', role: 'listbox', 'aria-label': 'Destinos' });
  let timer = 0;
  let items = [];
  let active = -1;
  const show = (open) => { ul.hidden = !open; input.setAttribute('aria-expanded', String(open)); };
  const pick = (it) => { st.dest = it; input.value = it.name; show(false); };
  const mark = () => ul.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
  input.addEventListener('keydown', (e) => {
    if (ul.hidden || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      mark();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === 'Escape') show(false);
  });
  input.addEventListener('input', () => {
    st.dest = null;
    clearTimeout(timer);
    if (input.value.trim().length < 2) { show(false); return; }
    timer = setTimeout(async () => {
      const r = await api('GET', '/v1/content/destinations', { query: { q: input.value.trim() }, label: 'autocomplete' });
      items = (ok(r) && r.body.results) || [];
      active = -1;
      put(ul, ...items.map((it) => h('li', { role: 'option', 'aria-selected': 'false', onmousedown: (e) => { e.preventDefault(); pick(it); } },
        badge(it.type === 'city' ? 'cidade' : it.type === 'hotel' ? 'hotel' : 'destino', it.type === 'hotel' ? '' : 'blue'), ' ', h('strong', {}, it.name),
        h('span', { class: 'muted small' }, ' ' + [it.region, it.country_name].filter(Boolean).join(', ') + (it.hotel_count ? ' · ' + it.hotel_count + ' hotéis' : '')))));
      show(items.length > 0);
    }, 250);
  });
  input.addEventListener('blur', () => setTimeout(() => show(false), 150));
  return field('Destino', h('div', { class: 'suggest' }, input, ul));
}

/** Os hotel_ids de uma região ou nome, página a página (fields=id). */
async function contentIds(filter, max) {
  const ids = [];
  let cursor;
  do {
    const r = await api('GET', '/v1/content/hotels/search', { query: { ...filter, fields: 'id', limit: Math.min(200, max), cursor }, label: 'hotéis da região' });
    if (!ok(r)) throw r;
    ids.push(...(r.body.hotel_ids || []));
    cursor = r.body.next_cursor;
  } while (cursor && ids.length < max);
  return ids.slice(0, max);
}

async function runSearch(box) {
  const st = hotelState();
  put(box, h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Buscando…')));
  let kind = st.mode;
  let ids;
  try {
    if (st.mode === 'destination') {
      if (!st.dest) throw new Error('escolha um destino da lista');
      kind = 'hotel_ids';
      ids = st.dest.type === 'hotel' ? [st.dest.id] : await contentIds(st.dest.type === 'city' ? { city_id: st.dest.id } : { destination_id: st.dest.id }, st.max);
    } else if (st.mode === 'name') {
      kind = 'hotel_ids';
      ids = await contentIds({ q: st.q }, st.max);
    } else if (st.mode === 'supplier_destination_id') {
      if (!st.sdest) throw new Error('escolha um destino do parceiro na lista');
      ids = st.sdest.id;
      supplierHotels(st, st.sdest.id, 10).catch(() => {}); // os nomes dos hotéis do parceiro, para os cartões
    } else {
      ids = list(st.ids);
      if (kind === 'giata_hotel_ids') ids = ids.map(Number);
    }
  } catch (err) {
    put(box, h('div', { class: 'card' }, err.status !== undefined ? errorBox(err, 'Conteúdo') : h('div', { class: 'alert red' }, err.message)));
    return;
  }
  if (!ids.length) { put(box, h('div', { class: 'card empty' }, 'Nenhum hotel para buscar.')); return; }

  const checkOut = new Date(st.checkIn + 'T12:00:00');
  checkOut.setDate(checkOut.getDate() + Number(st.nights || 1));
  const rooms = st.rooms.map((r) => { const ages = list(r.children).map(Number); return ages.length ? { adults: r.adults, children_ages: ages } : { adults: r.adults }; });
  const base = { integration: st.integration, credential: st.credential || undefined, check_in: st.checkIn, check_out: iso(checkOut), rooms,
    currency: st.currency || undefined, guest_country: st.country || undefined, max_rates_per_hotel: st.rates || undefined };
  const headers = st.integration === 'mock' ? mockHeader(st.scenario) : {};

  const started = performance.now();
  const calls = [await api('POST', '/v1/hotels/search', { body: { ...base, [kind]: ids }, headers, label: 'busca' })];
  const took = Math.round(performance.now() - started);
  const hotels = calls.flatMap((c) => (ok(c) && c.body.results) || []);
  await hotelBasics(hotels.map((x) => x.hotel_id));
  st.result = { kind, integration: st.integration, asked: Array.isArray(ids) ? ids.length : hotels.length, calls, hotels, took, rooms, checkIn: st.checkIn, checkOut: iso(checkOut) };
  drawResults(box);
}

function drawResults(box) {
  const st = hotelState();
  const res = st.result;
  const failed = res.calls.filter((c) => !ok(c));
  const warnings = res.calls.flatMap((c) => (ok(c) && c.body.warnings) || []);
  const rates = res.hotels.reduce((n, x) => n + x.rates.length, 0);
  const listBox = h('div');
  const draw = () => {
    let hs = res.hotels;
    const f = st.filter.trim().toLowerCase();
    if (f) hs = hs.filter((x) => ((S.hotels[x.hotel_id] || S.partnerHotels[res.integration + '/' + x.supplier_hotel_id] || {}).name || x.supplier_hotel_id).toLowerCase().includes(f));
    if (st.sort === 'price') hs = [...hs].sort((a, b) => Number(a.rates[0].net.amount) - Number(b.rates[0].net.amount));
    put(listBox, ...(hs.length ? hs.map((x) => hotelCard(x, res.integration)) : [h('div', { class: 'card empty' }, emptyMark(), 'Nenhum hotel com tarifa.')]));
  };
  const sort = h('select', { onchange: (e) => { st.sort = e.target.value; draw(); } }, opt('supplier', 'ordem do parceiro', st.sort === 'supplier'), opt('price', 'menor preço', st.sort === 'price'));
  const quoteScenario = st.integration === 'mock' ? field('Cenário da cotação', scenarioSelect('quote', st.quoteScenario, (v) => { st.quoteScenario = v; })) : null;

  put(box, 
    h('div', { class: 'card' },
      h('div', { class: 'head' },
        h('div', {}, h('div', { class: 'summary' },
            h('div', { class: 'metric' }, h('strong', {}, res.hotels.length), h('span', {}, 'hotéis com tarifa de ' + res.asked)),
            h('div', { class: 'metric' }, h('strong', {}, rates), h('span', {}, 'tarifas')),
            h('div', { class: 'metric' }, h('strong', {}, res.calls.length), h('span', {}, 'chamada')),
            h('div', { class: 'metric' }, h('strong', {}, res.took + ' ms'), h('span', {}, 'tempo total'))),
          h('div', { class: 'muted small', style: 'margin-top:8px' }, ic('calendar'), ' ', day(res.checkIn) + ' → ' + day(res.checkOut) + ' · ' + res.rooms.length + ' quarto(s)'),
          h('div', { class: 'calls' }, res.calls.map((c, i) => callChip(c, 'chamada ' + (i + 1))))),
        h('div', { class: 'row' }, field('Filtrar por nome', h('input', { value: st.filter, oninput: (e) => { st.filter = e.target.value; draw(); } })), field('Ordem', sort), quoteScenario)),
      failed.map((c) => errorBox(c, 'Uma chamada falhou')),
      warnings.map((w) => {
        const ids = w.hotel_ids || w.giata_hotel_ids || w.supplier_hotel_ids || [];
        return h('div', { class: 'alert amber' }, ic('exclamation-triangle'), ' ', h('strong', { translate: 'no' }, w.code), ' ',
          ids.length ? '(' + ids.length + (ids.length === 1 ? ' hotel: ' : ' hotéis: ') + ids.slice(0, 4).join(', ') + (ids.length > 4 ? ', …' : '') + ')' : '',
          w.error ? ' — ' + w.error.code : '');
      })),
    listBox);
  draw();
}

function hotelCard(x, integration) {
  const ht = S.hotels[x.hotel_id];
  const own = S.partnerHotels[integration + '/' + x.supplier_hotel_id]; // do catálogo do próprio parceiro
  const img = heroOf(ht);
  const addr = ht && ht.address ? [ht.address.line, ht.address.city, ht.address.country].filter(Boolean).join(', ') : own ? [own.address, own.city].filter(Boolean).join(' · ') : '';
  return h('div', { class: 'hotel' },
    h('div', { class: 'hotel-head' },
      img ? h('img', { src: img, alt: '', width: 104, height: 78, loading: 'lazy', onerror: (e) => e.target.replaceWith(placeholder()) }) : placeholder(),
      h('div', { class: 'info' },
        h('h2', {}, ht ? ht.name : own ? own.name : 'Hotel fora do catálogo', ' ', stars(ht ? ht.rating : own && own.stars), !ht && own ? h('span', { class: 'small' }, ' ', badge('catálogo do parceiro', 'blue')) : null),
        addr ? h('div', { class: 'muted small' }, addr) : null,
        h('div', { class: 'ids', translate: 'no' },
          x.hotel_id ? h('span', { title: 'hotel_id do catálogo' }, x.hotel_id) : null,
          x.giata_hotel_id || (ht && ht.giata_id) ? h('span', { title: 'id do GIATA' }, 'GIATA ' + (x.giata_hotel_id || ht.giata_id)) : null,
          x.supplier_hotel_id !== x.hotel_id ? h('span', { title: 'código no parceiro' }, 'parceiro ' + x.supplier_hotel_id) : null)),
      x.hotel_id ? h('button', { class: 'sm', onclick: () => hotelDetails(x.hotel_id) }, ic('images'), 'Ver hotel') : null),
    h('div', { class: 'tablewrap' }, h('table', { class: 'rates' },
      h('thead', {}, h('tr', {}, ['Quarto', 'Regime', 'Total net', 'Cancelamento', 'Taxas', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, x.rates.map((r) => h('tr', {},
        h('td', {}, r.room_name, r.rate_name ? h('div', { class: 'small' }, r.rate_name) : null, r.bed_description ? h('div', { class: 'muted small' }, r.bed_description) : null, promoTags(r), paymentLine(r)),
        h('td', {}, BOARDS[r.board] || r.board, r.board_name ? h('div', { class: 'muted small' }, r.board_name) : null),
        h('td', { class: 'net nowrap' }, money(r.net), r.payable ? h('div', { class: 'muted small' }, 'a pagar ' + money(r.payable)) : null, commissionTag(r)),
        h('td', { class: 'small' }, policyText(r.cancellation_policy)),
        h('td', { class: 'small' }, (r.taxes || []).map((t) => h('div', {}, t.type, ' ', h('span', { class: 'muted' }, t.charge), t.amount ? ' ' + money(t.amount) : ''))),
        h('td', {}, h('button', { class: 'sm primary', onclick: (e) => busy(e.target, () => quote(r.rate_token, x)) }, ic('calculator'), 'Cotar'))))))));
}

/** O símbolo da Kavox nos estados vazios. */
const emptyMark = () => h('img', { class: 'mark', src: 'brand/icon.png', alt: '', width: 40, height: 40 });
const placeholder = () => h('div', { class: 'ph', title: 'Sem foto no catálogo' }, h('img', { src: 'brand/icon.png', alt: '', width: 28, height: 28 }));

/** Tarifa comissionada: o percentual e o valor da comissão, como o parceiro informa, e como ela é acertada. */
function commissionTag(r) {
  const c = r && r.commission;
  if (!c) return null;
  const text = ['comissionada', c.percent ? Number(c.percent).toLocaleString('pt-BR') + '%' : null].filter(Boolean).join(' ') + (c.amount ? ' · ' + money(c.amount) : '');
  const how = c.settlement === 'deducted' ? 'já descontada: o parceiro cobra o net' : c.settlement === 'paid_later' ? 'paga depois: a conta paga ' + money(c.gross) + ' e a comissão volta' : c.settlement === 'informative' ? 'informativa: o net já é o custo final, o parceiro acerta a comissão fora da reserva' : '';
  return h('div', { class: 'small', title: (c.settlement === 'informative' ? 'Base ' : 'Preço cheio ') + money(c.gross) + (how ? ' · ' + how : '') }, badge(text, 'blue'));
}

/** As promoções da tarifa, como etiquetas: só o nome que o parceiro deu. O preço não muda por causa delas. */
function promoTags(r) {
  const list = (r && r.promotions) || [];
  if (!list.length) return null;
  return h('div', { class: 'promos' }, list.map((x) => h('span', { class: 'badge amber', title: x.description || 'Promoção informada pelo parceiro' }, ic('tag'), x.name)));
}

/** O que o parceiro diz sobre pagar a tarifa a ele: meios aceitos e pré-pagamento exigido. Só informa. */
function paymentText(r) {
  const p = r && r.payment;
  if (!p) return null;
  const methods = (p.methods || []).map((m) => PAYMENT_METHODS[m] || m).join(', ');
  const pre = p.prepayment ? 'pré-pagamento de ' + money(p.prepayment.amount) + (p.prepayment.due_at ? ' até ' + when(p.prepayment.due_at) : ' no ato da reserva') : '';
  return [methods, pre].filter(Boolean).join(' · ');
}
function paymentLine(r) {
  const text = paymentText(r);
  if (!text) return null;
  const onlyCard = r.payment.methods && r.payment.methods.length === 1 && r.payment.methods[0] === 'credit_card';
  return h('div', { class: 'muted small', title: (r.payment.prepayment && r.payment.prepayment.description) || 'Pagamento ao parceiro, como ele informa' }, ic('credit-card'), ' ', text, onlyCard ? h('span', {}, ' ', badge('só cartão', 'amber')) : null);
}

/** Como a reserva foi garantida no parceiro: o meio, o cartão (nunca o número) e o cartão virtual, quando houve. */
function bookingPaymentText(b) {
  const p = b && b.payment;
  if (!p || (!p.method && !p.card)) return null;
  const c = p.card;
  return [c ? (CARD_SOURCES[c.source] || c.source) + (c.last4 ? ' •••• ' + c.last4 : '') : (PAYMENT_METHODS[p.method] || p.method)].join('');
}
function bookingPayment(b) {
  const p = b && b.payment;
  if (!p || (!p.method && !p.card)) return null;
  const c = p.card;
  const v = p.vcn;
  return h('div', {},
    h('div', {}, PAYMENT_METHODS[p.method] || p.method || '—', c ? [' · ', h('strong', {}, CARD_SOURCES[c.source] || c.source), c.last4 ? h('span', { class: 'mono' }, ' •••• ' + c.last4) : null, c.brand ? ' ' + c.brand : '', c.holder_name ? ' · ' + c.holder_name : ''] : null),
    v ? h('div', { class: 'small' }, 'Cartão virtual ', badge(v.status), ' emitido por ', h('strong', {}, v.integration), ' com a credencial ', h('span', { class: 'mono' }, v.credential), v.supplier_id ? [' · id no emissor ', h('span', { class: 'mono' }, v.supplier_id)] : null,
      h('div', { class: 'mono muted' }, v.id)) : null);
}

function policyText(p) {
  if (!p) return '—';
  if (!p.refundable) return badge('não reembolsável', 'red');
  return h('span', {}, badge('reembolsável', 'green'), p.free_until ? h('div', { class: 'muted' }, 'grátis até ' + when(p.free_until)) : null);
}

async function hotelDetails(id) {
  const body = openModal(h('p', { class: 'muted' }, 'Carregando…'));
  const [r, labels] = await Promise.all([api('GET', '/v1/content/hotels/' + id, { query: { fields: 'basic,images,texts,facts' }, label: 'ficha do hotel' }), factLabels()]);
  if (!ok(r)) { body.append(errorBox(r)); return; }
  const ht = r.body;
  const a = ht.address || {};
  const loc = ht.location;
  openModal(
    title('building', ht.name, ' ', stars(ht.rating)),
    h('div', { class: 'sub' }, ic('map-marker'), ' ', [a.line, a.postal_code, a.city, a.country].filter(Boolean).join(', ')),
    h('div', { class: 'split', style: 'margin-top:12px' },
      h('dl', { class: 'kv' },
        h('dt', {}, 'hotel_id'), h('dd', { class: 'mono' }, ht.id),
        h('dt', {}, 'GIATA'), h('dd', { class: 'mono' }, ht.giata_id ?? '—'),
        h('dt', {}, 'Rede'), h('dd', {}, ht.chain ? ht.chain.name : '—'),
        h('dt', {}, 'Estado'), h('dd', {}, badge(ht.status), ht.replaced_by ? ' substituído por ' + ht.replaced_by : ''),
        h('dt', {}, 'Telefone'), h('dd', {}, ht.phone || '—'),
        h('dt', {}, 'E-mail'), h('dd', {}, ht.email || '—'),
        h('dt', {}, 'Site'), h('dd', {}, ht.url ? h('a', { href: ht.url, target: '_blank', rel: 'noopener' }, ht.url) : '—'),
        h('dt', {}, 'Mapa'), h('dd', {}, loc ? h('a', { href: 'https://www.google.com/maps?q=' + loc.lat + ',' + loc.lng, target: '_blank', rel: 'noopener' }, loc.lat.toFixed(5) + ', ' + loc.lng.toFixed(5)) : '—'),
        h('dt', {}, 'Atualizado'), h('dd', {}, when(ht.updated_at))),
      h('div', {}, h('h3', {}, 'Comodidades'), h('div', { class: 'facts' }, (ht.facts || []).map((f) => badge(labels[f.code] || f.code))))),
    h('h3', {}, 'Fotos (' + (ht.images || []).length + ')'),
    h('div', { class: 'gallery' }, (ht.images || []).slice(0, 24).map((im) => {
      const s = (im.sizes || []).find((z) => z.width >= 300) || im;
      return h('a', { href: im.url, target: '_blank', rel: 'noopener' }, h('img', { src: s.url, alt: im.category || 'foto do hotel', width: 300, height: 225, loading: 'lazy', onerror: (e) => e.target.parentNode.remove() }));
    })),
    ht.texts && ht.texts.sections ? h('div', {}, ht.texts.sections.map((sec) => h('div', {}, h('h3', {}, sec.title), h('p', {}, sec.text)))) : null,
    jsonBlock(ht));
}

// ---------- cotação e reserva ----------

async function quote(rateToken, hotelResult) {
  const st = hotelState();
  const headers = st.integration === 'mock' ? mockHeader(st.quoteScenario) : {};
  const r = await api('POST', '/v1/hotels/quote', { body: { rate_token: rateToken }, headers, label: 'cotar' });
  const ht = S.hotels[hotelResult.hotel_id];
  if (!ok(r)) { openModal(title('calculator', 'Cotação'), errorBox(r, 'Cotação')); return; }
  const q = r.body;
  const o = q.offer;
  openModal(
    title('calculator', 'Cotação · ', ht ? ht.name : o.supplier_hotel_id),
    h('div', { class: 'sub' }, h('span', {}, ic('link'), ' ', q.integration + ' · ' + q.credential), h('span', {}, ic('clock'), ' offer_token vale até ' + when(o.expires_at)), callChip(r, 'cotação')),
    changesBox(q.changes),
    noticesBox(o.notices),
    offerBox(o),
    h('h2', { class: 'stitle' }, ic('calendar-plus'), 'Reservar'),
    bookingForm(o, q.integration),
    jsonBlock(q));
}

function changesBox(changes, since) {
  since = since || 'desde a busca';
  if (!changes || !changes.length) return h('div', { class: 'alert green' }, 'Sem mudança ' + since + '.');
  return h('div', { class: 'alert amber' }, h('strong', {}, 'Mudou ' + since + ':'), h('ul', {}, changes.map((c) => h('li', {},
    h('strong', {}, c.type), ' ', describe(c.previous), ' → ', describe(c.current),
    c.difference ? ' (' + money(c.difference) + (c.difference_percent ? ', ' + c.difference_percent + '%' : '') + ')' : '', ' ', badge(c.direction, c.direction === 'worse' ? 'red' : c.direction === 'better' ? 'green' : '')))));
}
function describe(v) {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'object' && v.amount !== undefined) return money(v);
  if (Array.isArray(v)) return v.map((n) => n.text || JSON.stringify(n)).join(' / ');
  if (typeof v === 'object') return v.refundable === false ? 'não reembolsável' : v.free_until ? 'grátis até ' + when(v.free_until) : JSON.stringify(v);
  return String(v);
}
function noticesBox(notices) {
  if (!notices || !notices.length) return null;
  return h('div', { class: 'alert blue' }, h('strong', {}, 'Avisos do parceiro (mostre ao cliente):'), h('ul', {}, notices.map((n) => h('li', {}, n.text))));
}
function offerBox(o) {
  const r = o.rate;
  const p = r.cancellation_policy || {};
  return h('div', { class: 'split' },
    h('dl', { class: 'kv' },
      h('dt', {}, 'Estadia'), h('dd', {}, day(o.check_in) + ' → ' + day(o.check_out)),
      h('dt', {}, 'Quartos'), h('dd', {}, o.rooms.map((x, i) => 'Q' + (i + 1) + ': ' + x.adults + ' adulto(s)' + (x.children_ages && x.children_ages.length ? ', crianças ' + x.children_ages.join(', ') : '')).join(' · ')),
      h('dt', {}, 'Quarto'), h('dd', {}, r.room_name, r.bed_description ? ' · ' + r.bed_description : ''),
      r.rate_name ? [h('dt', {}, 'Tarifa'), h('dd', {}, r.rate_name)] : null,
      h('dt', {}, 'Regime'), h('dd', {}, BOARDS[r.board] || r.board, r.board_name ? ' · ' + r.board_name : ''),
      h('dt', {}, 'Total net'), h('dd', {}, h('strong', {}, money(r.net))),
      r.promotions && r.promotions.length ? [h('dt', {}, 'Promoções'), h('dd', {}, promoTags(r))] : null,
      r.payable ? [h('dt', {}, 'A pagar'), h('dd', {}, money(r.payable))] : null,
      r.payment ? [h('dt', {}, 'Pagamento ao parceiro'), h('dd', {}, paymentText(r), r.payment.prepayment && r.payment.prepayment.description ? h('div', { class: 'muted small' }, r.payment.prepayment.description) : null)] : null,
      r.commission ? [h('dt', {}, 'Comissão'), h('dd', {}, money(r.commission.amount), r.commission.percent ? ' (' + Number(r.commission.percent).toLocaleString('pt-BR') + '%)' : '', ' sobre ' + money(r.commission.gross), ' · ', r.commission.settlement === 'paid_later' ? 'paga depois' : r.commission.settlement === 'deducted' ? 'já descontada' : r.commission.settlement === 'informative' ? 'informativa (não altera o net)' : (r.commission.settlement || ''))] : null,
      r.sale_price ? [h('dt', {}, 'Preço de venda'), h('dd', {}, money(r.sale_price.amount || r.sale_price), r.sale_price.binding ? ' (obrigatório)' : '')] : null,
      o.rate.available !== undefined ? [h('dt', {}, 'Disponíveis'), h('dd', {}, o.rate.available)] : null),
    h('div', {},
      h('h3', {}, 'Cancelamento'), policyText(p),
      p.penalties && p.penalties.length ? h('table', {}, h('tbody', {}, p.penalties.map((x) => h('tr', {}, h('td', {}, 'a partir de ' + when(x.from)), h('td', { class: 'right' }, money(x.amount)))))) : null,
      h('h3', {}, 'Taxas'),
      (r.taxes || []).length ? h('table', {}, h('tbody', {}, r.taxes.map((t) => h('tr', {}, h('td', {}, t.type), h('td', {}, badge(t.charge, t.charge === 'local' ? 'amber' : '')), h('td', { class: 'muted' }, t.basis || ''), h('td', { class: 'right' }, money(t.amount)))))) : h('span', { class: 'muted' }, 'nenhuma informada')));
}

const SAMPLE = [['Ana', 'Souza'], ['Rui', 'Souza'], ['Bia', 'Lima'], ['Caio', 'Lima'], ['Duda', 'Reis'], ['Edu', 'Reis']];
function bookingForm(offer, integration) {
  const roomsInputs = offer.rooms.map((room, ri) => {
    const guests = [];
    for (let i = 0; i < room.adults; i++) guests.push({ age: null, label: i === 0 ? 'Titular (adulto)' : 'Adulto ' + (i + 1) });
    for (const age of room.children_ages || []) guests.push({ age, label: 'Criança, ' + age + ' anos' });
    return guests.map((g, gi) => {
      const [fn, ln] = SAMPLE[(ri * 2 + gi) % SAMPLE.length];
      return { ...g, first: h('input', { value: fn, required: true, size: 12 }), last: h('input', { value: ln, required: true, size: 12 }) };
    });
  });
  const reference = h('input', { value: 'SDK-' + Date.now().toString(36).toUpperCase(), maxlength: 64, name: 'reference', spellcheck: 'false', autocomplete: 'off' });
  const remarks = h('input', { maxlength: 250, placeholder: 'ex.: andar alto…', name: 'remarks', autocomplete: 'off' });
  const maxIncrease = h('input', { placeholder: '2.00…', size: 6, inputmode: 'decimal', name: 'max_increase', autocomplete: 'off' });
  const key = h('input', { value: uuid(), class: 'mono', size: 38, name: 'idempotency_key', spellcheck: 'false', autocomplete: 'off', translate: 'no' });
  let scenario = 'ok';
  const out = h('div');
  // o cartão de uma tarifa que só aceita cartão: vai ao parceiro nesta chamada e não é guardado em lugar nenhum
  const methods = (offer.rate && offer.rate.payment && offer.rate.payment.methods) || [];
  const onlyCard = methods.length === 1 && methods[0] === 'credit_card';
  const card = {
    holder_name: h('input', { name: 'card_holder', autocomplete: 'off', placeholder: 'MARIA SOUZA…', size: 22 }),
    number: h('input', { name: 'card_number', autocomplete: 'off', inputmode: 'numeric', class: 'mono', placeholder: '5555 5555 5555 4444…', size: 22, spellcheck: 'false' }),
    expiry_month: h('input', { name: 'card_month', autocomplete: 'off', inputmode: 'numeric', placeholder: 'MM…', size: 3 }),
    expiry_year: h('input', { name: 'card_year', autocomplete: 'off', inputmode: 'numeric', placeholder: 'AAAA…', size: 5 }),
    cvv: h('input', { name: 'card_cvv', autocomplete: 'off', inputmode: 'numeric', type: 'password', placeholder: '•••', size: 4 }),
  };
  const cardBox = h('details', { class: 'json', open: onlyCard },
    h('summary', {}, 'Cartão (payment.card): só para tarifa que só aceita cartão'),
    h('p', { class: 'small muted' }, 'Deixe vazio para usar o que a credencial do parceiro de hotel faz: emitir um cartão virtual (VCN) ou usar o cartão fixo. Sem nenhum dos dois, a reserva responde 422 CARD_REQUIRED. Em tarifa que aceita outro meio, mandar cartão é recusado.'),
    h('div', { class: 'row' }, field('Nome no cartão', card.holder_name), field('Número', card.number), field('Mês', card.expiry_month), field('Ano', card.expiry_year), field('CVV', card.cvv)));
  const submit = async (e) => {
    e.preventDefault();
    const body = {
      offer_token: offer.offer_token,
      reference: reference.value || undefined,
      remarks: remarks.value || undefined,
      rooms: roomsInputs.map((gs) => ({ guests: gs.map((g) => (g.age === null ? { first_name: g.first.value, last_name: g.last.value } : { first_name: g.first.value, last_name: g.last.value, age: g.age })) })),
    };
    if (maxIncrease.value) body.accept_changes = { max_price_increase_percent: maxIncrease.value };
    if (card.number.value.trim()) {
      body.payment = { card: { holder_name: card.holder_name.value.trim(), number: card.number.value.trim(), expiry_month: Number(card.expiry_month.value) || 0, expiry_year: Number(card.expiry_year.value) || 0, cvv: card.cvv.value.trim() } };
    }
    await busy(e.submitter, async () => {
      const r = await api('POST', '/v1/hotels/bookings', { body, headers: { 'Idempotency-Key': key.value, ...(integration === 'mock' ? mockHeader(scenario) : {}) }, label: 'reservar' });
      if (!ok(r)) { put(out, errorBox(r, 'Reserva'), r.status === 0 || (r.body && r.body.error && r.body.error.retryable) ? h('p', { class: 'small' }, 'Repita com a mesma Idempotency-Key: o Connect nunca reserva duas vezes.') : null); return; }
      bookingModal(r.body, r.status === 200 ? 'Repetição com a mesma Idempotency-Key: esta é a reserva que já existia.' : null);
    });
  };
  return h('form', { class: 'stack', onsubmit: submit },
    roomsInputs.map((gs, ri) => h('div', { class: 'room', style: 'flex-direction:column;align-items:stretch' }, h('strong', { class: 'small' }, 'Quarto ' + (ri + 1)),
      gs.map((g) => h('div', { class: 'row' }, h('span', { class: 'small muted', style: 'width:120px' }, g.label), field('Nome', g.first), field('Sobrenome', g.last))))),
    h('div', { class: 'row' }, field('Referência', reference), field('Observação', remarks), field('Aceita aumento até (%)', maxIncrease),
      integration === 'mock' ? field('Cenário', scenarioSelect('book', scenario, (v) => { scenario = v; })) : null),
    h('div', { class: 'row' }, field('Idempotency-Key', key), h('button', { type: 'button', class: 'sm', onclick: () => { key.value = uuid(); } }, 'Nova chave')),
    cardBox,
    integration !== 'mock' ? h('div', { class: 'alert red' }, 'Integração real (' + integration + '): esta reserva vai de verdade ao parceiro.') : null,
    out, h('div', { class: 'row' }, h('button', { class: 'primary' }, ic('check'), 'Reservar')));
}

// ---------- reserva ----------

function bookingModal(res, note) {
  const b = res.booking || res;
  const body = openModal();
  drawBooking(body, b, res, note);
}

function drawBooking(body, b, raw, note) {
  const ht = S.hotels[b.hotel_id];
  const c = b.cancellation || {};
  const actions = h('div', { class: 'stack' });
  const out = h('div');
  let retrieveScenario = 'ok';
  let cancelScenario = 'ok';
  const retrieve = async (e) => busy(e.target, async () => {
    const r = await api('GET', '/v1/hotels/bookings/' + b.id, { query: { refresh: 'true' }, headers: b.integration === 'mock' ? mockHeader(retrieveScenario) : {}, label: 'consultar no parceiro' });
    if (ok(r)) drawBooking(body, r.body.booking || r.body, r.body, 'Consultada agora no parceiro (?refresh=true): estado e número de confirmação atualizados.');
    else put(out, errorBox(r, 'Consulta'));
  });
  const penalty = h('input', { placeholder: 'ex.: 0.00…', size: 8, inputmode: 'decimal', name: 'max_penalty', autocomplete: 'off' });
  const key = h('input', { value: uuid(), class: 'mono', size: 38, name: 'idempotency_key', spellcheck: 'false', autocomplete: 'off', translate: 'no' });
  const cancel = async (e) => {
    if (!confirm('Cancelar a reserva ' + (b.locator || b.id) + ' no parceiro?')) return;
    await busy(e.target, async () => {
      const bodyReq = penalty.value ? { max_penalty: { amount: penalty.value, currency: (b.rate && b.rate.net.currency) || 'BRL' } } : {};
      const r = await api('POST', '/v1/hotels/bookings/' + b.id + '/cancel', { body: bodyReq, headers: { 'Idempotency-Key': key.value, ...(b.integration === 'mock' ? mockHeader(cancelScenario) : {}) }, label: 'cancelar reserva' });
      if (ok(r)) drawBooking(body, r.body.booking || r.body, r.body, 'Cancelamento respondido.');
      else put(out, errorBox(r, 'Cancelamento'), h('p', { class: 'small' }, 'Falha do parceiro deixa a reserva como estava. Repita com a mesma Idempotency-Key.'));
    });
  };
  const warnings = (raw && raw.warnings) || [];
  if (b.status === 'confirmed') actions.append(modifySection(body, b));
  if (b.status !== 'cancelled' && b.status !== 'failed') {
    actions.append(h('div', { class: 'row' },
      b.integration === 'mock' ? field('Cenário da consulta', scenarioSelect('retrieve', 'ok', (v) => { retrieveScenario = v; })) : null,
      h('button', { onclick: retrieve }, ic('refresh'), 'Consultar no parceiro')),
    h('div', { class: 'row' },
      field('Multa máxima aceita (vazio = a da política)', penalty), field('Idempotency-Key', key),
      b.integration === 'mock' ? field('Cenário do cancelamento', scenarioSelect('cancel', 'ok', (v) => { cancelScenario = v; })) : null,
      h('button', { class: 'danger', onclick: cancel }, ic('times-circle'), 'Cancelar reserva')));
  } else {
    actions.append(h('div', { class: 'row' }, h('button', { onclick: retrieve }, 'Consultar de novo')));
  }
  frame(body,
    title('calendar', 'Reserva ', badge(b.status), ' ', b.locator ? h('span', { class: 'mono', translate: 'no' }, b.locator) : ''),
    h('div', { class: 'sub' }, h('span', {}, ic('building'), ' ', ht ? ht.name : (b.supplier_hotel_id || '')), h('span', {}, ic('calendar'), ' ', day(b.check_in) + ' → ' + day(b.check_out)), h('span', {}, ic('link'), ' ', b.integration)),
    note ? h('div', { class: 'alert blue' }, note) : '',
    warnings.map((w) => h('div', { class: 'alert amber' }, h('strong', {}, w.code), w.offer ? ' — preço agora ' + money(w.offer.rate && w.offer.rate.net) : '')),
    (b.warnings || []).map((w) => h('div', { class: 'alert amber' }, h('strong', {}, w), BOOKING_WARNINGS[w] ? ' — ' + BOOKING_WARNINGS[w] : '')),
    b.changes && b.changes.length ? changesBox(b.changes, 'em relação ao que foi cotado') : null,
    h('div', { class: 'split' },
      h('dl', { class: 'kv' },
        h('dt', {}, 'id'), h('dd', { class: 'mono' }, b.id),
        h('dt', {}, 'Hotel'), h('dd', {}, ht ? ht.name : '', h('div', { class: 'mono small muted' }, b.hotel_id || b.supplier_hotel_id)),
        h('dt', {}, 'Integração'), h('dd', {}, b.integration + ' · ', h('span', { class: 'mono' }, b.credential)),
        h('dt', {}, 'Referência'), h('dd', {}, b.reference || '—'),
        h('dt', {}, 'Localizador'), h('dd', { class: 'mono' }, b.locator || '—'),
        h('dt', {}, 'Confirmação'), h('dd', { class: 'mono' }, b.confirmation_number || '—'),
        h('dt', {}, 'Estadia'), h('dd', {}, day(b.check_in) + ' → ' + day(b.check_out)),
        h('dt', {}, 'Quartos'), h('dd', {}, (b.rooms || []).map((x) => x.adults + ' ad.' + (x.children_ages && x.children_ages.length ? ' + ' + x.children_ages.length + ' cr.' : '')).join(' · ')),
        b.rate ? [h('dt', {}, 'Tarifa'), h('dd', {}, b.rate.room_name, b.rate.rate_name ? ' · ' + b.rate.rate_name : '', ' · ', BOARDS[b.rate.board] || b.rate.board, ' · ', h('strong', {}, money(b.rate.net)))] : null,
        b.rate && b.rate.commission ? [h('dt', {}, 'Comissão'), h('dd', {}, commissionTag(b.rate))] : null,
        b.rate && b.rate.payment ? [h('dt', {}, 'Meios que a tarifa aceita'), h('dd', {}, paymentText(b.rate))] : null,
        bookingPayment(b) ? [h('dt', {}, 'Pagamento'), h('dd', {}, bookingPayment(b))] : null,
        h('dt', {}, 'Criada'), h('dd', {}, when(b.created_at)),
        b.modified_at ? [h('dt', {}, 'Alterada'), h('dd', {}, when(b.modified_at))] : null),
      h('div', {},
        h('h3', {}, 'Cancelamento'),
        c.cancelled_at ? h('dl', { class: 'kv' },
          h('dt', {}, 'Cancelada'), h('dd', {}, when(c.cancelled_at) + ' por ' + (c.cancelled_by || '—')),
          h('dt', {}, 'Multa'), h('dd', {}, money(c.penalty)), h('dt', {}, 'Reembolso'), h('dd', {}, money(c.refund)),
          h('dt', {}, 'Id no parceiro'), h('dd', { class: 'mono' }, c.supplier_cancellation_id || '—'))
          : h('dl', { class: 'kv' },
            h('dt', {}, 'Multa agora'), h('dd', {}, money(c.current_penalty)),
            h('dt', {}, 'Muda em'), h('dd', {}, c.next_change_at ? when(c.next_change_at) + ' para ' + money(c.next_penalty) : 'não muda mais'),
            h('dt', {}, 'Fonte'), h('dd', {}, c.source || '—')),
        b.rate ? policyText(b.rate.cancellation_policy) : null)),
    h('h2', { class: 'stitle' }, ic('bolt'), 'Ações'), actions, out,
    jsonBlock(raw || b));
  titleModal(body);
}

/**
 * A alteração de uma reserva confirmada, nos dois passos da API: cotar a alteração (não muda nada, devolve o
 * modify_token) e alterar. A estadia enviada é a inteira desejada; o número de quartos não muda.
 */
function modifySection(body, b) {
  const box = h('div', { class: 'stack' });
  const out = h('div', { class: 'stack' });
  const checkIn = h('input', { type: 'date', value: b.check_in, name: 'check_in' });
  const checkOut = h('input', { type: 'date', value: b.check_out, name: 'check_out' });
  const rooms = (b.rooms || []).map((room) => ({
    adults: h('input', { type: 'number', min: 1, max: 9, value: room.adults, style: 'width:70px' }),
    ages: h('input', { value: (room.children_ages || []).join(', '), placeholder: 'ex.: 5, 9…', size: 10, autocomplete: 'off' }),
  }));
  let quoteScenario = 'ok';
  const stay = () => ({
    check_in: checkIn.value, check_out: checkOut.value,
    rooms: rooms.map((x) => {
      const ages = x.ages.value.split(/[,; ]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
      return ages.length ? { adults: Number(x.adults.value), children_ages: ages } : { adults: Number(x.adults.value) };
    }),
  });
  const quoteChange = async (e) => busy(e.target, async () => {
    const r = await api('POST', '/v1/hotels/bookings/' + b.id + '/modify/quote', { body: stay(), headers: b.integration === 'mock' ? mockHeader(quoteScenario) : {}, label: 'cotar alteração' });
    if (!ok(r)) { put(out, errorBox(r, 'Cotação da alteração'), unsupported(r) ? h('p', { class: 'small' }, 'Este parceiro não altera reserva: a operação não está disponível para esta integração.') : null); return; }
    put(out, modificationBox(body, b, r));
  });
  const section = h('div', { class: 'stack' },
    h('div', { class: 'row' },
      field('Check-in novo', checkIn), field('Check-out novo', checkOut),
      rooms.map((x, i) => [field('Q' + (i + 1) + ' adultos', x.adults), field('Q' + (i + 1) + ' idades das crianças', x.ages)]),
      b.integration === 'mock' ? field('Cenário da cotação', scenarioSelect('modifyQuote', 'ok', (v) => { quoteScenario = v; })) : null,
      h('button', { onclick: quoteChange }, ic('pencil'), 'Cotar alteração')),
    h('p', { class: 'muted small' }, 'POST /v1/hotels/bookings/{id}/modify/quote: a estadia inteira desejada (para trocar só os nomes, cote a mesma estadia). Não muda nada; devolve o modify_token.'),
    out);
  put(box, section);
  // só onde o parceiro altera: nos demais a API responde 422 UNSUPPORTED_OPERATION
  loadV1Integrations().then((list) => {
    const it = (list || []).find((i) => i.integration === b.integration);
    const can = it && it.capabilities && it.capabilities.hotel && it.capabilities.hotel.modify;
    if (it && !can) put(box, h('div', { class: 'muted small' }, ic('ban'), ' Alteração não está disponível para a integração ' + b.integration + ' (capabilities.hotel.modify = false).'));
  }).catch(() => {});
  return box;
}

const unsupported = (r) => r.body && r.body.error && r.body.error.code === 'UNSUPPORTED_OPERATION';

/** A alteração cotada: o que muda, a tarifa nova e o formulário dos hóspedes que faz a alteração. */
function modificationBox(body, b, quoted) {
  const m = quoted.body.modification;
  const guestsInputs = m.rooms.map((room, ri) => {
    const guests = [];
    for (let i = 0; i < room.adults; i++) guests.push({ age: null, label: i === 0 ? 'Titular (adulto)' : 'Adulto ' + (i + 1) });
    for (const age of room.children_ages || []) guests.push({ age, label: 'Criança, ' + age + ' anos' });
    return guests.map((g, gi) => {
      const [fn, ln] = SAMPLE[(ri * 2 + gi) % SAMPLE.length];
      return { ...g, first: h('input', { value: fn, required: true, size: 12 }), last: h('input', { value: ln, required: true, size: 12 }) };
    });
  });
  const maxIncrease = h('input', { placeholder: '2.00…', size: 6, inputmode: 'decimal', name: 'max_increase', autocomplete: 'off' });
  const key = h('input', { value: uuid(), class: 'mono', size: 38, name: 'idempotency_key', spellcheck: 'false', autocomplete: 'off', translate: 'no' });
  let scenario = 'ok';
  let token = m.modify_token;
  const out = h('div');
  const submit = async (e) => {
    e.preventDefault();
    if (b.integration !== 'mock' && !confirm('Alterar a reserva ' + (b.confirmation_number || b.locator || b.id) + ' no parceiro para ' + day(m.check_in) + ' → ' + day(m.check_out) + ', por ' + money(m.rate.net) + '?')) return;
    const req = {
      modify_token: token,
      rooms: guestsInputs.map((gs) => ({ guests: gs.map((g) => (g.age === null ? { first_name: g.first.value, last_name: g.last.value } : { first_name: g.first.value, last_name: g.last.value, age: g.age })) })),
    };
    if (maxIncrease.value) req.accept_changes = { max_price_increase_percent: maxIncrease.value };
    await busy(e.submitter, async () => {
      const r = await api('POST', '/v1/hotels/bookings/' + b.id + '/modify', { body: req, headers: { 'Idempotency-Key': key.value, ...(b.integration === 'mock' ? mockHeader(scenario) : {}) }, label: 'alterar reserva' });
      if (ok(r)) { drawBooking(body, r.body.booking || r.body, r.body, 'Reserva alterada no parceiro: a estadia e a tarifa abaixo já são as novas.'); return; }
      const err = (r.body && r.body.error) || {};
      if (err.modification) {
        // a alteração mudou desde a cotação: o erro traz o token da que vale agora
        token = err.modification.modify_token;
        put(out, errorBox(r, 'Alteração'), changesBox(err.modification.changes, 'desde a cotação da alteração'), h('p', { class: 'small' }, 'Nada foi alterado. O botão agora envia o modify_token novo: confirme e altere de novo.'));
        return;
      }
      put(out, errorBox(r, 'Alteração'), h('p', { class: 'small' }, r.status === 0 || err.retryable ? 'Sem resposta clara do parceiro: a reserva fica como estava, com o aviso modification_unconfirmed. Repita com a mesma Idempotency-Key.' : 'Recusada: a reserva fica como estava.'));
    });
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'sub' }, h('span', {}, ic('clock'), ' modify_token vale até ' + when(m.expires_at)), callChip(quoted, 'cotação da alteração')),
    changesBox(quoted.body.changes, 'em relação à reserva de hoje'),
    noticesBox(m.notices),
    offerBox(m),
    h('form', { class: 'stack', onsubmit: submit },
      guestsInputs.map((gs, ri) => h('div', { class: 'room', style: 'flex-direction:column;align-items:stretch' }, h('strong', { class: 'small' }, 'Quarto ' + (ri + 1)),
        gs.map((g) => h('div', { class: 'row' }, h('span', { class: 'small muted', style: 'width:120px' }, g.label), field('Nome', g.first), field('Sobrenome', g.last))))),
      h('div', { class: 'row' }, field('Aceita aumento até (%)', maxIncrease), field('Idempotency-Key', key),
        h('button', { type: 'button', class: 'sm', onclick: () => { key.value = uuid(); } }, 'Nova chave'),
        b.integration === 'mock' ? field('Cenário da alteração', scenarioSelect('modify', scenario, (v) => { scenario = v; })) : null),
      b.integration !== 'mock' ? h('div', { class: 'alert red' }, 'Integração real (' + b.integration + '): esta alteração vai de verdade ao parceiro.') : null,
      out, h('div', { class: 'row' }, h('button', { class: 'primary' }, ic('check'), 'Alterar reserva'))));
}

async function viewBookings() {
  const st = (S.bookings ||= { environment: (S.me && S.me.environment) || 'sandbox', status: '', reference: '', payment: '', items: [], cursor: null, loaded: false });
  const tableBox = h('div');
  const load = async (more) => {
    const r = await api('GET', '/v1/management/bookings', { query: { environment: st.environment, status: st.status, reference: st.reference, card_source: CARD_SOURCES[st.payment] ? st.payment : undefined, payment_method: PAYMENT_METHODS[st.payment] ? st.payment : undefined, cursor: more ? st.cursor : undefined, limit: 50 }, label: 'reservas' });
    if (!ok(r)) { put(tableBox, errorBox(r)); return; }
    st.items = more ? st.items.concat(r.body.data) : r.body.data;
    st.cursor = r.body.next_cursor || null;
    st.loaded = true;
    await hotelBasics(st.items.map((b) => b.hotel_id));
    draw();
  };
  const draw = () => put(tableBox, st.items.length ? h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Criada', 'Estado', 'Referência', 'Hotel', 'Estadia', 'Parceiro', 'Pagamento', 'Total'].map((t) => h('th', {}, t)))),
    h('tbody', {}, st.items.map((b) => h('tr', { class: 'click', tabindex: 0, onclick: () => bookingModal({ booking: b }), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bookingModal({ booking: b }); } } },
      h('td', { class: 'nowrap' }, when(b.created_at)), h('td', {}, badge(b.status)), h('td', {}, b.reference || '—', h('div', { class: 'mono small muted' }, b.locator || '')),
      h('td', {}, (S.hotels[b.hotel_id] || {}).name || h('span', { class: 'mono small' }, b.supplier_hotel_id)),
      h('td', { class: 'nowrap' }, day(b.check_in) + ' → ' + day(b.check_out)), h('td', {}, b.integration), h('td', { class: 'nowrap' }, bookingPaymentText(b) || '—', (b.warnings || []).some((w) => w === 'vcn_update_failed' || w === 'vcn_cancel_failed') ? [' ', badge('VCN com problema', 'amber')] : null), h('td', { class: 'nowrap' }, b.rate ? money(b.rate.net) : '—'))))),
  st.cursor ? h('button', { onclick: (e) => busy(e.target, () => load(true)) }, 'Carregar mais') : null) : h('div', { class: 'empty' }, emptyMark(), 'Nenhuma reserva com esses filtros.'));
  const byId = h('input', { placeholder: '01a1cd35-…', class: 'mono', size: 38, name: 'booking_id', spellcheck: 'false', autocomplete: 'off', required: true });
  const open = async (e) => {
    e.preventDefault();
    const r = await api('GET', '/v1/hotels/bookings/' + byId.value.trim(), { label: 'consultar reserva' });
    if (ok(r)) bookingModal(r.body); else openModal(errorBox(r));
  };
  const filters = h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); load(); } },
    field('Ambiente', h('select', { onchange: (e) => { st.environment = e.target.value; } }, opt('sandbox', 'sandbox', st.environment === 'sandbox'), opt('production', 'production', st.environment === 'production'))),
    field('Estado', h('select', { onchange: (e) => { st.status = e.target.value; } }, opt('', 'todos'), ['pending', 'confirmed', 'cancelled', 'failed', 'needs_review'].map((s) => opt(s, s, st.status === s)))),
    field('Pagamento', h('select', { onchange: (e) => { st.payment = e.target.value; } }, opt('', 'qualquer'), Object.entries({ ...CARD_SOURCES, ...PAYMENT_METHODS }).map(([k, label]) => opt(k, label, st.payment === k)))),
    field('Referência', h('input', { value: st.reference, oninput: (e) => { st.reference = e.target.value; } })),
    h('button', { class: 'primary' }, ic('filter'), 'Filtrar'));
  // reserva lida direto no parceiro, pelo id do parceiro: a que não passou pelo Connect
  const ints = (await loadV1Integrations()).filter((i) => i.capabilities && i.capabilities.hotel && i.capabilities.hotel.supplier_bookings);
  const atPartner = h('select', { name: 'integration' }, ints.length ? ints.map((i) => opt(i.integration, i.integration)) : opt('', 'nenhum parceiro lê pelo id dele'));
  const by = h('select', { name: 'by' }, opt('locator', 'id no parceiro'), opt('reference', 'referência / localizador da agência'));
  const handle = h('input', { class: 'mono', size: 40, name: 'handle', spellcheck: 'false', autocomplete: 'off', required: true, placeholder: '7ff42a70-…' });
  const readAtPartner = (e) => {
    e.preventDefault();
    return busy(e.submitter, async () => {
      const r = await api('GET', '/v1/hotels/supplier-bookings', { query: { integration: atPartner.value, [by.value]: handle.value.trim() }, label: 'reserva no parceiro' });
      if (ok(r)) supplierBookingModal(r); else openModal(errorBox(r, 'Reserva no parceiro'));
    });
  };
  const partnerCard = h('div', { class: 'card' }, h('div', { class: 'head' },
    h('div', {}, h('h2', {}, ic('external-link'), ' Reserva no parceiro, pelo id do parceiro'), h('p', { class: 'muted' }, 'GET /v1/hotels/supplier-bookings: lê direto no parceiro uma reserva que não passou pelo Connect (antiga, feita no site dele). Só leitura: nada é guardado.')),
    h('form', { class: 'row', onsubmit: readAtPartner }, field('Parceiro', atPartner), field('Buscar por', by), field('Valor', handle), h('button', { class: 'primary', disabled: !ints.length }, ic('search'), 'Consultar'))));

  if (!st.loaded) load(); else draw();
  return h('div', {},
    partnerCard,
    h('div', { class: 'card' }, h('div', { class: 'head' }, h('div', {}, title('calendar', 'Reservas'), h('p', { class: 'muted' }, 'A lista vem da API de gestão (/v1/management/bookings); consultar e cancelar usam a de produto (/v1/hotels/bookings).')),
      h('form', { class: 'row', onsubmit: open }, field('Abrir por id', byId), h('button', {}, 'Abrir'))), filters),
    h('div', { class: 'card' }, tableBox));
}

// ---------- cartões virtuais ----------

/**
 * Cartões virtuais (produto vcn). A lista e o cancelamento "pela conta" vêm da API de gestão
 * (/v1/management/vcns, escopos de reservas); emitir, consultar no emissor, atualizar e cancelar "pela chave"
 * usam a de produto (/v1/vcns), que pede permissão no produto vcn. O número do cartão só existe na resposta
 * da emissão: o Connect não o guarda.
 */
async function viewCards() {
  const st = (S.cards ||= { environment: (S.me && S.me.environment) || 'sandbox', status: '', loose: false, items: [], cursor: null, loaded: false });
  const tableBox = h('div');
  const load = async (more) => {
    const r = await api('GET', '/v1/management/vcns', { query: { environment: st.environment, status: st.status, loose: st.loose ? 'true' : undefined, cursor: more ? st.cursor : undefined, limit: 50 }, label: 'cartões virtuais' });
    if (!ok(r)) { put(tableBox, errorBox(r)); return; }
    st.items = more ? st.items.concat(r.body.data) : r.body.data;
    st.cursor = r.body.next_cursor || null;
    st.loaded = true;
    draw();
  };
  const loose = (c) => (c.status === 'waiting' || c.status === 'active') && (c.booking_status === 'failed' || c.booking_status === 'cancelled');
  const draw = () => put(tableBox, st.items.length ? h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Emitido', 'Estado', 'Cartão', 'Limite', 'Válido até', 'Emissor', 'Reserva'].map((t) => h('th', {}, t)))),
    h('tbody', {}, st.items.map((c) => h('tr', { class: 'click', tabindex: 0, onclick: () => cardModal(c, load), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cardModal(c, load); } } },
      h('td', { class: 'nowrap' }, when(c.created_at)), h('td', {}, badge(c.status)),
      h('td', {}, h('span', { class: 'mono' }, c.last4 ? '•••• ' + c.last4 : '—'), h('div', { class: 'small muted' }, c.holder_name || '')),
      h('td', { class: 'nowrap' }, money(c.limit)), h('td', { class: 'nowrap' }, day(c.valid_until)),
      h('td', {}, c.integration, h('div', { class: 'mono small muted' }, c.credential)),
      h('td', {}, c.booking_id ? [badge(c.booking_status || '—'), loose(c) ? [' ', badge('sobrou', 'amber')] : null] : h('span', { class: 'muted' }, 'avulso')))))),
  st.cursor ? h('button', { onclick: (e) => busy(e.target, () => load(true)) }, 'Carregar mais') : null) : h('div', { class: 'empty' }, emptyMark(), 'Nenhum cartão virtual com esses filtros.'));

  const filters = h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); load(); } },
    field('Ambiente', h('select', { onchange: (e) => { st.environment = e.target.value; } }, opt('sandbox', 'sandbox', st.environment === 'sandbox'), opt('production', 'production', st.environment === 'production'))),
    field('Estado', h('select', { onchange: (e) => { st.status = e.target.value; } }, opt('', 'todos'), ['issuing', 'waiting', 'active', 'cancelled', 'failed'].map((x) => opt(x, x, st.status === x)))),
    h('label', { class: 'f' }, 'Só os que sobraram', h('input', { type: 'checkbox', checked: st.loose, onchange: (e) => { st.loose = e.target.checked; }, title: 'Cartão ainda utilizável cuja reserva falhou ou foi cancelada' })),
    h('button', { class: 'primary' }, ic('filter'), 'Filtrar'));

  const byId = h('input', { placeholder: '01a1cd35-…', class: 'mono', size: 38, name: 'vcn_id', spellcheck: 'false', autocomplete: 'off', required: true });
  const open = async (e) => {
    e.preventDefault();
    const r = await api('GET', '/v1/vcns/' + byId.value.trim(), { label: 'consultar cartão' });
    if (ok(r)) cardModal(r.body.vcn, load); else openModal(errorBox(r, 'Cartão'));
  };

  if (!st.loaded) load(); else draw();
  return h('div', {},
    h('div', { class: 'card' }, h('div', { class: 'head' },
      h('div', {}, title('credit-card', 'Cartões virtuais'), h('p', { class: 'muted' }, 'A lista vem da API de gestão (/v1/management/vcns): os cartões que uma chave emitiu e os que o Connect emitiu para uma reserva. O número do cartão nunca aparece aqui: ele não é guardado.')),
      h('div', { class: 'row' }, h('form', { class: 'row', onsubmit: open }, field('Abrir por id (/v1/vcns)', byId), h('button', {}, 'Abrir')), h('button', { class: 'primary', onclick: () => cardIssueForm(load) }, ic('plus'), 'Emitir cartão'))), filters),
    h('div', { class: 'card' }, tableBox));
}

/** Um cartão: o que o Connect guarda dele e o que dá para fazer. */
function cardModal(c, reload) {
  const body = openModal();
  const out = h('div');
  const u = c.use || {};
  const usable = c.status === 'waiting' || c.status === 'active';
  const redraw = (next, note) => { closeModal(); cardModal({ booking_status: c.booking_status, ...next }, reload); if (note) toast(note); reload(); };
  const refresh = (e) => busy(e.target, async () => {
    const r = await api('GET', '/v1/vcns/' + c.id, { query: { refresh: 'true' }, label: 'consultar no emissor' });
    if (ok(r)) redraw(r.body.vcn, 'Lido agora no emissor'); else put(out, errorBox(r, 'Consulta'));
  });
  const limit = h('input', { value: (c.limit && c.limit.amount) || '', size: 10, inputmode: 'decimal', name: 'limit', autocomplete: 'off' });
  const until = h('input', { type: 'date', value: c.valid_until || '', name: 'valid_until' });
  const update = (e) => busy(e.target, async () => {
    // o emissor pede o cartão inteiro: o que não muda é repetido como está
    const card = { reference: c.reference, holder_name: c.holder_name, limit: { amount: limit.value, currency: c.limit.currency }, active_from: c.active_from, valid_until: until.value, use: u };
    const r = await api('PATCH', '/v1/vcns/' + c.id, { body: card, label: 'atualizar cartão' });
    if (ok(r)) redraw(r.body.vcn, 'Cartão atualizado'); else put(out, errorBox(r, 'Atualização'));
  });
  const key = h('input', { value: uuid(), class: 'mono', size: 38, name: 'idempotency_key', spellcheck: 'false', autocomplete: 'off', translate: 'no' });
  const cancelByKey = (e) => {
    if (!confirm('Cancelar o cartão ' + (c.last4 ? '•••• ' + c.last4 : c.id) + ' no emissor? Não dá para desfazer.')) return;
    busy(e.target, async () => {
      const r = await api('POST', '/v1/vcns/' + c.id + '/cancel', { body: {}, headers: { 'Idempotency-Key': key.value }, label: 'cancelar cartão' });
      if (ok(r)) redraw(r.body.vcn, 'Cartão cancelado'); else put(out, errorBox(r, 'Cancelamento'));
    });
  };
  const cancelByAccount = (e) => {
    if (!confirm('Cancelar o cartão ' + (c.last4 ? '•••• ' + c.last4 : c.id) + ' no emissor, pela API de gestão? Não dá para desfazer.')) return;
    busy(e.target, async () => {
      const r = await api('POST', '/v1/management/vcns/' + c.id + '/cancel', { body: {}, label: 'cancelar cartão (gestão)' });
      if (ok(r)) redraw(r.body, 'Cartão cancelado'); else put(out, errorBox(r, 'Cancelamento'));
    });
  };
  frame(body,
    title('credit-card', 'Cartão virtual ', badge(c.status), ' ', h('span', { class: 'mono', translate: 'no' }, c.last4 ? '•••• ' + c.last4 : '')),
    h('div', { class: 'sub' }, h('span', {}, ic('link'), ' ', c.integration), h('span', {}, ic('user'), ' ', c.holder_name || '—'), h('span', {}, ic('wallet'), ' ', money(c.limit))),
    usable && (c.booking_status === 'failed' || c.booking_status === 'cancelled') ? h('div', { class: 'alert amber' }, 'Este cartão continua utilizável no emissor e a reserva dele não existe mais. Se o hotel não tem multa a cobrar nele, cancele.') : null,
    h('dl', { class: 'kv' },
      h('dt', {}, 'id'), h('dd', { class: 'mono' }, c.id),
      h('dt', {}, 'Emissor'), h('dd', {}, c.integration + ' · ', h('span', { class: 'mono' }, c.credential)),
      h('dt', {}, 'Id no emissor'), h('dd', { class: 'mono' }, c.supplier_id || '—'),
      h('dt', {}, 'Portador'), h('dd', {}, c.holder_name || '—'),
      h('dt', {}, 'Limite'), h('dd', {}, money(c.limit)),
      h('dt', {}, 'Validade'), h('dd', {}, day(c.active_from) + ' → ' + day(c.valid_until)),
      h('dt', {}, 'Referência'), h('dd', {}, c.reference || '—'),
      h('dt', {}, 'Reserva'), h('dd', {}, c.booking_id ? [h('span', { class: 'mono' }, c.booking_id), c.booking_status ? [' ', badge(c.booking_status)] : null] : 'avulso (emitido em /v1/vcns)'),
      u.check_in ? [h('dt', {}, 'Uso'), h('dd', {}, (u.hotel_name ? u.hotel_name + ' · ' : '') + day(u.check_in) + ' → ' + day(u.check_out), u.locator ? [' · localizador ', h('span', { class: 'mono' }, u.locator)] : null)] : null,
      h('dt', {}, 'Emitido'), h('dd', {}, when(c.created_at)),
      c.cancelled_at ? [h('dt', {}, 'Cancelado'), h('dd', {}, when(c.cancelled_at))] : null),
    h('h2', { class: 'stitle' }, ic('bolt'), 'Ações'),
    h('div', { class: 'stack' },
      h('p', { class: 'small muted' }, 'As ações em /v1/vcns pedem permissão da chave de produto no produto vcn; a de gestão usa o escopo bookings:write.'),
      usable ? h('div', { class: 'row' }, h('button', { onclick: refresh }, ic('refresh'), 'Consultar no emissor')) : null,
      usable ? h('div', { class: 'row' }, field('Limite (' + ((c.limit && c.limit.currency) || '') + ')', limit), field('Válido até', until), h('button', { onclick: update }, ic('pencil'), 'Atualizar (PATCH /v1/vcns)')) : null,
      usable ? h('div', { class: 'row' }, field('Idempotency-Key', key), h('button', { class: 'danger', onclick: cancelByKey }, ic('times-circle'), 'Cancelar pela chave de produto'), h('button', { class: 'danger', onclick: cancelByAccount }, ic('times-circle'), 'Cancelar pela API de gestão')) : null),
    out, jsonBlock(c));
  titleModal(body);
}

/** Emite um cartão avulso em /v1/vcns. O número aparece uma única vez, na resposta. */
async function cardIssueForm(reload) {
  const issuers = (await loadV1Integrations()).filter((i) => (i.credentials || []).some((c) => (c.allowed || []).some((a) => a.product === 'vcn' && a.operations.includes('issue'))));
  const today = new Date();
  const plus = (days) => { const d = new Date(today); d.setDate(d.getDate() + days); return iso(d); };
  const integration = h('select', { name: 'integration', required: true }, issuers.length ? issuers.map((i) => opt(i.integration, i.integration)) : opt('', 'a chave não emite cartão em nenhum parceiro'));
  const holder = h('input', { value: 'MARIA SOUZA', required: true, maxlength: 60, name: 'holder_name', autocomplete: 'off' });
  const amount = h('input', { value: '1000.00', required: true, size: 10, inputmode: 'decimal', name: 'limit', autocomplete: 'off' });
  const currency = h('input', { value: 'BRL', required: true, size: 4, maxlength: 3, name: 'currency', autocomplete: 'off', spellcheck: 'false' });
  const from = h('input', { type: 'date', value: plus(0), required: true, name: 'active_from' });
  const until = h('input', { type: 'date', value: plus(90), required: true, name: 'valid_until' });
  const checkIn = h('input', { type: 'date', value: plus(30), required: true, name: 'check_in' });
  const checkOut = h('input', { type: 'date', value: plus(32), required: true, name: 'check_out' });
  const hotel = h('input', { value: 'Hotel Exemplo', name: 'hotel_name', autocomplete: 'off' });
  const city = h('input', { value: 'São Paulo', name: 'city', autocomplete: 'off', size: 14 });
  const state = h('input', { value: 'SP', name: 'state', autocomplete: 'off', size: 3 });
  const country = h('input', { value: 'BR', name: 'country', autocomplete: 'off', size: 3, maxlength: 2 });
  const reference = h('input', { value: 'SDK-VCN-' + Date.now().toString(36).toUpperCase(), maxlength: 64, name: 'reference', spellcheck: 'false', autocomplete: 'off' });
  const key = h('input', { value: uuid(), class: 'mono', size: 38, name: 'idempotency_key', spellcheck: 'false', autocomplete: 'off', translate: 'no' });
  let scenario = 'ok';
  const scenarioBox = h('span');
  const drawScenario = () => put(scenarioBox, integration.value === 'mock' ? field('Cenário', scenarioSelect('vcnIssue', scenario, (v) => { scenario = v; })) : null);
  integration.addEventListener('change', drawScenario);
  const out = h('div');
  const submit = async (e) => {
    e.preventDefault();
    const [first, ...rest] = holder.value.trim().split(/\s+/);
    const body = {
      integration: integration.value, reference: reference.value || undefined, holder_name: holder.value.trim(),
      limit: { amount: amount.value, currency: currency.value.toUpperCase() }, active_from: from.value, valid_until: until.value,
      use: { type: 'hotel', hotel_name: hotel.value || undefined, city: city.value || undefined, state: state.value || undefined, country: country.value.toUpperCase() || undefined,
        check_in: checkIn.value, check_out: checkOut.value, total: { amount: amount.value, currency: currency.value.toUpperCase() }, guest: { first_name: first, last_name: rest.join(' ') || first } },
    };
    await busy(e.submitter, async () => {
      const r = await api('POST', '/v1/vcns', { body, headers: { 'Idempotency-Key': key.value, ...(integration.value === 'mock' ? mockHeader(scenario) : {}) }, label: 'emitir cartão' });
      if (!ok(r)) { put(out, errorBox(r, 'Emissão'), h('p', { class: 'small' }, 'Nova tentativa depois de uma falha pede outra Idempotency-Key.')); return; }
      const shown = r.body.card;
      put(out, h('div', { class: 'alert ' + (shown ? 'green' : 'blue') },
        shown ? [h('strong', {}, 'Cartão emitido. '), 'O número e o código abaixo aparecem só agora: o Connect não os guarda.',
          h('dl', { class: 'kv' }, h('dt', {}, 'Número'), h('dd', { class: 'mono', translate: 'no' }, shown.number), h('dt', {}, 'CVV'), h('dd', { class: 'mono', translate: 'no' }, shown.cvv),
            h('dt', {}, 'Validade'), h('dd', { class: 'mono' }, String(shown.expiry_month).padStart(2, '0') + '/' + shown.expiry_year))]
          : 'Repetição com a mesma Idempotency-Key: este é o cartão que já existia, sem o número.'),
      h('dl', { class: 'kv' }, h('dt', {}, 'id'), h('dd', { class: 'mono' }, r.body.vcn.id), h('dt', {}, 'Estado'), h('dd', {}, badge(r.body.vcn.status)), h('dt', {}, 'Id no emissor'), h('dd', { class: 'mono' }, r.body.vcn.supplier_id || '—')));
      reload();
    });
  };
  openModal(title('plus', 'Emitir cartão virtual'),
    h('div', { class: 'sub' }, 'POST /v1/vcns, com a chave de produto. Em parceiro real o cartão é de verdade.'),
    h('form', { class: 'stack', onsubmit: submit },
      h('div', { class: 'row' }, field('Emissor', integration), scenarioBox, field('Portador', holder), field('Limite', amount), field('Moeda', currency)),
      h('div', { class: 'row' }, field('Vale a partir de', from), field('Válido até', until), field('Referência', reference)),
      h('h3', {}, ic('building'), ' Uso: a estadia que o cartão paga'),
      h('div', { class: 'row' }, field('Hotel', hotel), field('Cidade', city), field('UF', state), field('País', country), field('Check-in', checkIn), field('Check-out', checkOut)),
      h('div', { class: 'row' }, field('Idempotency-Key', key), h('button', { type: 'button', class: 'sm', onclick: () => { key.value = uuid(); } }, 'Nova chave')),
      out, h('div', { class: 'row' }, h('button', { class: 'primary', disabled: !issuers.length }, ic('check'), 'Emitir'))));
  drawScenario();
}

function supplierBookingModal(r) {
  const b = r.body.booking;
  const p = b.cancellation_policy;
  openModal(
    h('h2', {}, b.hotel_name || 'Reserva no parceiro', ' ', badge(b.status)),
    h('p', { class: 'sub' }, h('span', {}, ic('link'), ' ', r.body.integration + ' · ' + r.body.credential), h('span', {}, ic('calendar'), ' ', b.check_in ? day(b.check_in) + ' → ' + day(b.check_out) : 'sem datas'), callChip(r, 'consulta')),
    h('div', { class: 'alert blue' }, ic('info-circle'), ' Lida agora no parceiro. Não é uma reserva do Connect: não aparece na lista abaixo e não é cancelada por aqui.'),
    h('div', { class: 'split' },
      h('dl', { class: 'kv' },
        h('dt', {}, 'Id no parceiro'), h('dd', { class: 'mono', translate: 'no' }, b.locator),
        h('dt', {}, 'Número de confirmação'), h('dd', { class: 'mono' }, b.confirmation_number || '—'),
        h('dt', {}, 'Referência'), h('dd', { class: 'mono' }, b.reference || '—'),
        h('dt', {}, 'Hotel no parceiro'), h('dd', { class: 'mono small' }, b.supplier_hotel_id || '—'),
        h('dt', {}, 'hotel_id do Connect'), h('dd', { class: 'mono small' }, b.hotel_id || 'sem vínculo'),
        h('dt', {}, 'Total'), h('dd', {}, b.net ? money(b.net) : '—', b.pay_local ? ' (hóspede paga no hotel)' : ''),
        h('dt', {}, 'Cancelamento'), h('dd', { class: 'small' }, p ? policyText(p) : 'o parceiro não informa'),
        h('dt', {}, 'Criada em'), h('dd', {}, b.created_at ? when(b.created_at) : '—'),
        b.remarks ? h('dt', {}, 'Observações') : null, b.remarks ? h('dd', { class: 'small' }, b.remarks) : null),
      h('div', {}, h('h3', {}, 'Quartos e hóspedes'), (b.rooms || []).map((room, i) => h('div', { class: 'room' },
        h('strong', { class: 'small' }, 'Quarto ' + (i + 1) + ': ' + room.room_name), ' ', badge(BOARDS[room.board] || room.board, 'blue'),
        h('div', { class: 'small muted' }, room.adults + ' adulto(s)' + (room.children ? ', ' + room.children + ' criança(s)' : '')),
        h('ul', { class: 'small' }, (room.guests || []).map((g) => h('li', {}, g.first_name + ' ' + g.last_name + (g.age !== undefined ? ' (' + g.age + ' anos)' : '')))))))),
    jsonBlock(r.body));
}

// ---------- requisição e resposta ----------

/** Um botão que abre a requisição e a resposta de uma chamada no painel de baixo. */
function callChip(r, label) {
  return h('button', { type: 'button', class: 'chip ' + tone(r.status), onclick: () => openDrawer(r), title: 'Ver requisição e resposta' },
    ic('code'), (label ? label + ' · ' : ''), h('span', { class: 'status ' + tone(r.status) }, r.status || 'erro'), ' ' + r.duration_ms + ' ms');
}
const tone = (s) => (s >= 200 && s < 300 ? 'ok' : s >= 400 && s < 500 ? 'warn' : 'err');

function curlOf(r) {
  const q = r.request || {};
  const isMgmt = (q.url || '').includes('/v1/management');
  const parts = ['curl -X ' + q.method + " '" + q.url + "'", "-H 'Authorization: Bearer $" + (isMgmt ? 'KAVOX_CONNECT_MGMT_KEY' : 'KAVOX_CONNECT_KEY') + "'"];
  for (const [k, v] of Object.entries(q.headers || {})) parts.push("-H '" + k + ': ' + v + "'");
  if (q.body) parts.push("-H 'Content-Type: application/json'", "-d '" + JSON.stringify(q.body) + "'");
  return parts.join(' \\\n  ');
}

/** Uma chamada do registro: linha que abre requisição (curl e corpo) e resposta. */
function logEntry(r, open) {
  const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Copiado'));
  return h('details', { class: 'log', open: !!open },
    h('summary', {},
      h('span', { class: 'method' }, (r.request && r.request.method) || ''),
      h('span', { class: 'status ' + tone(r.status) }, r.status || 'erro'),
      h('span', { class: 'path', title: r.request && r.request.url, translate: 'no' }, ((r.request && r.request.url) || '').replace(/^https?:\/\/[^/]+/, ''), r.label ? h('span', { class: 'muted' }, '  · ' + r.label) : null),
      h('span', { class: 'muted small right num' }, r.duration_ms + ' ms'),
      h('span', { class: 'mono small muted rid', translate: 'no' }, r.request_id || r.error || '')),
    h('div', { class: 'split logbody' },
      h('div', {},
        h('div', { class: 'logtitle' }, h('span', {}, ic('arrow-up-right'), ' Requisição'), h('button', { type: 'button', class: 'sm', onclick: () => copy(curlOf(r)) }, ic('copy'), 'Copiar curl')),
        h('div', { class: 'small muted' }, 'chave ', h('span', { class: 'mono', translate: 'no' }, (r.request && r.request.key) || '—'), ' · ', r.at.toLocaleTimeString('pt-BR')),
        h('pre', {}, curlOf(r)), r.request && r.request.body ? h('pre', {}, JSON.stringify(r.request.body, null, 2)) : null),
      h('div', {},
        h('div', { class: 'logtitle' }, h('span', {}, ic('arrow-down-left'), ' Resposta ', h('span', { class: 'status ' + tone(r.status) }, r.status)), h('button', { type: 'button', class: 'sm', onclick: () => copy(JSON.stringify(r.body, null, 2)) }, ic('copy'), 'Copiar JSON')),
        r.server_timing ? h('div', { class: 'small muted mono' }, 'Server-Timing: ' + r.server_timing) : h('div', { class: 'small muted' }, r.request_id ? 'request_id ' + r.request_id : ''),
        h('pre', {}, r.error ? r.error : JSON.stringify(r.body, null, 2)))));
}

/** A barra de baixo: a última chamada sempre visível; um clique abre as últimas com requisição e resposta. */
function updateDock() {
  const dock = $('#dock');
  const last = S.log[0];
  put($('#dock-last'), last ? [
    h('span', { class: 'method' }, last.request && last.request.method),
    h('span', { class: 'status ' + tone(last.status) }, last.status || 'erro'),
    h('span', { class: 'path', translate: 'no' }, ((last.request && last.request.url) || '').replace(/^https?:\/\/[^/]+/, '')),
    h('span', { class: 'muted num' }, last.duration_ms + ' ms'),
  ] : h('span', { class: 'muted' }, 'Nenhuma chamada ainda'));
  dock.hidden = false;
  if (!$('#drawer').hidden) drawDrawer();
}
function drawDrawer(focus) {
  put($('#drawer-list'), S.log.length ? S.log.slice(0, 50).map((r) => logEntry(r, r === focus)) : h('div', { class: 'empty' }, 'Nenhuma chamada ainda.'));
}
function openDrawer(focus) {
  const d = $('#drawer');
  d.hidden = false;
  $('#dock-toggle').setAttribute('aria-expanded', 'true');
  drawDrawer(focus || S.log[0]);
}
function closeDrawer() {
  $('#drawer').hidden = true;
  $('#dock-toggle').setAttribute('aria-expanded', 'false');
}
$('#dock-toggle').addEventListener('click', () => ($('#drawer').hidden ? openDrawer() : closeDrawer()));
$('#drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden && !$('#modal').open) closeDrawer(); });

// ---------- Console ----------

function viewConsole() {
  return h('div', {},
    h('div', { class: 'card' }, h('div', { class: 'head' },
      h('div', {}, title('code', 'Console'), h('p', { class: 'muted' }, 'Toda chamada desta tela, da mais nova para a mais antiga: requisição e resposta como foram. O tempo é o de ida e volta medido pela ponte PHP. A barra de baixo mostra a última em qualquer tela.')),
      h('button', { onclick: () => { S.log = []; $('#console-count').textContent = ''; updateDock(); render(); } }, ic('trash'), 'Limpar'))),
    h('div', { class: 'card' }, S.log.length ? S.log.map((r) => logEntry(r)) : h('div', { class: 'empty' }, emptyMark(), 'Nenhuma chamada ainda.')));
}

// ---------- início ----------

(async () => {
  await loadConfig();
  await loadMe();
  render();
})();
