// Google Trends client. There's no official API so this hits the same
// endpoints the trends.google.com frontend uses:
//
//   /trending/rss             trending searches (plain RSS, pretty stable)
//   /trends/api/explore       hands out per-widget tokens for a query
//   /trends/api/widgetdata/*  the actual timeline / related data
//
// Google will 429 you if you're too chatty, so everything is cached for a few
// minutes.

import { XMLParser } from "fast-xml-parser";

const BASE = "https://trends.google.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const HL = "en-US";
const TZ = "-300";
const FETCH_TIMEOUT_MS = Number(process.env.TRENDS_FETCH_TIMEOUT_MS ?? 15_000);

export type Timeframe =
  | "now 1-H"
  | "now 4-H"
  | "now 1-d"
  | "now 7-d"
  | "today 1-m"
  | "today 3-m"
  | "today 12-m"
  | "today 5-y";

export const TIMEFRAMES: Timeframe[] = [
  "now 1-H",
  "now 4-H",
  "now 1-d",
  "now 7-d",
  "today 1-m",
  "today 3-m",
  "today 12-m",
  "today 5-y",
];

export interface NewsItem {
  title: string;
  url: string;
  source: string;
}

export interface TrendingSearch {
  rank: number;
  query: string;
  approxTraffic: string;
  publishedAt: string;
  news: NewsItem[];
}

export interface TimelinePoint {
  time: string;
  values: number[];
  isPartial: boolean;
}

export interface InterestOverTime {
  keywords: string[];
  geo: string;
  timeframe: string;
  points: TimelinePoint[];
  averages: number[];
}

export interface RelatedQuery {
  query: string;
  value: number;
  formattedValue: string;
}

export interface RelatedQueries {
  keyword: string;
  geo: string;
  timeframe: string;
  top: RelatedQuery[];
  rising: RelatedQuery[];
}

export class TrendsError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "TrendsError";
  }
}

// -- cache --------------------------------------------------------------------

const CACHE_TTL_MS = Number(process.env.TRENDS_CACHE_TTL_MS ?? 5 * 60 * 1000);
const cache = new Map<string, { expires: number; value: unknown }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await fn();
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}

// -- http ---------------------------------------------------------------------

let cookie: string | null = null;

async function getCookie(): Promise<string> {
  if (cookie) return cookie;
  const res = await fetch(`${BASE}/trends/explore?geo=US&hl=${HL}`, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
  });
  const setCookies: string[] =
    (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const nid = setCookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("NID="));
  cookie = nid ?? setCookies.map((c) => c.split(";")[0]).join("; ");
  return cookie;
}

async function fetchText(url: string, withCookie: boolean): Promise<string> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (withCookie) headers.Cookie = await getCookie();
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 429) {
    cookie = null; // grab a fresh NID next time, sometimes that's enough
    throw new TrendsError(
      "Google Trends rate-limited the request (HTTP 429). Wait a minute and try again.",
      429,
    );
  }
  if (!res.ok) {
    throw new TrendsError(`Google Trends returned HTTP ${res.status} for ${url}`, res.status);
  }
  return res.text();
}

// responses start with )]}' which has to be stripped before JSON.parse
const JSON_GUARD = /^\)\]\}['"]?,?\s*/;

function parseGoogleJson<T>(text: string): T {
  return JSON.parse(text.replace(JSON_GUARD, "")) as T;
}

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// -- trending now (rss) -------------------------------------------------------

export async function trendingNow(geo = "US", limit = 20): Promise<TrendingSearch[]> {
  const all = await cached(`trending:${geo}`, async () => {
    const xml = await fetchText(`${BASE}/trending/rss?geo=${encodeURIComponent(geo)}`, false);
    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
    const doc = parser.parse(xml) as {
      rss?: { channel?: { item?: RssItem | RssItem[] } };
    };
    const raw = doc.rss?.channel?.item;
    const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    return items.map((item, i) => toTrendingSearch(item, i + 1));
  });
  return all.slice(0, Math.max(1, limit));
}

interface RssNewsItem {
  news_item_title?: string;
  news_item_url?: string;
  news_item_source?: string;
}

interface RssItem {
  title?: string;
  approx_traffic?: string;
  pubDate?: string;
  news_item?: RssNewsItem | RssNewsItem[];
}

function toTrendingSearch(item: RssItem, rank: number): TrendingSearch {
  const rawNews = item.news_item;
  const news = rawNews === undefined ? [] : Array.isArray(rawNews) ? rawNews : [rawNews];
  return {
    rank,
    query: String(item.title ?? "").trim(),
    approxTraffic: String(item.approx_traffic ?? "").trim(),
    publishedAt: String(item.pubDate ?? "").trim(),
    news: news.map((n) => ({
      title: String(n.news_item_title ?? "").trim(),
      url: String(n.news_item_url ?? "").trim(),
      source: String(n.news_item_source ?? "").trim(),
    })),
  };
}

// -- explore (gets us widget tokens) ------------------------------------------

interface Widget {
  id: string;
  token: string;
  request: unknown;
}

async function explore(keywords: string[], geo: string, timeframe: string): Promise<Widget[]> {
  const key = `explore:${geo}:${timeframe}:${keywords.join("|")}`;
  return cached(key, async () => {
    const req = {
      comparisonItem: keywords.map((keyword) => ({ keyword, geo, time: timeframe })),
      category: 0,
      property: "",
    };
    const url = `${BASE}/trends/api/explore?${qs({ hl: HL, tz: TZ, req: JSON.stringify(req) })}`;
    const text = await fetchText(url, true);
    return parseGoogleJson<{ widgets: Widget[] }>(text).widgets;
  });
}

function widget(widgets: Widget[], id: string): Widget {
  const w = widgets.find((x) => x.id === id);
  if (!w) throw new TrendsError(`Google Trends did not return a ${id} widget for this query.`);
  return w;
}

async function widgetData<T>(path: string, w: Widget): Promise<T> {
  const url = `${BASE}/trends/api/widgetdata/${path}?${qs({
    hl: HL,
    tz: TZ,
    req: JSON.stringify(w.request),
    token: w.token,
  })}`;
  return parseGoogleJson<T>(await fetchText(url, true));
}

// -- interest over time -------------------------------------------------------

interface MultilineResponse {
  default: {
    timelineData: { formattedTime: string; value: number[]; isPartial?: boolean }[];
    averages?: number[];
  };
}

export async function interestOverTime(
  keywords: string[],
  geo = "US",
  timeframe: Timeframe = "today 3-m",
): Promise<InterestOverTime> {
  if (keywords.length === 0 || keywords.length > 5) {
    throw new TrendsError("Provide between 1 and 5 keywords.");
  }
  const widgets = await explore(keywords, geo, timeframe);
  const data = await cached(`multiline:${geo}:${timeframe}:${keywords.join("|")}`, () =>
    widgetData<MultilineResponse>("multiline", widget(widgets, "TIMESERIES")),
  );
  const points = data.default.timelineData.map((p) => ({
    time: p.formattedTime,
    values: p.value,
    isPartial: Boolean(p.isPartial),
  }));
  const averages =
    data.default.averages ??
    keywords.map((_, i) =>
      points.length
        ? Math.round(points.reduce((s, p) => s + (p.values[i] ?? 0), 0) / points.length)
        : 0,
    );
  return { keywords, geo, timeframe, points, averages };
}

// -- related queries ----------------------------------------------------------

interface RankedKeyword {
  query: string;
  value: number;
  formattedValue: string;
}

interface RelatedResponse {
  default: { rankedList: { rankedKeyword: RankedKeyword[] }[] };
}

export async function relatedQueries(
  keyword: string,
  geo = "US",
  timeframe: Timeframe = "today 3-m",
): Promise<RelatedQueries> {
  const widgets = await explore([keyword], geo, timeframe);
  const data = await cached(`related:${geo}:${timeframe}:${keyword}`, () =>
    widgetData<RelatedResponse>("relatedsearches", widget(widgets, "RELATED_QUERIES")),
  );
  const [top, rising] = data.default.rankedList;
  const pick = (l?: { rankedKeyword: RankedKeyword[] }) =>
    (l?.rankedKeyword ?? []).map((k) => ({
      query: k.query,
      value: k.value,
      formattedValue: k.formattedValue,
    }));
  return { keyword, geo, timeframe, top: pick(top), rising: pick(rising) };
}

// -- formatting ---------------------------------------------------------------
// plain text, the model reads this directly

export function formatTrending(items: TrendingSearch[], geo: string): string {
  if (items.length === 0) return `No trending searches returned for ${geo}.`;
  const lines = items.map((t) => {
    const headline = t.news[0] ? ` - ${t.news[0].title} (${t.news[0].source})` : "";
    return `${t.rank}. ${t.query} (${t.approxTraffic} searches)${headline}`;
  });
  return `Trending now on Google (${geo}):\n${lines.join("\n")}`;
}

export function formatInterest(d: InterestOverTime): string {
  const recent = d.points.slice(-8);
  const header = `Interest over time (${d.geo}, ${d.timeframe}, 0-100 scale):`;
  const avg = d.keywords.map((k, i) => `${k}: avg ${d.averages[i] ?? "n/a"}`).join(", ");
  const rows = recent.map((p) => {
    const vals = d.keywords.map((k, i) => `${k}=${p.values[i]}`).join(", ");
    return `  ${p.time}${p.isPartial ? " (partial)" : ""}: ${vals}`;
  });
  return [header, `  ${avg}`, "  Most recent points:", ...rows].join("\n");
}

export function formatRelated(r: RelatedQueries): string {
  const top = r.top.slice(0, 10).map((q) => `  ${q.query} (${q.formattedValue})`);
  const rising = r.rising.slice(0, 10).map((q) => `  ${q.query} (${q.formattedValue})`);
  return [
    `Related queries for "${r.keyword}" (${r.geo}, ${r.timeframe}):`,
    "  Top:",
    ...(top.length ? top : ["  (none)"]),
    "  Rising:",
    ...(rising.length ? rising : ["  (none)"]),
  ].join("\n");
}

export interface ContextOptions {
  geo?: string;
  keywords?: string[];
  timeframe?: Timeframe;
  trendingLimit?: number;
}

// Builds the block that gets stuck in front of the user's question. The keyword
// parts are best effort - if explore gets rate limited we still return the
// trending list and mention what's missing.
export async function buildTrendsContext(opts: ContextOptions = {}): Promise<string> {
  const geo = opts.geo ?? "US";
  const timeframe = opts.timeframe ?? "today 3-m";
  const keywords = (opts.keywords ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 5);
  const sections: string[] = [];
  const notes: string[] = [];

  try {
    sections.push(formatTrending(await trendingNow(geo, opts.trendingLimit ?? 15), geo));
  } catch (e) {
    notes.push(`trending searches unavailable: ${errorMessage(e)}`);
  }

  if (keywords.length) {
    try {
      sections.push(formatInterest(await interestOverTime(keywords, geo, timeframe)));
    } catch (e) {
      notes.push(`interest over time unavailable: ${errorMessage(e)}`);
    }
    try {
      sections.push(formatRelated(await relatedQueries(keywords[0], geo, timeframe)));
    } catch (e) {
      notes.push(`related queries unavailable: ${errorMessage(e)}`);
    }
  }

  const stamp = new Date().toISOString();
  const body = sections.length ? sections.join("\n\n") : "No Google Trends data could be fetched.";
  const noteBlock = notes.length ? `\n\nNotes: ${notes.join("; ")}` : "";
  return `<google_trends fetched_at="${stamp}" geo="${geo}">\n${body}${noteBlock}\n</google_trends>`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
