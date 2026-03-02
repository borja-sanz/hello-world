/**
 * autoSeed — seeds municipios data if the table is empty.
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

export async function autoSeedIfEmpty(): Promise<void> {
  const { rows } = await pool.query('SELECT COUNT(*) AS count FROM municipios');
  if (parseInt(rows[0].count) > 0) {
    console.log(`[autoSeed] ${rows[0].count} municipios already present — skipping seed`);
    return;
  }

  const base = path.resolve(__dirname, '../../../data/seeds');
  const centroidsPath = path.join(base, 'municipios_centroids.json');
  const populationPath = path.join(base, 'population_ine2018.json');

  if (!fs.existsSync(centroidsPath) || !fs.existsSync(populationPath)) {
    console.warn('[autoSeed] Seed JSON files not found — skipping auto-seed');
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
