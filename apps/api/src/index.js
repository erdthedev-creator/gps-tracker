/**
 * gps-tracker Worker (HTTP ingest + KV storage + scoreboard)
 *
 * Adds:
 *  - KV course storage key "course:active"
 *  - KV race state per device: key "race_state:<device_id>"
 *  - GET /course, POST /course
 *  - GET /scoreboard
 *
 * Rectangular zones only (no circles).
 */

const MAINTENANCE_MODE = false;

// KV keys
const KV_COURSE_KEY = "course:active";
const KV_DEVICES_KEY = "devices";
const KV_LATEST_PREFIX = "latest:";
const KV_STATE_PREFIX = "race_state:";

// --- helpers ---
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function text(s, status = 200, extraHeaders = {}) {
  return new Response(s, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders(), ...extraHeaders },
  });
}

function safeJsonParseArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function nowMs() {
  return Date.now();
}

// Haversine distance in meters
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Rect bounds check
// bounds: { south, west, north, east }
function pointInRect(lat, lon, bounds) {
  if (!bounds) return false;
  const { south, west, north, east } = bounds;
  if ([south, west, north, east].some((x) => typeof x !== "number")) return false;
  return lat >= south && lat <= north && lon >= west && lon <= east;
}

// Get active course (or default)
async function getCourse(env) {
  const raw = await env.GPS_KV.get(KV_COURSE_KEY);
  if (!raw) {
    return {
      version: 1,
      zones: [],   // [{id,name,bounds:{south,west,north,east}}]
      phases: [],  // [{id,name,expected_sequence:["Z1","Z2"], ranking_anchor:{lat,lon}}]
      activeWithinSec: 60, // for "active" calculation in scoreboard
    };
  }
  try {
    const v = JSON.parse(raw);
    // minimal sanity
    v.zones = Array.isArray(v.zones) ? v.zones : [];
    v.phases = Array.isArray(v.phases) ? v.phases : [];
    if (typeof v.activeWithinSec !== "number") v.activeWithinSec = 60;
    return v;
  } catch {
    return {
      version: 1,
      zones: [],
      phases: [],
      activeWithinSec: 60,
    };
  }
}

async function saveCourse(env, courseObj) {
  await env.GPS_KV.put(KV_COURSE_KEY, JSON.stringify(courseObj));
}

// Save latest + register device
async function saveLatestAndRegisterDevice(env, entry) {
  const deviceId = entry.device_id;

  // latest:<device_id>
  await env.GPS_KV.put(KV_LATEST_PREFIX + deviceId, JSON.stringify(entry));

  // devices list
  const devicesRaw = await env.GPS_KV.get(KV_DEVICES_KEY);
  const devices = devicesRaw ? safeJsonParseArray(devicesRaw) : [];
  if (!devices.includes(deviceId)) {
    devices.push(deviceId);
    await env.GPS_KV.put(KV_DEVICES_KEY, JSON.stringify(devices));
  }
}

// Detect current zone by course rectangles (first match)
function detectZoneId(course, lat, lon) {
  for (const z of course.zones || []) {
    if (z && z.bounds && pointInRect(lat, lon, z.bounds)) {
      return z.id || null;
    }
  }
  return null;
}

// Load and update race state based on zone enter events
async function updateRaceState(env, course, deviceId, lat, lon, receivedAtMs) {
  const key = KV_STATE_PREFIX + deviceId;
  const raw = await env.GPS_KV.get(key);
  let state;
  try {
    state = raw ? JSON.parse(raw) : null;
  } catch {
    state = null;
  }

  if (!state) {
    state = {
      device_id: deviceId,
      phaseIndex: 0,
      seqIndex: -1,      // -1 means "not started in phase yet"
      lastZoneId: null,
      lastUpdateMs: receivedAtMs,
      history: [],       // last few entered zones
    };
  }

  const zoneIdNow = detectZoneId(course, lat, lon);

  // "enter" event = zone changed and new zone is not null
  const entered = zoneIdNow && zoneIdNow !== state.lastZoneId;

  if (entered) {
    state.history.push(zoneIdNow);
    if (state.history.length > 20) state.history.shift();

    const phases = course.phases || [];
    const phase = phases[state.phaseIndex] || null;

    if (phase && Array.isArray(phase.expected_sequence)) {
      const seq = phase.expected_sequence;

      // next expected zone depends on seqIndex
      const nextExpected = seq[state.seqIndex + 1];

      if (zoneIdNow === nextExpected) {
        state.seqIndex += 1;

        // phase completed?
        if (state.seqIndex >= seq.length - 1) {
          // complete phase -> advance
          state.phaseIndex += 1;
          state.seqIndex = -1; // not started in next phase yet
        }
      } else {
        // Optional: if user enters the first expected zone while seqIndex is -1, accept it
        if (state.seqIndex === -1 && zoneIdNow === seq[0]) {
          state.seqIndex = 0;
        }
        // Otherwise ignore unexpected enters (keeps state)
      }
    }
  }

  state.lastZoneId = zoneIdNow;
  state.lastUpdateMs = receivedAtMs;

  await env.GPS_KV.put(key, JSON.stringify(state));

  return { state, zoneIdNow, entered };
}

// Compute rank metrics for device
function computeProgress(course, state, latest, serverTimeMs) {
  const phases = course.phases || [];
  const phaseIndex = typeof state?.phaseIndex === "number" ? state.phaseIndex : 0;
  const seqIndex = typeof state?.seqIndex === "number" ? state.seqIndex : -1;

  // Use current phase anchor if exists, else no distance metric
  const phase = phases[phaseIndex] || null;
  let distM = null;

  if (
    phase &&
    phase.ranking_anchor &&
    typeof phase.ranking_anchor.lat === "number" &&
    typeof phase.ranking_anchor.lon === "number" &&
    typeof latest?.lat === "number" &&
    typeof latest?.lon === "number"
  ) {
    distM = haversineMeters(
      latest.lat,
      latest.lon,
      phase.ranking_anchor.lat,
      phase.ranking_anchor.lon
    );
  }

  const lastSeen = latest?.received_at_ms ?? state?.lastUpdateMs ?? null;
  const activeWithinMs = (course.activeWithinSec || 60) * 1000;
  const isActive = typeof lastSeen === "number" ? (serverTimeMs - lastSeen) < activeWithinMs : false;

  return {
    phaseIndex,
    seqIndex,
    distM,
    isActive,
    lastSeen,
  };
}

// Sort: higher phaseIndex first, higher seqIndex first, then smaller distM, then newer lastSeen
function compareRank(a, b) {
  if (a.progress.phaseIndex !== b.progress.phaseIndex) return b.progress.phaseIndex - a.progress.phaseIndex;
  if (a.progress.seqIndex !== b.progress.seqIndex) return b.progress.seqIndex - a.progress.seqIndex;

  // distM can be null
  const ad = a.progress.distM;
  const bd = b.progress.distM;
  if (ad == null && bd != null) return 1;
  if (ad != null && bd == null) return -1;
  if (ad != null && bd != null && ad !== bd) return ad - bd;

  const al = a.progress.lastSeen ?? 0;
  const bl = b.progress.lastSeen ?? 0;
  return bl - al;
}

// --- UI HTML (simple scoreboard panel) ---
const INDEX_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>GPS Tracker • Course Editor + Scoreboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    html, body { height: 100%; margin: 0; }
    #map { height: 100%; width: 100%; }

    .panel{
      position:absolute; top:10px; left:10px; z-index:1000;
      background: rgba(255,255,255,0.95);
      padding: 10px; border-radius: 12px;
      font-family: system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
      box-shadow: 0 6px 18px rgba(0,0,0,0.18);
      width: 360px; max-height: calc(100vh - 20px); overflow:auto;
    }
    .panel h3{ margin: 0 0 8px 0; font-size: 14px; }
    .row{ display:flex; gap:8px; align-items:center; margin: 6px 0; }
    .row label{ font-size:12px; color:#333; }
    button{
      border: 1px solid #ddd; background:#fff; padding:6px 8px;
      border-radius:10px; cursor:pointer; font-size:12px;
    }
    button.primary{ border-color:#bbb; font-weight:600; }
    button.danger{ border-color:#f0b4b4; color:#a11; }
    button:disabled{ opacity:0.55; cursor:not-allowed; }
    input[type="text"], input[type="number"], select, textarea{
      width: 100%; box-sizing:border-box;
      border:1px solid #ddd; border-radius:10px; padding:6px 8px;
      font-size:12px;
    }
    textarea{ min-height: 90px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .muted{ color:#666; font-size:12px; }
    .sep{ height:1px; background:#eee; margin:10px 0; }
    .list{ border:1px solid #eee; border-radius:10px; padding:6px 8px; }
    .li{ display:flex; justify-content:space-between; align-items:center; gap:8px; padding:4px 0; border-bottom: 1px dashed #eee; }
    .li:last-child{ border-bottom:none; }
    .pill{ font-size:11px; background:#f6f6f6; border:1px solid #eee; padding:2px 6px; border-radius:999px; }
    .scoreItem{ padding:4px 0; border-bottom:1px dashed #eee; }
    .scoreItem:last-child{ border-bottom:none; }
    .two{ display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
    .hint{ font-size:11px; color:#555; line-height:1.25; }
  </style>
</head>
<body>
  <div id="map"></div>

  <div class="panel">
    <h3>Course Editor</h3>

    <div class="row">
      <button id="btnLoad" class="primary">Load Course</button>
      <button id="btnSave" class="primary">Save Course</button>
      <span id="status" class="mono muted">idle</span>
    </div>

    <div class="row">
      <button id="modeNone">Mode: View</button>
      <button id="modeRect">Draw Rectangle</button>
      <button id="modeCP">Add Checkpoint</button>
    </div>
    <div class="hint">
      Rectangle: click SW corner, then click NE corner. (No circles.)<br>
      Checkpoint: click anywhere to drop a point.
    </div>

    <div class="sep"></div>

    <div class="two">
      <div>
        <label>New Zone ID</label>
        <input id="zoneId" type="text" placeholder="Z1" value="Z1" />
      </div>
      <div>
        <label>New Zone Name</label>
        <input id="zoneName" type="text" placeholder="Area 1" value="Area 1" />
      </div>
    </div>

    <div class="row">
      <button id="btnClearRect" class="danger" disabled>Cancel Rectangle</button>
      <span class="muted">Pending clicks: <span id="rectClicks">0</span>/2</span>
    </div>

    <label>Zones (Rectangles)</label>
    <div id="zonesList" class="list"></div>

    <div class="sep"></div>

    <div class="two">
      <div>
        <label>New Checkpoint ID</label>
        <input id="cpId" type="text" placeholder="A" value="A" />
      </div>
      <div>
        <label>New Checkpoint Name</label>
        <input id="cpName" type="text" placeholder="Start" value="Start" />
      </div>
    </div>

    <label>Checkpoints</label>
    <div id="cpsList" class="list"></div>

    <div class="sep"></div>

    <h3>Phases Tool</h3>
    <div class="hint">
      Phase = (Expected zone sequence) + (Anchor checkpoint for distance tie-break).<br>
      Rank uses: phaseIndex desc, seqIndex desc, then distance-to-anchor asc.
    </div>

    <div class="two">
      <div>
        <label>Phase ID</label>
        <input id="phId" type="text" value="phase0" />
      </div>
      <div>
        <label>Phase Name</label>
        <input id="phName" type="text" value="Outbound" />
      </div>
    </div>

    <div class="row">
      <div style="flex:1">
        <label>Anchor Checkpoint</label>
        <select id="phAnchor"></select>
      </div>
      <div style="flex:1">
        <label>Zone Sequence (comma)</label>
        <input id="phSeq" type="text" placeholder="Z1,Z2,Z3" value="Z1,Z2,Z3" />
      </div>
    </div>

    <div class="row">
      <button id="btnAddPhase">Add/Update Phase</button>
      <button id="btnDelPhase" class="danger">Delete Phase</button>
    </div>

    <label>Phases (JSON preview)</label>
    <textarea id="phasesJson" spellcheck="false"></textarea>
    <div class="muted">You can edit this JSON manually if you want; it will be used on Save.</div>

    <div class="sep"></div>

    <h3>Scoreboard</h3>
    <div class="row muted">
      <div>Active: <span id="activeCount" class="mono">-</span></div>
      <div>Total: <span id="totalCount" class="mono">-</span></div>
    </div>
    <div id="scoreList" class="list"></div>

    <div class="sep"></div>
    <div class="muted">
      Endpoints: <span class="mono">/course</span>, <span class="mono">/scoreboard</span>
    </div>
  </div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const API = location.origin;

    // --- map ---
    const map = L.map("map").setView([41.086, 29.047], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    // --- in-memory course model (authoritative copy is KV via /course) ---
    let course = {
      version: 1,
      zones: [],        // [{id,name,bounds:{south,west,north,east}}]
      checkpoints: [],  // [{id,name,lat,lon}]
      phases: [],       // [{id,name,expected_sequence:[...], ranking_anchor:{lat,lon}}]
      activeWithinSec: 60
    };

    // layers
    const zoneLayers = new Map(); // zoneId -> L.rectangle
    const cpLayers = new Map();   // cpId -> L.marker
    const markers = new Map();    // device_id -> L.marker (live racers)

    // --- UI helpers ---
    const el = (id) => document.getElementById(id);
    const setStatus = (s) => el("status").textContent = s;

    function nextId(prefix, existingIds) {
      // Z1, Z2... or A,B...
      if (prefix === "Z") {
        let n = 1;
        while (existingIds.has("Z" + n)) n++;
        return "Z" + n;
      }
      // for checkpoints default: A,B,C...
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      for (let i=0; i<alphabet.length; i++) {
        const cand = alphabet[i];
        if (!existingIds.has(cand)) return cand;
      }
      return prefix + "_" + Math.floor(Math.random()*1000);
    }

    function renderAnchorSelect() {
      const sel = el("phAnchor");
      sel.innerHTML = "";
      for (const cp of course.checkpoints) {
        const opt = document.createElement("option");
        opt.value = cp.id;
        opt.textContent = cp.id + " — " + (cp.name || "");
        sel.appendChild(opt);
      }
      if (sel.options.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(no checkpoints yet)";
        sel.appendChild(opt);
      }
    }

    function renderPhasesJson() {
      el("phasesJson").value = JSON.stringify(course.phases, null, 2);
    }

    function loadPhasesJsonFromTextarea() {
      try {
        const v = JSON.parse(el("phasesJson").value || "[]");
        if (!Array.isArray(v)) throw new Error("phasesJson must be array");
        course.phases = v;
        return true;
      } catch (e) {
        alert("Invalid phases JSON: " + e.message);
        return false;
      }
    }

    function renderZonesList() {
      const box = el("zonesList");
      box.innerHTML = "";
      if (course.zones.length === 0) {
        box.innerHTML = "<div class='muted'>No zones yet.</div>";
        return;
      }
      for (const z of course.zones) {
        const div = document.createElement("div");
        div.className = "li";
        div.innerHTML = "<div><span class='mono'>" + z.id + "</span> <span class='muted'>(" + (z.name||"") + ")</span></div>";
        const right = document.createElement("div");
        right.style.display = "flex";
        right.style.gap = "6px";

        const btnZoom = document.createElement("button");
        btnZoom.textContent = "Zoom";
        btnZoom.onclick = () => {
          const lyr = zoneLayers.get(z.id);
          if (lyr) map.fitBounds(lyr.getBounds(), {padding:[20,20]});
        };

        const btnDel = document.createElement("button");
        btnDel.textContent = "Delete";
        btnDel.className = "danger";
        btnDel.onclick = () => deleteZone(z.id);

        right.appendChild(btnZoom);
        right.appendChild(btnDel);
        div.appendChild(right);
        box.appendChild(div);
      }
    }

    function renderCpsList() {
      const box = el("cpsList");
      box.innerHTML = "";
      if (course.checkpoints.length === 0) {
        box.innerHTML = "<div class='muted'>No checkpoints yet.</div>";
        return;
      }
      for (const cp of course.checkpoints) {
        const div = document.createElement("div");
        div.className = "li";
        div.innerHTML = "<div><span class='mono'>" + cp.id + "</span> <span class='muted'>(" + (cp.name||"") + ")</span> <span class='pill'>" + cp.lat.toFixed(5) + "," + cp.lon.toFixed(5) + "</span></div>";
        const right = document.createElement("div");
        right.style.display = "flex";
        right.style.gap = "6px";

        const btnZoom = document.createElement("button");
        btnZoom.textContent = "Zoom";
        btnZoom.onclick = () => {
          const lyr = cpLayers.get(cp.id);
          if (lyr) map.setView(lyr.getLatLng(), 16);
        };

        const btnDel = document.createElement("button");
        btnDel.textContent = "Delete";
        btnDel.className = "danger";
        btnDel.onclick = () => deleteCheckpoint(cp.id);

        right.appendChild(btnZoom);
        right.appendChild(btnDel);
        div.appendChild(right);
        box.appendChild(div);
      }
      renderAnchorSelect();
    }

    function upsertZoneLayer(z) {
      const b = z.bounds;
      const bounds = [[b.south, b.west], [b.north, b.east]];
      let r = zoneLayers.get(z.id);
      if (!r) {
        r = L.rectangle(bounds, {weight:2});
        r.addTo(map);
        r.bindTooltip(z.id, {permanent:true, direction:"center"});
        zoneLayers.set(z.id, r);
      } else {
        r.setBounds(bounds);
      }
    }

    function deleteZone(zoneId) {
      course.zones = course.zones.filter(z => z.id !== zoneId);
      const lyr = zoneLayers.get(zoneId);
      if (lyr) { map.removeLayer(lyr); zoneLayers.delete(zoneId); }
      renderZonesList();
    }

    function upsertCheckpointLayer(cp) {
      let m = cpLayers.get(cp.id);
      if (!m) {
        m = L.marker([cp.lat, cp.lon]).addTo(map);
        cpLayers.set(cp.id, m);
      } else {
        m.setLatLng([cp.lat, cp.lon]);
      }
      m.bindTooltip(cp.id, {permanent:true, direction:"top", offset:[0,-12]});
      m.bindPopup("<b>" + cp.id + "</b><br>" + (cp.name||"") + "<br>" + cp.lat + "," + cp.lon);
    }

    function deleteCheckpoint(cpId) {
      course.checkpoints = course.checkpoints.filter(c => c.id !== cpId);
      const lyr = cpLayers.get(cpId);
      if (lyr) { map.removeLayer(lyr); cpLayers.delete(cpId); }
      renderCpsList();
      // also remove anchor references from phases if any (optional)
      for (const ph of course.phases) {
        if (ph.ranking_anchor_id === cpId) {
          ph.ranking_anchor_id = "";
          ph.ranking_anchor = null;
        }
      }
      renderPhasesJson();
    }

    function redrawAll() {
      // clear and redraw zones/checkpoints
      for (const [id, lyr] of zoneLayers) map.removeLayer(lyr);
      for (const [id, lyr] of cpLayers) map.removeLayer(lyr);
      zoneLayers.clear();
      cpLayers.clear();

      for (const z of course.zones) upsertZoneLayer(z);
      for (const cp of course.checkpoints) upsertCheckpointLayer(cp);

      renderZonesList();
      renderCpsList();
      renderPhasesJson();
    }

    // --- drawing mode ---
    let mode = "none"; // none|rect|cp
    let rectClicks = []; // two LatLngs

    function setMode(m) {
      mode = m;
      el("modeNone").textContent = (mode==="none") ? "Mode: View ✓" : "Mode: View";
      el("modeRect").textContent = (mode==="rect") ? "Draw Rectangle ✓" : "Draw Rectangle";
      el("modeCP").textContent   = (mode==="cp") ? "Add Checkpoint ✓" : "Add Checkpoint";
    }

    function resetRectClicks() {
      rectClicks = [];
      el("rectClicks").textContent = "0";
      el("btnClearRect").disabled = true;
    }

    function clampBounds(sw, ne) {
      const south = Math.min(sw.lat, ne.lat);
      const north = Math.max(sw.lat, ne.lat);
      const west  = Math.min(sw.lng, ne.lng);
      const east  = Math.max(sw.lng, ne.lng);
      return { south, west, north, east };
    }

    function addZoneFromClicks() {
      if (rectClicks.length !== 2) return;
      const zId = (el("zoneId").value || "").trim();
      const zName = (el("zoneName").value || "").trim();
      if (!zId) { alert("Zone ID required"); return; }

      const existing = course.zones.find(z => z.id === zId);
      const bounds = clampBounds(rectClicks[0], rectClicks[1]);

      const obj = { id: zId, name: zName, bounds };
      if (existing) {
        existing.name = obj.name;
        existing.bounds = obj.bounds;
      } else {
        course.zones.push(obj);
      }

      upsertZoneLayer(obj);
      renderZonesList();

      // auto-suggest next zone id/name
      const ids = new Set(course.zones.map(z => z.id));
      const nextZ = nextId("Z", ids);
      el("zoneId").value = nextZ;
      el("zoneName").value = "Area " + nextZ.replace("Z","");

      resetRectClicks();
      setStatus("zone added/updated");
    }

    function addCheckpoint(latlng) {
      const cpId = (el("cpId").value || "").trim();
      const cpName = (el("cpName").value || "").trim();
      if (!cpId) { alert("Checkpoint ID required"); return; }

      const existing = course.checkpoints.find(c => c.id === cpId);
      const obj = { id: cpId, name: cpName, lat: latlng.lat, lon: latlng.lng };

      if (existing) {
        existing.name = obj.name;
        existing.lat = obj.lat;
        existing.lon = obj.lon;
      } else {
        course.checkpoints.push(obj);
      }

      upsertCheckpointLayer(obj);
      renderCpsList();

      // auto-suggest next cp id
      const ids = new Set(course.checkpoints.map(c => c.id));
      const nextC = nextId("C", ids);
      el("cpId").value = nextC;
      el("cpName").value = "CP " + nextC;

      setStatus("checkpoint added/updated");
    }

    // map click handler
    map.on("click", (e) => {
      if (mode === "rect") {
        rectClicks.push(e.latlng);
        el("rectClicks").textContent = String(rectClicks.length);
        el("btnClearRect").disabled = false;

        if (rectClicks.length === 2) {
          addZoneFromClicks();
        }
        return;
      }

      if (mode === "cp") {
        addCheckpoint(e.latlng);
        return;
      }
    });

    // buttons
    el("modeNone").onclick = () => setMode("none");
    el("modeRect").onclick = () => { setMode("rect"); resetRectClicks(); };
    el("modeCP").onclick = () => setMode("cp");
    el("btnClearRect").onclick = () => { resetRectClicks(); setStatus("rect cancelled"); };

    // phases tool
    el("btnAddPhase").onclick = () => {
      // allow manual edit in textarea to override
      if (!loadPhasesJsonFromTextarea()) return;

      const id = (el("phId").value || "").trim();
      const name = (el("phName").value || "").trim();
      const anchorId = (el("phAnchor").value || "").trim();
      const seqRaw = (el("phSeq").value || "").trim();

      if (!id) { alert("Phase ID required"); return; }
      if (!seqRaw) { alert("Phase zone sequence required"); return; }

      const expected_sequence = seqRaw.split(",").map(s => s.trim()).filter(Boolean);

      let ranking_anchor = null;
      let ranking_anchor_id = anchorId || "";
      if (anchorId) {
        const cp = course.checkpoints.find(c => c.id === anchorId);
        if (cp) ranking_anchor = { lat: cp.lat, lon: cp.lon };
      }

      const ph = {
        id, name,
        expected_sequence,
        ranking_anchor_id,
        ranking_anchor
      };

      const existing = course.phases.find(p => p.id === id);
      if (existing) {
        Object.assign(existing, ph);
      } else {
        course.phases.push(ph);
      }
      renderPhasesJson();
      setStatus("phase added/updated");
    };

    el("btnDelPhase").onclick = () => {
      if (!loadPhasesJsonFromTextarea()) return;
      const id = (el("phId").value || "").trim();
      if (!id) { alert("Phase ID required"); return; }
      course.phases = course.phases.filter(p => p.id !== id);
      renderPhasesJson();
      setStatus("phase deleted");
    };

    // load/save course
    el("btnLoad").onclick = async () => {
      try {
        setStatus("loading...");
        const r = await fetch(API + "/course");
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();
        // merge to our schema
        course.version = 1;
        course.zones = Array.isArray(d.zones) ? d.zones : [];
        course.checkpoints = Array.isArray(d.checkpoints) ? d.checkpoints : [];
        course.phases = Array.isArray(d.phases) ? d.phases : [];
        course.activeWithinSec = (typeof d.activeWithinSec === "number") ? d.activeWithinSec : 60;

        // Recompute phase anchors (in case saved as anchor_id only)
        for (const ph of course.phases) {
          if (ph.ranking_anchor_id && (!ph.ranking_anchor || typeof ph.ranking_anchor.lat !== "number")) {
            const cp = course.checkpoints.find(c => c.id === ph.ranking_anchor_id);
            if (cp) ph.ranking_anchor = { lat: cp.lat, lon: cp.lon };
          }
        }

        redrawAll();
        renderAnchorSelect();
        setStatus("loaded");
      } catch (e) {
        setStatus("load error");
        alert("Load failed: " + e.message);
      }
    };

    el("btnSave").onclick = async () => {
      // phases from textarea is authoritative
      if (!loadPhasesJsonFromTextarea()) return;

      // ensure phase anchor coords exist
      for (const ph of course.phases) {
        if (ph.ranking_anchor_id) {
          const cp = course.checkpoints.find(c => c.id === ph.ranking_anchor_id);
          if (cp) ph.ranking_anchor = { lat: cp.lat, lon: cp.lon };
        }
      }

      try {
        setStatus("saving...");
        const r = await fetch(API + "/course", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(course),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        setStatus("saved");
      } catch (e) {
        setStatus("save error");
        alert("Save failed: " + e.message);
      }
    };

    // --- scoreboard polling ---
    function upsertRacerMarker(device_id, lat, lon, label) {
      let m = markers.get(device_id);
      const ll = [lat, lon];
      if (!m) {
        m = L.marker(ll).addTo(map).bindPopup(device_id);
        markers.set(device_id, m);
      } else {
        m.setLatLng(ll);
      }
      if (label) m.bindTooltip(label, {permanent:true, direction:"top", offset:[0,-12]});
    }

    function renderScore(items, activeCount) {
      el("activeCount").textContent = String(activeCount ?? "-");
      el("totalCount").textContent = String(items.length);

      const box = el("scoreList");
      box.innerHTML = "";
      if (items.length === 0) {
        box.innerHTML = "<div class='muted'>No devices yet.</div>";
        return;
      }
      items.forEach((it, idx) => {
        const div = document.createElement("div");
        div.className = "scoreItem";
        const dist = it.progress && it.progress.distM != null ? (it.progress.distM.toFixed(0) + " m") : "-";
        const act = it.progress && it.progress.isActive ? "ACTIVE" : "offline";
        const ph = it.progress ? it.progress.phaseIndex : 0;
        const st = it.progress ? it.progress.seqIndex : -1;
        div.innerHTML =
          "<div class='mono'>#" + (idx+1) + " " + it.device_id + "</div>" +
          "<div class='muted'>phase=" + ph + " step=" + st + " dist=" + dist + " " + act + "</div>";
        box.appendChild(div);

        if (it.latest && typeof it.latest.lat === "number" && typeof it.latest.lon === "number") {
          upsertRacerMarker(it.device_id, it.latest.lat, it.latest.lon, "#" + (idx+1));
        }
      });
    }

    async function tickScore() {
      try {
        const r = await fetch(API + "/scoreboard");
        if (!r.ok) return;
        const d = await r.json();
        renderScore(d.items || [], d.active_count);
      } catch {}
    }

    // init
    setMode("none");
    resetRectClicks();
    renderZonesList();
    renderCpsList();
    renderAnchorSelect();
    renderPhasesJson();
    tickScore();
    setInterval(tickScore, 1000);
  </script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (MAINTENANCE_MODE) {
      return text("Service paused (maintenance mode)", 503);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // --- UI ---
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(INDEX_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
      });
    }

    // --- health ---
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, server_time_ms: nowMs() });
    }

    // --- course management ---
    if (url.pathname === "/course") {
      if (request.method === "GET") {
        const course = await getCourse(env);
        return json(course);
      }
      if (request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON" }, 400);
        }

        // enforce rectangles only (reject circle types etc.)
        body.version = 1;
        body.zones = Array.isArray(body.zones) ? body.zones : [];
        body.phases = Array.isArray(body.phases) ? body.phases : [];
        if (typeof body.activeWithinSec !== "number") body.activeWithinSec = 60;

        for (const z of body.zones) {
          if (!z || typeof z !== "object") return json({ ok:false, error:"Invalid zone object" }, 400);
          if (!z.bounds || typeof z.bounds !== "object") return json({ ok:false, error:"Zone bounds required" }, 400);
          // bounds must be numbers
          const b = z.bounds;
          if ([b.south,b.west,b.north,b.east].some((x)=>typeof x !== "number")) {
            return json({ ok:false, error:"Zone bounds must be numbers (south,west,north,east)" }, 400);
          }
        }

        await saveCourse(env, body);
        return json({ ok: true });
      }
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    // --- ingest (simple JSON) ---
    if (request.method === "POST" && url.pathname === "/ingest") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      const device_id = String(body.device_id || "").trim();
      const lat = Number(body.lat);
      const lon = Number(body.lon);
      const t_ms = body.t_ms != null ? Number(body.t_ms) : nowMs();

      if (!device_id) return json({ ok: false, error: "device_id required" }, 400);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ ok: false, error: "lat/lon required" }, 400);

      const entry = {
        device_id,
        t_ms: Number.isFinite(t_ms) ? t_ms : nowMs(),
        lat,
        lon,
        received_at_ms: nowMs(),
      };

      await saveLatestAndRegisterDevice(env, entry);

      // update race state
      const course = await getCourse(env);
      await updateRaceState(env, course, device_id, lat, lon, entry.received_at_ms);

      return json({ ok: true });
    }

    // --- traccar adapter (GET/POST) ---
    if (url.pathname === "/traccar") {
      if (request.method === "GET") {
        const device_id = String(url.searchParams.get("device_id") || url.searchParams.get("id") || "").trim();
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        const ts = url.searchParams.get("timestamp");
        let t_ms = nowMs();

        if (ts != null) {
          const n = Number(ts);
          if (Number.isFinite(n)) t_ms = n > 1e12 ? n : n * 1000;
        }

        if (!device_id) return text("ERR: device_id (or id) required", 400);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return text("ERR: lat/lon required", 400);

        const entry = { device_id, t_ms, lat, lon, received_at_ms: nowMs() };
        await saveLatestAndRegisterDevice(env, entry);

        const course = await getCourse(env);
        await updateRaceState(env, course, device_id, lat, lon, entry.received_at_ms);

        return text("OK");
      }

      if (request.method === "POST") {
        const device_id = String(url.searchParams.get("device_id") || url.searchParams.get("id") || "").trim();
        if (!device_id) return text("ERR: device_id (or id) required", 400);

        let body;
        try {
          body = await request.json();
        } catch {
          return text("ERR: invalid JSON", 400);
        }

        const p = body && body.location ? body.location : body;
        const c = p && p.coords ? p.coords : p;

        const lat = Number(c?.latitude ?? c?.lat);
        const lon = Number(c?.longitude ?? c?.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return text("ERR: lat/lon required", 400);

        let t_ms = nowMs();
        const ts = p?.timestamp ?? p?.time ?? p?.t_ms;
        if (typeof ts === "number") {
          t_ms = ts > 1e12 ? ts : ts * 1000;
        } else if (typeof ts === "string") {
          const parsed = Date.parse(ts);
          if (!Number.isNaN(parsed)) t_ms = parsed;
        }

        const entry = { device_id, t_ms, lat, lon, received_at_ms: nowMs() };
        await saveLatestAndRegisterDevice(env, entry);

        const course = await getCourse(env);
        await updateRaceState(env, course, device_id, lat, lon, entry.received_at_ms);

        return text("OK");
      }

      return text("Method not allowed", 405);
    }

    // --- latest endpoints (unchanged style) ---
    if (request.method === "GET" && url.pathname === "/latest_all") {
      const devicesRaw = await env.GPS_KV.get(KV_DEVICES_KEY);
      const devices = devicesRaw ? safeJsonParseArray(devicesRaw) : [];
      const items = [];
      for (const id of devices) {
        const raw = await env.GPS_KV.get(KV_LATEST_PREFIX + id);
        if (!raw) continue;
        try {
          items.push(JSON.parse(raw));
        } catch {}
      }
      return json({ server_time_ms: nowMs(), items });
    }

    if (request.method === "GET" && url.pathname === "/latest") {
      const device_id = String(url.searchParams.get("device_id") || "").trim();
      if (!device_id) return json({ ok: false, error: "device_id required" }, 400);

      const raw = await env.GPS_KV.get(KV_LATEST_PREFIX + device_id);
      if (!raw) {
        return json({ device_id, lat: null, lon: null, t_ms: null, received_at_ms: null });
      }
      try {
        return json(JSON.parse(raw));
      } catch {
        return json({ ok: false, error: "Corrupt data" }, 500);
      }
    }

    // --- scoreboard ---
    if (request.method === "GET" && url.pathname === "/scoreboard") {
      const course = await getCourse(env);
      const serverTimeMs = nowMs();

      const devicesRaw = await env.GPS_KV.get(KV_DEVICES_KEY);
      const devices = devicesRaw ? safeJsonParseArray(devicesRaw) : [];

      const out = [];

      for (const id of devices) {
        // latest
        let latest = null;
        const latestRaw = await env.GPS_KV.get(KV_LATEST_PREFIX + id);
        if (latestRaw) {
          try { latest = JSON.parse(latestRaw); } catch {}
        }

        // state
        let state = null;
        const stateRaw = await env.GPS_KV.get(KV_STATE_PREFIX + id);
        if (stateRaw) {
          try { state = JSON.parse(stateRaw); } catch {}
        }

        // If state missing but latest exists, initialize/update once (so scoreboard works immediately)
        if (!state && latest && typeof latest.lat === "number" && typeof latest.lon === "number") {
          const u = await updateRaceState(env, course, id, latest.lat, latest.lon, latest.received_at_ms ?? serverTimeMs);
          state = u.state;
        }

        const progress = computeProgress(course, state, latest, serverTimeMs);

        out.push({
          device_id: id,
          latest,
          state,
          progress,
        });
      }

      out.sort(compareRank);

      const activeCount = out.filter((x) => x.progress.isActive).length;

      return json({
        server_time_ms: serverTimeMs,
        active_count: activeCount,
        items: out,
      });
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};