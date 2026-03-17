# GeoRetail Guatemala

**Plataforma de Inteligencia de Ubicación Retail**

Identify optimal locations for **Despensa Familiar** and **Maxi Despensa** stores across Guatemala using a multi-factor composite scoring model (0–100) built on real geospatial data.

---

## Architecture

```
georetail-guatemala/
├── frontend/          # React 18 + TypeScript + Tailwind CSS + Leaflet.js
├── backend/           # Node.js + Express + TypeScript + PostGIS
├── data/              # Seed scripts, population data, Overpass QL queries
├── docker/            # Docker configs, PostgreSQL/PostGIS init SQL
├── docker-compose.yml # Full stack with one command
└── .env.example       # Environment variable template
```

---

## Quick Start

### Prerequisites
- Docker + Docker Compose
- Node.js 20+ (for local development outside Docker)

### 1. Configure Environment
```bash
cp .env.example .env
# Defaults work for local development — no changes required
```

### 2. Start Full Stack
```bash
docker-compose up -d
```

| Service    | URL                    | Description              |
|------------|------------------------|--------------------------|
| Frontend   | http://localhost:3000  | React map application    |
| Backend    | http://localhost:4000  | REST API                 |
| PostgreSQL | localhost:5432         | PostGIS database         |

### 3. Verify Health
```bash
curl http://localhost:4000/health
```
Expected response includes `status: "ok"` with row counts for stores, competitors, and municipios.

### 4. Seed Data
```bash
# Seed all 254 Guatemala municipios with population + GPS centroids
docker-compose exec backend npm run seed:municipios

# Fetch competitor locations from OpenStreetMap (requires internet)
docker-compose exec backend npm run seed:competitors

# Or seed both at once
docker-compose exec backend npm run seed
```

### 5. Calculate Initial Scores
```bash
curl -X POST http://localhost:4000/api/scoring/calculate-all
# Or use the Recalcular button in the Admin panel (⚙ icon, Sistema tab)
```

---

## Scoring Model

The **Opportunity Score (0–100)** weights five factor groups:

| Factor Group          | Weight | Key Signals |
|-----------------------|--------|-------------|
| Population            | 30%    | Municipio pop, 3km/5km/10km trade area pop |
| Mobility & Access     | 25%    | Road density, highway proximity, urban flag |
| Commercial Density    | 25%    | Markets, banks, pharmacies, commerce POIs |
| Competitive Landscape | 15%    | Distance to our stores, competitor chain density |
| Socioeconomic Proxy   | 5%     | Schools, health facilities, urban index |

### Population Score Breakpoints (piecewise linear)
| Population | Score |
|------------|-------|
| 0          | 0     |
| 5,000      | 10    |
| 15,000     | 25    |
| **24,000** | **40** ← Despensa Familiar threshold |
| 40,000     | 52    |
| **55,000** | **65** ← Maxi Despensa threshold |
| 100,000    | 80    |
| 300,000    | 92    |
| 1,100,000  | 100   |

### Format Recommendation Rules
| Condition | Recommended Format |
|-----------|-------------------|
| Population ≥ 55,000 | Maxi Despensa |
| Population 24,000–54,999 | Despensa Familiar |
| Population 24k–54k AND mobility score ≥ 0.80 | Maxi Despensa (override) |
| Population 24k–54k AND commercial score ≥ 0.85 | Maxi Despensa (override) |
| Population < 24,000 AND mobility override met | Despensa Familiar |
| Population < 24,000 | No recommendation |

Thresholds and weights are editable in real time via the Admin panel.

### Score Color Coding
| Score | Category | Recommendation |
|-------|----------|----------------|
| 80–100 | Prime   | GO (green) |
| 60–79  | Good    | CAUTION (yellow) |
| 40–59  | Marginal| CAUTION (yellow) |
| 0–39   | Low     | NO-GO (red) |

---

## API Reference

All endpoints are prefixed with `/api`.

### Health
```
GET  /health                          # DB connectivity + row counts
```

### Stores
```
GET    /api/stores                    # List stores (filter: ?format=&status=&department=)
GET    /api/stores/geojson            # Stores as GeoJSON FeatureCollection
POST   /api/stores/import             # Bulk import via CSV upload (multipart/form-data field "file")
GET    /api/stores/:id                # Single store
POST   /api/stores                    # Create store
PUT    /api/stores/:id                # Update store
PATCH  /api/stores/:id/performance    # Tag performance (success|on-plan|underperforming)
DELETE /api/stores/:id                # Delete store
```

### Competitors
```
GET    /api/competitors               # List competitors (filter: ?chain=&verified=)
GET    /api/competitors/geojson       # Competitors as GeoJSON
GET    /api/competitors/near          # Near a point (?lat=&lng=&radius=)
GET    /api/competitors/chains        # Distinct chains with counts
GET    /api/competitors/:id           # Single competitor
POST   /api/competitors               # Add competitor manually
PUT    /api/competitors/:id           # Update competitor
DELETE /api/competitors/:id           # Delete competitor
```

### Municipios
```
GET    /api/municipios                # List all 254 municipios
GET    /api/municipios/top            # Top by population (?limit=20)
GET    /api/municipios/containing     # Municipio containing point (?lat=&lng=)
GET    /api/municipios/near           # Municipios within radius (?lat=&lng=&radius=)
GET    /api/municipios/geojson        # Municipios as GeoJSON
GET    /api/municipios/:id            # Single municipio
```

### Scoring
```
GET    /api/scoring/municipios        # Top opportunity scores (?limit=20&min_score=0&format=)
GET    /api/scoring/config            # Active calibration configuration
GET    /api/scoring/municipio/:id     # Score for a specific municipio
POST   /api/scoring/point             # Score an arbitrary point { lat, lng }
POST   /api/scoring/trade-area        # Full 3/5/10km ring analysis { lat, lng }
POST   /api/scoring/calculate-all     # Trigger full batch rescore of all municipios
```

### Admin
```
GET    /api/admin/config              # Current calibration weights/thresholds
PUT    /api/admin/config              # Update weights/thresholds (weights must sum to 1.0)
POST   /api/admin/config/reset        # Reset to factory defaults
POST   /api/admin/recalculate         # Trigger full rescore
GET    /api/admin/stats               # System statistics (store/competitor/score counts)
```

### OSM
```
GET    /api/osm/status                # POI cache counts by type
GET    /api/osm/log                   # Recent Overpass refresh log
POST   /api/osm/refresh/supermarkets  # Fetch supermarkets from Overpass API
POST   /api/osm/refresh/pois          # Fetch commercial POIs
POST   /api/osm/refresh/roads         # Fetch road network data
POST   /api/osm/refresh/all           # Refresh all OSM data types
```

---

## UI Features

- **Interactive Leaflet map** centered on Guatemala with OSM tile layer
- **Layer toggles**: Show/hide stores, competitors, opportunity markers, heatmap
- **Map click**: Click anywhere to run a live 3/5/10km trade area analysis
- **Opportunity sidebar**: Ranked list of top municipios with score cards, factor bars, and recommended format
- **Filter controls**: Population threshold slider, minimum score filter
- **Admin panel** (⚙ button): Live weight editing, threshold tuning, system stats, OSM refresh trigger
- **Dark mode**: Respects OS preference, toggleable via ☀/🌙 button
- **Export**: 📄 Reporte button generates a printable HTML report; CSV download also available

---

## CSV Import Format

Upload store locations via `POST /api/stores/import` or the Admin panel:

```csv
store_name,format,lat,lng,status,department,municipio,open_date,notes
"Despensa Familiar Zona 1",Despensa Familiar,14.6408,-90.5133,open,Guatemala,Guatemala,2020-01-15,
"Maxi Despensa Xela",Maxi Despensa,14.8444,-91.5187,open,Quetzaltenango,Quetzaltenango,,
```

**Valid formats**: `Despensa Familiar`, `Maxi Despensa`, `Walmart`, `Paiz`, `Other`
**Valid statuses**: `open`, `planned`, `closed`, `under_construction`

---

## Data Sources

| Data | Source | License |
|------|--------|---------|
| Administrative boundaries | GADM (gadm.org) | Free (non-commercial) |
| Population | INE Guatemala Censo 2018 | Public domain |
| Competitor/POI locations | OpenStreetMap via Overpass API | ODbL |
| Road network | OpenStreetMap | ODbL |

### Optional: GADM Polygon Boundaries
For precise polygon containment (instead of KNN centroid fallback):
```bash
mkdir -p data/gadm
curl -L "https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_GTM_2.json" \
  -o data/gadm/GTM_adm2.geojson
# Re-run seed:municipios to load polygon geometries
docker-compose exec backend npm run seed:municipios
```

---

## Local Development (without Docker)

### Backend
```bash
cd backend
npm install
# Ensure DATABASE_URL is set in .env pointing to a running PostgreSQL+PostGIS instance
npm run dev          # ts-node watch mode on port 4000
npm run build        # compile to dist/
npm run seed         # seed all data
npm run test:queries # run 10 PostGIS smoke tests
```

### Frontend
```bash
cd frontend
npm install
# VITE_API_URL defaults to http://localhost:4000
npm run dev          # Vite dev server on port 3000
npm run build        # production build to dist/
npm run typecheck    # tsc --noEmit
```

### Database only
```bash
docker-compose up postgres -d
# Connection: postgresql://georetail:georetailpass@localhost:5432/georetail
```

---

## Module Build Log

| Module | Status | Description |
|--------|--------|-------------|
| 1 — Scaffold         | Complete | Monorepo, Docker Compose, Vite, Tailwind, env config |
| 2 — Database         | Complete | PostGIS schema, 254-municipio seed data, spatial queries |
| 3 — API Foundation   | Complete | Full CRUD for stores/competitors/municipios, CSV import |
| 4 — Scoring Engine   | Complete | 5-factor composite model, trade area rings, batch scoring |
| 5 — OSM Integration  | Complete | Overpass API fetch, poi_cache upsert, static fallback |
| 6 — Map Frontend     | Complete | Leaflet map, markers, trade area circles, legend |
| 7 — Sidebar & UI     | Complete | Rankings, factor bars, filter controls, trade area panel |
| 8 — Admin Panel      | Complete | Weight sliders, threshold inputs, system stats, OSM refresh |
| 9 — Export & Polish  | Complete | CSV export, printable HTML report, dark mode |
| 10 — Integration     | Complete | End-to-end wiring, TypeScript clean, README |
