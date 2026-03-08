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
