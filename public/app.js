// OSRSBot dashboard. Plain JS, no build step. All game/agent text goes through textContent.

const $ = sel => document.querySelector(sel);
const fmt = n => (n == null || Number.isNaN(n) ? '–' : Math.round(n).toLocaleString());
const short = n => {
  if (n == null) return '–';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M';
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return Math.round(n).toLocaleString();
};
const time = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let status = null;
let world = null;
let firstSkills = null;

// ---- API ------------------------------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Login required'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(err) {
  addEvent({ id: 'local-' + Date.now(), ts: Date.now(), kind: 'error', text: err.message || String(err) });
}

const act = path => () => api(path, {}).catch(toast);

// ---- login ----------------------------------------------------------------------------------

function showLogin() {
  $('#login').hidden = false;
  $('#login-password').focus();
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/login', { password: $('#login-password').value });
    $('#login').hidden = true;
    boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

// ---- status ---------------------------------------------------------------------------------

function pill(id, text, cls) {
  const p = $(id);
  p.textContent = text;
  p.className = 'pill ' + (cls || '');
}

function renderStatus(s) {
  status = s;
  const { agent, client, metrics: m, settings } = s;
  $('#bot-name').textContent = settings.botName ? `· ${settings.botName} @ ${settings.server}` : '· no bot name set';

  const cState = client.status === 'running' ? (client.inGame ? 'good' : 'warn') : client.status === 'stopped' ? '' : 'bad';
  pill('#pill-client', `client: ${client.status}${client.status === 'running' && !client.inGame ? ' (logging in)' : ''} · ${client.mode}`, cState);
  pill('#pill-gateway', `gateway: ${client.gateway}`, client.gateway === 'connected' ? 'good' : client.gateway === 'disconnected' ? '' : 'warn');
  const aCls = { running: 'good', paused: 'warn', waiting: 'warn', error: 'bad' }[agent.status] || '';
  pill('#pill-agent', `agent: ${agent.status}${agent.session ? ` · s${agent.session} ${agent.sessionTurns}/${settings.maxTurnsPerSession}` : ''}`, aCls);
  const budget = settings.dailyBudgetUsd ? ` / $${settings.dailyBudgetUsd}` : '';
  pill('#pill-spend', `$${m.spendToday.toFixed(2)}${budget} today`, settings.dailyBudgetUsd && m.spendToday >= settings.dailyBudgetUsd ? 'bad' : '');

  const llm = s.llm;
  const using = `${llm.provider === 'openrouter' ? 'OpenRouter' : 'Claude API'} · ${llm.model}${llm.sessionModel && llm.sessionModel !== llm.model && agent.status === 'running' ? ` (this session: ${llm.sessionModel})` : ''}`;
  $('#agent-detail').textContent = [using, llm.unavailable, agent.detail].filter(Boolean).join(' · ');
  $('#btn-agent-start').textContent = agent.status === 'paused' ? 'Resume' : 'Start';

  // current tool
  const tool = agent.currentTool;
  $('#current-tool').hidden = !tool;
  if (tool) {
    $('#current-tool-text').textContent = `${tool.name}${tool.purpose ? ': ' + tool.purpose : ''}`;
    $('#current-tool-time').textContent = `${Math.round((Date.now() - tool.startedAt) / 1000)}s`;
  }

  // progress
  $('#st-level').textContent = fmt(m.totalLevel);
  $('#st-xp').textContent = short(m.totalXp);
  $('#st-xph').textContent = short(m.xpPerHour10m);
  $('#st-xph60').textContent = short(m.xpPerHour60m);
  $('#st-peak').textContent = short(m.peakXpPerMin);
  const h = m.hiscore;
  $('#st-rank').textContent = h && !h.error ? h.rank : '–';
  $('#st-rank-k').textContent = h && !h.error ? `Rank · ${h.playtime} played` : (h?.error || 'Leaderboard rank');

  // benchmark
  const run = m.activeRun;
  $('#bench-active').hidden = !run;
  if (run) {
    const left = Math.max(0, Math.round((run.endsAt - Date.now()) / 1000));
    const r = run.result || {};
    $('#bench-active').textContent =
      `▶ ${run.label}: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left · +${fmt(r.xpGained || 0)} XP · peak ${fmt(r.peakXpPerMin || 0)}/min`;
  }

  // 3D view availability
  const browserMode = client.mode === 'browser' && client.status === 'running';
  $('#client3d-off').hidden = browserMode;
  $('#client3d-on').hidden = !browserMode;
  if (activeView === 'client3d') ensureViewSocket();

  fillSettingsOnce(settings);
  renderModelCard();
}

let settingsFilled = false;
function fillSettingsOnce(settings) {
  if (settingsFilled) return;
  settingsFilled = true;
  const form = $('#settings-form');
  for (const [k, v] of Object.entries(settings)) {
    const input = form.elements.namedItem(k);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!v;
    else input.value = v;
  }
  $('#goal').value = settings.goal;
}

// ---- event feed -----------------------------------------------------------------------------

const feed = $('#feed');
const seen = new Set();
const KIND_LABEL = {
  session_start: 'session', session_end: 'session', thinking: 'thinking', text: 'agent says', tool_call: 'tool',
  tool_result: 'result', operator: 'operator', agent: 'agent', client: 'client', bench: 'benchmark', error: 'error',
};

function addEvent(ev) {
  if (seen.has(ev.id)) return;
  seen.add(ev.id);
  const d = ev.data || {};
  const box = el('div', `ev ${ev.kind}${d.isError ? ' err' : ''}`);
  const meta = el('div', 'meta');
  meta.append(el('span', null, time(ev.ts)), el('span', null, KIND_LABEL[ev.kind] || ev.kind));
  if (d.tool) meta.append(el('span', null, d.tool));
  if (d.ms != null) meta.append(el('span', null, `${(d.ms / 1000).toFixed(1)}s`));
  box.append(meta);

  if (ev.kind === 'tool_call' && d.input) {
    box.append(el('div', 'body', ev.text));
    const input = d.input;
    if (typeof input.code === 'string') {
      const det = el('details');
      det.append(el('summary', null, `code (${input.code.split('\n').length} lines${input.timeout_seconds ? `, ${input.timeout_seconds}s limit` : ''})`), el('pre', null, input.code));
      box.append(det);
    } else if (Object.keys(input).length) {
      box.append(el('pre', null, JSON.stringify(input, null, 2)));
    }
  } else if (ev.kind === 'tool_result' && ev.text.length > 600) {
    const det = el('details');
    const firstLine = ev.text.split('\n').find(l => l.trim() && !/^──/.test(l)) || '';
    det.append(el('summary', null, firstLine.slice(0, 140)), el('div', 'body', ev.text));
    box.append(det);
  } else {
    box.append(el('div', 'body', ev.text));
  }

  feed.append(box);
  while (feed.children.length > 800) feed.firstChild.remove();
  if ($('#autoscroll').checked) feed.scrollTop = feed.scrollHeight;
}

$('#show-thinking').addEventListener('change', e => feed.classList.toggle('hide-thinking', !e.target.checked));
$('#show-results').addEventListener('change', e => feed.classList.toggle('hide-results', !e.target.checked));

let liveText = '';
function liveDelta(delta) {
  liveText += delta;
  const live = $('#live');
  live.hidden = false;
  live.textContent = liveText.slice(-2000);
  live.scrollTop = live.scrollHeight;
}
function liveEnd() {
  liveText = '';
  $('#live').hidden = true;
}

// ---- live stream ----------------------------------------------------------------------------

let source = null;
function connectStream() {
  source?.close();
  source = new EventSource('/api/stream');
  source.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'hello' || msg.type === 'status') renderStatus(msg.status);
    else if (msg.type === 'event') {
      addEvent(msg.event);
      if (msg.event.kind === 'bench') loadRuns();
    } else if (msg.type === 'delta') liveDelta(msg.delta);
    else if (msg.type === 'delta_end') liveEnd();
  };
  source.onerror = () => {
    // EventSource retries by itself; a 401 means the session cookie is gone.
    fetch('/api/status').then(r => { if (r.status === 401) { source.close(); showLogin(); } }).catch(() => {});
  };
}

// ---- world / radar --------------------------------------------------------------------------

async function pollWorld() {
  try {
    world = await api('/api/world');
    renderWorld();
  } catch { /* status pill shows connection problems */ }
}

function renderWorld() {
  drawRadar();
  const w = world;
  if (!w || !w.player) {
    $('#where').textContent = 'No game state yet.';
    return;
  }
  const p = w.player;
  const where = $('#where');
  where.replaceChildren();
  where.append(el('b', null, p.name), ` · combat ${p.combatLevel} · HP ${p.hp}/${p.maxHp}`, el('br'),
    `(${p.x}, ${p.z}) floor ${p.level}${p.isDead ? ' · DEAD' : ''} · state ${Math.round(w.ageMs / 100) / 10}s old`);

  const dlg = $('#dialog');
  dlg.hidden = !w.dialog;
  if (w.dialog) {
    dlg.replaceChildren(el('div', null, w.dialog.text || '(dialog)'));
    for (const o of w.dialog.options) dlg.append(el('div', 'muted', '› ' + o));
  }

  const msgs = $('#messages');
  msgs.replaceChildren(...w.messages.slice().reverse().map(m => el('li', null, (m.sender ? m.sender + ': ' : '') + m.text)));

  // skills
  if (!firstSkills && w.skills.length) firstSkills = Object.fromEntries(w.skills.map(s => [s.name, s.xp]));
  $('#skills').replaceChildren(...w.skills.map(s => {
    const row = el('div', 'skill');
    const gain = s.xp - (firstSkills?.[s.name] ?? s.xp);
    const name = el('span', null, s.name);
    if (gain > 0) name.append(' ', el('span', 'gain', '+' + short(gain)));
    row.append(name, el('b', null, s.level === s.baseLevel ? String(s.baseLevel) : `${s.level}/${s.baseLevel}`));
    row.title = `${s.xp.toLocaleString()} XP`;
    return row;
  }));

  // inventory
  const slots = [];
  for (let i = 0; i < 28; i++) {
    const item = w.inventory.find(it => it.slot === i);
    const cell = el('div', 'slot');
    if (item) {
      cell.append(el('div', null, item.name));
      if (item.count > 1) cell.append(el('div', 'n', short(item.count)));
      cell.title = `${item.name} × ${item.count}`;
    }
    slots.push(cell);
  }
  $('#inventory').replaceChildren(...slots);
  $('#equipment').textContent = w.equipment.length ? 'Worn: ' + w.equipment.map(e => e.name).join(', ') : 'Nothing worn';
}

const radar = $('#radar');
const rctx = radar.getContext('2d');
function drawRadar() {
  const W = radar.width, H = radar.height;
  rctx.fillStyle = '#0b0d10';
  rctx.fillRect(0, 0, W, H);
  const w = world;
  if (!w || !w.player) {
    rctx.fillStyle = '#8b929c';
    rctx.font = '14px system-ui';
    rctx.textAlign = 'center';
    rctx.fillText('Waiting for the bot to log in…', W / 2, H / 2);
    return;
  }
  const S = 12; // px per tile
  const cx = W / 2, cy = H / 2;
  const px = w.player.x, pz = w.player.z;
  const pos = (x, z) => [cx + (x - px) * S, cy - (z - pz) * S]; // north is up

  // grid every 8 tiles (map chunk lines)
  rctx.strokeStyle = '#171b21';
  rctx.lineWidth = 1;
  for (let gx = Math.floor((px - W / S / 2) / 8) * 8; gx < px + W / S / 2; gx += 8) {
    const [x] = pos(gx, 0);
    rctx.beginPath(); rctx.moveTo(x, 0); rctx.lineTo(x, H); rctx.stroke();
  }
  for (let gz = Math.floor((pz - H / S / 2) / 8) * 8; gz < pz + H / S / 2; gz += 8) {
    const [, y] = pos(0, gz);
    rctx.beginPath(); rctx.moveTo(0, y); rctx.lineTo(W, y); rctx.stroke();
  }

  // Labels are collected and drawn last, highest priority first, skipping any that would overlap.
  const labels = [];
  const label = (text, x, y, color, prio) => labels.push({ text, x, y: y - 7, color, prio });

  const named = new Set();
  for (const l of w.locs) {
    const [x, y] = pos(l.x, l.z);
    rctx.fillStyle = '#3a4250';
    rctx.fillRect(x - S / 2 + 1, y - S / 2 + 1, S - 2, S - 2);
    if (l.name && l.name !== 'null' && !named.has(l.name)) {
      named.add(l.name);
      label(l.name, x, y, '#6f7a8a', 0);
    }
  }
  for (const g of w.groundItems) {
    const [x, y] = pos(g.x, g.z);
    rctx.fillStyle = '#f0c060';
    rctx.beginPath(); rctx.arc(x, y, 3, 0, Math.PI * 2); rctx.fill();
    label(g.name, x, y, '#c9b98f', 1);
  }
  for (const n of w.npcs) {
    const [x, y] = pos(n.x, n.z);
    rctx.fillStyle = n.combatLevel > 0 ? '#e05d5d' : '#e0a83a';
    rctx.beginPath(); rctx.arc(x, y, 4, 0, Math.PI * 2); rctx.fill();
    label(n.name, x, y, '#d6a3a3', 2);
  }
  for (const p of w.players) {
    const [x, y] = pos(p.x, p.z);
    rctx.fillStyle = '#e4e6ea';
    rctx.beginPath(); rctx.arc(x, y, 4, 0, Math.PI * 2); rctx.fill();
    label(p.name, x, y, '#e4e6ea', 3);
  }
  rctx.fillStyle = '#4fbf7a';
  rctx.beginPath(); rctx.arc(cx, cy, 6, 0, Math.PI * 2); rctx.fill();
  rctx.strokeStyle = '#0b0d10'; rctx.lineWidth = 2; rctx.stroke();

  rctx.font = '10.5px system-ui';
  rctx.textAlign = 'center';
  const placed = [];
  labels.sort((a, b) => b.prio - a.prio || Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
  for (const l of labels) {
    const w2 = rctx.measureText(l.text).width / 2 + 2;
    const box = { x0: l.x - w2, x1: l.x + w2, y0: l.y - 10, y1: l.y + 2 };
    if (placed.some(b => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
    placed.push(box);
    rctx.fillStyle = l.color;
    rctx.fillText(l.text, l.x, l.y);
  }

  rctx.fillStyle = '#8b929c';
  rctx.font = '11px system-ui';
  rctx.textAlign = 'left';
  rctx.fillText('N ↑   ● you   ● npc   ● player   ● item   ■ object', 8, H - 8);
}

// ---- XP chart -------------------------------------------------------------------------------

async function drawChart() {
  let series;
  try { series = await api('/api/series?hours=6'); } catch { return; }
  const c = $('#xp-chart');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#8b929c';
  ctx.font = '11px system-ui';
  if (series.length < 2) { ctx.fillText('XP over the last 6 hours appears here.', 10, H / 2); return; }
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const x0 = series[0].xp, gained = series[series.length - 1].xp - x0;
  const x1 = x0 + Math.max(gained, 1); // vertical scale; a flat line when nothing was gained
  ctx.strokeStyle = '#d9a441';
  ctx.lineWidth = 2;
  ctx.beginPath();
  series.forEach((p, i) => {
    const x = 6 + ((p.t - t0) / Math.max(1, t1 - t0)) * (W - 12);
    const y = H - 16 - ((p.xp - x0) / (x1 - x0)) * (H - 30);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillText(`+${short(gained)} XP since ${time(t0).slice(0, 5)}`, 8, 12);
}

// ---- runs -----------------------------------------------------------------------------------

async function loadRuns() {
  let runs;
  try { runs = await api('/api/runs'); } catch { return; }
  const tbody = $('#runs tbody');
  tbody.replaceChildren(...runs.map(r => {
    const tr = el('tr');
    const res = r.result || {};
    const label = el('td', 'run-label', r.label);
    label.title = `${new Date(r.startedAt).toLocaleString()} · ${r.status}${r.goal ? '\nGoal: ' + r.goal : ''}`;
    tr.append(label,
      el('td', null, `${r.model.replace('claude-', '')} ${r.effort}`),
      el('td', null, short(res.xpGained)),
      el('td', null, res.levelsGained ?? '–'),
      el('td', null, short(res.peakXpPerMin)),
      el('td', null, short(res.avgXpPerHour)),
      el('td', null, res.costUsd != null ? '$' + res.costUsd.toFixed(2) : '–'));
    if (r.status !== 'finished') tr.style.opacity = r.status === 'running' ? 1 : 0.6;
    return tr;
  }));
}

// ---- 3D client view -------------------------------------------------------------------------

let activeView = 'radar';
let viewSocket = null;
const view3d = $('#client3d');
const v3ctx = view3d.getContext('2d');

function ensureViewSocket() {
  if (viewSocket || $('#client3d-on').hidden) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/view`);
  ws.binaryType = 'blob';
  ws.onmessage = async e => {
    const bmp = await createImageBitmap(e.data);
    if (view3d.width !== bmp.width || view3d.height !== bmp.height) { view3d.width = bmp.width; view3d.height = bmp.height; }
    v3ctx.drawImage(bmp, 0, 0);
    bmp.close();
  };
  ws.onclose = () => { if (viewSocket === ws) viewSocket = null; };
  viewSocket = ws;
}

function closeViewSocket() {
  viewSocket?.close();
  viewSocket = null;
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    activeView = tab.dataset.view;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    $('#view-radar').hidden = activeView !== 'radar';
    $('#view-client3d').hidden = activeView !== 'client3d';
    if (activeView === 'client3d') ensureViewSocket(); else closeViewSocket();
  });
}

const sendKey = (key, down) => viewSocket?.readyState === 1 && viewSocket.send(JSON.stringify({ key, down }));
for (const b of document.querySelectorAll('.camera-keys button')) {
  const k = b.dataset.key;
  b.addEventListener('pointerdown', () => sendKey(k, true));
  for (const ev of ['pointerup', 'pointerleave']) b.addEventListener(ev, () => sendKey(k, false));
}
view3d.tabIndex = 0;
view3d.addEventListener('mouseenter', () => view3d.focus());
view3d.addEventListener('keydown', e => { if (e.key.startsWith('Arrow')) { e.preventDefault(); if (!e.repeat) sendKey(e.key, true); } });
view3d.addEventListener('keyup', e => { if (e.key.startsWith('Arrow')) sendKey(e.key, false); });

// ---- controls -------------------------------------------------------------------------------

$('#btn-agent-start').addEventListener('click', act('/api/agent/start'));
$('#btn-agent-pause').addEventListener('click', act('/api/agent/pause'));
$('#btn-agent-stop').addEventListener('click', () => confirm('Stop the agent? Running code is cancelled.') && act('/api/agent/stop')());
$('#btn-agent-session').addEventListener('click', act('/api/agent/new-session'));
$('#btn-interrupt').addEventListener('click', act('/api/agent/interrupt'));
$('#btn-client-start').addEventListener('click', act('/api/client/start'));
$('#btn-client-restart').addEventListener('click', act('/api/client/restart'));
$('#btn-client-stop').addEventListener('click', act('/api/client/stop'));

$('#operator-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#operator-text');
  if (!input.value.trim()) return;
  try { await api('/api/agent/message', { text: input.value }); input.value = ''; } catch (err) { toast(err); }
});

$('#goal-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/settings', { goal: $('#goal').value.trim() }); } catch (err) { toast(err); }
});

$('#notes-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/notes', { notes: $('#notes').value }); } catch (err) { toast(err); }
});
$('#notes-form').closest('details').addEventListener('toggle', async e => {
  if (e.target.open) $('#notes').value = (await api('/api/notes')).notes;
});

$('#settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const patch = {};
  for (const input of form.elements) {
    if (!input.name) continue;
    if (input.type === 'checkbox') patch[input.name] = input.checked;
    else if (input.type === 'number') patch[input.name] = Number(input.value);
    else patch[input.name] = input.value.trim();
  }
  const msg = $('#settings-msg');
  try {
    await api('/api/settings', patch);
    msg.textContent = 'Saved';
    setTimeout(() => { msg.textContent = ''; }, 2500);
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#bench-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/bench/start', { label: $('#bench-label').value, minutes: Number($('#bench-minutes').value), goal: $('#bench-goal').value });
    loadRuns();
  } catch (err) { toast(err); }
});
$('#bench-stop').addEventListener('click', async () => { try { await api('/api/bench/stop', {}); loadRuns(); } catch (err) { toast(err); } });

$('#client-log-details').addEventListener('toggle', e => { if (e.target.open) loadClientLog(); });
async function loadClientLog() {
  if (!$('#client-log-details').open) return;
  try {
    const log = $('#client-log');
    log.textContent = (await api('/api/client-log')).join('\n') || '(empty)';
    log.scrollTop = log.scrollHeight;
  } catch { /* ignore */ }
}

// ---- AI model card --------------------------------------------------------------------------

let orModels = null;      // tool-capable OpenRouter models
let orAvailable = null;   // Set of ids this key may use (privacy settings), or null if unknown
let orAccount = null;
let anthropicModels = null;
let modelKeyLast = '';
let orFormDirty = false;

const fmtPrice = n => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n >= 0.1 ? n.toFixed(2) : n.toFixed(3));
const ctxText = n => (!n ? '?' : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const usd = n => (n == null ? '–' : `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`);

function modelTags(m) {
  const tags = [];
  const tag = (text, cls) => tags.push(el('span', `tag ${cls || ''}`, text));
  if (m.free) tag('free', 'free');
  else if (m.promptPrice < 0) tag('variable price', 'price');
  else tag(`$${fmtPrice(m.promptPrice)} in · $${fmtPrice(m.completionPrice)} out /M`, 'price');
  tag(`${ctxText(m.contextLength)} context`);
  if (m.reasoning) tag(m.efforts.length ? `reasoning: ${m.efforts.join('/')}` : 'reasoning', 'reason');
  if (orAvailable && !orAvailable.has(m.id)) tag('blocked by your privacy settings', 'blocked');
  if (m.expires) tag(`retiring ${m.expires}`, 'blocked');
  return tags;
}

async function loadModels(force) {
  try {
    const r = await api('/api/openrouter/models' + (force ? '?refresh=1' : ''));
    orModels = r.models.filter(m => m.tools);
    orAvailable = r.availableIds ? new Set(r.availableIds) : null;
    $('#or-f-usable-wrap').hidden = !orAvailable;
    renderModelCard(true);
    renderModelList();
  } catch (err) { toast(err); }
}

async function loadAccount(force) {
  try {
    orAccount = await api('/api/openrouter/account' + (force ? '?refresh=1' : ''));
    renderAccount();
  } catch { /* shown as not connected */ }
}

function renderAccount() {
  const a = orAccount;
  const box = $('#or-account');
  box.replaceChildren();
  const actions = el('div', 'actions');
  const btn = (text, fn, cls) => { const b = el('button', `small ${cls || ''}`, text); b.type = 'button'; b.addEventListener('click', fn); actions.append(b); };
  if (!a?.hasKey) {
    box.append(el('div', null, 'Not connected to OpenRouter. Connect your account (a key is created for you) or paste an existing key. Free models need no credits.'));
    btn('Connect OpenRouter', connectOpenRouter, 'primary');
    btn('Paste a key', () => showKeyForm(true));
    box.append(actions);
    return;
  }
  const info = a.info || {};
  const head = el('div', 'row');
  const who = el('span');
  who.append(el('b', null, 'OpenRouter connected'), ` · key ${a.keyHint}${info.label ? ` (${info.label})` : ''} · from ${a.keySource === 'env' ? '.env' : 'dashboard'}`);
  head.append(who);
  box.append(head);
  if (info.error) box.append(el('div', 'muted', `Key check: ${info.error}`));
  else {
    const limit = info.limit == null ? 'no spending limit on this key' : `${usd(info.limitRemaining)} of ${usd(info.limit)} key limit left${info.limitReset ? ` (resets ${info.limitReset})` : ''}`;
    box.append(el('div', 'muted', `Spent today ${usd(info.usageDaily ?? 0)} · this month ${usd(info.usageMonthly ?? info.usage)} · ${limit}`));
    const fd = info.freeDaily;
    if (fd) {
      const pct = Math.min(100, (fd.used / Math.max(1, fd.limit)) * 100);
      const line = el('div', 'muted', `Free-model requests today: ${fd.used} / ${fd.limit} (resets at midnight UTC)${fd.limit <= 50 ? ' · buying 10+ credits raises this to 1000/day' : ''}`);
      const meter = el('div', `meter ${pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : ''}`);
      const bar = el('span'); bar.style.width = `${pct}%`; meter.append(bar);
      box.append(line, meter);
    } else {
      box.append(el('div', 'muted', `Free-model requests today (counted here): ${a.freeRequestsToday}`));
    }
  }
  btn('↻', () => loadAccount(true));
  btn('Change key', () => showKeyForm(true));
  if (a.keySource === 'dashboard') btn('Disconnect', async () => {
    if (!confirm('Remove the saved OpenRouter key from this server?')) return;
    try { orAccount = await api('/api/openrouter/key', { key: '' }); renderAccount(); loadModels(true); } catch (err) { toast(err); }
  }, 'danger');
  box.append(actions);
}

function showKeyForm(show) {
  $('#or-key-form').hidden = !show;
  if (show) $('#or-key-input').focus();
}

async function connectOpenRouter() {
  try {
    const { url } = await api('/api/openrouter/connect', {});
    location.href = url;
  } catch (err) { toast(err); }
}

$('#or-key-save').addEventListener('click', async () => {
  const input = $('#or-key-input');
  try {
    orAccount = await api('/api/openrouter/key', { key: input.value });
    input.value = '';
    showKeyForm(false);
    renderAccount();
    loadModels(true);
  } catch (err) { toast(err); }
});
$('#or-key-cancel').addEventListener('click', () => showKeyForm(false));

/** Back from openrouter.ai/auth: trade the code for a key, then clean the URL. */
async function finishOpenRouterLogin() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('or_state');
  if (!code || !state) return;
  history.replaceState(null, '', location.pathname);
  try {
    orAccount = await api('/api/openrouter/exchange', { code, state });
    renderAccount();
    loadModels(true);
  } catch (err) { toast(err); }
}

function currentOrModel() {
  const id = status?.settings.openrouterModel;
  return orModels?.find(m => m.id === id) || null;
}

/** Re-render when the model-related settings change (from this tab or another). */
function renderModelCard(force) {
  if (!status) return;
  const s = status.settings;
  const key = JSON.stringify([s.provider, s.openrouterModel, s.openrouterFallbacks, s.anthropicModel, s.effort, s.providerSort, s.dataCollection, s.maxPromptPrice, s.maxCompletionPrice, s.maxOutputTokens, !!orModels]);
  if (!force && key === modelKeyLast) return;
  modelKeyLast = key;

  document.querySelectorAll('.provider-tab').forEach(t => t.classList.toggle('active', t.dataset.provider === s.provider));
  $('#or-panel').hidden = s.provider !== 'openrouter';
  $('#an-panel').hidden = s.provider !== 'anthropic';

  // OpenRouter: current model
  const m = currentOrModel();
  $('#or-model-name').textContent = m ? m.name : s.openrouterModel;
  $('#or-model-id').textContent = s.openrouterModel;
  $('#or-model-tags').replaceChildren(...(m ? modelTags(m) : [el('span', 'tag', orModels ? 'not in the catalog (check the id)' : 'loading…')]));

  // Fallbacks
  $('#or-fallbacks').replaceChildren(...(s.openrouterFallbacks.length ? s.openrouterFallbacks.map(id => {
    const chip = el('span', 'chip', id);
    const x = el('button', null, '×');
    x.type = 'button';
    x.title = 'Remove fallback';
    x.addEventListener('click', () => saveSettings({ openrouterFallbacks: s.openrouterFallbacks.filter(f => f !== id) }));
    chip.append(x);
    return chip;
  }) : [el('span', 'muted small-text', 'none (add with + fallback in the model list)')]));

  // Effort choices follow the model
  const effortSel = $('#or-effort');
  const efforts = m?.reasoning ? (m.efforts.length ? m.efforts : ['low', 'medium', 'high', 'xhigh', 'max']) : [];
  effortSel.replaceChildren(...(efforts.length
    ? ['low', 'medium', 'high', 'xhigh', 'max'].filter(e => efforts.includes(e)).map(e => { const o = el('option', null, e); o.value = e; return o; })
    : [Object.assign(el('option', null, m ? 'no reasoning on this model' : 'high'), { value: s.effort })]));
  effortSel.disabled = !!m && !m.reasoning;
  effortSel.value = efforts.includes(s.effort) ? s.effort : (m?.defaultEffort && efforts.includes(m.defaultEffort) ? m.defaultEffort : efforts[efforts.length - 1] || s.effort);

  if (!orFormDirty) {
    const f = $('#or-form');
    for (const name of ['maxOutputTokens', 'providerSort', 'dataCollection', 'maxPromptPrice', 'maxCompletionPrice']) f.elements.namedItem(name).value = s[name];
  }

  // Claude API panel
  if (anthropicModels) {
    const sel = $('#an-model');
    if (sel.options.length !== anthropicModels.length) sel.replaceChildren(...anthropicModels.map(id => Object.assign(el('option', null, id), { value: id })));
    sel.value = s.anthropicModel;
    $('#an-form').elements.namedItem('effort').value = s.effort;
  }

  renderModelList();
  if ($('#or-endpoints-details').open) loadEndpoints();
}

function renderModelList() {
  if ($('#or-picker').hidden || !orModels || !status) return;
  const q = $('#or-search').value.trim().toLowerCase();
  const onlyFree = $('#or-f-free').checked;
  const onlyReasoning = $('#or-f-reasoning').checked;
  const onlyUsable = orAvailable && $('#or-f-usable').checked;
  const sort = $('#or-sort').value;
  const s = status.settings;
  let list = orModels.filter(m =>
    (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) &&
    (!onlyFree || m.free) && (!onlyReasoning || m.reasoning) && (!onlyUsable || orAvailable.has(m.id)));
  const price = m => (m.promptPrice < 0 ? Infinity : m.promptPrice + m.completionPrice);
  list.sort(sort === 'newest' ? (a, b) => b.created - a.created
    : sort === 'price' ? (a, b) => price(a) - price(b) || b.created - a.created
    : sort === 'context' ? (a, b) => b.contextLength - a.contextLength
    : (a, b) => (b.free - a.free) || (b.id === 'openrouter/free') - (a.id === 'openrouter/free') || b.created - a.created);
  const shown = list.slice(0, 150);
  const rows = shown.map(m => {
    const row = el('div', `model-row${m.id === s.openrouterModel ? ' selected' : ''}${orAvailable && !orAvailable.has(m.id) ? ' blocked' : ''}`);
    row.title = m.description;
    const main = el('div', 'mr-main');
    main.append(el('div', 'mr-name', m.name), el('code', null, m.id));
    const tags = el('div', 'tags'); tags.append(...modelTags(m)); main.append(tags);
    const side = el('div', 'mr-side');
    const fb = el('button', 'small', '+ fallback');
    fb.type = 'button';
    fb.disabled = m.id === s.openrouterModel || s.openrouterFallbacks.includes(m.id) || s.openrouterFallbacks.length >= 3;
    fb.addEventListener('click', e => { e.stopPropagation(); saveSettings({ openrouterFallbacks: [...s.openrouterFallbacks, m.id] }); });
    side.append(fb);
    row.append(main, side);
    row.addEventListener('click', () => saveSettings({ openrouterModel: m.id }));
    return row;
  });
  if (list.length > shown.length) rows.push(el('div', 'muted small-text', `${list.length - shown.length} more: refine the search.`));
  if (!list.length) rows.push(el('div', 'muted small-text', 'No models match.'));
  $('#or-model-list').replaceChildren(...rows);
}

async function loadEndpoints() {
  const id = status?.settings.openrouterModel;
  const tbody = $('#or-endpoints tbody');
  if (!id || id.startsWith('openrouter/')) {
    tbody.replaceChildren(el('tr', null, ''));
    tbody.firstChild.append(Object.assign(el('td', 'muted', 'Routers pick a model per request, so there is no fixed provider list.'), { colSpan: 6 }));
    return;
  }
  try {
    const eps = await api(`/api/openrouter/endpoints?model=${encodeURIComponent(id)}`);
    tbody.replaceChildren(...eps.map(e => {
      const tr = el('tr');
      tr.append(
        el('td', null, `${e.provider}${e.quantization && e.quantization !== 'unknown' ? ` (${e.quantization})` : ''}${e.tools ? '' : ' · no tools'}`),
        el('td', null, e.promptPrice === 0 && e.completionPrice === 0 ? 'free' : `$${fmtPrice(e.promptPrice)} / $${fmtPrice(e.completionPrice)}`),
        el('td', null, ctxText(e.contextLength)),
        el('td', null, e.uptime30m == null ? '–' : `${Math.round(e.uptime30m)}%`),
        el('td', null, e.latencyP50 == null ? '–' : `${(e.latencyP50 / 1000).toFixed(1)}s`),
        el('td', null, e.throughputP50 == null ? '–' : Math.round(e.throughputP50)));
      return tr;
    }));
  } catch (err) {
    tbody.replaceChildren(el('tr'));
    tbody.firstChild.append(Object.assign(el('td', 'muted', err.message), { colSpan: 6 }));
  }
}

async function saveSettings(patch, msgEl) {
  try {
    const { settings } = await api('/api/settings', patch);
    status.settings = settings;
    renderModelCard();
    if (msgEl) { msgEl.textContent = 'Saved: applies from the next session'; setTimeout(() => { msgEl.textContent = ''; }, 3000); }
    return true;
  } catch (err) {
    if (msgEl) msgEl.textContent = err.message; else toast(err);
    return false;
  }
}

document.querySelectorAll('.provider-tab').forEach(tab => tab.addEventListener('click', () => saveSettings({ provider: tab.dataset.provider })));
$('#or-browse').addEventListener('click', () => {
  const picker = $('#or-picker');
  picker.hidden = !picker.hidden;
  $('#or-browse').textContent = picker.hidden ? 'Browse models' : 'Close';
  if (!picker.hidden) { renderModelList(); $('#or-search').focus(); }
});
for (const id of ['#or-search', '#or-sort', '#or-f-free', '#or-f-reasoning', '#or-f-usable']) $(id).addEventListener('input', renderModelList);
$('#or-refresh').addEventListener('click', () => loadModels(true));
$('#or-endpoints-details').addEventListener('toggle', e => { if (e.target.open) loadEndpoints(); });
$('#or-form').addEventListener('input', () => { orFormDirty = true; });

function orFormPatch() {
  const f = $('#or-form');
  const patch = {
    maxOutputTokens: Number(f.elements.namedItem('maxOutputTokens').value),
    providerSort: f.elements.namedItem('providerSort').value,
    dataCollection: f.elements.namedItem('dataCollection').value,
    maxPromptPrice: Number(f.elements.namedItem('maxPromptPrice').value) || 0,
    maxCompletionPrice: Number(f.elements.namedItem('maxCompletionPrice').value) || 0,
  };
  if (!$('#or-effort').disabled) patch.effort = $('#or-effort').value;
  return patch;
}
$('#or-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (await saveSettings(orFormPatch(), $('#or-msg'))) orFormDirty = false;
});
$('#or-apply-now').addEventListener('click', async () => {
  if (await saveSettings(orFormPatch(), $('#or-msg'))) { orFormDirty = false; act('/api/agent/new-session')(); }
});
function anFormPatch() {
  const f = $('#an-form');
  return { anthropicModel: f.elements.namedItem('anthropicModel').value, effort: f.elements.namedItem('effort').value };
}
$('#an-form').addEventListener('submit', e => { e.preventDefault(); saveSettings(anFormPatch(), $('#an-msg')); });
$('#an-apply-now').addEventListener('click', async () => { if (await saveSettings(anFormPatch(), $('#an-msg'))) act('/api/agent/new-session')(); });

// ---- boot -----------------------------------------------------------------------------------

let booted = false;
async function boot() {
  try {
    renderStatus(await api('/api/status'));
  } catch { return; } // login shown
  if (booted) return;
  booted = true;
  for (const ev of await api('/api/events')) addEvent(ev);
  await finishOpenRouterLogin();
  api('/api/anthropic/models').then(list => { anthropicModels = list; renderModelCard(true); }).catch(() => {});
  loadModels();
  loadAccount();
  setInterval(() => loadAccount(), 60_000);
  connectStream();
  pollWorld();
  drawChart();
  loadRuns();
  setInterval(pollWorld, 1000);
  setInterval(drawChart, 30_000);
  setInterval(loadClientLog, 3000);
}

boot();
