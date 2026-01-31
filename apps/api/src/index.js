export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response("", { headers: corsHeaders() });
    }

    // POST /ingest
    if (url.pathname === "/ingest" && request.method === "POST") {
      const data = await request.json();

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
      const devices = devicesRaw ? JSON.parse(devicesRaw) : [];
      if (!devices.includes(device_id)) {
        devices.push(device_id);
        await env.GPS_KV.put("devices", JSON.stringify(devices));
      }

      return json({ ok: true }, 200);
    }

    // GET /latest_all
    if (url.pathname === "/latest_all" && request.method === "GET") {
      const devicesRaw = await env.GPS_KV.get("devices");
      const devices = devicesRaw ? JSON.parse(devicesRaw) : [];

      const items = [];
      for (const id of devices) {
        const v = await env.GPS_KV.get(`latest:${id}`);
        if (v) items.push(JSON.parse(v));
      }

      return json({ server_time_ms: Date.now(), items }, 200);
    }

    // GET /latest?device_id=...
    if (url.pathname === "/latest" && request.method === "GET") {
      const device_id = url.searchParams.get("device_id");
      if (!device_id) return json({ error: "device_id required" }, 400);

      const v = await env.GPS_KV.get(`latest:${device_id}`);
      return json(v ? JSON.parse(v) : { device_id, lat: null, lon: null, t_ms: null }, 200);
    }

    return json({ error: "not found" }, 404);
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
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
