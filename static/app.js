/* ═══════════════════════════════════════════════════════════════════════
   VFORCE RC TRANSMITTER — MOBILE CONTROLLER ENGINE
   Multi-Touch RC Element Handling, 60Hz Low-Latency Telemetry Streaming,
   Square-Bounds Gimbal, Throttle Hold Axis, and Zero UI Overlap.
   ═══════════════════════════════════════════════════════════════════════ */

let ws = null;
let isConnected = false;
let activeModelData = null;
let sendTimer = null;
let pingInterval = null;
let pingStart = 0;
let reconnectTimer = null;

// Input packet state sent to base station
const inputState = {
  axes: {},
  buttons: {},
  switches: {}
};

// Pointer tracking map for independent multi-touch
const activePointers = new Map();

// ── DOM Initialization ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
  fetchActiveModel();

  async function requestFullscreenSafe() {
    try {
      if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        } else if (document.documentElement.webkitRequestFullscreen) {
          await document.documentElement.webkitRequestFullscreen();
        }
      }
    } catch (e) {}
  }

  // Auto request fullscreen on first interaction anywhere
  document.addEventListener('pointerdown', () => {
    requestFullscreenSafe();
  }, { once: true });

  document.getElementById('btn-start').addEventListener('click', async () => {
    await requestFullscreenSafe();

    // Lock screen orientation to landscape if supported
    try {
      if (screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock('landscape');
      }
    } catch (e) {}

    showScreen('tx-screen');
  });

  const btnTxFs = document.getElementById('btn-tx-fullscreen');
  if (btnTxFs) {
    btnTxFs.addEventListener('click', async () => {
      if (!document.fullscreenElement) {
        await requestFullscreenSafe();
      } else {
        try { if (document.exitFullscreen) await document.exitFullscreen(); } catch (e) {}
      }
    });
  }

  document.getElementById('btn-exit').addEventListener('click', () => {
    try {
      if (document.exitFullscreen) document.exitFullscreen();
    } catch (e) {}
    showScreen('setup-screen');
  });

  document.getElementById('btn-recenter').addEventListener('click', () => {
    recenterAllSticks();
  });
});

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(screenId);
  if (target) target.classList.add('active');

  if (screenId === 'tx-screen') {
    startInputLoop();
  } else {
    stopInputLoop();
  }
}

// ── Fetch Model Configuration ────────────────────────────────────────
async function fetchActiveModel() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    const activeId = data.active_model;
    activeModelData = data.models[activeId];

    if (activeModelData) {
      const nameEl = document.getElementById('mobile-model-name');
      const hudModel = document.getElementById('tx-hud-model');
      if (nameEl) nameEl.innerText = activeModelData.name || "RC Model";
      if (hudModel) hudModel.innerText = activeModelData.name || "RC Model";

      renderControlsSurface(activeModelData);
    }
  } catch (err) {
    console.error("Failed to fetch model:", err);
  }
}

// ── WebSocket Link with Auto-Reconnect & Heartbeat ────────────────────
function connectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${window.location.host}/ws`;

  try {
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  } catch (e) {}

  ws = new WebSocket(url);

  ws.onopen = () => {
    isConnected = true;
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    if (dot) dot.classList.add('connected');
    if (txt) txt.innerText = 'Connected & Linked';

    // Declare role as controller
    try {
      ws.send(JSON.stringify({ type: "role", role: "controller" }));
    } catch (e) {}

    // Start latency pings
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        pingStart = Date.now();
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 2500);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "pong") {
        const ping = Date.now() - pingStart;
        const pingEl = document.getElementById('tx-hud-ping');
        if (pingEl) pingEl.innerText = `${ping} ms`;
      } else if (msg.type === "model_updated") {
        fetchActiveModel();
      }
    } catch (e) {}
  };

  ws.onerror = () => {
    try { ws.close(); } catch (e) {}
  };

  ws.onclose = () => {
    isConnected = false;
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    if (dot) dot.classList.remove('connected');
    if (txt) txt.innerText = 'Reconnecting to Base Station...';

    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
      }, 1500);
    }
  };
}

// Automatically reconnect when phone wakes up or tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
  }
});

// ── 60Hz Input Transmission Loop ─────────────────────────────────────
function startInputLoop() {
  if (sendTimer) clearInterval(sendTimer);
  sendTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "input",
        axes: inputState.axes,
        buttons: inputState.buttons,
        switches: inputState.switches
      }));
    }
  }, 16); // ~60 Hz
}

function stopInputLoop() {
  if (sendTimer) clearInterval(sendTimer);
  sendTimer = null;
  // Send neutral on disarm
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "input",
      axes: {},
      buttons: {},
      switches: {}
    }));
  }
}

// ── Render Dynamic Controls on Screen (No Text Overlap) ──────────────
function renderControlsSurface(model) {
  const surface = document.getElementById('controls-surface');
  if (!surface) return;
  surface.innerHTML = '';

  // Reset inputs
  inputState.axes = {};
  inputState.buttons = {};
  inputState.switches = {};

  if (!model.elements || model.elements.length === 0) {
    surface.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#64748b;font-weight:600;">No controls configured for this model. Add elements in the PC dashboard.</div>`;
    return;
  }

  model.elements.forEach(el => {
    const elContainer = document.createElement('div');
    elContainer.className = `rc-element ${el.type}`;
    elContainer.id = `el-${el.id}`;

    elContainer.style.left = `${el.x}%`;
    elContainer.style.top = `${el.y}%`;
    elContainer.style.width = `${el.width}%`;
    elContainer.style.height = `${el.height}%`;

    // Render by type (NO text labels on mobile!)
    if (el.type === 'stick') {
      setupStickElement(el, elContainer);
    } else if (el.type === 'slider') {
      setupSliderElement(el, elContainer);
    } else if (el.type === 'switch-2pos') {
      setupSwitch2PosElement(el, elContainer);
    } else if (el.type === 'switch-3pos') {
      setupSwitch3PosElement(el, elContainer);
    } else if (el.type === 'button') {
      setupButtonElement(el, elContainer);
    } else if (el.type === 'knob') {
      setupKnobElement(el, elContainer);
    }

    surface.appendChild(elContainer);
  });
}

// ── 1. Square-Bounds Gimbal with Throttle Hold Support ────────────────
function setupStickElement(el, container) {
  // Pure control surface without overlapping text labels
  container.innerHTML = `
    <div class="stick-dish" id="dish-${el.id}">
      <div class="stick-thumb" id="thumb-${el.id}"></div>
    </div>
  `;

  const dish = container.querySelector(`#dish-${el.id}`);
  const thumb = container.querySelector(`#thumb-${el.id}`);

  let currentDx = 0;
  let currentDy = 0;

  inputState.axes[`${el.id}_x`] = 0.0;
  inputState.axes[`${el.id}_y`] = 0.0;

  function updateStickPosition(e) {
    const rect = dish.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Square travel area: independent travel for X and Y
    const maxTravelX = (rect.width / 2) - 24;
    const maxTravelY = (rect.height / 2) - 24;

    let dx = e.clientX - centerX;
    let dy = e.clientY - centerY;

    // Square clamping: full deflection on both axes simultaneously!
    dx = Math.max(-maxTravelX, Math.min(maxTravelX, dx));
    dy = Math.max(-maxTravelY, Math.min(maxTravelY, dy));

    currentDx = dx;
    currentDy = dy;
    thumb.style.transform = `translate(${dx}px, ${dy}px)`;

    const normX = dx / maxTravelX;
    const normY = -(dy / maxTravelY); // Up is positive

    inputState.axes[`${el.id}_x`] = parseFloat(normX.toFixed(4));
    inputState.axes[`${el.id}_y`] = parseFloat(normY.toFixed(4));
  }

  dish.addEventListener('pointerdown', (e) => {
    dish.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { type: 'stick', el });
    updateStickPosition(e);
  });

  dish.addEventListener('pointermove', (e) => {
    if (activePointers.has(e.pointerId)) {
      updateStickPosition(e);
    }
  });

  function releaseStick(e) {
    if (activePointers.has(e.pointerId)) {
      activePointers.delete(e.pointerId);

      const holdAxis = el.hold_axis || 'none';
      let targetDx = 0;
      let targetDy = 0;

      if (holdAxis === 'x') {
        // X acts like throttle slider: stays in position, Y returns to center
        targetDx = currentDx;
        targetDy = 0;
        inputState.axes[`${el.id}_y`] = 0.0;
      } else if (holdAxis === 'y') {
        // Y acts like throttle slider: stays in position, X returns to center
        targetDx = 0;
        targetDy = currentDy;
        inputState.axes[`${el.id}_x`] = 0.0;
      } else if (holdAxis === 'both') {
        targetDx = currentDx;
        targetDy = currentDy;
      } else {
        // Standard: both spring return to center
        targetDx = 0;
        targetDy = 0;
        inputState.axes[`${el.id}_x`] = 0.0;
        inputState.axes[`${el.id}_y`] = 0.0;
      }

      currentDx = targetDx;
      currentDy = targetDy;
      thumb.style.transform = `translate(${targetDx}px, ${targetDy}px)`;
    }
  }

  dish.addEventListener('pointerup', releaseStick);
  dish.addEventListener('pointercancel', releaseStick);
}

function recenterAllSticks() {
  document.querySelectorAll('.stick-thumb').forEach(thumb => {
    thumb.style.transform = 'translate(0px, 0px)';
  });
  Object.keys(inputState.axes).forEach(k => {
    if (k.endsWith('_x') || k.endsWith('_y')) {
      inputState.axes[k] = 0.0;
    }
  });
}

// ── 2. Throttle / Slider ─────────────────────────────────────────────
function setupSliderElement(el, container) {
  container.innerHTML = `
    <div class="slider-dish" id="dish-${el.id}">
      <div class="slider-center-tick"></div>
      <div class="slider-thumb" id="thumb-${el.id}"></div>
    </div>
  `;

  const dish = container.querySelector(`#dish-${el.id}`);
  const thumb = container.querySelector(`#thumb-${el.id}`);

  // Default throttle at minimum (-1.0)
  inputState.axes[el.id] = -1.0;

  dish.addEventListener('pointerdown', (e) => {
    dish.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { type: 'slider', el, dish, thumb });
    updateSliderPosition(e, el, dish, thumb);
  });

  dish.addEventListener('pointermove', (e) => {
    if (activePointers.has(e.pointerId)) {
      updateSliderPosition(e, el, dish, thumb);
    }
  });

  function releaseSlider(e) {
    activePointers.delete(e.pointerId);
    // Sliders stay where they are released (throttle behaviour)
  }

  dish.addEventListener('pointerup', releaseSlider);
  dish.addEventListener('pointercancel', releaseSlider);

  // Position thumb at bottom initially
  setTimeout(() => {
    const rect = dish.getBoundingClientRect();
    const halfTravel = (rect.height / 2) - 24;
    thumb.style.transform = `translateY(${halfTravel}px)`;
  }, 100);
}

function updateSliderPosition(e, el, dish, thumb) {
  const rect = dish.getBoundingClientRect();
  const centerY = rect.top + rect.height / 2;
  const halfTravel = (rect.height / 2) - 24;

  let dy = e.clientY - centerY;
  dy = Math.max(-halfTravel, Math.min(halfTravel, dy));

  thumb.style.transform = `translateY(${dy}px)`;

  // Normalized -1.0 at bottom to +1.0 at top
  const normVal = -(dy / halfTravel);
  inputState.axes[el.id] = parseFloat(normVal.toFixed(4));
}

// ── 3. 2-Position Toggle Switch ──────────────────────────────────────
function setupSwitch2PosElement(el, container) {
  let isUp = false;
  inputState.switches[el.id] = -1.0;

  container.innerHTML = `
    <div class="switch-panel" id="sw-${el.id}">
      <span class="switch-indicator-label">ON</span>
      <div class="switch-slot">
        <div class="switch-knob pos-down" id="knob-${el.id}"></div>
      </div>
      <span class="switch-indicator-label">OFF</span>
    </div>
  `;

  const panel = container.querySelector(`#sw-${el.id}`);
  const knob = container.querySelector(`#knob-${el.id}`);

  panel.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    isUp = !isUp;
    knob.className = `switch-knob ${isUp ? 'pos-up' : 'pos-down'}`;
    inputState.switches[el.id] = isUp ? 1.0 : -1.0;
  });
}

// ── 4. 3-Position Mode Switch ────────────────────────────────────────
function setupSwitch3PosElement(el, container) {
  let posIndex = 1; // 0 = UP (+1.0), 1 = MID (0.0), 2 = DOWN (-1.0)
  inputState.switches[el.id] = 0.0;

  container.innerHTML = `
    <div class="switch-panel" id="sw-${el.id}">
      <span class="switch-indicator-label">1</span>
      <div class="switch-slot">
        <div class="switch-knob pos-mid" id="knob-${el.id}"></div>
      </div>
      <span class="switch-indicator-label">3</span>
    </div>
  `;

  const panel = container.querySelector(`#sw-${el.id}`);
  const knob = container.querySelector(`#knob-${el.id}`);

  const positions = ['pos-up', 'pos-mid', 'pos-down'];
  const values = [1.0, 0.0, -1.0];

  panel.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    posIndex = (posIndex + 1) % 3;
    knob.className = `switch-knob ${positions[posIndex]}`;
    inputState.switches[el.id] = values[posIndex];
  });
}

// ── 5. Momentary Push Button ─────────────────────────────────────────
function setupButtonElement(el, container) {
  inputState.buttons[el.id] = false;

  container.innerHTML = `
    <div class="clay-push-btn" id="btn-${el.id}">ACT</div>
  `;

  const btn = container.querySelector(`#btn-${el.id}`);

  btn.addEventListener('pointerdown', (e) => {
    btn.setPointerCapture(e.pointerId);
    btn.classList.add('pressed');
    inputState.buttons[el.id] = true;
  });

  function releaseBtn(e) {
    btn.classList.remove('pressed');
    inputState.buttons[el.id] = false;
  }

  btn.addEventListener('pointerup', releaseBtn);
  btn.addEventListener('pointercancel', releaseBtn);
}

// ── 6. Rotary Knob ───────────────────────────────────────────────────
function setupKnobElement(el, container) {
  inputState.axes[el.id] = 0.0;
  let currentAngle = 0; // -135 to +135 deg

  container.innerHTML = `
    <div class="knob-body" id="knob-${el.id}">
      <div class="knob-pointer"></div>
    </div>
  `;

  const knob = container.querySelector(`#knob-${el.id}`);

  knob.addEventListener('pointerdown', (e) => {
    knob.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { type: 'knob', startY: e.clientY, startAngle: currentAngle });
  });

  knob.addEventListener('pointermove', (e) => {
    const ptr = activePointers.get(e.pointerId);
    if (ptr && ptr.type === 'knob') {
      const deltaY = ptr.startY - e.clientY;
      let newAngle = ptr.startAngle + deltaY * 1.5;
      newAngle = Math.max(-135, Math.min(135, newAngle));
      currentAngle = newAngle;
      knob.style.transform = `rotate(${currentAngle}deg)`;

      // Map -135..+135 to -1.0..+1.0
      inputState.axes[el.id] = parseFloat((currentAngle / 135).toFixed(4));
    }
  });

  function releaseKnob(e) {
    activePointers.delete(e.pointerId);
  }

  knob.addEventListener('pointerup', releaseKnob);
  knob.addEventListener('pointercancel', releaseKnob);
}
