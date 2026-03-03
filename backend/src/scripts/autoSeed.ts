/**
 * autoSeed — seeds reference data if tables are empty.
 * Runs automatically on startup so Render deployments work without
 * any manual seeding step.
 *
 * Data sources used:
 *  - Municipio locations/population: INE Guatemala Censo 2018
 *  - Poverty index:      INE ENCOVI 2014 (department level)
 *  - Remittance index:   Banco de Guatemala 2020 (department level)
 *  - Store/competitor locations: OpenStreetMap via Overpass API (with static fallback)
 */
import { pool } from '../db';
import { PoolClient } from 'pg';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const OVERPASS_URL = process.env.OVERPASS_API_URL || 'https://overpass-api.de/api/interpreter';
const DATA_DIR = path.resolve(__dirname, '../../../data/seeds');

// ── Interfaces ────────────────────────────────────────────────────────────────

interface CentroidRecord {
  code: string;
  name: string;
  department: string;
  lat: number;
  lng: number;
  is_urban: boolean;
}
interface CentroidsFile  { municipios: CentroidRecord[] }
interface PopulationFile { municipios: Array<{ code: string; population: number }> }

interface SocioeconomicEntry {
  department: string;
  poverty_index: number;
  remittance_index: number;
}
interface SocioeconomicFile { departments: SocioeconomicEntry[] }

interface MunicipioDetailEntry {
  name: string;
  department: string;
  poverty_index: number;
  area_km2: number;
}
interface MunicipioDetailFile { municipios: MunicipioDetailEntry[] }

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

// ── Chain classification ───────────────────────────────────────────────────────

const OWN_CHAINS: { pattern: RegExp; format: 'Despensa Familiar' | 'Maxi Despensa' | 'Walmart' | 'Paiz' }[] = [
  { pattern: /despensa\s*familiar/i, format: 'Despensa Familiar' },
  { pattern: /maxi\s*despensa/i,     format: 'Maxi Despensa' },
  { pattern: /\bwalmart\b/i,         format: 'Walmart' },
  { pattern: /\bpaiz\b/i,            format: 'Paiz' },
];

const COMPETITOR_CHAINS: { pattern: RegExp; chain: string }[] = [
  { pattern: /super\s*del\s*barrio/i, chain: 'Super del Barrio' },
  { pattern: /la\s*bodegona/i,        chain: 'La Bodegona' },
  { pattern: /la\s*torre/i,           chain: 'La Torre' },
  { pattern: /maxi\s*bodega/i,        chain: 'Maxi Bodega' },
  { pattern: /suma\s*express/i,       chain: 'Suma Express' },
  { pattern: /\bsuma\b/i,             chain: 'Suma' },
  { pattern: /econosuper/i,           chain: 'Econosuper' },
];

function classifyOwn(name: string) {
  for (const { pattern, format } of OWN_CHAINS) if (pattern.test(name)) return format;
  return null;
}

function classifyCompetitor(name: string) {
  for (const { pattern, chain } of COMPETITOR_CHAINS) if (pattern.test(name)) return chain;
  return null;
}

// ── Static fallback data ──────────────────────────────────────────────────────

const STATIC_OWN_STORES = [
  { name: 'Despensa Familiar Zona 1',        format: 'Despensa Familiar', lat: 14.6408, lng: -90.5133, department: 'Guatemala',       municipio: 'Guatemala' },
  { name: 'Despensa Familiar Mixco',         format: 'Despensa Familiar', lat: 14.6350, lng: -90.5950, department: 'Guatemala',       municipio: 'Mixco' },
  { name: 'Despensa Familiar Xela',          format: 'Despensa Familiar', lat: 14.8347, lng: -91.5172, department: 'Quetzaltenango',  municipio: 'Quetzaltenango' },
  { name: 'Despensa Familiar Escuintla',     format: 'Despensa Familiar', lat: 14.3015, lng: -90.7873, department: 'Escuintla',       municipio: 'Escuintla' },
  { name: 'Despensa Familiar Chimaltenango', format: 'Despensa Familiar', lat: 14.6614, lng: -90.8200, department: 'Chimaltenango',   municipio: 'Chimaltenango' },
  { name: 'Despensa Familiar Cobán',         format: 'Despensa Familiar', lat: 15.4700, lng: -90.3780, department: 'Alta Verapaz',    municipio: 'Cobán' },
  { name: 'Despensa Familiar Huehuetenango', format: 'Despensa Familiar', lat: 15.3200, lng: -91.4780, department: 'Huehuetenango',   municipio: 'Huehuetenango' },
  { name: 'Maxi Despensa Villa Nueva',       format: 'Maxi Despensa',     lat: 14.5286, lng: -90.5897, department: 'Guatemala',       municipio: 'Villa Nueva' },
  { name: 'Maxi Despensa Zona 9',            format: 'Maxi Despensa',     lat: 14.6010, lng: -90.5120, department: 'Guatemala',       municipio: 'Guatemala' },
  { name: 'Maxi Despensa Xela',              format: 'Maxi Despensa',     lat: 14.8380, lng: -91.5160, department: 'Quetzaltenango',  municipio: 'Quetzaltenango' },
  { name: 'Walmart Aguilar Batres',          format: 'Walmart',           lat: 14.5930, lng: -90.5430, department: 'Guatemala',       municipio: 'Guatemala' },
  { name: 'Walmart Pradera Xela',            format: 'Walmart',           lat: 14.8410, lng: -91.5100, department: 'Quetzaltenango',  municipio: 'Quetzaltenango' },
  { name: 'Walmart Miraflores',              format: 'Walmart',           lat: 14.5990, lng: -90.5440, department: 'Guatemala',       municipio: 'Guatemala' },
  { name: 'Paiz Zona 10',                   format: 'Paiz',              lat: 14.5990, lng: -90.5160, department: 'Guatemala',       municipio: 'Guatemala' },
  { name: 'Paiz Miraflores',                format: 'Paiz',              lat: 14.5985, lng: -90.5450, department: 'Guatemala',       municipio: 'Guatemala' },
  { name: 'Paiz Petapa',                    format: 'Paiz',              lat: 14.5220, lng: -90.5770, department: 'Guatemala',       municipio: 'San Miguel Petapa' },
];

const STATIC_COMPETITORS = [
  { name: 'Super del Barrio Zona 12',     chain: 'Super del Barrio', lat: 14.5801, lng: -90.5300 },
  { name: 'Super del Barrio Mixco',       chain: 'Super del Barrio', lat: 14.6330, lng: -90.6100 },
  { name: 'Super del Barrio Villa Nueva', chain: 'Super del Barrio', lat: 14.5240, lng: -90.5900 },
  { name: 'Super del Barrio Zona 6',      chain: 'Super del Barrio', lat: 14.6600, lng: -90.5050 },
  { name: 'Super del Barrio Zona 18',     chain: 'Super del Barrio', lat: 14.6750, lng: -90.4700 },
  { name: 'La Bodegona Zona 11',          chain: 'La Bodegona',      lat: 14.6100, lng: -90.5400 },
  { name: 'La Bodegona Antigua',          chain: 'La Bodegona',      lat: 14.5560, lng: -90.7380 },
  { name: 'La Bodegona Cobán',            chain: 'La Bodegona',      lat: 15.4680, lng: -90.3760 },
  { name: 'La Torre Zona 9',              chain: 'La Torre',         lat: 14.6050, lng: -90.5130 },
  { name: 'La Torre Xela',               chain: 'La Torre',         lat: 14.8320, lng: -91.5150 },
  { name: 'La Torre Escuintla',           chain: 'La Torre',         lat: 14.3000, lng: -90.7900 },
  { name: 'La Torre Chimaltenango',       chain: 'La Torre',         lat: 14.6580, lng: -90.8190 },
  { name: 'Suma Xela',                   chain: 'Suma',             lat: 14.8390, lng: -91.5100 },
  { name: 'Suma Huehuetenango',           chain: 'Suma',             lat: 15.3200, lng: -91.4780 },
  { name: 'Suma Cobán',                  chain: 'Suma',             lat: 15.4700, lng: -90.3780 },
  { name: 'Suma Express Zona 1',          chain: 'Suma Express',     lat: 14.6410, lng: -90.5110 },
  { name: 'Suma Express Zona 4',          chain: 'Suma Express',     lat: 14.6320, lng: -90.5180 },
  { name: 'Maxi Bodega Zona 7',           chain: 'Maxi Bodega',      lat: 14.6250, lng: -90.5550 },
  { name: 'Maxi Bodega Mixco',            chain: 'Maxi Bodega',      lat: 14.6340, lng: -90.6080 },
  { name: 'Econosuper Chimaltenango',     chain: 'Econosuper',       lat: 14.6620, lng: -90.8200 },
  { name: 'Econosuper Jalapa',            chain: 'Econosuper',       lat: 14.6340, lng: -89.9870 },
];

// ── Municipios ────────────────────────────────────────────────────────────────

async function seedMunicipios(): Promise<void> {
  const { rows } = await pool.query('SELECT COUNT(*) AS count FROM municipios');
  if (parseInt(rows[0].count) > 0) {
    console.log(`[autoSeed] ${rows[0].count} municipios already present — skipping`);
    return;
  }

  const centroidsPath = path.join(DATA_DIR, 'municipios_centroids.json');
  const populationPath = path.join(DATA_DIR, 'population_ine2018.json');
  if (!fs.existsSync(centroidsPath) || !fs.existsSync(populationPath)) {
    console.warn('[autoSeed] Seed JSON files not found — skipping municipios seed');
    return;
  }

  const centroids = (JSON.parse(fs.readFileSync(centroidsPath, 'utf8')) as CentroidsFile).municipios;
  const popMap: Record<string, number> = {};
  for (const p of (JSON.parse(fs.readFileSync(populationPath, 'utf8')) as PopulationFile).municipios) {
    popMap[p.code] = p.population;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of centroids) {
      await client.query(
        `INSERT INTO municipios (name, department, code, population, lat, lng, is_urban, centroid)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ST_SetSRID(ST_MakePoint($8, $9), 4326))
         ON CONFLICT (code) DO NOTHING`,
        [c.name, c.department, c.code, popMap[c.code] ?? 0,
         c.lat, c.lng, c.is_urban ?? false, c.lng, c.lat]
      );
    }
    await client.query('COMMIT');
    console.log(`[autoSeed] Seeded ${centroids.length} municipios`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Socioeconomic indicators ─────────────────────────────────────────────────
// Source: INE ENCOVI 2014 (poverty) + Banco de Guatemala 2020 (remittances)
// Applied at department level to all municipios in each department.

async function seedSocioeconomicIndicators(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS count FROM municipios WHERE poverty_index IS NOT NULL`
  );
  if (parseInt(rows[0].count) > 0) {
    console.log('[autoSeed] Socioeconomic indicators already present — skipping');
    return;
  }

  const indicatorsPath = path.join(DATA_DIR, 'socioeconomic_indicators.json');
  if (!fs.existsSync(indicatorsPath)) {
    console.warn('[autoSeed] socioeconomic_indicators.json not found — skipping');
    return;
  }

  const data = JSON.parse(fs.readFileSync(indicatorsPath, 'utf8')) as SocioeconomicFile;
  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query('BEGIN');
    for (const entry of data.departments) {
      const result = await client.query(
        `UPDATE municipios SET poverty_index = $1, remittance_index = $2 WHERE department = $3`,
        [entry.poverty_index, entry.remittance_index, entry.department]
      );
      updated += result.rowCount ?? 0;
    }
    await client.query('COMMIT');
    console.log(`[autoSeed] Applied socioeconomic indicators to ${updated} municipios`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── OpenStreetMap fetch ───────────────────────────────────────────────────────

async function fetchFromOverpass(): Promise<{
  ownStores: Array<{ osmId: number; name: string; lat: number; lng: number; format: string }>;
  competitors: Array<{ osmId: number; name: string; lat: number; lng: number; chain: string }>;
}> {
  const query = `
[out:json][timeout:90];
area["name"="Guatemala"]["boundary"="administrative"]["admin_level"="2"]->.gt;
(
  node["shop"="supermarket"](area.gt);
  way["shop"="supermarket"](area.gt);
  node["name"~"despensa familiar|maxi despensa|walmart|paiz|super del barrio|la bodegona|la torre|suma|maxi bodega|econosuper",i](area.gt);
  way["name"~"despensa familiar|maxi despensa|walmart|paiz|super del barrio|la bodegona|la torre|suma|maxi bodega|econosuper",i](area.gt);
);
out center;
  `.trim();

  const response = await axios.post(
    OVERPASS_URL,
    `data=${encodeURIComponent(query)}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 95_000 }
  );

  const elements: OverpassElement[] = response.data.elements || [];
  const ownStores: Array<{ osmId: number; name: string; lat: number; lng: number; format: string }> = [];
  const competitors: Array<{ osmId: number; name: string; lat: number; lng: number; chain: string }> = [];
  const seen = new Set<number>();

  for (const el of elements) {
    if (seen.has(el.id)) continue;
    seen.add(el.id);
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!lat || !lon) continue;
    const name = el.tags?.name || el.tags?.['name:es'] || '';
    if (!name) continue;

    const ownFormat = classifyOwn(name);
    if (ownFormat) { ownStores.push({ osmId: el.id, name, lat, lng: lon, format: ownFormat }); continue; }

    const compChain = classifyCompetitor(name);
    if (compChain) { competitors.push({ osmId: el.id, name, lat, lng: lon, chain: compChain }); }
  }

  return { ownStores, competitors };
}

// ── Stores + Competitors ──────────────────────────────────────────────────────

async function insertStores(
  client: PoolClient,
  stores: Array<{ name: string; format: string; lat: number; lng: number; department?: string; municipio?: string }>
): Promise<number> {
  let count = 0;
  const validFormats = ['Despensa Familiar', 'Maxi Despensa', 'Walmart', 'Paiz'];
  for (const s of stores) {
    const fmt = validFormats.includes(s.format) ? s.format : 'Other';
    await client.query(
      `INSERT INTO stores (name, format, lat, lng, status, department, municipio, chain)
       VALUES ($1, $2, $3, $4, 'open', $5, $6, 'Walmart Guatemala')
       ON CONFLICT DO NOTHING`,
      [s.name, fmt, s.lat, s.lng, s.department ?? null, s.municipio ?? null]
    );
    count++;
  }
  return count;
}

async function insertCompetitors(
  client: PoolClient,
  competitors: Array<{ name: string; chain: string; lat: number; lng: number; osmId?: number }>
): Promise<number> {
  let count = 0;
  for (const c of competitors) {
    await client.query(
      `INSERT INTO competitors (name, chain, lat, lng, osm_id, source, verified)
       VALUES ($1, $2, $3, $4, $5, $6, false)
       ON CONFLICT (osm_id) DO NOTHING`,
      [c.name, c.chain, c.lat, c.lng, c.osmId ?? null, c.osmId ? 'osm' : 'manual']
    );
    count++;
  }
  return count;
}

async function seedStoresAndCompetitors(): Promise<void> {
  const [storeCount, compCount] = await Promise.all([
    pool.query('SELECT COUNT(*) AS count FROM stores'),
    pool.query('SELECT COUNT(*) AS count FROM competitors'),
  ]);
  const storesEmpty = parseInt(storeCount.rows[0].count) === 0;
  const compsEmpty  = parseInt(compCount.rows[0].count) === 0;

  if (!storesEmpty && !compsEmpty) {
    console.log('[autoSeed] Stores and competitors already present — skipping');
    return;
  }

  // Try OpenStreetMap for real coordinates
  let osmStores: Array<{ osmId: number; name: string; lat: number; lng: number; format: string }> = [];
  let osmComps:  Array<{ osmId: number; name: string; lat: number; lng: number; chain: string }> = [];

  try {
    console.log('[autoSeed] Fetching store locations from OpenStreetMap...');
    const results = await fetchFromOverpass();
    osmStores = results.ownStores;
    osmComps  = results.competitors;
    console.log(`[autoSeed] OSM: ${osmStores.length} own stores, ${osmComps.length} competitors`);
  } catch (err: any) {
    console.warn(`[autoSeed] Overpass unavailable (${err.message}) — using static fallback`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (storesEmpty) {
      const src = osmStores.length > 0 ? 'OpenStreetMap' : 'static fallback';
      const n   = await insertStores(client, osmStores.length > 0 ? osmStores : STATIC_OWN_STORES);
      console.log(`[autoSeed] Seeded ${n} stores from ${src}`);
    }

    if (compsEmpty) {
      const src = osmComps.length > 0 ? 'OpenStreetMap' : 'static fallback';
      const n   = await insertCompetitors(client, osmComps.length > 0 ? osmComps : STATIC_COMPETITORS);
      console.log(`[autoSeed] Seeded ${n} competitors from ${src}`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Municipio detail (municipio-level poverty + area) ─────────────────────────
// Source: World Bank 2014 Guatemala small-area poverty map + INE area data.
// Provides intra-department differentiation for key urban centers.
// Runs AFTER seedSocioeconomicIndicators() to override department-level defaults
// with more accurate municipio-specific values where available.

async function seedMunicipioDetail(): Promise<void> {
  // area_km2 being non-null is our marker that this seed has already run
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS count FROM municipios WHERE area_km2 IS NOT NULL`
  );
  if (parseInt(rows[0].count) > 0) {
    console.log('[autoSeed] Municipio detail data already present — skipping');
    return;
  }

  const detailPath = path.join(DATA_DIR, 'municipio_detail.json');
  if (!fs.existsSync(detailPath)) {
    console.warn('[autoSeed] municipio_detail.json not found — skipping');
    return;
  }

  const data = JSON.parse(fs.readFileSync(detailPath, 'utf8')) as MunicipioDetailFile;
  const client = await pool.connect();
  let updated = 0;

  try {
    await client.query('BEGIN');
    for (const entry of data.municipios) {
      const result = await client.query(
        `UPDATE municipios
         SET poverty_index = $1, area_km2 = $2
         WHERE LOWER(TRIM(name))       = LOWER(TRIM($3))
           AND LOWER(TRIM(department)) = LOWER(TRIM($4))`,
        [entry.poverty_index, entry.area_km2, entry.name, entry.department]
      );
      updated += result.rowCount ?? 0;
    }
    await client.query('COMMIT');
    console.log(`[autoSeed] Applied municipio-level detail (poverty + area) to ${updated} municipios`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Calibration weight migration ──────────────────────────────────────────────
// Bumps socioeconomic weight from 5% → 13% if the user hasn't customized it.
// Now that real government data (INE ENCOVI poverty + Banguat remittances) drives
// this factor at the municipio level, a higher weight reflects the signal quality.

async function migrateCalibrationWeights(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, weight_socioeconomic FROM calibration_config
     WHERE is_active = true ORDER BY id DESC LIMIT 1`
  );
  if (rows.length === 0) return;

  const currentSocio = parseFloat(rows[0].weight_socioeconomic);
  // Only auto-migrate if weights are still at the original 5% default
  if (Math.abs(currentSocio - 0.05) > 0.001) {
    console.log('[autoSeed] Calibration weights already customized — skipping migration');
    return;
  }

  await pool.query(
    `UPDATE calibration_config
     SET weight_population    = 0.28,
         weight_mobility      = 0.22,
         weight_commercial    = 0.22,
         weight_competition   = 0.15,
         weight_socioeconomic = 0.13,
         name                 = 'real-data-v2',
         updated_at           = NOW()
     WHERE id = $1`,
    [rows[0].id]
  );
  console.log(
    '[autoSeed] Calibration weights updated: ' +
    'population 30%→28%, mobility 25%→22%, commercial 25%→22%, socioeconomic 5%→13%'
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function autoSeedIfEmpty(): Promise<void> {
  await seedMunicipios();
  await seedSocioeconomicIndicators();  // department-level poverty + remittance baseline
  await seedMunicipioDetail();          // municipio-specific overrides (poverty + area_km2)
  await seedStoresAndCompetitors();     // fetches from OSM with static fallback
  await migrateCalibrationWeights();    // bump socioeconomic weight to match real data quality
}
