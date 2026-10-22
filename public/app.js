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

  $('#agent-detail').textContent = agent.detail || '';
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

// ---- boot -----------------------------------------------------------------------------------

let booted = false;
async function boot() {
  try {
    renderStatus(await api('/api/status'));
  } catch { return; } // login shown
  if (booted) return;
  booted = true;
  for (const ev of await api('/api/events')) addEvent(ev);
  connectStream();
  pollWorld();
  drawChart();
  loadRuns();
  setInterval(pollWorld, 1000);
  setInterval(drawChart, 30_000);
  setInterval(loadClientLog, 3000);
}

boot();
