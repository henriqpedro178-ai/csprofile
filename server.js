const express = require('express');
const puppeteer = require('puppeteer-core');


const app = express();
const PORT = process.env.PORT || 3000;

// ── Cache simples em memória ──────────────────────────────────────────
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

// ── Browser singleton ─────────────────────────────────────────────────
let browser = null;
async function getBrowser() {
  if (browser && browser.connected) return browser;
  console.log('[browser] launching...');
  browser = await puppeteer.launch({
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--single-process'],
    defaultViewport: null,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: true,
  });
  browser.on('disconnected', () => { browser = null; });
  console.log('[browser] ready');
  return browser;
}

// ── Scraper ───────────────────────────────────────────────────────────
async function scrapeCsStats(steamid) {
  const cached = getCached(steamid);
  if (cached) { console.log(`[cache hit] ${steamid}`); return cached; }

  console.log(`[scraper] ${steamid}`);
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    await page.goto(`https://csstats.gg/player/${steamid}`, {
      waitUntil: 'networkidle2',
      timeout: 25000,
    });

    // Aguarda o SPA renderizar
    await page.waitForFunction(
      () => document.body.innerText.length > 500,
      { timeout: 8000 }
    ).catch(() => {});

    const data = await page.evaluate(() => {
      const result = { premier: null, bestPremier: null, mapRanks: [], seasons: [] };
      const txt = (el) => el?.textContent?.replace(/,/g, '').trim() || '';
      const num = (s) => { const n = parseInt(s); return n >= 1000 && n <= 50000 ? n : null; };

      // Premier
      for (const sel of ['[class*="cs2rating"]','[class*="premier"][class*="rating"]','#cs2rating','[data-rating]']) {
        const el = document.querySelector(sel);
        if (el) { const n = num(txt(el)); if (n) { result.premier = n; break; } }
      }
      if (!result.premier) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const t = node.textContent.replace(/,/g, '').trim();
          const n = parseInt(t);
          if (t === String(n) && n >= 5000 && n <= 50000) {
            const cls = (node.parentElement?.className || '').toLowerCase();
            if (cls.match(/rating|rank|premier|cs2/)) { result.premier = n; break; }
          }
        }
      }

      // Best Premier
      document.querySelectorAll('[class*="best"],[class*="peak"],[class*="highest"]').forEach(el => {
        if (result.bestPremier) return;
        const n = num(txt(el)); if (n) result.bestPremier = n;
      });

      // Map ranks
      document.querySelectorAll('div.over').forEach(over => {
        const mapImg  = over.querySelector('div.icon img');
        const rankImg = over.querySelector('div.rank img');
        if (!mapImg || !rankImg) return;
        const mapRaw = (mapImg.getAttribute('alt') || mapImg.getAttribute('title') || '').trim();
        if (!mapRaw) return;
        const rankMatch = rankImg.getAttribute('src')?.match(/\/ranks\/(\d+)\.png/);
        if (!rankMatch) return;
        const rankNum = parseInt(rankMatch[1]);
        if (isNaN(rankNum) || rankNum < 0 || rankNum > 18) return;
        const mapName = mapRaw.replace(/^(de_|cs_|ar_|dz_)/,'').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
        result.mapRanks.push({ map: mapName, mapKey: mapRaw, rank: rankNum });
      });

      // Seasons
      const seasonPatterns = [/\bSeason\s+\d+\b/i, /\bS\d+\b/, /\b(CS2|Premier)\s+S\d+/i];
      const isRating = n => n >= 1000 && n <= 50000;
      const seen = new Set();
      for (const el of document.querySelectorAll('*')) {
        const ownText = Array.from(el.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join(' ').trim();
        if (!ownText || !seasonPatterns.some(p=>p.test(ownText))) continue;
        const candidates = [el,el.parentElement,el.nextElementSibling,el.previousElementSibling,el.parentElement?.nextElementSibling,el.parentElement?.previousElementSibling,...(el.parentElement?.children||[])];
        let rating = null;
        for (const c of candidates) {
          if (!c) continue;
          const n = parseInt(c.textContent.replace(/,/g,'').trim());
          if (isRating(n)) { rating = n; break; }
          for (const child of c.children||[]) { const n2=parseInt(child.textContent.replace(/,/g,'').trim()); if(isRating(n2)){rating=n2;break;} }
          if (rating) break;
        }
        if (rating && !seen.has(ownText)) { seen.add(ownText); result.seasons.push({ season: ownText, rating }); }
      }

      return result;
    });

    console.log(`[scraper] done:`, JSON.stringify(data));
    setCache(steamid, data);
    return data;
  } finally {
    await page.close();
  }
}

// ── CORS ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Rotas ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, cached: cache.size, browserConnected: !!(browser?.connected) });
});

app.get('/player/:steamid', async (req, res) => {
  const { steamid } = req.params;
  if (!/^\d{17}$/.test(steamid)) return res.status(400).json({ error: 'Invalid SteamID64' });
  try {
    const data = await scrapeCsStats(steamid);
    res.json({ ok: true, steamid, ...data });
  } catch (err) {
    console.error('[error]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Boot ──────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[server] port ${PORT}`);
  await getBrowser().catch(e => console.error('[browser preheat]', e.message));
});

// ── Debug: retorna HTML bruto da página ───────────────────────────────
app.get('/debug/:steamid', async (req, res) => {
  const { steamid } = req.params;
  if (!/^\d{17}$/.test(steamid)) return res.status(400).json({ error: 'Invalid SteamID64' });
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(`https://csstats.gg/player/${steamid}`, { waitUntil: 'networkidle2', timeout: 25000 });
    await new Promise(r => setTimeout(r, 5000));
    const html = await page.content();
    const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    res.setHeader('Content-Type', 'application/json');
    res.json({ htmlLen: html.length, textPreview: text, htmlPreview: html.slice(0, 5000) });
  } finally {
    await page.close();
  }
});
