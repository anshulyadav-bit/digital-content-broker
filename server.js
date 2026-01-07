// server.js
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

const NEWSAPI_KEY = process.env.NEWSAPI_KEY;
const BROKER_KEY = process.env.BROKER_KEY;

// ----- simple auth -----
app.use((req, res, next) => {
  if (req.header("X-API-Key") !== BROKER_KEY) {
    return res.status(401).json({ message: "Invalid API key" });
  }
  next();
});

// ----- feed definitions (NewsAPI-backed) -----
const FEEDS = [
  {
    feed_id: "tubefilter",
    name: "Tubefilter",
    domains: ["tubefilter.com"],
    q: '(YouTube OR TikTok OR creator OR "creator economy")',
  },
  {
    feed_id: "ppc_land",
    name: "PPC Land",
    domains: ["ppc.land"],
    q: '(TikTok OR YouTube OR ads OR creator)',
  },
  {
    feed_id: "hollywood_reporter",
    name: "Hollywood Reporter",
    domains: ["hollywoodreporter.com"],
    q: '(YouTube OR TikTok OR creator OR "digital-first")',
  },
  {
    feed_id: "publishpress",
    name: "PublishPress",
    domains: ["publishpress.com"],
    q: '(creator OR newsletter OR YouTube OR TikTok)',
  },
  {
    feed_id: "google_news_youtube_series_us_en",
    name: "YouTube Series (proxy)",
    domains: [
      "tubefilter.com",
      "hollywoodreporter.com",
      "variety.com",
      "deadline.com",
    ],
    q: '(YouTube AND (series OR "creator series" OR episodic))',
  },
  {
    feed_id: "tiktok_creativecenter_trends",
    name: "TikTok Trends (proxy)",
    domains: [
      "adweek.com",
      "digiday.com",
      "socialmediatoday.com",
      "sproutsocial.com",
    ],
    q: '(TikTok AND (trends OR trending OR hashtags OR sounds))',
  },
];

// ----- helpers -----
function idFor(url) {
  return crypto.createHash("sha1").update(url).digest("hex");
}

async function newsapiFetch(feed, limit = 15) {
  const params = new URLSearchParams({
    q: feed.q,
    domains: feed.domains.join(","),
    sortBy: "publishedAt",
    pageSize: String(limit),
  });

  const r = await fetch(`https://newsapi.org/v2/everything?${params}`, {
    headers: { "X-Api-Key": NEWSAPI_KEY },
  });

  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ----- routes -----

app.get("/v1/sources", (req, res) => {
  res.json({
    sources: FEEDS.map(f => ({
      feed_id: f.feed_id,
      name: f.name,
    })),
  });
});

app.get("/v1/feeds/:feed_id/items", async (req, res) => {
  try {
    const feed = FEEDS.find(f => f.feed_id === req.params.feed_id);
    if (!feed) return res.status(404).json({ message: "Unknown feed_id" });

    const data = await newsapiFetch(feed);
    const items = (data.articles || []).map(a => ({
      id: idFor(a.url),
      title: a.title,
      url: a.url,
      source: feed.feed_id,
      published_at: a.publishedAt,
      snippet: a.description,
      classification: { digital_first: true, excluded_reasons: [] },
    }));

    res.json({ items });
  } catch (e) {
    res.status(500).json({ message: String(e) });
  }
});

// ----- start -----
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Running on", port));
