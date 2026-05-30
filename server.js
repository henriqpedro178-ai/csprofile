const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Cache simples em memória (15 min por perfil) ───────────────────────
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

// ── Instância única do browser (reutilizada entre requests) ───────────
let browser = null;
async function getBrowser() {
  if (browser) {
    try { await browser.version(); return browser; } catch (_) { browser = null; }
  }
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  });
  return browser;
}

// ── Scraper principal ──────────────────────────────────────────────────
async function scrapeCsStats(steamid) {
  const cached = getCached(steamid);
  if (cached) return cached;

  const b = await getBrowser();
  const page = await b.newPage();

  try {
    // Headers realistas para passar o Cloudflare
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'upgrade-insecure-requests': '1',
    });

    await page.goto(`https://csstats.gg/player/${steamid}`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Espera o conteúdo carregar
    await page.waitForSelector('body', { timeout: 10000 });

    const data = await page.evaluate(() => {
      const result = {
        premier: null,
        bestPremier: null,
        mapRanks: [],
        seasons: [],
        competitive: null,
      };

      // ── Premier rating atual ──
      // Procura o número grande de Premier rating
      const premierEls = [
        ...document.querySelectorAll('[class*="premier"] [class*="rating"]'),
        ...document.querySelectorAll('[class*="rating"][class*="premier"]'),
        ...document.querySelectorAll('.cs2rating'),
        ...document.querySelectorAll('[data-cs2rating]'),
      ];
      for (const el of premierEls) {
        const txt = el.textContent.replace(/,/g, '').trim();
        const num = parseInt(txt);
        if (num > 1000 && num < 50000) { result.premier = num; break; }
      }

      // Fallback: procura qualquer número entre 1000-50000 em elementos de rank
      if (!result.premier) {
        const allEls = document.querySelectorAll(
          '[class*="rank"], [class*="rating"], [class*="elo"], [class*="premier"]'
        );
        for (const el of allEls) {
          const txt = el.textContent.replace(/,/g, '').replace(/\s/g, '');
          const num = parseInt(txt);
          if (num >= 1000 && num <= 50000) { result.premier = num; break; }
        }
      }

      // ── Best Premier (maior rank histórico) ──
      const bestEls = document.querySelectorAll(
        '[class*="best"], [class*="highest"], [class*="peak"]'
      );
      for (const el of bestEls) {
        const txt = el.textContent.replace(/,/g, '').trim();
        const num = parseInt(txt);
        if (num >= 1000 && num <= 50000) { result.bestPremier = num; break; }
      }

      // ── Ranks por mapa ──
      // csstats.gg mostra uma tabela/grid de mapas com rank
      const mapRows = document.querySelectorAll(
        '[class*="map-row"], [class*="maprow"], [class*="map_row"], tr[data-map], [class*="map-stat"]'
      );
      mapRows.forEach(row => {
        const mapName = row.querySelector('[class*="map-name"], [class*="mapname"], td:first-child')?.textContent?.trim();
        const rank = row.querySelector('[class*="rank"], [class*="rating"]')?.textContent?.replace(/,/g, '').trim();
        if (mapName && rank) {
          const num = parseInt(rank);
          if (num >= 0) result.mapRanks.push({ map: mapName, rank: num });
        }
      });

      // ── Seasons Premier ──
      const seasonEls = document.querySelectorAll(
        '[class*="season"], [class*="Season"]'
      );
      seasonEls.forEach(el => {
        const label = el.querySelector('[class*="label"], [class*="name"], span:first-child')?.textContent?.trim();
        const rating = el.querySelector('[class*="rating"], [class*="rank"], strong')?.textContent?.replace(/,/g, '').trim();
        if (label && rating) {
          const num = parseInt(rating);
          if (num >= 1000 && num <= 50000) result.seasons.push({ season: label, rating: num });
        }
      });

      return result;
    });

    // Se não encontrou nada com seletores genéricos, tenta parsear o HTML
    if (!data.premier && !data.mapRanks.length) {
      const html = await page.content();

      // Procura padrão de Premier rating no HTML bruto
      const premierMatch = html.match(/(?:premier|cs2)[^>]*?(\d{4,5})(?:\s*<|\s*,)/i);
      if (premierMatch) data.premier = parseInt(premierMatch[1]);

      // Procura JSON embutido na página (muitos sites colocam window.__data__ ou similar)
      const jsonMatch = html.match(/window\.__(?:data|state|props|INITIAL_STATE)__\s*=\s*({.+?});/s);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          // Tenta extrair dados do JSON embutido
          const walkJson = (obj, depth = 0) => {
            if (depth > 5 || !obj || typeof obj !== 'object') return;
            if (obj.premier_rating || obj.premierRating) {
              data.premier = obj.premier_rating || obj.premierRating;
            }
            if (obj.best_rating || obj.bestRating) {
              data.bestPremier = obj.best_rating || obj.bestRating;
            }
            Object.values(obj).forEach(v => walkJson(v, depth + 1));
          };
          walkJson(parsed);
        } catch (_) {}
      }
    }

    setCache(steamid, data);
    return data;

  } finally {
    await page.close();
  }
}

// ── Rotas ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[csstats-scraper] listening on port ${PORT}`);
  // Pré-aquece o browser
  getBrowser().then(() => console.log('[csstats-scraper] browser ready'));
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
