/**
 * initDb — runs the schema SQL against the connected database.
 * All statements use IF NOT EXISTS / CREATE OR REPLACE so this is safe
 * to call on every startup.
 */
import { pool } from '../db';
import fs from 'fs';
import path from 'path';

export async function initDb(): Promise<void> {
  // Resolve relative to this file: backend/dist/scripts/ → repo root → docker/postgres/init.sql
  const sqlPath = path.resolve(__dirname, '../../../docker/postgres/init.sql');

  if (!fs.existsSync(sqlPath)) {
    console.warn('[initDb] init.sql not found at', sqlPath, '— skipping schema init');
  } else {
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await pool.query(sql);
  }

  // Ensure municipio_isochrones table exists before migrating it
  await pool.query(`
    CREATE TABLE IF NOT EXISTS municipio_isochrones (
      id               SERIAL PRIMARY KEY,
      municipio_id     INTEGER NOT NULL REFERENCES municipios(id) ON DELETE CASCADE,
      profile          VARCHAR(50) NOT NULL DEFAULT 'mapbox/driving',
      contour_minutes  INTEGER NOT NULL CHECK (contour_minutes IN (15, 30, 45)),
      geometry         GEOMETRY(MultiPolygon, 4326) NOT NULL,
      mapbox_model     VARCHAR(50),
      fetched_at       TIMESTAMPTZ DEFAULT NOW(),
      bbox_west        DECIMAL(10, 7),
      bbox_east        DECIMAL(10, 7),
      bbox_south       DECIMAL(10, 7),
      bbox_north       DECIMAL(10, 7),
      UNIQUE (municipio_id, profile, contour_minutes)
    )
  `);

  // Column migrations: always run regardless of whether init.sql was found
  const migrations = [
    `ALTER TABLE poi_cache ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE municipio_isochrones ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ DEFAULT NOW()`,
  ];
  for (const migration of migrations) {
    await pool.query(migration);
  }
  console.log('[initDb] Schema ready');
}
