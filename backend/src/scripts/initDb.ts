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
    return;
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');
  await pool.query(sql);
  console.log('[initDb] Schema ready');
}
