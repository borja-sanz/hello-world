import { Pool, types } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// By default node-postgres returns NUMERIC/DECIMAL columns as strings to avoid
// precision loss. For this app all score values fit safely in JS floats, so we
// parse them as numbers — otherwise .toFixed() crashes in the frontend.
// OID 1700 = NUMERIC / DECIMAL
types.setTypeParser(1700, (val: string) => parseFloat(val));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function testConnection(): Promise<void> {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT version()');
    console.log('Connected to PostgreSQL:', result.rows[0].version);
    client.release();
  } catch (err) {
    console.error('Failed to connect to database:', err);
    process.exit(1);
  }
}

export async function query<T = any>(
  text: string,
  params?: any[]
): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}
