/**
 * gps-tracker Worker (single-file)
 * Features:
 * - POST /ingest accepts format:
 *   {lat, lon, alt?, acc?, spd?, time?, id?}  OR  {device_id, lat, lon, t_ms?}
 * - /traccar adapter (GET/POST) for Traccar/OsmAnd style senders
 * - KV storage: latest:<id>, race_state:<id>, devices list, hidden list
 * - Course editor UI at "/": rectangles (zones), checkpoints (2-char badge), phases (ordered)
 * - Multi-layout save/load by name: /course?name= , list: /courses
 * - Active layout used by ingest/scoreboard: /active_course
 */

const MAINTENANCE_MODE = false;

// KV keys
const KV_DEVICES_KEY = "devices";
const KV_LATEST_PREFIX = "latest:";
const KV_STATE_PREFIX = "race_state:";
const KV_HIDDEN_DEVICES_KEY = "hidden:devices";

// Backward compatible "default course content"
const KV_COURSE_KEY = "course:active";

// Multi-layout support
const KV_COURSE_INDEX_KEY = "courses:index"; // ["default","layout1",...]
const KV_COURSE_PREFIX = "course:";          // course:<name>
const KV_ACTIVE_COURSE_NAME_KEY = "course:active_name"; // active layout name

// ---------------------- Helpers ----------------------
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

function asNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

// bounds: { south, west, north, east }
function pointInRect(lat, lon, bounds) {
  if (!bounds) return false;
  const { south, west, north, east } = bounds;
  if ([south, west, north, east].some((x) => typeof x !== "number")) return false;
  return lat >= south && lat <= north && lon >= west && lon <= east;
}

// ---------------------- Course / Multi Layout ----------------------
function defaultCourseTemplate(name = "default") {
  return {
    version: 1,
    name,
    zones: [],        // [{id,name,bounds:{south,west,north,east}}]
    checkpoints: [],  // [{id,name,lat,lon}]
    phases: [],       // [{id,name,enter_zone_id,distance_checkpoint_id}] ordered
    activeWithinSec: 60,
  };
}

function normalizeCourseName(name) {
  const n = String(name || "").trim();
  if (!n) return "default";
  return n.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "default";
}

async function listCourses(env) {
  const raw = await env.GPS_KV.get(KV_COURSE_INDEX_KEY);
  const arr = raw ? safeJsonParseArray(raw) : [];
  const set = new Set(arr);
  set.add("default");
  const out = Array.from(set);
  out.sort();
  await env.GPS_KV.put(KV_COURSE_INDEX_KEY, JSON.stringify(out));
  return out;
}

async function upsertCourseIndex(env, courseName) {
  const name = normalizeCourseName(courseName);
  const arr = await listCourses(env);
  if (!arr.includes(name)) {
    arr.push(name);
    arr.sort();
    await env.GPS_KV.put(KV_COURSE_INDEX_KEY, JSON.stringify(arr));
  }
  return name;
}

// Backward-compatible default course storage
async function getCourseDefault(env) {
  const raw = await env.GPS_KV.get(KV_COURSE_KEY);
  if (!raw) return defaultCourseTemplate("default");
  try {
    const v = JSON.parse(raw);
    v.version = 1;
    v.name = "default";
    v.zones = Array.isArray(v.zones) ? v.zones : [];
    v.checkpoints = Array.isArray(v.checkpoints) ? v.checkpoints : [];
    v.phases = Array.isArray(v.phases) ? v.phases : [];
    if (typeof v.activeWithinSec !== "number") v.activeWithinSec = 60;
    return v;
  } catch {
    return defaultCourseTemplate("default");
  }
}

async function saveCourseDefault(env, courseObj) {
  courseObj.version = 1;
  courseObj.name = "default";
  await env.GPS_KV.put(KV_COURSE_KEY, JSON.stringify(courseObj));
}

async function getCourseByName(env, courseName) {
  const name = normalizeCourseName(courseName);
  if (name === "default") return await getCourseDefault(env);

  const raw = await env.GPS_KV.get(KV_COURSE_PREFIX + name);
  if (!raw) return defaultCourseTemplate(name);
  try {
    const v = JSON.parse(raw);
    v.version = 1;
    v.name = name;
    v.zones = Array.isArray(v.zones) ? v.zones : [];
    v.checkpoints = Array.isArray(v.checkpoints) ? v.checkpoints : [];
    v.phases = Array.isArray(v.phases) ? v.phases : [];
    if (typeof v.activeWithinSec !== "number") v.activeWithinSec = 60;
    return v;
  } catch {
    return defaultCourseTemplate(name);
  }
}

async function saveCourseByName(env, courseName, courseObj) {
  const name = normalizeCourseName(courseName);
  courseObj.version = 1;
  courseObj.name = name;

  if (name === "default") {
    await saveCourseDefault(env, courseObj);
  } else {
    await env.GPS_KV.put(KV_COURSE_PREFIX + name, JSON.stringify(courseObj));
  }
  await upsertCourseIndex(env, name);
  return name;
}

async function getActiveCourseName(env) {
  const raw = await env.GPS_KV.get(KV_ACTIVE_COURSE_NAME_KEY);
  return normalizeCourseName(raw || "default");
}

async function setActiveCourseName(env, name) {
  const n = normalizeCourseName(name);
  await env.GPS_KV.put(KV_ACTIVE_COURSE_NAME_KEY, n);
  await upsertCourseIndex(env, n);
  return n;
}

async function getActiveCourse(env) {
  const n = await getActiveCourseName(env);
  return await getCourseByName(env, n);
}

// ---------------------- Hidden Devices ----------------------
async function getHiddenDevices(env) {
  const raw = await env.GPS_KV.get(KV_HIDDEN_DEVICES_KEY);
  return raw ? safeJsonParseArray(raw) : [];
}

async function setHiddenDevices(env, arr) {
  await env.GPS_KV.put(KV_HIDDEN_DEVICES_KEY, JSON.stringify(arr));
}

// ---------------------- Device data ----------------------
async function saveLatestAndRegisterDevice(env, entry) {
  const deviceId = entry.device_id;
  await env.GPS_KV.put(KV_LATEST_PREFIX + deviceId, JSON.stringify(entry));

  const devicesRaw = await env.GPS_KV.get(KV_DEVICES_KEY);
  const devices = devicesRaw ? safeJsonParseArray(devicesRaw) : [];
  if (!devices.includes(deviceId)) {
    devices.push(deviceId);
    await env.GPS_KV.put(KV_DEVICES_KEY, JSON.stringify(devices));
  }
}

// detect zone by course rectangles (first match)
function detectZoneId(course, lat, lon) {
  for (const z of course.zones || []) {
    if (z && z.bounds && pointInRect(lat, lon, z.bounds)) return z.id || null;
  }
  return null;
}

// ---------------------- Phase-based State Machine ----------------------
/**
 * Strict rules:
 * - Phase k starts ONLY when entering phases[k].enter_zone_id
 * - Advance ONLY to phase k+1 by entering phases[k+1].enter_zone_id
 * - AND ONLY if current phase is started (phaseStarted=true)
 * - No skipping.
 */
async function updateRaceState(env, course, deviceId, lat, lon, receivedAtMs) {
  const key = KV_STATE_PREFIX + deviceId;
  const raw = await env.GPS_KV.get(key);
  let state;
  try { state = raw ? JSON.parse(raw) : null; } catch { state = null; }

  if (!state) {
    state = {
      device_id: deviceId,
      phaseIndex: 0,
      phaseStarted: false,
      lastZoneId: null,
      lastUpdateMs: receivedAtMs,
      history: [],
    };
  }

  const zoneIdNow = detectZoneId(course, lat, lon);
  const entered = zoneIdNow && zoneIdNow !== state.lastZoneId;

  if (entered) {
    state.history.push(zoneIdNow);
    if (state.history.length > 20) state.history.shift();

    const phases = course.phases || [];
    const cur = phases[state.phaseIndex] || null;
    const next = phases[state.phaseIndex + 1] || null;

    // start current phase only by entering its zone
    if (cur && cur.enter_zone_id && zoneIdNow === cur.enter_zone_id) {
      state.phaseStarted = true;
    }

    // advance only to NEXT phase, only if current phase is started
    if (next && next.enter_zone_id && zoneIdNow === next.enter_zone_id && state.phaseStarted === true) {
      state.phaseIndex += 1;
      state.phaseStarted = true;
    }
  }

  state.lastZoneId = zoneIdNow;
  state.lastUpdateMs = receivedAtMs;

  await env.GPS_KV.put(key, JSON.stringify(state));
  return { state, zoneIdNow, entered };
}

function computeProgress(course, state, latest, serverTimeMs) {
  const phases = course.phases || [];
  const checkpoints = course.checkpoints || [];

  const phaseIndex = typeof state?.phaseIndex === "number" ? state.phaseIndex : 0;
  const phaseStarted = !!state?.phaseStarted;
  const ph = phases[phaseIndex] || null;

  let distM = null;
  if (ph && ph.distance_checkpoint_id && latest && typeof latest.lat === "number" && typeof latest.lon === "number") {
    const cp = checkpoints.find((c) => c.id === ph.distance_checkpoint_id);
    if (cp && typeof cp.lat === "number" && typeof cp.lon === "number") {
      distM = haversineMeters(latest.lat, latest.lon, cp.lat, cp.lon);
    }
  }

  const lastSeen = latest?.received_at_ms ?? state?.lastUpdateMs ?? null;
  const activeWithinMs = (course.activeWithinSec || 60) * 1000;
  const isActive = typeof lastSeen === "number" ? (serverTimeMs - lastSeen) < activeWithinMs : false;

  return { phaseIndex, phaseStarted, distM, isActive, lastSeen };
}

function compareRank(a, b) {
  if (a.progress.phaseIndex !== b.progress.phaseIndex) return b.progress.phaseIndex - a.progress.phaseIndex;

  if (a.progress.phaseStarted !== b.progress.phaseStarted) {
    return (b.progress.phaseStarted ? 1 : 0) - (a.progress.phaseStarted ? 1 : 0);
  }

  const ad = a.progress.distM;
  const bd = b.progress.distM;

  if (ad == null && bd != null) return 1;
  if (ad != null && bd == null) return -1;
  if (ad != null && bd != null && ad !== bd) return ad - bd;

  const al = a.progress.lastSeen ?? 0;
  const bl = b.progress.lastSeen ?? 0;
  return bl - al;
}

// ---------------------- Validation ----------------------
function validateCourseBody(body) {
  body.version = 1;
  body.zones = Array.isArray(body.zones) ? body.zones : [];
  body.checkpoints = Array.isArray(body.checkpoints) ? body.checkpoints : [];
  body.phases = Array.isArray(body.phases) ? body.phases : [];
  if (typeof body.activeWithinSec !== "number") body.activeWithinSec = 60;

  // zones
  for (const z of body.zones) {
    if (!z || typeof z !== "object") return "Invalid zone object";
    if (!z.id || typeof z.id !== "string") return "Zone id required";
    if (!z.bounds || typeof z.bounds !== "object") return "Zone bounds required";
    const b = z.bounds;
    if ([b.south, b.west, b.north, b.east].some((x) => typeof x !== "number")) {
      return "Zone bounds must be numbers (south,west,north,east)";
    }
  }

  // checkpoints
  for (const c of body.checkpoints) {
    if (!c || typeof c !== "object") return "Invalid checkpoint object";
    if (!c.id || typeof c.id !== "string") return "Checkpoint id required";
    if (typeof c.lat !== "number" || typeof c.lon !== "number") return "Checkpoint lat/lon must be numbers";
  }

  const zoneIds = new Set(body.zones.map((z) => z.id));
  const cpIds = new Set(body.checkpoints.map((c) => c.id));

  // phases
  for (const p of body.phases) {
    if (!p || typeof p !== "object") return "Invalid phase object";
    if (!p.id || typeof p.id !== "string") return "Phase id required";
    if (!p.enter_zone_id || typeof p.enter_zone_id !== "string") return "Phase enter_zone_id required";
    if (!p.distance_checkpoint_id || typeof p.distance_checkpoint_id !== "string") return "Phase distance_checkpoint_id required";
    if (!zoneIds.has(p.enter_zone_id)) return "Phase enter_zone_id not found in zones: " + p.enter_zone_id;
    if (!cpIds.has(p.distance_checkpoint_id)) return "Phase distance_checkpoint_id not found in checkpoints: " + p.distance_checkpoint_id;
  }

  return null;
}

// ---------------------- UI ----------------------
const INDEX_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>GPS Tracker • Layout Tool + Scoreboard</title>
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
      width: 410px; max-height: calc(100vh - 20px); overflow:auto;
    }
    .row{ display:flex; gap:8px; align-items:center; margin: 6px 0; }
    .two{ display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
    h3{ margin: 0 0 8px 0; font-size: 14px; }

    button{
      border: 1px solid #ddd; background:#fff; padding:6px 8px;
      border-radius:10px; cursor:pointer; font-size:12px;
    }
    button.primary{ border-color:#bbb; font-weight:600; }
    button.danger{ border-color:#f0b4b4; color:#a11; }
    button:disabled{ opacity:0.55; cursor:not-allowed; }

    input[type="text"], select{
      width: 100%; box-sizing:border-box;
      border:1px solid #ddd; border-radius:10px; padding:6px 8px;
      font-size:12px;
    }

    .mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .muted{ color:#666; font-size:12px; }
    .sep{ height:1px; background:#eee; margin:10px 0; }
    .list{ border:1px solid #eee; border-radius:10px; padding:6px 8px; }
    .li{ display:flex; justify-content:space-between; align-items:center; gap:8px; padding:4px 0; border-bottom: 1px dashed #eee; }
    .li:last-child{ border-bottom:none; }
    .pill{ font-size:11px; background:#f6f6f6; border:1px solid #eee; padding:2px 6px; border-radius:999px; }
    .hint{ font-size:11px; color:#555; line-height:1.25; }

    /* checkpoint badge */
    .cp-badge{
      width:28px; height:28px;
      border-radius:999px;
      border:2px solid #111;
      background:#fff;
      display:flex; align-items:center; justify-content:center;
      font-weight:700;
      font-size:12px;
      line-height:1;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      user-select:none;
    }
  </style>
</head>
<body>
  <div id="map"></div>

  <div class="panel">
    <div class="row" style="justify-content:space-between">
      <h3 style="margin:0">Course Tool</h3>
      <button id="btnToggleCourse" class="primary">Hide</button>
    </div>

    <div id="courseBody">
      <div class="two">
        <div>
          <label class="muted">Layout Name</label>
          <input id="layoutName" type="text" value="default" />
        </div>
        <div>
          <label class="muted">Layouts</label>
          <select id="layoutSelect"></select>
        </div>
      </div>

      <div class="row">
        <button id="btnLoad" class="primary">Load</button>
        <button id="btnSave" class="primary">Save</button>
        <button id="btnRefreshLayouts">Refresh</button>
        <span id="status" class="mono muted">idle</span>
      </div>

      <div class="hint">Loaded/saved layout becomes ACTIVE (scoreboard uses it).</div>

      <div class="sep"></div>

      <div class="row">
        <button id="modeNone">Mode: View ✓</button>
        <button id="modeRect">Draw Rectangle</button>
        <button id="modeCP">Add Checkpoint</button>
      </div>
      <div class="hint">
        Rectangle: click SW corner, then click NE corner.<br>
        Checkpoint: click anywhere to drop a point.
      </div>

      <div class="sep"></div>

      <div class="two">
        <div>
          <label class="muted">New Zone ID</label>
          <input id="zoneId" type="text" value="Z1" />
        </div>
        <div>
          <label class="muted">New Zone Name</label>
          <input id="zoneName" type="text" value="Area 1" />
        </div>
      </div>

      <div class="row">
        <button id="btnClearRect" class="danger" disabled>Cancel Rectangle</button>
        <span class="muted">Clicks: <span id="rectClicks">0</span>/2</span>
      </div>

      <label class="muted">Zones</label>
      <div id="zonesList" class="list"></div>

      <div class="sep"></div>

      <div class="two">
        <div>
          <label class="muted">New CP ID (2 chars shown)</label>
          <input id="cpId" type="text" value="A" />
        </div>
        <div>
          <label class="muted">New CP Name</label>
          <input id="cpName" type="text" value="Start" />
        </div>
      </div>

      <label class="muted">Checkpoints</label>
      <div id="cpsList" class="list"></div>

      <div class="sep"></div>

      <h3>Phases (Ordered)</h3>
      <div class="hint">
        Strict order: start only by entering phase zone. Advance only to NEXT phase zone, only if started.
      </div>

      <div class="two">
        <div>
          <label class="muted">Phase ID</label>
          <input id="phId" type="text" value="p1" />
        </div>
        <div>
          <label class="muted">Phase Name</label>
          <input id="phName" type="text" value="Stage 1" />
        </div>
      </div>

      <div class="row">
        <div style="flex:1">
          <label class="muted">Enter Zone</label>
          <select id="phZone"></select>
        </div>
        <div style="flex:1">
          <label class="muted">Distance CP</label>
          <select id="phCP"></select>
        </div>
      </div>

      <div class="row">
        <button id="btnUpsertPhase">Add/Update Phase</button>
        <button id="btnDelPhase" class="danger">Delete Phase</button>
      </div>

      <label class="muted">Phase List</label>
      <div id="phList" class="list"></div>

      <div class="sep"></div>
    </div>

    <h3>Scoreboard</h3>
    <div class="row muted">
      <div>Active: <span id="activeCount" class="mono">-</span></div>
      <div>Total: <span id="totalCount" class="mono">-</span></div>
      <div>Hidden: <span id="hiddenCount" class="mono">-</span></div>
    </div>
    <div id="scoreList" class="list"></div>

    <div class="sep"></div>

    <h3>Hidden Devices</h3>
    <div class="hint">Hidden devices are excluded from map + scoreboard.</div>
    <div id="hiddenList" class="list"></div>

    <div class="sep"></div>
    <div class="muted">
      Endpoints: <span class="mono">/ingest</span>, <span class="mono">/traccar</span>,
      <span class="mono">/course?name=</span>, <span class="mono">/courses</span>,
      <span class="mono">/active_course</span>, <span class="mono">/scoreboard</span>
    </div>
  </div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const API = location.origin;

    const map = L.map("map").setView([41.086, 29.047], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    let course = { version:1, name:"default", zones:[], checkpoints:[], phases:[], activeWithinSec:60 };

    const zoneLayers = new Map(); // zoneId -> L.rectangle
    const cpLayers = new Map();   // cpId -> L.marker
    const racerMarkers = new Map(); // device_id -> L.marker
    let hiddenSet = new Set();

    const el = (id) => document.getElementById(id);
    const setStatus = (s) => el("status").textContent = s;

    // toggle course tool
    let courseVisible = true;
    el("btnToggleCourse").onclick = () => {
      courseVisible = !courseVisible;
      el("courseBody").style.display = courseVisible ? "" : "none";
      el("btnToggleCourse").textContent = courseVisible ? "Hide" : "Show";
    };

    function nextZoneId() {
      const ids = new Set(course.zones.map(z => z.id));
      let n = 1;
      while (ids.has("Z" + n)) n++;
      return "Z" + n;
    }

    function nextCheckpointId() {
      const ids = new Set(course.checkpoints.map(c => c.id));
      const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      for (let i=0; i<abc.length; i++) {
        if (!ids.has(abc[i])) return abc[i];
      }
      return "C" + Math.floor(Math.random()*1000);
    }

    function clampBounds(sw, ne) {
      const south = Math.min(sw.lat, ne.lat);
      const north = Math.max(sw.lat, ne.lat);
      const west  = Math.min(sw.lng, ne.lng);
      const east  = Math.max(sw.lng, ne.lng);
      return { south, west, north, east };
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

    function makeCpIcon(text) {
      const t = (text || "").toString().slice(0,2);
      return L.divIcon({
        className: "",
        html: "<div class='cp-badge'>" + t + "</div>",
        iconSize: [28,28],
        iconAnchor: [14,14],
      });
    }

    function upsertCheckpointLayer(cp) {
      let m = cpLayers.get(cp.id);
      const label = (cp.id || "").slice(0,2);
      if (!m) {
        m = L.marker([cp.lat, cp.lon], { icon: makeCpIcon(label) }).addTo(map);
        cpLayers.set(cp.id, m);
      } else {
        m.setLatLng([cp.lat, cp.lon]);
        m.setIcon(makeCpIcon(label));
      }
      m.bindPopup("<b>" + cp.id + "</b><br>" + (cp.name||"") + "<br>" + cp.lat.toFixed(6) + "," + cp.lon.toFixed(6));
    }

    function redrawCourse() {
      for (const lyr of zoneLayers.values()) map.removeLayer(lyr);
      for (const lyr of cpLayers.values()) map.removeLayer(lyr);
      zoneLayers.clear();
      cpLayers.clear();

      for (const z of course.zones) upsertZoneLayer(z);
      for (const cp of course.checkpoints) upsertCheckpointLayer(cp);

      renderZonesList();
      renderCpsList();
      renderPhaseSelects();
      renderPhases();
    }

    function renderZonesList() {
      const box = el("zonesList");
      box.innerHTML = "";
      if (course.zones.length === 0) {
        box.innerHTML = "<div class='muted'>No zones.</div>";
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
        btnDel.onclick = () => {
          course.zones = course.zones.filter(x => x.id !== z.id);
          const lyr = zoneLayers.get(z.id);
          if (lyr) map.removeLayer(lyr);
          zoneLayers.delete(z.id);
          renderZonesList();
          renderPhaseSelects();
        };

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
        box.innerHTML = "<div class='muted'>No checkpoints.</div>";
        return;
      }
      for (const cp of course.checkpoints) {
        const div = document.createElement("div");
        div.className = "li";
        div.innerHTML =
          "<div><span class='mono'>" + cp.id + "</span> <span class='muted'>(" + (cp.name||"") + ")</span> " +
          "<span class='pill'>" + cp.lat.toFixed(5) + "," + cp.lon.toFixed(5) + "</span></div>";

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
        btnDel.onclick = () => {
          course.checkpoints = course.checkpoints.filter(x => x.id !== cp.id);
          const lyr = cpLayers.get(cp.id);
          if (lyr) map.removeLayer(lyr);
          cpLayers.delete(cp.id);
          renderCpsList();
          renderPhaseSelects();
        };

        right.appendChild(btnZoom);
        right.appendChild(btnDel);
        div.appendChild(right);
        box.appendChild(div);
      }
    }

    function renderPhaseSelects() {
      const zoneSel = el("phZone");
      zoneSel.innerHTML = "";
      for (const z of course.zones) {
        const opt = document.createElement("option");
        opt.value = z.id;
        opt.textContent = z.id + " — " + (z.name||"");
        zoneSel.appendChild(opt);
      }
      if (zoneSel.options.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(no zones)";
        zoneSel.appendChild(opt);
      }

      const cpSel = el("phCP");
      cpSel.innerHTML = "";
      for (const c of course.checkpoints) {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.id + " — " + (c.name||"");
        cpSel.appendChild(opt);
      }
      if (cpSel.options.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(no checkpoints)";
        cpSel.appendChild(opt);
      }
    }

    function renderPhases() {
      const box = el("phList");
      box.innerHTML = "";
      if (course.phases.length === 0) {
        box.innerHTML = "<div class='muted'>No phases.</div>";
        return;
      }

      course.phases.forEach((ph, idx) => {
        const div = document.createElement("div");
        div.className = "li";
        div.innerHTML =
          "<div><span class='mono'>" + (idx+1) + ".</span> " +
          "<span class='mono'>" + ph.id + "</span> " +
          "<span class='muted'>(" + (ph.name||"") + ")</span><br>" +
          "<span class='muted'>enter=" + (ph.enter_zone_id||"-") +
          " distCP=" + (ph.distance_checkpoint_id||"-") + "</span></div>";

        const right = document.createElement("div");
        right.style.display = "flex";
        right.style.gap = "6px";

        const btnUp = document.createElement("button");
        btnUp.textContent = "↑";
        btnUp.disabled = idx === 0;
        btnUp.onclick = () => {
          const tmp = course.phases[idx-1];
          course.phases[idx-1] = course.phases[idx];
          course.phases[idx] = tmp;
          renderPhases();
        };

        const btnDown = document.createElement("button");
        btnDown.textContent = "↓";
        btnDown.disabled = idx === course.phases.length - 1;
        btnDown.onclick = () => {
          const tmp = course.phases[idx+1];
          course.phases[idx+1] = course.phases[idx];
          course.phases[idx] = tmp;
          renderPhases();
        };

        const btnEdit = document.createElement("button");
        btnEdit.textContent = "Edit";
        btnEdit.onclick = () => {
          el("phId").value = ph.id || "";
          el("phName").value = ph.name || "";
          el("phZone").value = ph.enter_zone_id || "";
          el("phCP").value = ph.distance_checkpoint_id || "";
        };

        right.appendChild(btnUp);
        right.appendChild(btnDown);
        right.appendChild(btnEdit);

        div.appendChild(right);
        box.appendChild(div);
      });
    }

    // modes
    let mode = "none"; // none|rect|cp
    let rectClicks = [];

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

    el("modeNone").onclick = () => setMode("none");
    el("modeRect").onclick = () => { setMode("rect"); resetRectClicks(); };
    el("modeCP").onclick = () => setMode("cp");
    el("btnClearRect").onclick = () => { resetRectClicks(); setStatus("rect cancelled"); };

    map.on("click", (e) => {
      if (mode === "rect") {
        rectClicks.push(e.latlng);
        el("rectClicks").textContent = String(rectClicks.length);
        el("btnClearRect").disabled = false;

        if (rectClicks.length === 2) {
          const zId = (el("zoneId").value || "").trim();
          const zName = (el("zoneName").value || "").trim();
          if (!zId) { alert("Zone ID required"); resetRectClicks(); return; }

          const bounds = clampBounds(rectClicks[0], rectClicks[1]);
          const existing = course.zones.find(z => z.id === zId);
          const obj = { id: zId, name: zName, bounds };

          if (existing) Object.assign(existing, obj);
          else course.zones.push(obj);

          upsertZoneLayer(obj);
          renderZonesList();
          renderPhaseSelects();

          const nextZ = nextZoneId();
          el("zoneId").value = nextZ;
          el("zoneName").value = "Area " + nextZ.replace("Z","");
          resetRectClicks();
          setStatus("zone saved (local)");
        }
        return;
      }

      if (mode === "cp") {
        const cpId = (el("cpId").value || "").trim();
        const cpName = (el("cpName").value || "").trim();
        if (!cpId) { alert("Checkpoint ID required"); return; }

        const obj = { id: cpId, name: cpName, lat: e.latlng.lat, lon: e.latlng.lng };
        const existing = course.checkpoints.find(c => c.id === cpId);
        if (existing) Object.assign(existing, obj);
        else course.checkpoints.push(obj);

        upsertCheckpointLayer(obj);
        renderCpsList();
        renderPhaseSelects();

        const nextC = nextCheckpointId();
        el("cpId").value = nextC;
        el("cpName").value = "CP " + nextC;

        setStatus("checkpoint saved (local)");
      }
    });

    // phases upsert/delete
    el("btnUpsertPhase").onclick = () => {
      const id = (el("phId").value || "").trim();
      const name = (el("phName").value || "").trim();
      const enterZone = (el("phZone").value || "").trim();
      const distCP = (el("phCP").value || "").trim();

      if (!id) { alert("Phase ID required"); return; }
      if (!enterZone) { alert("Enter Zone required"); return; }
      if (!distCP) { alert("Distance CP required"); return; }

      const ph = { id, name, enter_zone_id: enterZone, distance_checkpoint_id: distCP };
      const existing = course.phases.find(p => p.id === id);
      if (existing) Object.assign(existing, ph);
      else course.phases.push(ph);

      renderPhases();
      setStatus("phase saved (local)");
    };

    el("btnDelPhase").onclick = () => {
      const id = (el("phId").value || "").trim();
      if (!id) { alert("Phase ID required"); return; }
      course.phases = course.phases.filter(p => p.id !== id);
      renderPhases();
      setStatus("phase deleted (local)");
    };

    // layouts
    async function refreshLayouts() {
      try {
        const r = await fetch(API + "/courses");
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();
        const names = Array.isArray(d.names) ? d.names : ["default"];

        const sel = el("layoutSelect");
        sel.innerHTML = "";
        names.forEach((n) => {
          const opt = document.createElement("option");
          opt.value = n;
          opt.textContent = n;
          sel.appendChild(opt);
        });

        const cur = (el("layoutName").value || "default").trim() || "default";
        sel.value = names.includes(cur) ? cur : "default";
      } catch {}
    }
    el("btnRefreshLayouts").onclick = refreshLayouts;
    el("layoutSelect").onchange = () => { el("layoutName").value = el("layoutSelect").value; };

    async function setActiveLayout(name) {
      try {
        await fetch(API + "/active_course", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
      } catch {}
    }

    // load/save
    el("btnLoad").onclick = async () => {
      try {
        const name = (el("layoutName").value || "default").trim() || "default";
        setStatus("loading...");
        const r = await fetch(API + "/course?name=" + encodeURIComponent(name));
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();

        course = {
          version: 1,
          name: d.name || name,
          zones: Array.isArray(d.zones) ? d.zones : [],
          checkpoints: Array.isArray(d.checkpoints) ? d.checkpoints : [],
          phases: Array.isArray(d.phases) ? d.phases : [],
          activeWithinSec: (typeof d.activeWithinSec === "number") ? d.activeWithinSec : 60,
        };

        redrawCourse();
        await setActiveLayout(course.name);
        await refreshLayouts();
        setStatus("loaded (active=" + course.name + ")");
      } catch (e) {
        setStatus("load error");
        alert("Load failed: " + e.message);
      }
    };

    el("btnSave").onclick = async () => {
      try {
        const name = (el("layoutName").value || "default").trim() || "default";
        setStatus("saving...");
        const r = await fetch(API + "/course?name=" + encodeURIComponent(name), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(course),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const resp = await r.json().catch(() => ({}));
        course.name = resp.name || name;

        await setActiveLayout(course.name);
        await refreshLayouts();
        setStatus("saved (active=" + course.name + ")");
      } catch (e) {
        setStatus("save error");
        alert("Save failed: " + e.message);
      }
    };

    // hidden devices
    async function loadHidden() {
      try {
        const r = await fetch(API + "/hidden_devices");
        if (!r.ok) return;
        const d = await r.json();
        const arr = Array.isArray(d.hidden) ? d.hidden : [];
        hiddenSet = new Set(arr);
        el("hiddenCount").textContent = String(arr.length);
        renderHiddenList(arr);
      } catch {}
    }

    async function setHidden(deviceId, hidden) {
      try {
        const r = await fetch(API + "/hidden_devices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_id: deviceId, hidden }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        await loadHidden();
      } catch (e) {
        alert("Hide/unhide failed: " + e.message);
      }
    }

    function renderHiddenList(arr) {
      const box = el("hiddenList");
      box.innerHTML = "";
      if (arr.length === 0) {
        box.innerHTML = "<div class='muted'>No hidden devices.</div>";
        return;
      }
      arr.forEach((id) => {
        const div = document.createElement("div");
        div.className = "li";
        div.innerHTML = "<div class='mono'>" + id + "</div>";
        const btn = document.createElement("button");
        btn.textContent = "Unhide";
        btn.onclick = () => setHidden(id, false);
        div.appendChild(btn);
        box.appendChild(div);
      });
    }

    // scoreboard map markers
    function upsertRacerMarker(device_id, lat, lon, label) {
      let m = racerMarkers.get(device_id);
      const ll = [lat, lon];
      if (!m) {
        m = L.marker(ll).addTo(map).bindPopup(device_id);
        racerMarkers.set(device_id, m);
      } else {
        m.setLatLng(ll);
      }
      m.bindTooltip(label, {permanent:true, direction:"top", offset:[0,-12]});
    }

    function removeRacerMarker(device_id) {
      const m = racerMarkers.get(device_id);
      if (m) {
        map.removeLayer(m);
        racerMarkers.delete(device_id);
      }
    }

    function renderScore(items, activeCount) {
      el("activeCount").textContent = String(activeCount ?? "-");
      el("totalCount").textContent = String(items.length);

      const box = el("scoreList");
      box.innerHTML = "";
      if (items.length === 0) {
        box.innerHTML = "<div class='muted'>No visible devices.</div>";
        return;
      }

      items.forEach((it, idx) => {
        const div = document.createElement("div");
        div.className = "li";

        const dist = (it.progress && it.progress.distM != null) ? (it.progress.distM.toFixed(0) + " m") : "-";
        const act = it.progress && it.progress.isActive ? "ACTIVE" : "offline";
        const ph = it.progress ? it.progress.phaseIndex : 0;
        const started = it.progress ? (it.progress.phaseStarted ? "started" : "not-started") : "n/a";

        div.innerHTML =
          "<div>" +
            "<div class='mono'>#" + (idx+1) + " " + it.device_id + "</div>" +
            "<div class='muted'>phase=" + ph + " (" + started + ") dist=" + dist + " " + act + "</div>" +
          "</div>";

        const right = document.createElement("div");
        right.style.display = "flex";
        right.style.gap = "6px";

        const btnHide = document.createElement("button");
        btnHide.textContent = "Hide";
        btnHide.className = "danger";
        btnHide.onclick = () => setHidden(it.device_id, true);

        right.appendChild(btnHide);
        div.appendChild(right);
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
        const items = Array.isArray(d.items) ? d.items : [];
        const active = d.active_count ?? 0;

        for (const id of hiddenSet) removeRacerMarker(id);
        renderScore(items, active);
      } catch {}
    }

    // init
    setMode("none");
    resetRectClicks();
    redrawCourse();
    loadHidden();
    refreshLayouts();
    tickScore();
    setInterval(tickScore, 1000);
  </script>
</body>
</html>`;

// ---------------------- Worker fetch ----------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (MAINTENANCE_MODE) return text("Service paused (maintenance mode)", 503);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // UI
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(INDEX_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
      });
    }

    // health
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, server_time_ms: nowMs() });
    }

    // list layouts
    if (request.method === "GET" && url.pathname === "/courses") {
      const names = await listCourses(env);
      return json({ ok: true, names });
    }

    // active layout
    if (url.pathname === "/active_course") {
      if (request.method === "GET") {
        const name = await getActiveCourseName(env);
        return json({ ok: true, name });
      }
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
        const name = normalizeCourseName(body?.name || "default");
        const out = await setActiveCourseName(env, name);
        return json({ ok: true, name: out });
      }
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    // hidden devices
    if (url.pathname === "/hidden_devices") {
      if (request.method === "GET") {
        const hidden = await getHiddenDevices(env);
        return json({ ok: true, hidden });
      }
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

        const device_id = String(body.device_id || "").trim();
        const hidden = !!body.hidden;
        if (!device_id) return json({ ok: false, error: "device_id required" }, 400);

        const arr = await getHiddenDevices(env);
        const set = new Set(arr);
        if (hidden) set.add(device_id);
        else set.delete(device_id);

        const out = Array.from(set);
        await setHiddenDevices(env, out);
        return json({ ok: true, hidden: out });
      }
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    // course (multi-layout)
    if (url.pathname === "/course") {
      const name = normalizeCourseName(url.searchParams.get("name") || "default");

      if (request.method === "GET") {
        const course = await getCourseByName(env, name);
        return json(course);
      }

      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

        const err = validateCourseBody(body);
        if (err) return json({ ok: false, error: err }, 400);

        const savedName = await saveCourseByName(env, name, body);
        return json({ ok: true, name: savedName });
      }

      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    // ingest: accepts your format
    if (request.method === "POST" && url.pathname === "/ingest") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      // Android → Worker field mapping
      const device_id = String(body.device_id ?? body.id ?? "").trim();
      const lat = Number(body.lat);
      const lon = Number(body.lon);

      const t_ms =
        body.t_ms != null ? Number(body.t_ms) :
        body.time != null ? Number(body.time) :
        Date.now();

      if (!device_id)
        return json({ ok: false, error: "device_id/id required" }, 400);

      if (!Number.isFinite(lat) || !Number.isFinite(lon))
        return json({ ok: false, error: "lat/lon required" }, 400);

      const entry = {
        device_id,
        lat,
        lon,
        t_ms,
        alt: body.alt ?? null,
        acc: body.acc ?? null,
        spd: body.spd ?? null,
        received_at_ms: Date.now()
      };

      await saveLatestAndRegisterDevice(env, entry);

      const course = await getActiveCourse(env);
      await updateRaceState(env, course, device_id, lat, lon, entry.received_at_ms);

      return json({ ok: true });
    }

    // traccar adapter (GET/POST)
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

        const course = await getActiveCourse(env);
        await updateRaceState(env, course, device_id, lat, lon, entry.received_at_ms);

        return text("OK");
      }

      if (request.method === "POST") {
        const device_id = String(url.searchParams.get("device_id") || url.searchParams.get("id") || "").trim();
        if (!device_id) return text("ERR: device_id (or id) required", 400);

        let body;
        try { body = await request.json(); } catch { return text("ERR: invalid JSON", 400); }

        // Try flexible shapes
        const p = body && body.location ? body.location : body;
        const c = p && p.coords ? p.coords : p;

        const lat = Number(c?.latitude ?? c?.lat);
        const lon = Number(c?.longitude ?? c?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return text("ERR: lat/lon required", 400);

        let t_ms = nowMs();
        const ts = p?.timestamp ?? p?.time ?? p?.t_ms;
        if (typeof ts === "number") t_ms = ts > 1e12 ? ts : ts * 1000;
        else if (typeof ts === "string") {
          const parsed = Date.parse(ts);
          if (!Number.isNaN(parsed)) t_ms = parsed;
        }

        const entry = { device_id, t_ms, lat, lon, received_at_ms: nowMs() };
        await saveLatestAndRegisterDevice(env, entry);

        const course = await getActiveCourse(env);
        await updateRaceState(env, course, device_id, lat, lon, entry.received_at_ms);

        return text("OK");
      }

      return text("Method not allowed", 405);
    }

    // latest_all (excluding hidden)
    if (request.method === "GET" && url.pathname === "/latest_all") {
      const hidden = new Set(await getHiddenDevices(env));
      const devicesRaw = await env.GPS_KV.get(KV_DEVICES_KEY);
      const devices = devicesRaw ? safeJsonParseArray(devicesRaw) : [];

      const items = [];
      for (const id of devices) {
        if (hidden.has(id)) continue;
        const raw = await env.GPS_KV.get(KV_LATEST_PREFIX + id);
        if (!raw) continue;
        try { items.push(JSON.parse(raw)); } catch {}
      }
      return json({ server_time_ms: nowMs(), items });
    }

    // scoreboard (uses ACTIVE layout)
    if (request.method === "GET" && url.pathname === "/scoreboard") {
      const course = await getActiveCourse(env);
      const serverTimeMs = nowMs();

      const hidden = await getHiddenDevices(env);
      const hiddenSet = new Set(hidden);

      const devicesRaw = await env.GPS_KV.get(KV_DEVICES_KEY);
      const devices = devicesRaw ? safeJsonParseArray(devicesRaw) : [];

      const out = [];
      for (const id of devices) {
        if (hiddenSet.has(id)) continue;

        let latest = null;
        const latestRaw = await env.GPS_KV.get(KV_LATEST_PREFIX + id);
        if (latestRaw) {
          try { latest = JSON.parse(latestRaw); } catch {}
        }

        let state = null;
        const stateRaw = await env.GPS_KV.get(KV_STATE_PREFIX + id);
        if (stateRaw) {
          try { state = JSON.parse(stateRaw); } catch {}
        }

        // bootstrap if missing state
        if (!state && latest && typeof latest.lat === "number" && typeof latest.lon === "number") {
          const u = await updateRaceState(env, course, id, latest.lat, latest.lon, latest.received_at_ms ?? serverTimeMs);
          state = u.state;
        }

        const progress = computeProgress(course, state, latest, serverTimeMs);
        out.push({ device_id: id, latest, state, progress });
      }

      out.sort(compareRank);

      return json({
        server_time_ms: serverTimeMs,
        active_course: course.name || (await getActiveCourseName(env)),
        active_count: out.filter((x) => x.progress.isActive).length,
        items: out,
      });
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};