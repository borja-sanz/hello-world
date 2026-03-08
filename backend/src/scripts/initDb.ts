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

  // Column migrations — each wrapped individually so one failure doesn't block others
  const migrations: { name: string; sql: string }[] = [
    {
      name: 'poi_cache.fetched_at',
      sql:  `ALTER TABLE poi_cache ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ DEFAULT NOW()`,
    },
    {
      name: 'municipio_isochrones.fetched_at',
      sql:  `ALTER TABLE municipio_isochrones ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ DEFAULT NOW()`,
    },
  ];

  for (const { name, sql } of migrations) {
    try {
      await pool.query(sql);
      console.log(`[initDb] migration OK: ${name}`);
    } catch (err: any) {
      console.warn(`[initDb] migration skipped (${name}):`, err.message);
    }
  }
  console.log('[initDb] Schema ready');
}
