/* ═══════════════════════════════════════════════════════════════════════
   VFORCE RC BASE STATION — PC DASHBOARD CONTROLLER
   Handles Model Configuration, Layout Builder, Live 16-Channel Telemetry,
   Expo/Curves Visualizer, Mixing, and WebSocket Link.
   ═══════════════════════════════════════════════════════════════════════ */

let modelsData = { active_model: "default_car", models: {} };
let currentModelId = "";
let selectedElementId = null;
let activeCurveChannel = 1;
let ws = null;
let wsPingStart = 0;

// Default initial channel telemetry
let liveChannels = {};
let liveChannelsUs = {};
for (let i = 1; i <= 16; i++) {
  liveChannels[String(i)] = 0.0;
  liveChannelsUs[String(i)] = 1500;
}

// ── DOM Initialization ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initCurveCanvas();
  initEvents();
  loadData();
  connectWebSocket();
});

// ── Tab Navigation ───────────────────────────────────────────────────
function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      const targetContent = document.getElementById(targetId);
      if (targetContent) {
        targetContent.classList.add('active');
      }

      if (targetId === 'tab-curves') {
        drawExpoCurve();
      }
    });
  });
}

// ── Data Fetching ────────────────────────────────────────────────────
async function loadData() {
  try {
    // Network Info
    const netRes = await fetch('/api/network');
    const net = await netRes.json();
    const phoneUrl = `${net.protocol}://${net.ip}:${net.port}/mobile`;
    const urlDisplay = document.getElementById('phone-url-display');
    if (urlDisplay) urlDisplay.innerText = phoneUrl;

    // Output Config
    const outRes = await fetch('/api/output');
    const outCfg = await outRes.json();
    populateOutputConfig(outCfg);

    // Models
    const mRes = await fetch('/api/models');
    modelsData = await mRes.json();
    currentModelId = modelsData.active_model || Object.keys(modelsData.models)[0];

    renderModelSelect();
    loadModel(currentModelId);
    buildMonitorGrid();
    buildCurvePills();
  } catch (err) {
    console.error("Failed to load initial data", err);
  }
}

function populateOutputConfig(cfg) {
  const enabled = document.getElementById('out-udp-enabled');
  const ip = document.getElementById('out-target-ip');
  const port = document.getElementById('out-target-port');
  const proto = document.getElementById('out-protocol');

  if (enabled) enabled.checked = !!cfg.enabled;
  if (ip) ip.value = cfg.target_ip || "192.168.4.1";
  if (port) port.value = cfg.target_port || 8888;
  if (proto) proto.value = cfg.protocol || "udp_raw_us";
}

// ── WebSocket Connection & Channel Streaming ─────────────────────────
function connectWebSocket() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${window.location.host}/ws`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log("[WS] Connected to base station.");
    wsPingStart = Date.now();
    ws.send(JSON.stringify({ type: "role", role: "dashboard" }));
    ws.send(JSON.stringify({ type: "ping" }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "channels") {
        updateMonitorBars(msg.channels, msg.channels_us);
      } else if (msg.type === "init") {
        updateMonitorBars(msg.channels, msg.channels_us);
      } else if (msg.type === "pong") {
        const latency = Date.now() - wsPingStart;
        const latencyEl = document.getElementById('ws-latency');
        if (latencyEl) latencyEl.innerText = `${latency} ms`;
        setTimeout(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            wsPingStart = Date.now();
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 3000);
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    console.log("[WS] Disconnected. Reconnecting in 2s...");
    setTimeout(connectWebSocket, 2000);
  };
}

// ── Model Selection & Switching ──────────────────────────────────────
function getActiveModel() {
  if (!modelsData.models[currentModelId]) {
    const keys = Object.keys(modelsData.models);
    if (keys.length > 0) currentModelId = keys[0];
  }
  return modelsData.models[currentModelId] || null;
}

function renderModelSelect() {
  const sel = document.getElementById('model-select');
  if (!sel) return;
  sel.innerHTML = '';
  Object.keys(modelsData.models).forEach(id => {
    const m = modelsData.models[id];
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = m.name || id;
    if (id === currentModelId) opt.selected = true;
    sel.appendChild(opt);
  });
}

function loadModel(modelId) {
  currentModelId = modelId;
  modelsData.active_model = modelId;
  const model = getActiveModel();
  if (!model) return;

  // Initialize missing structures
  model.elements = model.elements || [];
  model.channel_map = model.channel_map || {};
  model.trims = model.trims || {};
  model.rates = model.rates || {};
  model.expo = model.expo || {};
  model.endpoints = model.endpoints || {};
  model.mixing = model.mixing || [];
  model.failsafe = model.failsafe || {};

  // Update Model Meta
  const nameInput = document.getElementById('model-name-input');
  const chCount = document.getElementById('model-channels-count');
  if (nameInput) nameInput.value = model.name || "";
  if (chCount) chCount.value = String(model.channels || 16);

  selectedElementId = null;
  renderCanvasElements();
  renderPropsPanel();
  renderMappingsTable();
  loadCurveChannel(activeCurveChannel);
  renderMixesList();
  renderEndpointsTable();
}

// ── Visual Layout Designer (Phone Canvas) ────────────────────────────
function renderCanvasElements() {
  const canvas = document.getElementById('editor-canvas');
  if (!canvas) return;
  canvas.innerHTML = '';

  const model = getActiveModel();
  if (!model) return;

  model.elements.forEach(el => {
    const dom = document.createElement('div');
    dom.className = `canvas-el ${el.type}`;
    if (el.id === selectedElementId) dom.classList.add('selected');
    dom.dataset.id = el.id;

    dom.style.left = `${el.x}%`;
    dom.style.top = `${el.y}%`;
    dom.style.width = `${el.width}%`;
    dom.style.height = `${el.height}%`;

    // Render stylized visual representations
    let visualHtml = '';
    if (el.type === 'stick') {
      visualHtml = `<div class="stick-gimbal"><div class="stick-nub"></div></div>`;
    } else if (el.type === 'slider') {
      visualHtml = `<div class="slider-track"><div class="slider-handle"></div></div>`;
    } else if (el.type === 'switch-2pos' || el.type === 'switch-3pos') {
      visualHtml = `<div class="switch-lever"><div class="switch-bat"></div></div>`;
    } else if (el.type === 'button') {
      visualHtml = `<div class="btn-cap"></div>`;
    } else if (el.type === 'knob') {
      visualHtml = `<div class="knob-ring"><div class="knob-dot"></div></div>`;
    }

    dom.innerHTML = `
      <span class="canvas-el-label">${el.text || el.type}</span>
      ${visualHtml}
    `;

    // Click to select
    dom.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      selectElement(el.id);
      startDragElement(e, el, dom, canvas);
    });

    canvas.appendChild(dom);
  });

  // Clicking empty canvas deselects
  canvas.onmousedown = (e) => {
    if (e.target === canvas) selectElement(null);
  };
}

function selectElement(id) {
  selectedElementId = id;
  const canvas = document.getElementById('editor-canvas');
  if (canvas) {
    canvas.querySelectorAll('.canvas-el').forEach(el => {
      el.classList.toggle('selected', el.dataset.id === id);
    });
  }
  renderPropsPanel();
}

function renderPropsPanel() {
  const form = document.getElementById('props-form');
  const empty = document.getElementById('props-empty-hint');
  const delBtn = document.getElementById('btn-del-element');
  const model = getActiveModel();

  const el = model ? model.elements.find(e => e.id === selectedElementId) : null;

  if (!el) {
    if (form) form.style.display = 'none';
    if (empty) empty.style.display = 'block';
    if (delBtn) delBtn.style.display = 'none';
    return;
  }

  if (form) form.style.display = 'flex';
  if (empty) empty.style.display = 'none';
  if (delBtn) delBtn.style.display = 'inline-flex';

  document.getElementById('prop-label').value = el.text || "";
  document.getElementById('prop-w').value = Math.round(el.width);
  document.getElementById('prop-h').value = Math.round(el.height);
  document.getElementById('prop-x').value = Math.round(el.x);
  document.getElementById('prop-y').value = Math.round(el.y);

  // Stick return-to-center / throttle mode row
  const stickHoldRow = document.getElementById('row-prop-stick-hold');
  const stickHoldSelect = document.getElementById('prop-stick-hold');
  if (stickHoldRow && stickHoldSelect) {
    if (el.type === 'stick') {
      stickHoldRow.style.display = 'flex';
      stickHoldSelect.value = el.hold_axis || 'none';
    } else {
      stickHoldRow.style.display = 'none';
    }
  }
}

function startDragElement(e, el, dom, canvas) {
  const rect = canvas.getBoundingClientRect();
  const startMouseX = e.clientX;
  const startMouseY = e.clientY;
  const startX = el.x;
  const startY = el.y;

  function onMouseMove(ev) {
    const deltaX = ((ev.clientX - startMouseX) / rect.width) * 100;
    const deltaY = ((ev.clientY - startMouseY) / rect.height) * 100;

    let newX = Math.max(0, Math.min(100 - el.width, startX + deltaX));
    let newY = Math.max(0, Math.min(100 - el.height, startY + deltaY));

    el.x = Math.round(newX);
    el.y = Math.round(newY);

    dom.style.left = `${el.x}%`;
    dom.style.top = `${el.y}%`;

    const propX = document.getElementById('prop-x');
    const propY = document.getElementById('prop-y');
    if (propX) propX.value = el.x;
    if (propY) propY.value = el.y;
  }

  function onMouseUp() {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

// ── Channel Mappings Table ───────────────────────────────────────────
function renderMappingsTable() {
  const tbody = document.getElementById('mappings-tbody');
  const countBadge = document.getElementById('mapping-count');
  if (!tbody) return;
  tbody.innerHTML = '';

  const model = getActiveModel();
  if (!model) return;

  const map = model.channel_map;
  let count = 0;

  model.elements.forEach(el => {
    let inputs = [];
    if (el.type === 'stick') {
      inputs = [
        { key: `${el.id}_x`, label: `${el.text || 'Stick'} (X-Axis)` },
        { key: `${el.id}_y`, label: `${el.text || 'Stick'} (Y-Axis)` }
      ];
    } else {
      inputs = [{ key: el.id, label: `${el.text || el.type}` }];
    }

    inputs.forEach(inp => {
      count++;
      const currentMapping = map[inp.key] || { channel: 1, reversed: false };
      const tr = document.createElement('tr');

      // Build CH options
      let chOptions = '';
      for (let ch = 1; ch <= 16; ch++) {
        chOptions += `<option value="${ch}" ${currentMapping.channel === ch ? 'selected' : ''}>CH ${ch}</option>`;
      }

      tr.innerHTML = `
        <td style="font-weight:600;">${inp.label}</td>
        <td>
          <select data-key="${inp.key}" class="map-ch-select">
            ${chOptions}
          </select>
        </td>
        <td>
          <input type="checkbox" data-key="${inp.key}" class="map-inv-check clay-toggle" ${currentMapping.reversed ? 'checked' : ''}>
        </td>
      `;

      tbody.appendChild(tr);
    });
  });

  if (countBadge) countBadge.innerText = `${count} Mapped`;

  // Bind change events
  tbody.querySelectorAll('.map-ch-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const k = e.target.dataset.key;
      map[k] = map[k] || {};
      map[k].channel = parseInt(e.target.value, 10);
    });
  });

  tbody.querySelectorAll('.map-inv-check').forEach(chk => {
    chk.addEventListener('change', (e) => {
      const k = e.target.dataset.key;
      map[k] = map[k] || {};
      map[k].reversed = e.target.checked;
    });
  });
}

// ── 16-Channel Live Monitor ──────────────────────────────────────────
function buildMonitorGrid() {
  const grid = document.getElementById('channel-monitor-grid');
  if (!grid) return;
  grid.innerHTML = '';

  for (let ch = 1; ch <= 16; ch++) {
    const card = document.createElement('div');
    card.className = 'ch-card';
    card.id = `ch-card-${ch}`;

    card.innerHTML = `
      <div class="ch-card-header">
        <div class="ch-title">
          <span class="ch-badge">CH ${ch}</span>
          <span class="ch-name" id="ch-name-${ch}">Channel ${ch}</span>
        </div>
        <div class="ch-values">
          <span class="ch-pct" id="ch-pct-${ch}">0%</span>
          <span class="ch-us" id="ch-us-${ch}">1500 µs</span>
        </div>
      </div>
      <div class="ch-bar-track">
        <div class="ch-center-mark"></div>
        <div class="ch-bar-fill" id="ch-bar-${ch}" style="left: 50%; width: 0%;"></div>
      </div>
    `;

    grid.appendChild(card);
  }
}

function updateMonitorBars(channels, channelsUs) {
  if (!channels) return;

  for (let ch = 1; ch <= 16; ch++) {
    const key = String(ch);
    const val = channels[key] !== undefined ? channels[key] : 0.0;
    const us = channelsUs ? channelsUs[ch - 1] : Math.round(1500 + val * 500);

    const pctEl = document.getElementById(`ch-pct-${ch}`);
    const usEl = document.getElementById(`ch-us-${ch}`);
    const barEl = document.getElementById(`ch-bar-${ch}`);

    if (pctEl) pctEl.innerText = `${Math.round(val * 100)}%`;
    if (usEl) usEl.innerText = `${us} µs`;

    if (barEl) {
      if (val >= 0) {
        barEl.style.left = '50%';
        barEl.style.width = `${Math.min(50, val * 50)}%`;
      } else {
        const w = Math.min(50, Math.abs(val) * 50);
        barEl.style.left = `${50 - w}%`;
        barEl.style.width = `${w}%`;
      }
    }
  }
}

// ── Trims & Exponential Curves Visualizer ────────────────────────────
function buildCurvePills() {
  const container = document.getElementById('curves-channel-pills');
  if (!container) return;
  container.innerHTML = '';

  for (let ch = 1; ch <= 16; ch++) {
    const btn = document.createElement('button');
    btn.className = `ch-pill-btn ${ch === activeCurveChannel ? 'active' : ''}`;
    btn.innerText = `CH ${ch}`;
    btn.addEventListener('click', () => {
      container.querySelectorAll('.ch-pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadCurveChannel(ch);
    });
    container.appendChild(btn);
  }
}

function loadCurveChannel(ch) {
  activeCurveChannel = ch;
  const title = document.getElementById('active-curve-channel-title');
  if (title) title.innerText = `CH ${ch} Configuration`;

  const model = getActiveModel();
  if (!model) return;

  const k = String(ch);
  const trim = model.trims[k] || 0;
  const rate = model.rates[k] !== undefined ? model.rates[k] : 100;
  const expo = model.expo[k] || 0;

  document.getElementById('slider-trim').value = trim;
  document.getElementById('val-trim').innerText = `${trim}%`;

  document.getElementById('slider-rate').value = rate;
  document.getElementById('val-rate').innerText = `${rate}%`;

  document.getElementById('slider-expo').value = expo;
  document.getElementById('val-expo').innerText = `${expo}%`;

  drawExpoCurve();
}

function initCurveCanvas() {
  const canvas = document.getElementById('curve-canvas');
  if (!canvas) return;
  drawExpoCurve();
}

function drawExpoCurve() {
  const canvas = document.getElementById('curve-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  const model = getActiveModel();
  const k = String(activeCurveChannel);
  const expoPct = model && model.expo[k] !== undefined ? model.expo[k] : 0;
  const ratePct = model && model.rates[k] !== undefined ? model.rates[k] : 100;
  const trimPct = model && model.trims[k] !== undefined ? model.trims[k] : 0;

  const cx = w / 2;
  const cy = h / 2;
  const scaleX = (w - 40) / 2;
  const scaleY = (h - 40) / 2;

  // Grid lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);

  // Center axes
  ctx.beginPath();
  ctx.moveTo(20, cy);
  ctx.lineTo(w - 20, cy);
  ctx.moveTo(cx, 20);
  ctx.lineTo(cx, h - 20);
  ctx.stroke();

  // Linear Reference
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(cx - scaleX, cy + scaleY);
  ctx.lineTo(cx + scaleX, cy - scaleY);
  ctx.stroke();

  ctx.setLineDash([]);

  // Active Exponential Curve
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 3;
  ctx.beginPath();

  const e = expoPct / 100.0;
  const r = ratePct / 100.0;
  const t = trimPct / 100.0;

  for (let px = -scaleX; px <= scaleX; px += 2) {
    const x = px / scaleX; // -1 to +1
    // Standard expo formula: (1 - e) * x + e * x^3
    let y = (1.0 - e) * x + e * (x ** 3);
    y = y * r + t;
    y = Math.max(-1.0, Math.min(1.0, y));

    const plotX = cx + px;
    const plotY = cy - y * scaleY;

    if (px === -scaleX) ctx.moveTo(plotX, plotY);
    else ctx.lineTo(plotX, plotY);
  }
  ctx.stroke();
}

// ── Programmable Mixing ──────────────────────────────────────────────
function renderMixesList() {
  const container = document.getElementById('mixes-container');
  if (!container) return;
  container.innerHTML = '';

  const model = getActiveModel();
  if (!model || !model.mixing || model.mixing.length === 0) {
    container.innerHTML = `<div class="empty-hint">No channel mixes active. Click "+ Add Mix" or select a preset below.</div>`;
    return;
  }

  model.mixing.forEach((mix, index) => {
    const card = document.createElement('div');
    card.className = 'mix-card';
    card.innerHTML = `
      <div class="mix-rule">
        <span>CH ${mix.source || 1}</span>
        <span class="mix-arrow">➔</span>
        <span>CH ${mix.destination || 2}</span>
        <span style="color:var(--text-dim); margin-left:10px;">Weight:</span>
        <input type="number" class="clay-input mix-weight" data-idx="${index}" value="${mix.weight !== undefined ? mix.weight : 100}" style="width:70px;">
        <span>%</span>
      </div>
      <button class="clay-btn mini danger mix-del" data-idx="${index}">✕</button>
    `;

    container.appendChild(card);
  });

  container.querySelectorAll('.mix-weight').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      model.mixing[idx].weight = parseInt(e.target.value, 10);
    });
  });

  container.querySelectorAll('.mix-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      model.mixing.splice(idx, 1);
      renderMixesList();
    });
  });
}

// ── Endpoints & Failsafe ──────────────────────────────────────────────
function renderEndpointsTable() {
  const tbody = document.getElementById('endpoints-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const model = getActiveModel();
  if (!model) return;

  for (let ch = 1; ch <= 16; ch++) {
    const k = String(ch);
    const ep = model.endpoints[k] || { min: -100, max: 100 };
    const fs = model.failsafe[k] !== undefined ? model.failsafe[k] : 0;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:700;">CH ${ch}</td>
      <td>
        <input type="number" class="clay-input ep-min" data-ch="${ch}" value="${ep.min}" min="-100" max="0" style="width:75px;"> %
      </td>
      <td>
        <input type="number" class="clay-input ep-max" data-ch="${ch}" value="${ep.max}" min="0" max="100" style="width:75px;"> %
      </td>
      <td>
        <input type="number" class="clay-input ep-fs" data-ch="${ch}" value="${fs}" min="-100" max="100" style="width:75px;"> %
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.ep-min').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const ch = e.target.dataset.ch;
      model.endpoints[ch] = model.endpoints[ch] || { min: -100, max: 100 };
      model.endpoints[ch].min = parseInt(e.target.value, 10);
    });
  });

  tbody.querySelectorAll('.ep-max').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const ch = e.target.dataset.ch;
      model.endpoints[ch] = model.endpoints[ch] || { min: -100, max: 100 };
      model.endpoints[ch].max = parseInt(e.target.value, 10);
    });
  });

  tbody.querySelectorAll('.ep-fs').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const ch = e.target.dataset.ch;
      model.failsafe[ch] = parseInt(e.target.value, 10);
    });
  });
}

// ── Global Event Listeners ───────────────────────────────────────────
function initEvents() {
  // Model Select Dropdown
  const modelSel = document.getElementById('model-select');
  if (modelSel) {
    modelSel.addEventListener('change', (e) => {
      loadModel(e.target.value);
    });
  }

  // Model Meta Inputs
  const nameInput = document.getElementById('model-name-input');
  if (nameInput) {
    nameInput.addEventListener('input', (e) => {
      const model = getActiveModel();
      if (model) {
        model.name = e.target.value;
        const opt = document.querySelector(`#model-select option[value="${currentModelId}"]`);
        if (opt) opt.textContent = model.name;
      }
    });
  }

  const chCount = document.getElementById('model-channels-count');
  if (chCount) {
    chCount.addEventListener('change', (e) => {
      const model = getActiveModel();
      if (model) model.channels = parseInt(e.target.value, 10);
    });
  }

  // Element Properties inputs
  ['prop-label', 'prop-w', 'prop-h', 'prop-x', 'prop-y'].forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('input', () => {
      const model = getActiveModel();
      if (!model || !selectedElementId) return;
      const el = model.elements.find(e => e.id === selectedElementId);
      if (!el) return;

      if (id === 'prop-label') el.text = input.value;
      if (id === 'prop-w') el.width = parseFloat(input.value) || 10;
      if (id === 'prop-h') el.height = parseFloat(input.value) || 10;
      if (id === 'prop-x') el.x = parseFloat(input.value) || 0;
      if (id === 'prop-y') el.y = parseFloat(input.value) || 0;

      renderCanvasElements();
      renderMappingsTable();
    });
  });

  const stickHoldSelect = document.getElementById('prop-stick-hold');
  if (stickHoldSelect) {
    stickHoldSelect.addEventListener('change', (e) => {
      const model = getActiveModel();
      if (!model || !selectedElementId) return;
      const el = model.elements.find(item => item.id === selectedElementId);
      if (el && el.type === 'stick') {
        el.hold_axis = e.target.value;
      }
    });
  }

  // Add Element button
  const addBtn = document.getElementById('btn-add-element');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const type = document.getElementById('add-element-type').value;
      const model = getActiveModel();
      if (!model) return;

      const newId = `el_${type}_${Date.now().toString(36)}`;
      let w = 20, h = 30;
      if (type === 'stick') { w = 36; h = 64; }
      else if (type === 'slider') { w = 15; h = 64; }
      else if (type === 'switch-2pos' || type === 'switch-3pos') { w = 12; h = 26; }
      else if (type === 'button') { w = 14; h = 24; }
      else if (type === 'knob') { w = 18; h = 30; }

      const newEl = {
        id: newId,
        type: type,
        x: 40,
        y: 35,
        width: w,
        height: h,
        text: type.toUpperCase()
      };

      model.elements.push(newEl);

      // Default channel mapping
      if (type === 'stick') {
        model.channel_map[`${newId}_x`] = { channel: 1, reversed: false };
        model.channel_map[`${newId}_y`] = { channel: 2, reversed: false };
      } else {
        model.channel_map[newId] = { channel: 3, reversed: false };
      }

      renderCanvasElements();
      selectElement(newId);
      renderMappingsTable();
    });
  }

  // Delete Element button
  const delElBtn = document.getElementById('btn-del-element');
  if (delElBtn) {
    delElBtn.addEventListener('click', () => {
      const model = getActiveModel();
      if (!model || !selectedElementId) return;
      model.elements = model.elements.filter(e => e.id !== selectedElementId);
      delete model.channel_map[selectedElementId];
      delete model.channel_map[`${selectedElementId}_x`];
      delete model.channel_map[`${selectedElementId}_y`];
      selectElement(null);
      renderCanvasElements();
      renderMappingsTable();
    });
  }

  // New Model button
  document.getElementById('btn-new-model').addEventListener('click', () => {
    const name = prompt("Enter model name (e.g., FPV Drone 6CH):", "New RC Model");
    if (!name) return;
    const newId = `model_${Date.now().toString(36)}`;
    modelsData.models[newId] = {
      name: name,
      channels: 8,
      elements: [
        { id: "el_stick_1", type: "stick", x: 6, y: 18, width: 38, height: 66, text: "Gimbal Left" },
        { id: "el_stick_2", type: "stick", x: 56, y: 18, width: 38, height: 66, text: "Gimbal Right" }
      ],
      channel_map: {
        "el_stick_1_x": { channel: 4, reversed: false },
        "el_stick_1_y": { channel: 3, reversed: false },
        "el_stick_2_x": { channel: 1, reversed: false },
        "el_stick_2_y": { channel: 2, reversed: false }
      },
      trims: {},
      rates: {},
      expo: {},
      endpoints: {},
      mixing: [],
      failsafe: { "3": -100 }
    };
    renderModelSelect();
    loadModel(newId);
    showToast(`Created ${name}`);
  });

  // Duplicate Model button
  document.getElementById('btn-dup-model').addEventListener('click', () => {
    const model = getActiveModel();
    if (!model) return;
    const dupId = `model_${Date.now().toString(36)}`;
    const copy = JSON.parse(JSON.stringify(model));
    copy.name = `${copy.name} (Copy)`;
    modelsData.models[dupId] = copy;
    renderModelSelect();
    loadModel(dupId);
    showToast("Model duplicated");
  });

  // Delete Model button
  document.getElementById('btn-del-model').addEventListener('click', () => {
    const keys = Object.keys(modelsData.models);
    if (keys.length <= 1) {
      alert("Cannot delete the only model.");
      return;
    }
    if (confirm(`Delete model "${getActiveModel()?.name}"?`)) {
      delete modelsData.models[currentModelId];
      currentModelId = Object.keys(modelsData.models)[0];
      renderModelSelect();
      loadModel(currentModelId);
      showToast("Model deleted");
    }
  });

  // Trim, Rate, Expo Sliders
  document.getElementById('slider-trim').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    document.getElementById('val-trim').innerText = `${val}%`;
    const model = getActiveModel();
    if (model) model.trims[String(activeCurveChannel)] = val;
    drawExpoCurve();
  });

  document.getElementById('slider-rate').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    document.getElementById('val-rate').innerText = `${val}%`;
    const model = getActiveModel();
    if (model) model.rates[String(activeCurveChannel)] = val;
    drawExpoCurve();
  });

  document.getElementById('slider-expo').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    document.getElementById('val-expo').innerText = `${val}%`;
    const model = getActiveModel();
    if (model) model.expo[String(activeCurveChannel)] = val;
    drawExpoCurve();
  });

  // Add Mix button
  document.getElementById('btn-add-mix').addEventListener('click', () => {
    const model = getActiveModel();
    if (!model) return;
    model.mixing.push({ source: 1, destination: 2, weight: 50, offset: 0 });
    renderMixesList();
  });

  // Mix Presets
  document.getElementById('btn-preset-elevon').addEventListener('click', () => {
    const model = getActiveModel();
    if (!model) return;
    // Elevon: Ail CH1 + Ele CH2 mixed into CH1 & CH2
    model.mixing = [
      { source: 1, destination: 1, weight: 50, offset: 0 },
      { source: 2, destination: 1, weight: 50, offset: 0 },
      { source: 1, destination: 2, weight: -50, offset: 0 },
      { source: 2, destination: 2, weight: 50, offset: 0 }
    ];
    renderMixesList();
    showToast("Elevon preset loaded");
  });

  document.getElementById('btn-preset-vtail').addEventListener('click', () => {
    const model = getActiveModel();
    if (!model) return;
    // V-Tail: Rudder CH4 + Elevator CH2
    model.mixing = [
      { source: 2, destination: 2, weight: 50, offset: 0 },
      { source: 4, destination: 2, weight: 50, offset: 0 },
      { source: 2, destination: 4, weight: 50, offset: 0 },
      { source: 4, destination: 4, weight: -50, offset: 0 }
    ];
    renderMixesList();
    showToast("V-Tail preset loaded");
  });

  document.getElementById('btn-preset-diff').addEventListener('click', () => {
    const model = getActiveModel();
    if (!model) return;
    // Differential Steering: Throttle CH3 + Steering CH1 -> Left Motor CH3, Right Motor CH2
    model.mixing = [
      { source: 3, destination: 3, weight: 100, offset: 0 },
      { source: 1, destination: 3, weight: 50, offset: 0 },
      { source: 3, destination: 2, weight: 100, offset: 0 },
      { source: 1, destination: 2, weight: -50, offset: 0 }
    ];
    renderMixesList();
    showToast("Diff Steering preset loaded");
  });

  // Save Output Config
  document.getElementById('btn-save-output').addEventListener('click', async () => {
    const cfg = {
      enabled: document.getElementById('out-udp-enabled').checked,
      target_ip: document.getElementById('out-target-ip').value.trim(),
      target_port: parseInt(document.getElementById('out-target-port').value, 10),
      protocol: document.getElementById('out-protocol').value
    };
    try {
      await fetch('/api/output', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg)
      });
      showToast("Receiver output settings saved");
    } catch (e) {
      alert("Failed to save output config");
    }
  });

  // Copy Phone URL
  document.getElementById('btn-copy-url').addEventListener('click', () => {
    const url = document.getElementById('phone-url-display').innerText;
    navigator.clipboard.writeText(url);
    showToast("Phone link copied to clipboard!");
  });

  // Save All Changes (Models)
  document.getElementById('btn-save').addEventListener('click', async () => {
    try {
      await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelsData)
      });
      showToast("All model changes saved!");
    } catch (e) {
      alert("Failed to save models");
    }
  });

  // Quit VForce
  document.getElementById('btn-quit').addEventListener('click', async () => {
    if (confirm("Shutdown VForce Base Station?")) {
      try {
        await fetch('/api/shutdown', { method: 'POST' });
        window.close();
      } catch (e) {}
    }
  });
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.innerText = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}
