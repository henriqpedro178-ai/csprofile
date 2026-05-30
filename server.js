const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

async function scrapeCsStats(steamid) {
  const cached = getCached(steamid);
  if (cached) return cached;

  const url = `https://csstats.gg/player/${steamid}`;
  console.log(`[scraper] fetching ${url}`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    },
    signal: AbortSignal.timeout(15000),
  });

  console.log(`[scraper] status: ${res.status}, content-type: ${res.headers.get('content-type')}`);

  const html = await res.text();
  console.log(`[scraper] html length: ${html.length}`);
  console.log(`[scraper] html preview: ${html.slice(0, 300)}`);

  // Verifica bloqueio Cloudflare
  if (html.includes('Just a moment') || html.includes('cf-browser-verification') || res.status === 403) {
    throw new Error('CLOUDFLARE_BLOCKED');
  }

  const data = {
    premier: null,
    bestPremier: null,
    mapRanks: [],
    seasons: [],
    _status: res.status,
    _htmlLen: html.length,
  };

  // ── Premier atual ──
  // csstats.gg coloca o rating em elementos como: <div class="cs2rating">15,330</div>
  // ou dentro de spans com o número formatado
  const premierPatterns = [
    /class="[^"]*cs2rating[^"]*"[^>]*>[\s]*([0-9,]+)/i,
    /class="[^"]*premier[^"]*rating[^"]*"[^>]*>[\s]*([0-9,]+)/i,
    /id="[^"]*premier[^"]*"[^>]*>[\s\S]*?([0-9]{2},?[0-9]{3})/i,
    /"current_rating":\s*([0-9]+)/,
    /"premier_rating":\s*([0-9]+)/,
    /"cs2rating":\s*([0-9]+)/,
    /Premier[^<]{0,50}([1-9][0-9]{3,4})/,
  ];
  for (const pat of premierPatterns) {
    const m = html.match(pat);
    if (m) {
      const num = parseInt(m[1].replace(/,/g, ''));
      if (num >= 1000 && num <= 50000) { data.premier = num; break; }
    }
  }

  // ── Best Premier ──
  const bestPatterns = [
    /"best_rating":\s*([0-9]+)/,
    /"peak_rating":\s*([0-9]+)/,
    /Best[^<]{0,50}([1-9][0-9]{3,4})/i,
    /Peak[^<]{0,50}([1-9][0-9]{3,4})/i,
  ];
  for (const pat of bestPatterns) {
    const m = html.match(pat);
    if (m) {
      const num = parseInt(m[1].replace(/,/g, ''));
      if (num >= 1000 && num <= 50000) { data.bestPremier = num; break; }
    }
  }

  // ── JSON embutido na página (__NEXT_DATA__, window.__data__, etc) ──
  const jsonPatterns = [
    /__NEXT_DATA__\s*=\s*({[\s\S]+?})<\/script>/,
    /window\.__data__\s*=\s*({[\s\S]+?});/,
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?});/,
    /var\s+playerData\s*=\s*({[\s\S]+?});/,
  ];
  for (const pat of jsonPatterns) {
    const m = html.match(pat);
    if (m) {
      try {
        const parsed = JSON.parse(m[1]);
        const str = JSON.stringify(parsed);
        // Procura campos de rating no JSON
        const ratingMatch = str.match(/"(?:premier_rating|cs2rating|current_rating|rating)":\s*([0-9]+)/);
        if (ratingMatch) {
          const num = parseInt(ratingMatch[1]);
          if (num >= 1000 && num <= 50000 && !data.premier) data.premier = num;
        }
        console.log('[scraper] found embedded JSON, keys:', Object.keys(parsed).slice(0, 10));
      } catch (_) {}
    }
  }

  // ── Map ranks ──
  // Procura padrão de rank por mapa no HTML
  const mapPattern = /"map":\s*"([^"]+)"[^}]*"rank":\s*([0-9]+)/g;
  let mapMatch;
  while ((mapMatch = mapPattern.exec(html)) !== null) {
    data.mapRanks.push({ map: mapMatch[1], rank: parseInt(mapMatch[2]) });
  }

  // ── Seasons ──
  const seasonPattern = /"season":\s*"([^"]+)"[^}]*"rating":\s*([0-9]+)/g;
  let seasonMatch;
  while ((seasonMatch = seasonPattern.exec(html)) !== null) {
    const num = parseInt(seasonMatch[2]);
    if (num >= 1000 && num <= 50000) {
      data.seasons.push({ season: seasonMatch[1], rating: num });
    }
  }

  setCache(steamid, data);
  return data;
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, cached: cache.size });
});

app.get('/player/:steamid', async (req, res) => {
  const { steamid } = req.params;
  if (!/^\d{17}$/.test(steamid)) {
    return res.status(400).json({ error: 'Invalid SteamID64' });
  }
  try {
    const data = await scrapeCsStats(steamid);
    res.json({ ok: true, steamid, ...data });
  } catch (err) {
    console.error('[scraper] error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[csstats-scraper] listening on port ${PORT}`);
});
