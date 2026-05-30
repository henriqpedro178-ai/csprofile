# csstats-scraper

Servidor Node.js que faz scraping do csstats.gg usando Puppeteer.
Deploy no Railway para usar com a extensão CSProfile.

## Deploy no Railway

1. Cria um repo no GitHub e faz push desse projeto
2. Acessa [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Seleciona o repo
4. Railway detecta o Dockerfile automaticamente
5. Após deploy, copia a URL pública (ex: `https://csstats-scraper-production.up.railway.app`)

## Endpoints

### `GET /health`
Verifica se o servidor está rodando.

### `GET /player/:steamid64`
Retorna dados do perfil do csstats.gg.

**Exemplo:**
```
GET /player/76561199238565721
```

**Resposta:**
```json
{
  "ok": true,
  "steamid": "76561199238565721",
  "premier": 15330,
  "bestPremier": 17114,
  "mapRanks": [
    { "map": "Dust2", "rank": 13 },
    { "map": "Mirage", "rank": 7 }
  ],
  "seasons": [
    { "season": "Season 1", "rating": 14500 }
  ]
}
```

## Uso no Worker (worker.js)

Adiciona no topo do worker:
```js
const CSSTATS_URL = 'https://SEU_APP.up.railway.app';
```

E no `Promise.all`:
```js
fetch(`${CSSTATS_URL}/player/${steamid}`)
```
