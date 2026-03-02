/**
 * autoSeed — seeds reference data if tables are empty.
 * Runs automatically on startup so Render deployments work without
 * any manual seeding step.
 *
 * Competitor + store locations are fetched from OpenStreetMap (Overpass API)
 * for real, up-to-date coordinates.  A static fallback is used when Overpass
 * is unavailable at startup.
 */
import { pool } from '../db';
import { PoolClient } from 'pg';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const OVERPASS_URL = process.env.OVERPASS_API_URL || 'https://overpass-api.de/api/interpreter';

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
  { pattern: /\bsuma\b/i,            chain: 'Suma' },
  { pattern: /econosuper/i,           chain: 'Econosuper' },
];

function classifyOwn(name: string) {
  for (const { pattern, format } of OWN_CHAINS) {
    if (pattern.test(name)) return format;
  }
  return null;
}

function classifyCompetitor(name: string) {
  for (const { pattern, chain } of COMPETITOR_CHAINS) {
    if (pattern.test(name)) return chain;
  }
  return null;
}

// ── Overpass fetch ────────────────────────────────────────────────────────────

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface ClassifiedStore {
  osmId: number;
  name: string;
  lat: number;
  lng: number;
}

interface ClassifiedResults {
  ownStores: (ClassifiedStore & { format: string })[];
  competitors: (ClassifiedStore & { chain: string })[];
}

async function fetchFromOverpass(): Promise<ClassifiedResults> {
  // Single query: all supermarkets + our specific chains in Guatemala
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
  const results: ClassifiedResults = { ownStores: [], competitors: [] };
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
    if (ownFormat) {
      results.ownStores.push({ osmId: el.id, name, lat, lng: lon, format: ownFormat });
      continue;
    }

    const compChain = classifyCompetitor(name);
    if (compChain) {
      results.competitors.push({ osmId: el.id, name, lat, lng: lon, chain: compChain });
    }
    // Unknown supermarkets are intentionally skipped — keeps the map clean
  }

  return results;
}

// ── Static fallbacks ──────────────────────────────────────────────────────────

const STATIC_OWN_STORES = [
  { name: 'Despensa Familiar Zona 1',        format: 'Despensa Familiar', lat: 14.6408, lng: -90.5133, department: 'Guatemala',        municipio: 'Guatemala' },
  { name: 'Despensa Familiar Mixco',         format: 'Despensa Familiar', lat: 14.6350, lng: -90.5950, department: 'Guatemala',        municipio: 'Mixco' },
  { name: 'Despensa Familiar Xela',          format: 'Despensa Familiar', lat: 14.8347, lng: -91.5172, department: 'Quetzaltenango',   municipio: 'Quetzaltenango' },
  { name: 'Despensa Familiar Escuintla',     format: 'Despensa Familiar', lat: 14.3015, lng: -90.7873, department: 'Escuintla',        municipio: 'Escuintla' },
  { name: 'Despensa Familiar Chimaltenango', format: 'Despensa Familiar', lat: 14.6614, lng: -90.8200, department: 'Chimaltenango',    municipio: 'Chimaltenango' },
  { name: 'Despensa Familiar Cobán',         format: 'Despensa Familiar', lat: 15.4700, lng: -90.3780, department: 'Alta Verapaz',     municipio: 'Cobán' },
  { name: 'Despensa Familiar Huehuetenango', format: 'Despensa Familiar', lat: 15.3200, lng: -91.4780, department: 'Huehuetenango',    municipio: 'Huehuetenango' },
  { name: 'Maxi Despensa Villa Nueva',       format: 'Maxi Despensa',     lat: 14.5286, lng: -90.5897, department: 'Guatemala',        municipio: 'Villa Nueva' },
  { name: 'Maxi Despensa Zona 9',            format: 'Maxi Despensa',     lat: 14.6010, lng: -90.5120, department: 'Guatemala',        municipio: 'Guatemala' },
  { name: 'Maxi Despensa Xela',              format: 'Maxi Despensa',     lat: 14.8380, lng: -91.5160, department: 'Quetzaltenango',   municipio: 'Quetzaltenango' },
  { name: 'Walmart Aguilar Batres',          format: 'Walmart',           lat: 14.5930, lng: -90.5430, department: 'Guatemala',        municipio: 'Guatemala' },
  { name: 'Walmart Pradera Xela',            format: 'Walmart',           lat: 14.8410, lng: -91.5100, department: 'Quetzaltenango',   municipio: 'Quetzaltenango' },
  { name: 'Walmart Miraflores',              format: 'Walmart',           lat: 14.5990, lng: -90.5440, department: 'Guatemala',        municipio: 'Guatemala' },
  { name: 'Paiz Zona 10',                   format: 'Paiz',              lat: 14.5990, lng: -90.5160, department: 'Guatemala',        municipio: 'Guatemala' },
  { name: 'Paiz Miraflores',                format: 'Paiz',              lat: 14.5985, lng: -90.5450, department: 'Guatemala',        municipio: 'Guatemala' },
  { name: 'Paiz Petapa',                    format: 'Paiz',              lat: 14.5220, lng: -90.5770, department: 'Guatemala',        municipio: 'San Miguel Petapa' },
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

// ── Seed helpers ──────────────────────────────────────────────────────────────

type StoreFormat = 'Despensa Familiar' | 'Maxi Despensa' | 'Walmart' | 'Paiz' | 'Other';

async function insertStores(
  client: PoolClient,
  stores: Array<{ name: string; format: string; lat: number; lng: number; department?: string; municipio?: string }>
): Promise<number> {
  let count = 0;
  for (const s of stores) {
    const fmt: StoreFormat = (['Despensa Familiar', 'Maxi Despensa', 'Walmart', 'Paiz'] as string[]).includes(s.format)
      ? s.format as StoreFormat
      : 'Other';
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

// ── Municipios ────────────────────────────────────────────────────────────────

interface CentroidRecord { code: string; name: string; department: string; lat: number; lng: number; is_urban: boolean }
interface CentroidsFile  { municipios: CentroidRecord[] }
interface PopulationFile { municipios: Array<{ code: string; population: number }> }

async function seedMunicipios(): Promise<void> {
  const { rows } = await pool.query('SELECT COUNT(*) AS count FROM municipios');
  if (parseInt(rows[0].count) > 0) {
    console.log(`[autoSeed] ${rows[0].count} municipios already present — skipping`);
    return;
  }

  const base = path.resolve(__dirname, '../../../data/seeds');
  const centroidsPath = path.join(base, 'municipios_centroids.json');
  const populationPath = path.join(base, 'population_ine2018.json');

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
        [c.name, c.department, c.code, popMap[c.code] ?? 0, c.lat, c.lng, c.is_urban ?? false, c.lng, c.lat]
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

// ── Stores + Competitors (from OSM, with static fallback) ─────────────────────

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

  // Try OpenStreetMap first
  let osmStores: (ClassifiedStore & { format: string })[] = [];
  let osmCompetitors: (ClassifiedStore & { chain: string })[] = [];

  try {
    console.log('[autoSeed] Fetching store locations from OpenStreetMap...');
    const results = await fetchFromOverpass();
    osmStores = results.ownStores;
    osmCompetitors = results.competitors;
    console.log(`[autoSeed] OSM returned ${osmStores.length} own stores, ${osmCompetitors.length} competitors`);
  } catch (err: any) {
    console.warn(`[autoSeed] Overpass unavailable (${err.message}) — using static fallback data`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (storesEmpty) {
      const storesToInsert = osmStores.length > 0 ? osmStores : STATIC_OWN_STORES;
      const n = await insertStores(client, storesToInsert);
      const src = osmStores.length > 0 ? 'OpenStreetMap' : 'static fallback';
      console.log(`[autoSeed] Seeded ${n} stores from ${src}`);
    }

    if (compsEmpty) {
      const compsToInsert = osmCompetitors.length > 0 ? osmCompetitors : STATIC_COMPETITORS;
      const n = await insertCompetitors(client, compsToInsert);
      const src = osmCompetitors.length > 0 ? 'OpenStreetMap' : 'static fallback';
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

// ── Main export ───────────────────────────────────────────────────────────────

export async function autoSeedIfEmpty(): Promise<void> {
  await seedMunicipios();
  await seedStoresAndCompetitors();
}
