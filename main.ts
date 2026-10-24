// Deno Deploy - Vavoo Stream Proxy (self-healing)
// Deploy: https://dash.deno.com/new (Playground o GitHub)

const PING_URL = "https://www.vavoo.tv/api/app/ping";
const BASE_SITES = ["https://vavoo.to", "https://kool.to"];
const LANGUAGE = "de";
const REGION = "US";
const SEPARATORS = ["➾", "⟿", "->", "→", "»", "›"];

// Cache in-memory (persiste tra richieste nello stesso isolate)
const cache = {
  sig: { value: null as string | null, ts: 0 },
  catalog: { value: null as any[] | null, ts: 0 },
  resolve: {} as Record<string, { url: string; ts: number }>,
};

const SIG_TTL = 240000;
const CATALOG_TTL = 600000;
const RESOLVE_TTL = 300000;

async function getSig(): Promise<string> {
  const now = Date.now();
  if (cache.sig.value && now - cache.sig.ts < SIG_TTL) return cache.sig.value;

  const ts = now;
  const payload = {
    reason: "app-focus", locale: LANGUAGE, theme: "dark",
    metadata: {
      device: { type: "desktop", uniqueId: `deno-${ts}` },
      os: { name: "linux", version: "Linux", abis: ["x64"], host: "node" },
      app: { platform: "electron" },
      version: { package: "tv.vavoo.app", binary: "3.1.8", js: "3.1.8" },
    },
    appFocusTime: 0, playerActive: false, playDuration: 0,
    devMode: false, hasAddon: true, castConnected: false,
    package: "tv.vavoo.app", version: "3.1.8", process: "app",
    firstAppStart: ts, lastAppStart: ts, ipLocation: null,
    adblockEnabled: true,
    proxy: { supported: ["ss"], engine: "Mu", enabled: false, autoServer: true },
    iap: { supported: false },
  };

  const r = await fetch(PING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "MediaHubMX/2" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("Ping HTTP " + r.status);
  const data = await r.json();
  if (!data.addonSig) throw new Error("No addonSig");
  cache.sig = { value: data.addonSig, ts: now };
  return data.addonSig;
}

function apiHeaders(sig: string) {
  return {
    "content-type": "application/json; charset=utf-8",
    "mediahubmx-signature": sig,
    "user-agent": "MediaHubMX/2",
    "accept": "*/*",
    "Accept-Language": LANGUAGE,
  };
}

function extractCountry(group: string): string {
  group = (group || "").trim();
  if (!group) return "default";
  for (const sep of SEPARATORS) {
    if (group.includes(sep)) return group.split(sep)[0].trim() || "default";
  }
  return group;
}

async function loadCatalog(): Promise<any[]> {
  const now = Date.now();
  if (cache.catalog.value && now - cache.catalog.ts < CATALOG_TTL) {
    return cache.catalog.value;
  }

  const sig = await getSig();
  let channels: any[] = [];
  const errors: string[] = [];

  for (const base of BASE_SITES) {
    let cursor: string | null = null;
    try {
      while (true) {
        const body = {
          language: LANGUAGE, region: REGION,
          catalogId: "iptv", id: "iptv",
          adult: false, search: "", sort: "",
          filter: {}, cursor: cursor, clientVersion: "3.0.2",
        };
        const r = await fetch(base + "/mediahubmx-catalog.json", {
          method: "POST",
          headers: apiHeaders(sig),
          body: JSON.stringify(body),
        });
        if (!r.ok) { errors.push(base + " HTTP " + r.status); break; }
        const data = await r.json();
        for (const item of data.items || []) {
          if (item.type === "iptv" && item.url) {
            channels.push({
              name: item.name || "Unknown",
              url: item.url,
              logo: item.logo || "",
              country: extractCountry(item.group || ""),
            });
          }
        }
        cursor = data.nextCursor;
        if (!cursor) break;
      }
      if (channels.length > 0) break;
    } catch (e: any) {
      errors.push(base + ": " + e.message);
    }
  }

  if (channels.length === 0) throw new Error("Catalog empty: " + errors.join(" | "));
  cache.catalog = { value: channels, ts: now };
  return channels;
}

function findChannel(query: string, catalog: any[]): any | null {
  const ita = catalog.filter(c => c.country.toLowerCase() === "italy");
  const q = query.toLowerCase();

  for (const ch of ita) if (ch.name.toLowerCase() === q) return ch;
  for (const ch of ita) {
    const n = ch.name.toLowerCase();
    if (q.includes(n) || n.includes(q)) return ch;
  }
  const words = new Set(q.split(" "));
  let best: any = null;
  let bestScore = 0;
  for (const ch of ita) {
    const score = [...words].filter(w => ch.name.toLowerCase().includes(w)).length;
    if (score > bestScore) { best = ch; bestScore = score; }
  }
  return bestScore >= Math.max(1, words.size - 1) ? best : null;
}

async function resolveChannel(channelUrl: string): Promise<{ url: string | null; errors: string[] }> {
  const sig = await getSig();
  const errors: string[] = [];

  for (const base of BASE_SITES) {
    try {
      const body = { language: LANGUAGE, region: REGION, url: channelUrl, clientVersion: "3.0.2" };
      const r = await fetch(base + "/mediahubmx-resolve.json", {
        method: "POST",
        headers: apiHeaders(sig),
        body: JSON.stringify(body),
      });
      if (!r.ok) { errors.push(base + " HTTP " + r.status); continue; }
      const data = await r.json();
      if (Array.isArray(data) && data[0] && data[0].url) return { url: data[0].url, errors };
      if (data && data.url) return { url: data.url, errors };
      if (data && data.streamUrl) return { url: data.streamUrl, errors };
      errors.push(base + " no url");
    } catch (e: any) {
      errors.push(base + ": " + e.message);
    }
  }
  return { url: null, errors };
}

// Riscrive TUTTI gli URL del manifest (assoluti E relativi) via proxy /seg
function rewriteManifest(text: string, manifestUrl: string, origin: string): string {
  return text.split("\n").map(line => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return line;
    try {
      const absolute = new URL(t, manifestUrl).href;
      return origin + "/seg?u=" + encodeURIComponent(absolute);
    } catch {
      return line;
    }
  }).join("\n");
}

async function getStreamUrl(ch: string): Promise<string> {
  const now = Date.now();
  const cached = cache.resolve[ch];
  if (cached && now - cached.ts < RESOLVE_TTL) return cached.url;

  const catalog = await loadCatalog();
  const match = findChannel(ch, catalog);
  if (!match) throw new Error("canale non trovato: " + ch);
  const result = await resolveChannel(match.url);
  if (!result.url) throw new Error("resolve fallito: " + result.errors.join(" | "));
  cache.resolve[ch] = { url: result.url, ts: now };
  return result.url;
}

async function handleRequest(request: Request): Promise<Response> {
  const u = new URL(request.url);
  const CORS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" };

  // HEALTH
  if (u.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "ok", service: "vavoo-deno", time: new Date().toISOString(),
    }), { headers: { "Content-Type": "application/json", ...CORS } });
  }

  // DEBUG: /debug?ch=sky sport uno
  if (u.pathname === "/debug") {
    const ch = u.searchParams.get("ch") || "sky sport uno";
    const steps: string[] = [];
    try {
      steps.push("1. resolve...");
      const streamUrl = await getStreamUrl(ch);
      steps.push("   OK: " + streamUrl.substring(0, 60));

      steps.push("2. fetch manifest...");
      const resp = await fetch(streamUrl, { headers: { "User-Agent": "VAVOO/2.6" } });
      steps.push("   HTTP " + resp.status);
      if (!resp.ok) return new Response(steps.join("\n"), { headers: { "Content-Type": "text/plain", ...CORS } });

      const text = await resp.text();
      const lines = text.split("\n");
      steps.push("3. manifest: " + lines.length + " righe");
      steps.push("--- prime 12 righe ---");
      lines.slice(0, 12).forEach(l => steps.push(l));
      steps.push("--- fine ---");

      const segLine = lines.map(l => l.trim()).find(l => l && !l.startsWith("#"));
      if (segLine) {
        const segUrl = new URL(segLine, streamUrl).href;
        steps.push("4. test primo segmento (diretto)...");
        steps.push("   " + segUrl.substring(0, 80));
        const segResp = await fetch(segUrl, { headers: { "User-Agent": "VAVOO/2.6" } });
        steps.push("   HTTP " + segResp.status + " | " + (segResp.headers.get("content-type") || "?") +
                   " | " + (segResp.headers.get("content-length") || "?") + " bytes");
        const proxied = u.origin + "/seg?u=" + encodeURIComponent(segUrl);
        const proxyResp = await fetch(proxied);
        steps.push("5. test via /seg proxy...");
        steps.push("   HTTP " + proxyResp.status + " | " + (proxyResp.headers.get("content-type") || "?"));
      }
      return new Response(steps.join("\n"), { headers: { "Content-Type": "text/plain", ...CORS } });
    } catch (e: any) {
      steps.push("ERRORE: " + e.message);
      return new Response(steps.join("\n"), { status: 500, headers: { "Content-Type": "text/plain", ...CORS } });
    }
  }

  // LIVE: /live?ch=<nome>           → segmenti via proxy
  //       /live?ch=<nome>&direct=1  → manifest con URL diretti al CDN
  if (u.pathname === "/live") {
    const ch = u.searchParams.get("ch");
    if (!ch) return new Response("uso: /live?ch=<nome> (&direct=1)", { status: 400 });
    try {
      const streamUrl = await getStreamUrl(ch);
      const resp = await fetch(streamUrl, { headers: { "User-Agent": "VAVOO/2.6" } });
      if (!resp.ok) {
        delete cache.resolve[ch];
        return new Response("unavailable HTTP " + resp.status, { status: 502 });
      }
      const text = await resp.text();

      if (u.searchParams.get("direct")) {
        return new Response(text, {
          headers: { "Content-Type": "application/vnd.apple.mpegurl", ...CORS },
        });
      }

      const rewritten = rewriteManifest(text, streamUrl, u.origin);
      return new Response(rewritten, {
        headers: { "Content-Type": "application/vnd.apple.mpegurl", ...CORS },
      });
    } catch (e: any) {
      return new Response("error: " + e.message, { status: 500 });
    }
  }

  // SEGMENTI: /seg?u=<url>
  if (u.pathname === "/seg") {
    const target = u.searchParams.get("u");
    if (!target) return new Response("uso: /seg?u=<url>", { status: 400 });
    try {
      const resp = await fetch(target, { headers: { "User-Agent": "VAVOO/2.6" } });
      if (!resp.ok) return new Response("upstream " + resp.status, { status: 502 });
      const ct = resp.headers.get("content-type") || "video/mp2t";
      const buf = await resp.arrayBuffer();
      return new Response(buf, {
        headers: { "Content-Type": ct, "Content-Length": String(buf.byteLength), ...CORS },
      });
    } catch (e: any) {
      return new Response("error: " + e.message, { status: 500 });
    }
  }

  return new Response("uso: /debug?ch=<nome> | /live?ch=<nome> (&direct=1)", { status: 400 });
}

// Entry point Deno Deploy
Deno.serve(handleRequest);
