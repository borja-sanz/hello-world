/**
 * POI Cache Seed — Export & Import
 *
 * Solves ephemeral-environment problem: after a Google Places sync (which costs
 * money and takes minutes), we snapshot poi_cache to a JSON file inside the repo.
 * On next startup, if poi_cache is empty, we restore from that file automatically.
 *
 * Export: backend/data/poi_cache_seed.json
 * Triggered:  automatically after every successful Google Places refresh
 *             manually via POST /api/admin/save-poi-seed
 *
 * Import: runs during autoSeedIfEmpty() on startup
 *         skipped silently if seed file doesn't exist yet or table already has data
 */

import fs from 'fs';
import path from 'path';
import { pool } from '../db';

const SEED_FILE = path.resolve(__dirname, '../../data/poi_cache_seed.json');

interface SeedRow {
  name:         string | null;
  poi_type:     string;
  lat:          string;
  lng:          string;
  tags:         object | null;
  municipio_id: number | null;
  source:       string;
}

/** Write current Google Places poi_cache rows to the seed file. */
export async function exportPoiCacheSeed(): Promise<number> {
  const { rows } = await pool.query<SeedRow>(`
    SELECT name, poi_type,
           lat::text, lng::text,
           tags, municipio_id, source
    FROM poi_cache
    WHERE source = 'google_places'
    ORDER BY id
  `);

  if (rows.length === 0) return 0;

  fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
  fs.writeFileSync(SEED_FILE, JSON.stringify(rows, null, 2), 'utf8');
  console.log(`[poiSeed] Exported ${rows.length} Google Places POIs → ${SEED_FILE}`);
  return rows.length;
}

/**
 * Load seed file into poi_cache if the table has no Google Places rows.
 * Inserts in batches of 500 to avoid oversized queries.
 */
export async function importPoiCacheSeed(): Promise<number> {
  if (!fs.existsSync(SEED_FILE)) return 0;

  // Skip if there's already Google Places data (avoid double-loading)
  const { rows: check } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM poi_cache WHERE source = 'google_places'`
  );
  if (check[0].cnt > 0) {
    console.log(`[poiSeed] poi_cache already has ${check[0].cnt} Google Places rows — skipping seed import`);
    return 0;
  }

  let data: SeedRow[];
  try {
    data = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  } catch {
    console.warn('[poiSeed] Could not parse seed file — skipping');
    return 0;
  }

  if (!Array.isArray(data) || data.length === 0) return 0;

  console.log(`[poiSeed] Importing ${data.length} Google Places POIs from seed file…`);

  const BATCH = 500;
  let imported = 0;

  for (let i = 0; i < data.length; i += BATCH) {
    const batch = data.slice(i, i + BATCH);
    const values: unknown[] = [];
    const placeholders = batch.map((row, j) => {
      const base = j * 6;
      values.push(
        row.name,
        row.poi_type,
        parseFloat(row.lat),
        parseFloat(row.lng),
        row.tags ? JSON.stringify(row.tags) : null,
        row.municipio_id,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4},
               ST_SetSRID(ST_MakePoint($${base + 4}, $${base + 3}), 4326),
               $${base + 5}::jsonb, $${base + 6}, 'google_places')`;
    });

    await pool.query(
      `INSERT INTO poi_cache (name, poi_type, lat, lng, geometry, tags, municipio_id, source)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values
    );
    imported += batch.length;
  }

  console.log(`[poiSeed] Import complete: ${imported} rows loaded into poi_cache`);
  return imported;
}
