/**
 * Seed municipios from centroid data + INE 2018 population
 *
 * Loads coordinates from municipios_centroids.json, joins population from
 * population_ine2018.json, and inserts into the municipios table.
 *
 * If data/gadm/GTM_adm2.geojson is present, also loads full polygon geometries.
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface CentroidRecord {
  code: string;
  name: string;
  department: string;
  lat: number;
  lng: number;
  is_urban: boolean;
}

interface PopulationRecord {
  code: string;
  name: string;
  department: string;
  population: number;
}

async function seedMunicipios(): Promise<void> {
  const client = await pool.connect();

  try {
    console.log('Loading centroid data...');
    const centroidsPath = path.resolve(__dirname, '../../../data/seeds/municipios_centroids.json');
    const populationPath = path.resolve(__dirname, '../../../data/seeds/population_ine2018.json');

    if (!fs.existsSync(centroidsPath)) {
      throw new Error(`Centroid file not found: ${centroidsPath}`);
    }
    if (!fs.existsSync(populationPath)) {
      throw new Error(`Population file not found: ${populationPath}`);
    }

    const centroids: CentroidRecord[] = JSON.parse(fs.readFileSync(centroidsPath, 'utf8')).municipios;
    const populationData: PopulationRecord[] = JSON.parse(fs.readFileSync(populationPath, 'utf8')).municipios;

    // Build a lookup by code for fast joining
    const popByCode = new Map<string, number>();
    for (const p of populationData) {
      popByCode.set(p.code, p.population);
    }

    console.log(`Loaded ${centroids.length} centroids, ${populationData.length} population records`);

    await client.query('BEGIN');

    let inserted = 0;
    let updated = 0;

    for (const m of centroids) {
      const population = popByCode.get(m.code) ?? null;

      const result = await client.query(
        `INSERT INTO municipios (name, department, code, population, population_year, lat, lng, centroid, is_urban)
         VALUES ($1, $2, $3, $4, 2018, $5, $6,
                 ST_SetSRID(ST_MakePoint($6, $5), 4326),
                 $7)
         ON CONFLICT (code) DO UPDATE SET
           population      = EXCLUDED.population,
           population_year = EXCLUDED.population_year,
           centroid        = EXCLUDED.centroid,
           is_urban        = EXCLUDED.is_urban
         RETURNING (xmax = 0) AS is_insert`,
        [m.name, m.department, m.code, population, m.lat, m.lng, m.is_urban]
      );

      if (result.rows[0]?.is_insert) {
        inserted++;
      } else {
        updated++;
      }
    }

    await client.query('COMMIT');
    console.log(`Done: ${inserted} inserted, ${updated} updated`);

    // Try loading GADM polygon geometries if file exists
    const gadmPath = path.resolve(__dirname, '../../../data/gadm/GTM_adm2.geojson');
    if (fs.existsSync(gadmPath)) {
      await loadGadmGeometries(client, gadmPath);
    } else {
      console.log('GADM file not found — using centroid-only geometries');
      console.log('To load full polygons, download GTM_adm2.geojson to data/gadm/');
    }

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function loadGadmGeometries(client: any, gadmPath: string): Promise<void> {
  console.log('Loading GADM polygon geometries...');

  const geojson = JSON.parse(fs.readFileSync(gadmPath, 'utf8'));
  const features = geojson.features as any[];

  let matched = 0;
  let unmatched = 0;

  await client.query('BEGIN');

  for (const feature of features) {
    const props = feature.properties;
    // GADM Level 2 field names vary: NAME_2 is the municipio name
    const municipioName: string = props.NAME_2 || props.name || '';
    const departmentName: string = props.NAME_1 || props.department || '';
    const geomWkt = geometryToWKT(feature.geometry);

    if (!geomWkt) {
      unmatched++;
      continue;
    }

    // Try to match by fuzzy name (normalize accents for comparison)
    const result = await client.query(
      `UPDATE municipios
       SET geometry = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)),
           centroid = ST_Centroid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))
       WHERE department ILIKE $2
         AND (name ILIKE $3 OR unaccent(name) ILIKE unaccent($3))
       RETURNING id`,
      [JSON.stringify(feature.geometry), `%${departmentName}%`, `%${municipioName}%`]
    );

    if (result.rowCount && result.rowCount > 0) {
      matched++;
    } else {
      unmatched++;
      console.log(`  No match: ${municipioName} / ${departmentName}`);
    }
  }

  await client.query('COMMIT');
  console.log(`GADM geometries: ${matched} matched, ${unmatched} unmatched`);
}

function geometryToWKT(_geometry: any): string | null {
  // We pass the raw GeoJSON geometry to PostGIS via ST_GeomFromGeoJSON
  // This function just validates it's not null
  return _geometry ? 'ok' : null;
}

// Update schema to add lat/lng columns if not present
async function ensureColumns(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE municipios
        ADD COLUMN IF NOT EXISTS lat DECIMAL(10, 7),
        ADD COLUMN IF NOT EXISTS lng DECIMAL(10, 7)
    `);
  } finally {
    client.release();
  }
}

(async () => {
  try {
    await ensureColumns();
    await seedMunicipios();
    console.log('Municipio seed complete');
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
})();
