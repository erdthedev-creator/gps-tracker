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
  <title>GPS Tracker + Scoreboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
  />
  <style>
    html, body { height: 100%; margin: 0; }
    #map { height: 100%; width: 100%; }
    .panel {
      position: absolute;
      top: 10px;
      left: 10px;
      z-index: 1000;
      background: rgba(255,255,255,0.95);
      padding: 10px;
      border-radius: 10px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      max-width: 340px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    }
    .panel h3 { margin: 0 0 6px 0; font-size: 14px; }
    .row { display: flex; gap: 8px; font-size: 12px; margin-bottom: 6px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    #score { max-height: 260px; overflow: auto; border-top: 1px solid #eee; padding-top: 6px; }
    .item { padding: 4px 0; border-bottom: 1px dashed #eee; }
    .muted { color: #666; }
  </style>
</head>
<body>
  <div id="map"></div>

  <div class="panel">
    <h3>Scoreboard</h3>
    <div class="row">
      <div>Status: <span id="status" class="mono">starting…</span></div>
    </div>
    <div class="row muted">
      <div>Tip: course/rules KV’den okunur. Sıralama phase/step + anchor mesafesi ile yapılır.</div>
    </div>
    <div id="score"></div>
  </div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const API = location.origin;

    const map = L.map("map").setView([41.086, 29.047], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    const markers = new Map();
    let firstFitDone = false;

    function setStatus(s){ document.getElementById("status").textContent = s; }

    function upsertMarker(device_id, lat, lon, label) {
      let m = markers.get(device_id);
      const ll = [lat, lon];
      if (!m) {
        m = L.marker(ll).addTo(map).bindPopup(device_id);
        markers.set(device_id, m);
      } else {
        m.setLatLng(ll);
      }
      if (label) m.bindTooltip(label, {permanent: true, direction: "top", offset:[0,-12]});
    }

    function renderScoreboard(items) {
      const box = document.getElementById("score");
      box.innerHTML = "";

      items.forEach((it, idx) => {
        const div = document.createElement("div");
        div.className = "item";
        const distTxt = (it.progress.distM == null) ? "-" : (it.progress.distM.toFixed(0) + " m");
        const activeTxt = it.progress.isActive ? "ACTIVE" : "offline";
        div.innerHTML =
          "<div class='mono'>#" + (idx+1) + " " + it.device_id + "</div>" +
          "<div class='muted'>phase=" + it.progress.phaseIndex + " step=" + it.progress.seqIndex + " dist=" + distTxt + " " + activeTxt + "</div>";
        box.appendChild(div);

        // marker label show rank
        if (it.latest && typeof it.latest.lat === "number" && typeof it.latest.lon === "number") {
          upsertMarker(it.device_id, it.latest.lat, it.latest.lon, "#" + (idx+1));
          if (!firstFitDone) {
            map.setView([it.latest.lat, it.latest.lon], 14);
            firstFitDone = true;
          }
        }
      });
    }

    async function tick() {
      try {
        const r = await fetch(API + "/scoreboard");
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();
        renderScoreboard(d.items || []);
        setStatus("ok");
      } catch (e) {
        setStatus("error: " + e.message);
      }
    }

    tick();
    setInterval(tick, 1000);
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