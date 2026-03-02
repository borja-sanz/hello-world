/**
 * PostGIS Query Test Suite
 *
 * Verifies all spatial queries used by the scoring engine work correctly.
 * Run after seeding: npm run test:queries
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface TestResult {
  name: string;
  passed: boolean;
  result?: any;
  error?: string;
  duration: number;
}

async function runTest(
  name: string,
  fn: (client: any) => Promise<any>
): Promise<TestResult> {
  const client = await pool.connect();
  const start = Date.now();
  try {
    const result = await fn(client);
    return { name, passed: true, result, duration: Date.now() - start };
  } catch (err: any) {
    return { name, passed: false, error: err.message, duration: Date.now() - start };
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  console.log('GeoRetail Guatemala — PostGIS Query Tests\n');

  const results: TestResult[] = [];

  // 1. Basic PostGIS availability
  results.push(await runTest('PostGIS extension available', async (c) => {
    const r = await c.query('SELECT PostGIS_Version()');
    return r.rows[0].postgis_version;
  }));

  // 2. Municipios table populated
  results.push(await runTest('Municipios table has data', async (c) => {
    const r = await c.query('SELECT COUNT(*) FROM municipios');
    const count = parseInt(r.rows[0].count);
    if (count === 0) throw new Error('No municipios found — run seed:municipios first');
    return `${count} municipios`;
  }));

  // 3. Centroid geometry exists
  results.push(await runTest('Municipio centroids have geometry', async (c) => {
    const r = await c.query(`
      SELECT COUNT(*) FROM municipios WHERE centroid IS NOT NULL
    `);
    return `${r.rows[0].count} with centroid`;
  }));

  // 4. ST_DWithin — find municipios within 50km of Guatemala City
  results.push(await runTest('ST_DWithin: municipios within 50km of capital', async (c) => {
    const r = await c.query(`
      SELECT name, department,
             ROUND(ST_Distance(centroid, ST_SetSRID(ST_MakePoint(-90.5069, 14.6349), 4326)::geography) / 1000) AS dist_km
      FROM municipios
      WHERE ST_DWithin(
        centroid::geography,
        ST_SetSRID(ST_MakePoint(-90.5069, 14.6349), 4326)::geography,
        50000
      )
      ORDER BY dist_km
      LIMIT 5
    `);
    return r.rows.map((row: any) => `${row.name} (${row.dist_km}km)`).join(', ');
  }));

  // 5. Population ranking query
  results.push(await runTest('Population ranking by department', async (c) => {
    const r = await c.query(`
      SELECT department,
             SUM(population) AS total_pop,
             COUNT(*) AS municipio_count
      FROM municipios
      WHERE population IS NOT NULL
      GROUP BY department
      ORDER BY total_pop DESC
      LIMIT 5
    `);
    return r.rows.map((row: any) =>
      `${row.department}: ${Number(row.total_pop).toLocaleString()}`
    ).join(' | ');
  }));

  // 6. Competitors table
  results.push(await runTest('Competitors table accessible', async (c) => {
    const r = await c.query('SELECT COUNT(*), COUNT(DISTINCT chain) AS chains FROM competitors');
    return `${r.rows[0].count} records, ${r.rows[0].chains} chains`;
  }));

  // 7. Stores within radius of a point (trade area simulation)
  results.push(await runTest('Trade area: stores within 10km of a point', async (c) => {
    const r = await c.query(`
      SELECT name, chain,
             ROUND(ST_Distance(geometry, ST_SetSRID(ST_MakePoint(-90.5069, 14.6349), 4326)::geography) / 1000) AS dist_km
      FROM competitors
      WHERE ST_DWithin(
        geometry::geography,
        ST_SetSRID(ST_MakePoint(-90.5069, 14.6349), 4326)::geography,
        10000
      )
      ORDER BY dist_km
      LIMIT 10
    `);
    if (r.rows.length === 0) return 'No competitors found (seed competitors first)';
    return r.rows.map((row: any) => `${row.name} (${row.dist_km}km)`).join(', ');
  }));

  // 8. Nearest store query
  results.push(await runTest('Nearest store to a point (KNN)', async (c) => {
    const r = await c.query(`
      SELECT name, chain,
             ROUND(ST_Distance(geometry, ST_SetSRID(ST_MakePoint(-90.5069, 14.6349), 4326)::geography) / 1000) AS dist_km
      FROM competitors
      WHERE geometry IS NOT NULL
      ORDER BY geometry <-> ST_SetSRID(ST_MakePoint(-90.5069, 14.6349), 4326)
      LIMIT 1
    `);
    if (r.rows.length === 0) return 'No competitors found';
    const row = r.rows[0];
    return `${row.name} at ${row.dist_km}km`;
  }));

  // 9. Calibration config exists
  results.push(await runTest('Calibration config initialized', async (c) => {
    const r = await c.query('SELECT * FROM calibration_config WHERE is_active = true LIMIT 1');
    if (r.rows.length === 0) throw new Error('No active calibration config found');
    const cfg = r.rows[0];
    return `weights: pop=${cfg.weight_population} mob=${cfg.weight_mobility} com=${cfg.weight_commercial}`;
  }));

  // 10. Latest opportunity scores view
  results.push(await runTest('latest_opportunity_scores view accessible', async (c) => {
    const r = await c.query('SELECT COUNT(*) FROM latest_opportunity_scores');
    return `${r.rows[0].count} scored municipios`;
  }));

  // --- Print results ---
  console.log('\n' + '─'.repeat(70));
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    const label = r.passed ? r.result : `ERROR: ${r.error}`;
    console.log(`${icon} [${r.duration}ms] ${r.name}`);
    if (label) console.log(`    → ${label}`);
  }

  console.log('─'.repeat(70));
  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
