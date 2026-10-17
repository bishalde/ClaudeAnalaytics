// Anthropic first-party API list prices, USD per 1M tokens.
//
// Every request is billed as five separate token buckets:
//   input        - uncached prompt tokens            (base input rate)
//   cacheWrite5m - prompt written to the 5-min cache (1.25x input)
//   cacheWrite1h - prompt written to the 1-hour cache (2x input)
//   cacheRead    - prompt served from cache          (per-model rate, usually 0.1x input)
//   output       - generated tokens incl. thinking   (output rate)
//
// Rows are matched in order against the model id, so more specific patterns
// (e.g. opus-4-5) must come before broader ones (e.g. opus-4).
const PRICING_UPDATED = '2026-10-06';

const MODELS = [
  { match: /fable-5-1|mythos-5-1/, name: 'Fable 5.1', input: 10, output: 50, cacheRead: 0.25 },
  { match: /fable-5|mythos-5/,     name: 'Fable 5',   input: 10, output: 50, cacheRead: 1.00 },
  { match: /opus-5-5/,   name: 'Opus 5.5',   input: 4,  output: 20, cacheRead: 0.20, fast: 2 },
  { match: /opus-5/,     name: 'Opus 5',     input: 5,  output: 25, cacheRead: 0.50, fast: 2 },
  { match: /opus-4-[5-9]/, name: 'Opus 4.5+', input: 5, output: 25, cacheRead: 0.50, fast: 2 },
  { match: /opus-4|opus-3|3-opus/, name: 'Opus 4/3', input: 15, output: 75, cacheRead: 1.50 },
  { match: /sonnet-5/,   name: 'Sonnet 5.x', input: 2,  output: 10, cacheRead: 0.20 },
  { match: /sonnet-4-[6-9]/, name: 'Sonnet 4.6', input: 3, output: 15, cacheRead: 0.30 },
  // Sonnet 4 / 4.5 charge a premium once a prompt exceeds 200K tokens.
  { match: /sonnet-4/,   name: 'Sonnet 4/4.5', input: 3, output: 15, cacheRead: 0.30,
    longContext: { threshold: 200_000, input: 6, output: 22.5, cacheRead: 0.60 } },
  { match: /sonnet-3|3-[57]-sonnet|3-sonnet/, name: 'Sonnet 3.x', input: 3, output: 15, cacheRead: 0.30 },
  // Haiku 5.5 is tiered at 100K prompt tokens.
  { match: /haiku-5/,    name: 'Haiku 5.5',  input: 0.10, output: 0.50, cacheRead: 0.01,
    longContext: { threshold: 100_000, input: 0.50, output: 2.50, cacheRead: 0.05 } },
  { match: /haiku-4/,    name: 'Haiku 4.5',  input: 1,    output: 5,    cacheRead: 0.10 },
  { match: /3-5-haiku|haiku-3-5/, name: 'Haiku 3.5', input: 0.80, output: 4, cacheRead: 0.08 },
  { match: /haiku/,      name: 'Haiku 3',    input: 0.25, output: 1.25, cacheRead: 0.03 },
];

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const WEB_SEARCH_PER_REQUEST = 10 / 1000;

const cache = new Map();
function getPricing(model) {
  if (!model) return null;
  if (cache.has(model)) return cache.get(model);
  const id = model.toLowerCase();
  const row = MODELS.find(r => r.match.test(id)) || null;
  cache.set(model, row);
  return row;
}

// u: { input, cacheWrite5m, cacheWrite1h, cacheRead, output, webSearch, speed }
// Returns cost broken down by bucket, plus `known: false` when the model has no price row.
function costOf(model, u) {
  const p = getPricing(model);
  if (!p) return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, web: 0, total: 0, known: false };

  let rates = p;
  const prompt = u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;
  if (p.longContext && prompt > p.longContext.threshold) rates = { ...p, ...p.longContext };
  const speed = u.speed === 'fast' ? (p.fast || 1) : 1;

  const input = u.input * rates.input * speed / 1e6;
  const cacheWrite = (u.cacheWrite5m * CACHE_WRITE_5M + u.cacheWrite1h * CACHE_WRITE_1H) * rates.input * speed / 1e6;
  const cacheRead = u.cacheRead * rates.cacheRead * speed / 1e6;
  const output = u.output * rates.output * speed / 1e6;
  const web = (u.webSearch || 0) * WEB_SEARCH_PER_REQUEST;
  return { input, cacheWrite, cacheRead, output, web, total: input + cacheWrite + cacheRead + output + web, known: true };
}

// What the cached prompt tokens would have cost with no caching at all.
function uncachedCostOf(model, u) {
  const p = getPricing(model);
  if (!p) return 0;
  const prompt = u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;
  const rates = p.longContext && prompt > p.longContext.threshold ? { ...p, ...p.longContext } : p;
  const speed = u.speed === 'fast' ? (p.fast || 1) : 1;
  return (prompt * rates.input + u.output * rates.output) * speed / 1e6 + (u.webSearch || 0) * WEB_SEARCH_PER_REQUEST;
}

function pricingTable() {
  return {
    updated: PRICING_UPDATED,
    cacheWrite5m: CACHE_WRITE_5M,
    cacheWrite1h: CACHE_WRITE_1H,
    webSearchPer1k: WEB_SEARCH_PER_REQUEST * 1000,
    models: MODELS.map(({ match, ...rest }) => rest),
  };
}

module.exports = { getPricing, costOf, uncachedCostOf, pricingTable };
