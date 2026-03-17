# Data Directory

This directory contains seed data and scripts for GeoRetail Guatemala.

## Structure

```
data/
├── seeds/
│   ├── municipios_gadm.geojson   # Guatemala municipio boundaries (GADM)
│   ├── population_ine2018.json   # INE 2018 census population by municipio
│   ├── seed_municipios.ts        # Script to load GeoJSON into PostGIS
│   └── seed_population.ts        # Script to join population data
├── queries/
│   └── overpass/
│       ├── supermarkets.ql       # Overpass QL: supermarkets in Guatemala
│       ├── roads.ql              # Overpass QL: road network
│       └── pois.ql               # Overpass QL: commercial POIs
└── gadm/
    └── GTM_adm3.geojson          # GADM Level 3 = municipios (download separately)
```

## Data Sources

### Administrative Boundaries (GADM)
Download Guatemala municipio boundaries from GADM:
- URL: https://gadm.org/download_country.html?country=GTM
- Format: GeoJSON, Level 2 (departamentos) or Level 3 (municipios)
- License: Free for non-commercial use

### Population Data (INE Guatemala)
- Source: Instituto Nacional de Estadística, Censo 2018
- URL: https://www.censopoblacion.gt/
- Alternative: Embed static JSON with 340 municipios + population

### OpenStreetMap (Overpass API)
All POI and road data is fetched via Overpass API at runtime.
No download needed — queries run automatically on app startup.

## Seed Instructions

After running `docker-compose up`, seed the database:

```bash
# From backend directory:
npm run seed:municipios   # Loads GeoJSON boundaries
npm run seed:population   # Loads INE 2018 census data
npm run seed:competitors  # Fetches from Overpass API
```
