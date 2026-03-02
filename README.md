# GeoRetail Guatemala

**Plataforma de Inteligencia de Ubicación Retail**

Identify optimal locations for Despensa Familiar and Maxi Despensa stores across Guatemala using a multi-factor composite scoring model built on real geospatial data.

---

## Architecture

```
georetail-guatemala/
├── frontend/          # React + TypeScript + Tailwind + Leaflet.js
├── backend/           # Node.js + Express + PostGIS
├── data/              # Seed scripts, population data, Overpass queries
├── docker/            # Docker configs, PostgreSQL init SQL
├── docker-compose.yml # Full stack with one command
└── .env.example       # Environment variable template
```

## Quick Start

### Prerequisites
- Docker + Docker Compose
- Node.js 20+ (for local development without Docker)

### 1. Configure Environment
```bash
cp .env.example .env
# Edit .env — defaults work for local development
```

### 2. Start Full Stack
```bash
docker-compose up -d
```

Services:
| Service    | URL                   | Description              |
|------------|-----------------------|--------------------------|
| Frontend   | http://localhost:3000 | React map application    |
| Backend    | http://localhost:4000 | REST API                 |
| PostgreSQL | localhost:5432        | PostGIS database         |

### 3. Health Check
```bash
curl http://localhost:4000/health
```

### 4. Seed Data (after first startup)
```bash
# Seed municipio boundaries + population data
cd backend && npm run seed:municipios
cd backend && npm run seed:population

# Fetch competitor locations from OpenStreetMap
cd backend && npm run seed:competitors
```

---

## Data Sources

| Data | Source | License |
|------|--------|---------|
| Administrative boundaries | GADM (gadm.org) | Free (non-commercial) |
| Population | INE Guatemala Censo 2018 | Public domain |
| Store/competitor locations | OpenStreetMap via Overpass API | ODbL |
| Roads/mobility | OpenStreetMap | ODbL |
| Commercial POIs | OpenStreetMap | ODbL |

### Getting GADM Data (required for Module 2)
```bash
# Download Guatemala Level 2 boundaries (municipios)
curl -L "https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_GTM_2.json" \
  -o data/gadm/GTM_adm2.geojson
```

---

## Scoring Model

The **Opportunity Score (0-100)** weights five factor groups:

| Factor Group | Weight | Key Signals |
|---|---|---|
| Population | 30% | Total pop, 3km/10km radius trade areas, growth |
| Mobility & Access | 25% | Road connectivity, highway proximity, transit |
| Commercial Density | 25% | Markets, banks, pharmacies, commerce clusters |
| Competitive Landscape | 15% | Distance to our stores, competitor density |
| Socioeconomic Proxy | 5% | Schools, health centers, remittances, poverty |

### Format Recommendation Rules
- **Population 24k-54k** -> Despensa Familiar
- **Population 55k+** -> Maxi Despensa
- **Override**: High mobility score -> lower population threshold
- **Override**: High commercial density -> recommend Maxi Despensa even below 55k

### Score Color Coding
| Score | Recommendation |
|-------|----------------|
| 80-100 | Prime opportunity - GO |
| 60-79 | Investigate further - CAUTION |
| 40-59 | Marginal - CAUTION |
| 0-39 | Not recommended - NO-GO |

---

## API Endpoints

### Stores
```
GET    /api/stores              # List all stores
POST   /api/stores              # Add store
PUT    /api/stores/:id          # Update store
DELETE /api/stores/:id          # Remove store
POST   /api/stores/import       # Import CSV
```

### Scoring
```
GET  /api/scoring/municipios    # Top 20 opportunity scores
POST /api/scoring/point         # Score a lat/lng point
GET  /api/scoring/:municipio_id # Score for specific municipio
POST /api/scoring/trade-area    # Trade area analysis (3/5/10km rings)
```

### Admin
```
GET  /api/admin/config          # Get calibration settings
PUT  /api/admin/config          # Update weights/thresholds
POST /api/admin/recalculate     # Trigger full rescore
```

---

## Development Modules

| Module | Status | Description |
|--------|--------|-------------|
| 1 - Scaffold | Complete | Folder structure, Docker, env config |
| 2 - Database | Pending | Schema, PostGIS, seed scripts |
| 3 - API Foundation | Pending | CRUD endpoints, CSV import |
| 4 - Scoring Engine | Pending | Composite score calculator |
| 5 - OSM Integration | Pending | Overpass API, POI fetching |
| 6 - Map Frontend | Pending | Leaflet map, layer toggles |
| 7 - Sidebar & UI | Pending | Rankings, score display |
| 8 - Admin Panel | Pending | Weight calibration |
| 9 - Export & Polish | Pending | PDF/CSV export, mobile UI |
| 10 - Integration | Pending | E2E testing, final docs |

---

## Local Development (without Docker)

### Backend
```bash
cd backend
npm install
# Set DATABASE_URL in .env
npm run dev
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Database only
```bash
docker-compose up postgres -d
```

---

## CSV Import Format

Upload store locations via POST /api/stores/import or through the UI:

```csv
store_name,format,lat,lng,status,department,municipio,open_date,notes
"Despensa Familiar Zona 1",Despensa Familiar,14.6408,-90.5133,open,Guatemala,Guatemala,2020-01-15,
```

Valid formats: Despensa Familiar, Maxi Despensa, Walmart, Paiz, Other
Valid statuses: open, planned, closed, under_construction
