// apps/api/src/index.js

const INDEX_HTML = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>GPS Tracker</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <style>
    html, body { height: 100%; margin: 0; }
    #map { height: 100%; }
    .hud{
      position: fixed; top: 10px; left: 10px; z-index: 9999;
      background: rgba(255,255,255,0.95);
      padding: 10px 12px;
      border-radius: 10px;
      font: 13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      box-shadow: 0 2px 10px rgba(0,0,0,0.15);
      width: 360px;
    }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
  </style>
</head>
<body>
<div class="hud">
  <div><b>Durum:</b> <span id="status">başlıyor…</span></div>
  <div class="mono" id="info">-</div>
</div>
<div id="map"></div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const API_BASE = location.origin;

  const statusEl = document.getElementById("status");
  const infoEl = document.getElementById("info");

  const map = L.map("map").setView([0,0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  const markers = new Map();

  function ensureMarker(device_id, lat, lon) {
    const ll = [lat, lon];
    if (!markers.has(device_id)) {
      const m = L.marker(ll).addTo(map).bindPopup(device_id);
      markers.set(device_id, m);
      map.setView(ll, 15);
    } else {
      markers.get(device_id).setLatLng(ll);
    }
  }

  async function tick(){
    try {
      statusEl.textContent = "çekiliyor…";
      const r = await fetch(\`\${API_BASE}/latest_all\`, { cache: "no-store" });
      if (!r.ok) throw new Error(\`HTTP \${r.status} @ \${r.url}\`);
      const d = await r.json();

      const items = d.items || [];
      infoEl.textContent = \`devices=\${items.length} | server=\${d.server_time_ms ?? "-"}\`;

      for (const it of items) {
        if (it.lat == null || it.lon == null) continue;
        ensureMarker(it.device_id, it.lat, it.lon);
      }
      statusEl.textContent = "ok";
    } catch(e) {
      statusEl.textContent = "hata";
      infoEl.textContent = String(e);
    }
  }

  tick();
  setInterval(tick, 1000);
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response("", { headers: corsHeaders() });
    }

    // GET /  -> Map UI (HTML)
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(INDEX_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // HTML için de CORS zarar vermez; ama şart değil. İstersen kaldırabilirsin.
          ...corsHeaders(),
        },
      });
    }

    // GET /health -> quick check
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, server_time_ms: Date.now() }, 200);
    }

    // POST /ingest
    if (url.pathname === "/ingest" && request.method === "POST") {
      let data;
      try {
        data = await request.json();
      } catch {
        return json({ ok: false, error: "invalid JSON" }, 400);
      }

      const device_id = String(data.device_id || "unknown");
      const lat = data.lat;
      const lon = data.lon;
      const t_ms = Number(data.t_ms || Date.now());

      if (lat == null || lon == null) {
        return json({ ok: false, error: "lat/lon required" }, 400);
      }

      const entry = {
        device_id,
        t_ms,
        lat: Number(lat),
        lon: Number(lon),
        received_at_ms: Date.now(),
      };

      await env.GPS_KV.put(`latest:${device_id}`, JSON.stringify(entry));

      // devices list
      const devicesRaw = await env.GPS_KV.get("devices");
      const devices = devicesRaw ? safeJsonParseArray(devicesRaw) : [];
      if (!devices.includes(device_id)) {
        devices.push(device_id);
        await env.GPS_KV.put("devices", JSON.stringify(devices));
      }

      return json({ ok: true }, 200);
    }

    // GET /latest_all
    if (url.pathname === "/latest_all" && request.method === "GET") {
      const devicesRaw = await env.GPS_KV.get("devices");
      const devices = devicesRaw ? safeJsonParseArray(devicesRaw) : [];

      const items = [];
      for (const id of devices) {
        const v = await env.GPS_KV.get(`latest:${id}`);
        if (v) {
          try { items.push(JSON.parse(v)); } catch {}
        }
      }

      return json({ server_time_ms: Date.now(), items }, 200);
    }

    // GET /latest?device_id=...
    if (url.pathname === "/latest" && request.method === "GET") {
      const device_id = url.searchParams.get("device_id");
      if (!device_id) return json({ error: "device_id required" }, 400);

      const v = await env.GPS_KV.get(`latest:${device_id}`);
      if (!v) return json({ device_id, lat: null, lon: null, t_ms: null }, 200);

      try {
        return json(JSON.parse(v), 200);
      } catch {
        return json({ error: "stored JSON corrupted", device_id }, 500);
      }
    }

    return json({ error: "not found", path: url.pathname }, 404);
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function safeJsonParseArray(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
