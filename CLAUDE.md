# GeoRetail Guatemala — Claude Context

## What This Is

**GeoRetail Guatemala** is a retail location intelligence platform for identifying optimal expansion sites for **Despensa Familiar** and **Maxi Despensa** grocery stores across Guatemala. It uses a multi-factor composite scoring model (0–100) built on real geospatial data.

Owner/repo: `borja-sanz/hello-world` (the repo name is misleading — this is a full production app).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Tailwind CSS + Leaflet.js (react-leaflet) |
| Backend | Node.js + Express + TypeScript |
| Database | PostgreSQL 15 + PostGIS 3.3 |
| Build | Vite (frontend), tsc (backend) |
| Containerization | Docker Compose |
| Deployment | Render.com (free tier) |

---

## Repository Structure

```
/
├── frontend/          # React SPA (port 3000 dev)
│   └── src/
│       ├── App.tsx            # Root component, all top-level state
│       ├── api/index.ts       # All API calls centralized here
│       ├── components/
│       │   ├── MapView.tsx    # Leaflet map with all layers
│       │   ├── Sidebar.tsx    # Right sidebar (rankings, trade area, NTL)
│       │   ├── TradeAreaPanel.tsx
│       │   ├── NtlPanel.tsx   # Night-time light settlement panel
│       │   ├── SiteSelectionPanel.tsx
│       │   ├── FilterControls.tsx
│       │   └── ...
│       ├── pages/AdminPanel.tsx  # Admin modal (weights, thresholds, OSM)
│       └── types/index.ts     # All shared TypeScript types
├── backend/           # Express API (port 4000 dev)
│   └── src/
│       ├── index.ts           # App entry, routes wiring
│       ├── db.ts              # pg pool connection
│       ├── routes/            # One file per resource
│       │   ├── stores.ts, competitors.ts, municipios.ts
│       │   ├── scoring.ts, admin.ts, osm.ts
│       │   ├── google-pois.ts (also mounted at /api/pois)
│       │   ├── ntl.ts         # Night-time light / VIIRS settlements
│       │   └── siteSelection.ts
│       ├── services/
│       │   ├── scoringEngine.ts     # Core 5-factor scoring logic
│       │   ├── siteSelectionService.ts
│       │   ├── osmService.ts        # Overpass API integration
│       │   ├── isochroneService.ts  # Drive-time isochrones
│       │   ├── googlePlacesService.ts
│       │   └── googlePoiService.ts
│       └── scripts/
│           ├── initDb.ts      # Schema creation
│           ├── autoSeed.ts    # Auto-seed on startup (prod)
│           ├── seed.ts / seedMunicipios.ts / seedCompetitors.ts
│           ├── loadViirs.ts   # VIIRS raster loading
│           └── buildViirsClusters.ts
├── docker/postgres/init.sql  # Full DB schema
├── docker-compose.yml
├── render.yaml        # Render.com deploy config
└── package.json       # Root: build scripts + start
```

---

## Database Schema (Key Tables)

- **`stores`** — Our own store locations (Despensa Familiar, Maxi Despensa, Walmart, Paiz, Other)
- **`competitors`** — Competitor locations (from OSM, manual, Google Places)
- **`municipios`** — All 254 Guatemala municipios with population, PostGIS geometry/centroid
- **`poi_cache`** — Cached OSM POIs (markets, banks, pharmacies, roads, etc.)
- **`opportunity_scores`** — Calculated scores per municipio (5-factor composite)
- **`scoring_config`** — Editable weights + thresholds (live admin edits)
- **`ntl_settlements`** / **`poi_nuclei`** — VIIRS night-time light clusters, POI nuclei
- **`competitor_gaps`** — Pre-computed competitor gap analysis zones

PostGIS is used extensively: `ST_DWithin`, `ST_Distance`, `ST_MakePoint`, `ST_SetSRID`, spatial indices via GIST.

---

## Scoring Model

Five-factor composite (0–100):

| Factor | Weight | Signals |
|--------|--------|---------|
| Population | 30% | Municipio pop, 3/5/10km trade area |
| Mobility & Access | 25% | Road density, highway proximity, urban flag |
| Commercial Density | 25% | Markets, banks, pharmacies, POIs |
| Competitive Landscape | 15% | Distance to our stores, competitor density |
| Socioeconomic Proxy | 5% | Schools, health facilities |

**Format thresholds**: ≥55k pop → Maxi Despensa; 24k–54k → Despensa Familiar; <24k → no recommendation.
**Score colors**: 80–100 green (GO), 60–79 yellow, 40–59 yellow, 0–39 red (NO-GO).

Weights + thresholds are editable live via Admin panel → `PUT /api/admin/config`.

---

## API Endpoints (all prefixed `/api`)

- `/stores` — CRUD + CSV import + GeoJSON
- `/competitors` — CRUD + GeoJSON + near point + chains
- `/municipios` — list/containing/near/GeoJSON
- `/scoring` — top scores, config, per-municipio, arbitrary point, trade area, batch recalc
- `/admin` — config CRUD, stats, recalculate
- `/osm` (also `/pois`) — POI cache status, Overpass refresh
- `/ntl` — VIIRS night-time light settlements
- `/site-selection` — Stage 2 within-municipio site candidates
- `GET /health` — DB connectivity + row counts

---

## Key Commands

```bash
# Full stack (Docker)
docker-compose up -d

# Backend dev (port 4000, watch mode)
cd backend && npm run dev

# Frontend dev (port 3000, Vite HMR)
cd frontend && npm run dev

# Build for production (builds frontend, copies to backend/public, compiles backend)
npm run build        # from root
npm start            # serves everything from backend on port 4000

# Seed data
docker-compose exec backend npm run seed:municipios
docker-compose exec backend npm run seed:competitors
docker-compose exec backend npm run seed         # both

# Trigger scoring
curl -X POST http://localhost:4000/api/scoring/calculate-all
```

---

## Environment Variables

```
POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD
NODE_ENV / BACKEND_PORT / FRONTEND_PORT
DATABASE_URL                   # postgresql://user:pass@host:5432/db
VITE_API_URL                   # defaults to http://localhost:4000
OVERPASS_API_URL               # defaults to https://overpass-api.de/api/interpreter
ADMIN_SECRET                   # simple admin token
VITE_MAPBOX_TOKEN              # optional (falls back to OSM/Leaflet)
REFRESH_OSM_ON_STARTUP         # boolean
```

---

## Git / Branches

- **`master`** — main branch
- **`claude/georetail-guatemala-app-XDJep`** — active development branch (always develop here)

**Push rule**: Always push to `claude/georetail-guatemala-app-XDJep`. Use:
```bash
git push -u origin claude/georetail-guatemala-app-XDJep
```

---

## Recent Work (as of March 2026)

Looking at recent commits:
- Drive-time isochrone polygons (replacing simple circles)
- Competitor gap analysis filtered by `municipio_id`
- Stage 2 within-municipio site selection
- VIIRS night-time light fallback Zonas (for areas with no OSM POI data)
- POI nuclei (`poi_nuclei`) clustering bubbles on the map
- Competitor and own-store marker clustering for map performance
- User manual Word document (`GeoRetail_Guatemala_Manual_v1.0.docx`) generated by `generate_manual.py`

---

## Architecture Notes

- In **production**, the backend serves the compiled React frontend as static files from `backend/public/`. Single process, single port.
- In **development**, Vite dev server (3000) proxies API calls to Express (4000).
- The `autoSeedIfEmpty` function runs on prod startup to seed GADM geometries + municipios if the DB is empty.
- Trade area analysis uses real isochrones via `isochroneService.ts` (Mapbox Isochrone API or fallback).
- OSM data is fetched from Overpass API and cached in `poi_cache` table with upsert logic.
- VIIRS raster data provides settlement fallback when OSM POI density is insufficient.
