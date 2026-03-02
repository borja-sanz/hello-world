/**
 * autoSeed — seeds reference data if tables are empty.
 * Runs automatically on startup so Render deployments work without
 * any manual seeding step.
 */
import { pool } from '../db';
import fs from 'fs';
import path from 'path';

interface CentroidRecord {
  code: string;
  name: string;
  department: string;
  lat: number;
  lng: number;
  is_urban: boolean;
}

interface PopulationFile {
  municipios: Array<{ code: string; population: number }>;
}

interface CentroidsFile {
  municipios: CentroidRecord[];
}

// ── Static competitor locations (used when Overpass API is unavailable) ──────
const STATIC_COMPETITORS = [
  { name: 'Super del Barrio Zona 12',     chain: 'Super del Barrio', lat: 14.5801, lng: -90.5300 },
  { name: 'Super del Barrio Mixco',       chain: 'Super del Barrio', lat: 14.6330, lng: -90.6100 },
  { name: 'Super del Barrio Villa Nueva', chain: 'Super del Barrio', lat: 14.5240, lng: -90.5900 },
  { name: 'La Bodegona Zona 11',          chain: 'La Bodegona',      lat: 14.6100, lng: -90.5400 },
  { name: 'La Bodegona Antigua',          chain: 'La Bodegona',      lat: 14.5560, lng: -90.7380 },
  { name: 'La Torre Zona 9',              chain: 'La Torre',         lat: 14.6050, lng: -90.5130 },
  { name: 'La Torre Xela',               chain: 'La Torre',         lat: 14.8320, lng: -91.5150 },
  { name: 'La Torre Escuintla',           chain: 'La Torre',         lat: 14.3000, lng: -90.7900 },
  { name: 'Suma Xela',                   chain: 'Suma',             lat: 14.8390, lng: -91.5100 },
  { name: 'Suma Huehuetenango',           chain: 'Suma',             lat: 15.3200, lng: -91.4780 },
  { name: 'Suma Cobán',                  chain: 'Suma',             lat: 15.4700, lng: -90.3780 },
  { name: 'Suma Express Zona 1',          chain: 'Suma Express',     lat: 14.6410, lng: -90.5110 },
  { name: 'Maxi Bodega Zona 7',           chain: 'Maxi Bodega',      lat: 14.6250, lng: -90.5550 },
  { name: 'Econosuper Chimaltenango',     chain: 'Econosuper',       lat: 14.6620, lng: -90.8200 },
  { name: 'Econosuper Jalapa',            chain: 'Econosuper',       lat: 14.6340, lng: -89.9870 },
  { name: 'Paiz Zona 10',                chain: 'Paiz',             lat: 14.5990, lng: -90.5160 },
  { name: 'Paiz Miraflores',             chain: 'Paiz',             lat: 14.5990, lng: -90.5450 },
  { name: 'Walmart Aguilar Batres',       chain: 'Walmart',          lat: 14.5930, lng: -90.5430 },
  { name: 'Walmart Pradera Xela',         chain: 'Walmart',          lat: 14.8410, lng: -91.5100 },
];

// ── Template stores (from stores_template.csv — replace with real data) ───────
const TEMPLATE_STORES = [
  { name: 'Despensa Familiar Zona 1',   format: 'Despensa Familiar', lat: 14.6408, lng: -90.5133, status: 'open', department: 'Guatemala',       municipio: 'Guatemala' },
  { name: 'Despensa Familiar Mixco',    format: 'Despensa Familiar', lat: 14.6350, lng: -90.5950, status: 'open', department: 'Guatemala',       municipio: 'Mixco' },
  { name: 'Maxi Despensa Villa Nueva',  format: 'Maxi Despensa',     lat: 14.5286, lng: -90.5897, status: 'open', department: 'Guatemala',       municipio: 'Villa Nueva' },
  { name: 'Despensa Familiar Xela',     format: 'Despensa Familiar', lat: 14.8347, lng: -91.5172, status: 'open', department: 'Quetzaltenango', municipio: 'Quetzaltenango' },
];

// ── Municipios ────────────────────────────────────────────────────────────────
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

  const centroids: CentroidRecord[] = (JSON.parse(fs.readFileSync(centroidsPath, 'utf8')) as CentroidsFile).municipios;
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

// ── Competitors ───────────────────────────────────────────────────────────────
async function seedCompetitors(): Promise<void> {
  const { rows } = await pool.query('SELECT COUNT(*) AS count FROM competitors');
  if (parseInt(rows[0].count) > 0) {
    console.log(`[autoSeed] ${rows[0].count} competitors already present — skipping`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of STATIC_COMPETITORS) {
      await client.query(
        `INSERT INTO competitors (name, chain, lat, lng, source, verified)
         VALUES ($1, $2, $3, $4, 'manual', false)`,
        [c.name, c.chain, c.lat, c.lng]
      );
    }
    await client.query('COMMIT');
    console.log(`[autoSeed] Seeded ${STATIC_COMPETITORS.length} competitors`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Stores ────────────────────────────────────────────────────────────────────
async function seedStores(): Promise<void> {
  const { rows } = await pool.query('SELECT COUNT(*) AS count FROM stores');
  if (parseInt(rows[0].count) > 0) {
    console.log(`[autoSeed] ${rows[0].count} stores already present — skipping`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of TEMPLATE_STORES) {
      await client.query(
        `INSERT INTO stores (name, format, lat, lng, status, department, municipio, chain)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Walmart Guatemala')`,
        [s.name, s.format, s.lat, s.lng, s.status, s.department, s.municipio]
      );
    }
    await client.query('COMMIT');
    console.log(`[autoSeed] Seeded ${TEMPLATE_STORES.length} template stores`);
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
  await seedCompetitors();
  await seedStores();
}
