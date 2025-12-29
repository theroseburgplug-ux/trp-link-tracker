// TRP Link Tracker Worker — Hybrid Analytics Version (Per-click + Aggregates)

// Main export
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

async function handleRequest(request, env, ctx) {
  if (!env || !env.LINKS) {
    return new Response("KV binding LINKS missing. Check wrangler config.", {
      status: 500,
    });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, ""); // trim trailing slash

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ---------- API ROUTES ----------
// DEBUG ROUTE — LIST ALL LINKS & KEYS
if (path === "/debug/list-all") {
  const list = await env.LINKS.list();
  const out = [];

  for (const entry of list.keys) {
    if (!entry.name.startsWith("click:")) {
      const data = await env.LINKS.get(entry.name);
      out.push(JSON.parse(data));
    }
  }

  return new Response(JSON.stringify(out, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
}

  // Create short link
  if (path === "/api/links" && request.method === "POST") {
    return handleCreateLink(request, env, corsHeaders, url);
  }

  // List links for a given key
  if (path === "/api/links" && request.method === "GET") {
    return handleListLinks(request, env, corsHeaders);
  }

  // Recent clicks for a link
  if (path.startsWith("/api/recent-clicks/") && request.method === "GET") {
    const slug = path.replace("/api/recent-clicks/", "");
    return handleRecentClicks(slug, request, env, corsHeaders);
  }

  // Basic stats JSON (auth required)
  if (path.startsWith("/api/stats/") && request.method === "GET") {
    const slug = path.replace("/api/stats/", "");
    return handleStats(slug, request, env, corsHeaders);
  }

  // Dashboard JSON (same as stats but slightly richer structure)
  if (path.startsWith("/api/dashboard/") && request.method === "GET") {
    const slug = path.replace("/api/dashboard/", "");
    return handleDashboard(slug, request, env, corsHeaders);
  }

  // Update link
  if (path.startsWith("/api/update/") && request.method === "PUT") {
    const slug = path.replace("/api/update/", "");
    return handleUpdateLink(slug, request, env, corsHeaders);
  }

  // Delete link
  if (path.startsWith("/api/delete/") && request.method === "DELETE") {
    const slug = path.replace("/api/delete/", "");
    return handleDeleteLink(slug, request, env, corsHeaders);
  }

  // ---------- REDIRECT SHORT LINK ----------
  if (path !== "" && path !== "/" && path.length > 1) {
    const slug = path.slice(1);
    const linkData = await env.LINKS.get(slug);

    if (linkData) {
      const link = JSON.parse(linkData);

      // Track click (per-event + aggregate + total)
      // Don't block redirect if tracking fails
      trackClick(slug, request, env, link).catch(() => {});

      return Response.redirect(link.destination, 302);
    }
  }

  // ---------- HOMEPAGE ----------
  if (path === "" || path === "/") {
    return new Response("<h1>TRP Link Tracker Running</h1>", {
      headers: { "Content-Type": "text/html" },
    });
  }

  return json({ error: "Not found" }, 404, corsHeaders);
}

// --------------------------------------------------------
// CREATE LINK
// --------------------------------------------------------

async function handleCreateLink(request, env, cors, url) {
  try {
    const data = await request.json();
    let { slug, destination, title } = data;

    if (!destination) {
      return json({ error: "Destination URL is required" }, 400, cors);
    }

    destination = destination.trim();

    // Validate URL
    if (!isValidUrl(destination)) {
      return json({ error: "Invalid destination URL" }, 400, cors);
    }

    if (!slug || !slug.trim()) {
      slug = generateSlug();
    }

    slug = slug.trim();

    const exists = await env.LINKS.get(slug);
    if (exists) {
      return json({ error: "Slug already in use" }, 409, cors);
    }

    const owner_key = generateOwnerKey();
    const now = Date.now();

    const record = {
      slug,
      destination,
      title: title || "",
      created: now,
      updated: now,
      owner_key,
      clicks: 0, // total clicks counter
    };

    await env.LINKS.put(slug, JSON.stringify(record));

    // Add to owner index
    await indexOwnerKey(env, owner_key, slug);

    return json(
      {
        success: true,
        slug,
        short_url: `${url.origin}/${slug}`,
        dashboard_url: `${url.origin}/dashboard/${slug}?key=${owner_key}`,
        owner_key,
      },
      200,
      cors
    );
  } catch (err) {
    return json(
      { error: "Invalid JSON body", details: err.message },
      400,
      cors
    );
  }
}

// --------------------------------------------------------
// LIST LINKS FOR OWNER KEY
// --------------------------------------------------------

async function handleListLinks(request, env, cors) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!key) return json({ error: "Missing ?key=" }, 400, cors);

  // Use owner index for fast lookup
  const indexKey = `owner_index:${key}`;
  const indexData = await env.LINKS.get(indexKey);
  
  if (!indexData) {
    return json({ links: [] }, 200, cors);
  }

  const slugs = JSON.parse(indexData);
  const links = [];

  for (const slug of slugs) {
    const obj = await env.LINKS.get(slug);
    if (obj) {
      const parsed = JSON.parse(obj);
      links.push(parsed);
    }
  }

  links.sort((a, b) => b.created - a.created);
  return json({ links }, 200, cors);
}

// --------------------------------------------------------
// STATS + DASHBOARD (using aggregates)
// --------------------------------------------------------

async function handleStats(slug, request, env, cors) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  const data = await env.LINKS.get(slug);
  if (!data) return json({ error: "Link not found" }, 404, cors);

  const link = JSON.parse(data);

  if (!key || key !== link.owner_key) {
    return json({ error: "Unauthorized" }, 403, cors);
  }

  const aggregates = await getAggregatesForLink(slug, env, 30);

  return json(
    {
      slug,
      destination: link.destination,
      title: link.title || "",
      created: link.created,
      updated: link.updated,
      totalClicks: link.clicks || 0,
      aggregates,
    },
    200,
    cors
  );
}

async function handleDashboard(slug, request, env, cors) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  const data = await env.LINKS.get(slug);
  if (!data) return json({ error: "Link not found" }, 404, cors);

  const link = JSON.parse(data);

  if (!key || key !== link.owner_key) {
    return json({ error: "Unauthorized" }, 403, cors);
  }

  const aggregates = await getAggregatesForLink(slug, env, 30);

  return json(
    {
      link: {
        slug,
        destination: link.destination,
        title: link.title || "",
        created: link.created,
        updated: link.updated,
        totalClicks: link.clicks || 0,
      },
      analytics: aggregates,
    },
    200,
    cors
  );
}

// --------------------------------------------------------
// RECENT CLICKS
// --------------------------------------------------------

async function handleRecentClicks(slug, request, env, cors) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);

  const data = await env.LINKS.get(slug);
  if (!data) return json({ error: "Link not found" }, 404, cors);

  const link = JSON.parse(data);

  if (!key || key !== link.owner_key) {
    return json({ error: "Unauthorized" }, 403, cors);
  }

  // Get recent click events
  const clickList = await env.LINKS.list({ prefix: `click:${slug}:` });
  const clicks = [];

  for (const entry of clickList.keys) {
    if (clicks.length >= limit) break;
    
    const clickData = await env.LINKS.get(entry.name);
    if (clickData) {
      const click = JSON.parse(clickData);
      clicks.push(click);
    }
  }

  // Sort by timestamp descending (most recent first)
  clicks.sort((a, b) => b.timestamp - a.timestamp);

  return json(
    {
      slug,
      clicks: clicks.slice(0, limit),
      total: link.clicks || 0,
    },
    200,
    cors
  );
}

// --------------------------------------------------------
// UPDATE / DELETE
// --------------------------------------------------------

async function handleUpdateLink(slug, request, env, cors) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  const data = await env.LINKS.get(slug);
  if (!data) return json({ error: "Not found" }, 404, cors);

  const link = JSON.parse(data);

  if (!key || key !== link.owner_key) {
    return json({ error: "Unauthorized" }, 403, cors);
  }

  const incoming = await request.json();

  if (incoming.destination) {
    const destination = incoming.destination.trim();
    
    // Validate URL
    if (!isValidUrl(destination)) {
      return json({ error: "Invalid destination URL" }, 400, cors);
    }
    
    link.destination = destination;
  }

  if (typeof incoming.title === "string") {
    link.title = incoming.title.trim();
  }

  link.updated = Date.now();
  await env.LINKS.put(slug, JSON.stringify(link));

  return json({ success: true }, 200, cors);
}

async function handleDeleteLink(slug, request, env, cors) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  const data = await env.LINKS.get(slug);
  if (!data) return json({ error: "Not found" }, 404, cors);

  const link = JSON.parse(data);

  if (key !== link.owner_key) return json({ error: "Unauthorized" }, 403, cors);

  // Remove from owner index
  const indexKey = `owner_index:${link.owner_key}`;
  const indexData = await env.LINKS.get(indexKey);
  if (indexData) {
    const slugs = JSON.parse(indexData);
    const filtered = slugs.filter(s => s !== slug);
    if (filtered.length > 0) {
      await env.LINKS.put(indexKey, JSON.stringify(filtered));
    } else {
      await env.LINKS.delete(indexKey);
    }
  }

  // delete per-click events
  const clickList = await env.LINKS.list({ prefix: `click:${slug}:` });
  for (const entry of clickList.keys) {
    await env.LINKS.delete(entry.name);
  }

  // delete aggregates
  const aggList = await env.LINKS.list({ prefix: `agg:${slug}:` });
  for (const entry of aggList.keys) {
    await env.LINKS.delete(entry.name);
  }

  await env.LINKS.delete(slug);
  return json({ success: true }, 200, cors);
}

// --------------------------------------------------------
// ANALYTICS STORAGE (HYBRID STRATEGY C)
// --------------------------------------------------------

async function trackClick(slug, request, env, linkRecord) {
  const now = Date.now();
  const cf = request.cf || {};

  const headers = request.headers || new Headers();
  const ua = headers.get("User-Agent") || "";
  const referer = headers.get("Referer") || "";

  // Geolocation + device (Cloudflare provides this in production)
  const country = cf.country || null;
  const region = cf.region || cf.regionCode || null;
  const city = cf.city || null;
  const deviceType = cf.deviceType || null;
  const browser = cf.clientTcpRtt ? null : detectBrowserFromUA(ua);
  const os = detectOSFromUA(ua);

  const ip =
    headers.get("CF-Connecting-IP") ||
    headers.get("x-forwarded-for") ||
    null;
  const iphash = await hashIP(ip);

  // Extract UTM params from querystring, if present
  const url = new URL(request.url);
  const utm = {
    source: url.searchParams.get("utm_source"),
    medium: url.searchParams.get("utm_medium"),
    campaign: url.searchParams.get("utm_campaign"),
    term: url.searchParams.get("utm_term"),
    content: url.searchParams.get("utm_content"),
  };

  const event = {
    timestamp: now,
    country,
    region,
    city,
    device: deviceType,
    browser,
    os,
    referrer: referer || null,
    utm,
    iphash,
  };

  // 1) Store individual click event
  const clickId = `click:${slug}:${now}:${Math.random()
    .toString(16)
    .slice(2)}`;
  await env.LINKS.put(clickId, JSON.stringify(event));

  // 2) Update per-day aggregate for this slug
  const dateStr = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
  const aggKey = `agg:${slug}:${dateStr}`;
  const existingAgg = await env.LINKS.get(aggKey);
  let agg;

  if (existingAgg) {
    agg = JSON.parse(existingAgg);
  } else {
    agg = {
      date: dateStr,
      total: 0,
      byCountry: {},
      byReferrer: {},
      byDevice: {},
      byBrowser: {},
    };
  }

  agg.total += 1;

  if (country) incrementCount(agg.byCountry, country);
  if (deviceType) incrementCount(agg.byDevice, deviceType);
  if (browser) incrementCount(agg.byBrowser, browser);

  if (referer) {
    const refDomain = normalizeReferrerDomain(referer);
    if (refDomain) incrementCount(agg.byReferrer, refDomain);
  }

  await env.LINKS.put(aggKey, JSON.stringify(agg));

  // 3) Increment total clicks on link record
  let link = linkRecord;
  if (!link) {
    const stored = await env.LINKS.get(slug);
    if (!stored) return;
    link = JSON.parse(stored);
  }

  link.clicks = (link.clicks || 0) + 1;
  link.updated = now;
  await env.LINKS.put(slug, JSON.stringify(link));
}

// Get merged aggregates for last N days
async function getAggregatesForLink(slug, env, days = 30) {
  // List all agg keys for this slug
  const list = await env.LINKS.list({ prefix: `agg:${slug}:` });

  const today = new Date();
  const cutoff = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);

  const byDate = [];
  const countryMap = {};
  const referrerMap = {};
  const deviceMap = {};
  const browserMap = {};

  for (const entry of list.keys) {
    const key = entry.name; // agg:slug:YYYY-MM-DD
    const parts = key.split(":");
    const dateStr = parts[2];
    if (!dateStr) continue;

    const date = new Date(dateStr + "T00:00:00Z");
    if (date < cutoff) continue;

    const raw = await env.LINKS.get(key);
    if (!raw) continue;

    const agg = JSON.parse(raw);

    byDate.push({
      date: agg.date,
      total: agg.total || 0,
    });

    if (agg.byCountry) {
      for (const [c, count] of Object.entries(agg.byCountry)) {
        incrementCount(countryMap, c, count);
      }
    }

    if (agg.byReferrer) {
      for (const [ref, count] of Object.entries(agg.byReferrer)) {
        incrementCount(referrerMap, ref, count);
      }
    }

    if (agg.byDevice) {
      for (const [dev, count] of Object.entries(agg.byDevice)) {
        incrementCount(deviceMap, dev, count);
      }
    }

    if (agg.byBrowser) {
      for (const [br, count] of Object.entries(agg.byBrowser)) {
        incrementCount(browserMap, br, count);
      }
    }
  }

  // Sort by date ascending
  byDate.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const mapToArray = (m, keyName) =>
    Object.entries(m)
      .map(([k, v]) => ({ [keyName]: k, total: v }))
      .sort((a, b) => b.total - a.total);

  return {
    byDate,
    byCountry: mapToArray(countryMap, "country"),
    byReferrer: mapToArray(referrerMap, "referrer"),
    byDevice: mapToArray(deviceMap, "device"),
    byBrowser: mapToArray(browserMap, "browser"),
  };
}

// --------------------------------------------------------
// Utility helpers
// --------------------------------------------------------

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function generateOwnerKey() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateSlug() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 6; i++)
    s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function incrementCount(map, key, amount = 1) {
  if (!key) return;
  if (!map[key]) map[key] = 0;
  map[key] += amount;
}

// Very light UA parsing (just enough for dashboards)
function detectBrowserFromUA(ua) {
  const s = ua.toLowerCase();
  if (!s) return null;
  if (s.includes("edge")) return "Edge";
  if (s.includes("opr") || s.includes("opera")) return "Opera";
  if (s.includes("chrome")) return "Chrome";
  if (s.includes("safari")) return "Safari";
  if (s.includes("firefox")) return "Firefox";
  return "Other";
}

function detectOSFromUA(ua) {
  const s = ua.toLowerCase();
  if (!s) return null;
  if (s.includes("windows")) return "Windows";
  if (s.includes("mac os") || s.includes("macintosh")) return "macOS";
  if (s.includes("android")) return "Android";
  if (s.includes("iphone") || s.includes("ipad") || s.includes("ios"))
    return "iOS";
  if (s.includes("linux")) return "Linux";
  return "Other";
}

function normalizeReferrerDomain(ref) {
  try {
    const u = new URL(ref);
    return u.hostname.replace(/^www\./, "");
  } catch {
    // ref might be like "https://..." or something weird
    return null;
  }
}

async function hashIP(ip) {
  if (!ip) return null;
  try {
    const enc = new TextEncoder();
    const data = enc.encode(ip);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    // truncate so we aren't storing full fingerprint
    return hex.slice(0, 32);
  } catch {
    return null;
  }
}

// Validate URL format
function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    // Only allow http and https protocols
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Index owner key for fast lookups
async function indexOwnerKey(env, owner_key, slug) {
  const indexKey = `owner_index:${owner_key}`;
  const existing = await env.LINKS.get(indexKey);
  
  let slugs = [];
  if (existing) {
    slugs = JSON.parse(existing);
  }
  
  if (!slugs.includes(slug)) {
    slugs.push(slug);
    await env.LINKS.put(indexKey, JSON.stringify(slugs));
  }
}
