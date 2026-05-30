const express = require('express');
const puppeteer = require('puppeteer');

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
      '--disable-blink-features=AutomationControlled',
    ],
  });
  return browser;
}

async function scrapeCsStats(steamid) {
  const cached = getCached(steamid);
  if (cached) return cached;

  const b = await getBrowser();
  const page = await b.newPage();

  try {
    // Remove webdriver flag
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });

    console.log(`[scraper] fetching csstats for ${steamid}`);

    // Timeout de 20s — se o Cloudflare bloquear, falha rápido
    await page.goto(`https://csstats.gg/player/${steamid}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // Verifica se foi bloqueado pelo Cloudflare
    const title = await page.title();
    console.log(`[scraper] page title: ${title}`);

    if (title.includes('Just a moment') || title.includes('Attention Required')) {
      throw new Error('CLOUDFLARE_BLOCKED');
    }

    // Aguarda algum conteúdo real aparecer (máx 10s)
    await page.waitForFunction(
      () => document.body.innerText.length > 500,
      { timeout: 10000 }
    ).catch(() => {});

    const html = await page.content();
    console.log(`[scraper] html length: ${html.length}`);

    // Extrai dados via evaluate
    const data = await page.evaluate(() => {
      const result = {
        premier: null,
        bestPremier: null,
        mapRanks: [],
        seasons: [],
        debug_text: document.body.innerText.slice(0, 500),
      };

      // Procura todos os números entre 1000-50000 em elementos visíveis
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );
      const candidates = [];
      let node;
      while ((node = walker.nextNode())) {
        const txt = node.textContent.replace(/,/g, '').trim();
        const num = parseInt(txt);
        if (num >= 1000 && num <= 50000 && txt === String(num)) {
          const parent = node.parentElement;
          const cls = (parent?.className || '') + ' ' + (parent?.parentElement?.className || '');
          candidates.push({ num, cls: cls.toLowerCase(), txt });
        }
      }

      // Premier: procura classe com "premier", "rating", "rank", "cs2"
      for (const c of candidates) {
        if (c.cls.match(/premier|cs2rating|cs2-rating/)) {
          result.premier = c.num; break;
        }
      }
      if (!result.premier && candidates.length) {
        result.premier = candidates[0].num;
      }

      result._candidates = candidates.slice(0, 10);
      return result;
    });

    console.log(`[scraper] result:`, JSON.stringify(data).slice(0, 300));
    setCache(steamid, data);
    return data;

  } finally {
    await page.close();
  }
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
    // Retorna ok:false mas não 500 — o Worker trata graciosamente
    res.json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[csstats-scraper] listening on port ${PORT}`);
  getBrowser().then(() => console.log('[csstats-scraper] browser ready'));
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
