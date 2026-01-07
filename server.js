import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== ENV VARS =====
const NEWSAPI_KEY = process.env.NEWSAPI_KEY; // your NewsAPI key (secret, backend-only)
const BROKER_KEY = process.env.BROKER_KEY;   // key your GPT Action will send in X-API-Key

if (!NEWSAPI_KEY) console.warn("Missing NEWSAPI_KEY env var");
if (!BROKER_KEY) console.warn("Missing BROKER_KEY env var");

// ===== AUTH (for GPT Action -> your backend) =====
app.use((req, res, next) => {
  const key = req.header("X-API-Key");
  if (!BROKER_KEY || !key || key !== BROKER_KEY) {
    return res.status(401).json({ message: "Missing/invalid API key" });
  }
  next();
});

// ===== FEEDS (your feed_id -> NewsAPI query templates) =====
// Practical reality: NewsAPI doesn't provide "TikTok Creative Center Trends" or "Google News section feeds".
// We approximate them with curated multi-domain + query bundles.
const FEEDS = [
  {
    feed_id: "ppc_land",
    name: "PPC Land",
    homepage: "https://ppc.land/",
    content_type: "advertising",
    domains: ["ppc.land"],
    q: [
      '(TikTok OR YouTube OR Instagram OR "Meta" OR creator OR "short form" OR Shorts OR Reels)',
      '(ads OR advertising OR monetization OR measurement OR attribution OR "brand safety" OR targeting OR privacy OR "ad product")'
    ].join(" AND "),
  },
  {
    feed_id: "tubefilter",
    name: "Tubefilter",
    homepage: "https://www.tubefilter.com/",
    content_type: "creator_economy",
    domains: ["tubefilter.com"],
    q: [
      '(YouTube OR TikTok OR Instagram OR creator OR "creator economy" OR Shorts OR Reels)',
      '(launch OR series OR format OR monetization OR partnership OR slate OR funding OR "creator fund" OR studio)'
    ].join(" AND "),
  },
  {
    feed_id: "publishpress",
    name: "PublishPress",
    homepage: "https://publishpress.com/",
    content_type: "industry_news",
    domains: ["publishpress.com"],
    q: [
      '(creator OR newsletter OR "web-first" OR "digital-first" OR Shorts OR Reels OR YouTube OR TikTok)',
      '(publishing OR distribution OR WordPress OR workflow OR editorial OR CMS)'
    ].join(" AND "),
  },
  {
    feed_id: "hollywood_reporter",
    name: "The Hollywood Reporter",
    homepage: "https://www.hollywoodreporter.com/",
    content_type: "entertainment_trade",
    domains: ["hollywoodreporter.com"],
    q: [
      '(YouTube OR TikTok OR creator OR "digital-first" OR "web series" OR Shorts OR Reels)',
      '(series OR slate OR launch OR partnership OR studio OR format OR deal)'
    ].join(" AND "),
  },
  {
    // Google News section proxy: query bundle across reliable domains
    feed_id: "google_news_youtube_series_us_en",
    name: "YouTube Series (US/EN) — proxy bundle",
    homepage: "https://news.google.com/",
    content_type: "industry_news",
    domains: [
      "tubefilter.com",
      "hollywoodreporter.com",
      "deadline.com",
      "variety.com",
      "digiday.com",
      "adweek.com",
      "theverge.com",
      "techcrunch.com",
      "venturebeat.com",
      "fastcompany.com"
    ],
    q: [
      '(YouTube OR "YouTube Shorts" OR creator OR "digital studio" OR "web series")',
      '(series OR episodic OR slate OR pilot OR trailer OR "new show" OR "original series" OR format)',
      '(launch OR debut OR announcement OR deal OR partnership OR greenlit)'
    ].join(" AND "),
  },
  {
    // TikTok Creative Center Trends proxy: trend reporting via marketing/platform outlets
    feed_id: "tiktok_creativecenter_trends",
    name: "TikTok Trends — proxy bundle",
    homepage: "https://ads.tiktok.com/business/creativecenter/inspiration/trends",
    content_type: "trends",
    domains: [
      "socialmediatoday.com",
      "later.com",
      "sproutsocial.com",
      "hootsuite.com",
      "buffer.com",
      "searchenginejournal.com",
      "adweek.com",
      "digiday.com",
      "theverge.com",
      "techcrunch.com"
    ],
    q: [
      '(TikTok)',
      '("Creative Center" OR trends OR trending OR "trend report" OR "top trends" OR hashtags OR sounds OR viral)',
      '(creator OR brands OR ads OR campaign OR "creative strategy" OR UGC)'
    ].join(" AND "),
  },
];

// ===== HELPERS =====
function isoNow() {
  return new Date().toISOString();
}

function stableId(url, publishedAt) {
  return crypto.createHash("sha256").update(`${url}|${publishedAt || ""}`).digest("hex");
}

// lightweight classifier to support your schema
function classifyDigitalFirst({ title = "", description = "", url = "" }, exclude = ["linear", "streaming"]) {
  const text = `${title}\n${description}\n${url}`.toLowerCase();

  const excluded_reasons = [];
  if (exclude.includes("linear") && /(broadcast|linear tv|cable|syndication)/.test(text)) {
    excluded_reasons.push("linear");
  }
  if (exclude.includes("streaming") && /(netflix|prime video|disney\+|hulu|paramount\+|apple tv|streaming)/.test(text)) {
    excluded_reasons.push("streaming");
  }

  // digital-first hints (tweak as needed)
  const digitalHints = /(youtube|tiktok|instagram|shorts|reels|creator|web series|newsletter|substack|patreon|discord)/;
  const digital_first = excluded_reasons.length === 0 && digitalHints.test(text);

  return { digital_first, excluded_reasons };
}

async function newsapiEverything({ q, domains, fromISO, pageSize }) {
  if (!NEWSAPI_KEY) throw new Error("Server misconfigured: NEWSAPI_KEY missing");

  const params = new URLSearchParams();
  params.set("q", q);
  params.set("sortBy", "publishedAt");
  params.set("pageSize", String(pageSize));
  if (domains?.length) params.set("domains", domains.join(","));
  if (fromISO) params.set("from", fromISO);

  const resp = await fetch(`https://newsapi.org/v2/everything?${params.toString()}`, {
    headers: { "X-Api-Key": NEWSAPI_KEY } // NewsAPI header name
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`NewsAPI error ${resp.status}: ${body}`);
  }
  return resp.json();
}

// ===== ROUTES =====

// /v1/sources
app.get("/v1/sources", (req, res) => {
  res.json({
    sources: FEEDS.map(f => ({
      feed_id: f.feed_id,
      name: f.name,
      homepage: f.homepage,
      content_type: f.content_type
    }))
  });
});

// /v1/feeds/{feed_id}/items
app.get("/v1/feeds/:feed_id/items", async (req, res) => {
  try {
    const feed = FEEDS.find(f => f.feed_id === req.params.feed_id);
    if (!feed) return res.status(404).json({ message: "Unknown feed_id" });

    const limit = Math.min(Number(req.query.limit ?? 15), 50);
    const sinceHours = req.query.since_hours ? Number(req.query.since_hours) : null;

    const digitalFirstOnly = String(req.query.digital_first_only ?? "true") === "true";
    const excludeCsv = String(req.query.exclude ?? "linear,streaming");
    const exclude = excludeCsv.split(",").map(s => s.trim()).filter(Boolean);

    const fromISO = sinceHours
      ? new Date(Date.now() - sinceHours * 3600 * 1000).toISOString()
      : undefined;

    const data = await newsapiEverything({
      q: feed.q,
      domains: feed.domains,
      fromISO,
      pageSize: limit,
    });

    let items = (data.articles || []).map(a => {
      const published_at = a.publishedAt || isoNow();
      const url = a.url;

      const classification = classifyDigitalFirst(
        { title: a.title || "", description: a.description || "", url },
        exclude
      );

      return {
        id: stableId(url, published_at),
        title: a.title || "(untitled)",
        url,
        source: feed.feed_id,
        published_at,
        snippet: a.description || "",
        labels: [],
        classification,
      };
    });

    if (digitalFirstOnly) items = items.filter(i => i.classification.digital_first);

    res.json({ items });
  } catch (e) {
    res.status(500).json({ message: String(e?.message || e) });
  }
});

// /v1/newsletter/digest
app.post("/v1/newsletter/digest", async (req, res) => {
  try {
    const body = req.body || {};
    const sources = Array.isArray(body.sources) ? body.sources : [];
    if (!sources.length) return res.status(422).json({ message: "Invalid inputs (empty sources)" });

    const window_hours = Number(body.window_hours ?? 168);
    const max_items_per_section = Number(body.max_items_per_section ?? 6);
    const digital_first_only = body.digital_first_only !== false;

    const exclude = Array.isArray(body.exclude) ? body.exclude : ["linear", "streaming"];
    const fromISO = new Date(Date.now() - window_hours * 3600 * 1000).toISOString();

    const selected = FEEDS.filter(f => sources.includes(f.feed_id));
    if (!selected.length) return res.status(422).json({ message: "Invalid inputs (no matching sources)" });

    // fetch items per feed
    const all = [];
    for (const feed of selected) {
      const data = await newsapiEverything({
        q: feed.q,
        domains: feed.domains,
        fromISO,
        pageSize: 50,
      });

      const mapped = (data.articles || []).map(a => {
        const published_at = a.publishedAt || isoNow();
        const url = a.url;
        const classification = classifyDigitalFirst(
          { title: a.title || "", description: a.description || "", url },
          exclude
        );
        return {
          id: stableId(url, published_at),
          title: a.title || "(untitled)",
          url,
          source: feed.feed_id,
          published_at,
          snippet: a.description || "",
          labels: [],
          classification,
        };
      });

      all.push(...mapped);
    }

    // dedupe by url
    const byUrl = new Map();
    for (const it of all) byUrl.set(it.url, it);
    let items = Array.from(byUrl.values());

    if (digital_first_only) items = items.filter(i => i.classification.digital_first);

    // naive sectioning (simple, works; you can improve later)
    const sections = [
      { name: "New digital-first launches", items: [] },
      { name: "Formats & creator series to watch", items: [] },
      { name: "Platform moves & monetization", items: [] },
      { name: "Examples (what to steal—in a legal way)", items: [] }
    ];

    function score(item, section) {
      const t = `${item.title} ${item.snippet}`.toLowerCase();
      if (section.includes("launch") && /(launch|announce|debut|unveil|introduc)/.test(t)) return 4;
      if (section.includes("Formats") && /(series|format|episod|season|shorts|reels)/.test(t)) return 4;
      if (section.includes("Platform") && /(monetiz|ads|revenue|policy|algorithm|update|creator fund)/.test(t)) return 4;
      if (section.includes("Examples") && /(case study|example|breakdown|how to|strategy|playbook)/.test(t)) return 4;
      return 1;
    }

    for (const s of sections) {
      const ranked = [...items].sort((a, b) => score(b, s.name) - score(a, s.name));
      s.items = ranked.slice(0, max_items_per_section).map(it => ({
        headline: it.title,
        blurb: it.snippet || "Summary unavailable.",
        urls: [it.url]
      }));
    }

    const citations = items.slice(0, 200).map(it => ({
      url: it.url,
      title: it.title,
      source: it.source
    }));

    res.json({
      title: "Digital-First Content Brief",
      generated_at: isoNow(),
      sections,
      citations
    });
  } catch (e) {
    res.status(500).json({ message: String(e?.message || e) });
  }
});

// health check
app.get("/", (req, res) => res.send("OK"));

// start
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Broker running on port ${port}`));
