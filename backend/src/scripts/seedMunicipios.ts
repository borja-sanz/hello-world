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
import * as https from 'https';
import * as path from 'path';
import { execSync } from 'child_process';
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

    // Try loading GADM polygon geometries
    const gadmDir  = path.resolve(__dirname, '../../../data/gadm');
    const gadmPath = path.join(gadmDir, 'GTM_adm2.geojson');
    const rawPath  = path.join(gadmDir, 'gadm41_GTM_2.json');   // alternate name

    if (fs.existsSync(gadmPath)) {
      // Preferred path: file already present with the expected name
      await loadGadmGeometries(client, gadmPath);
    } else if (fs.existsSync(rawPath)) {
      // Alternate: file was placed manually with the GADM 4.1 filename
      fs.renameSync(rawPath, gadmPath);
      await loadGadmGeometries(client, gadmPath);
    } else {
      // Auto-download from UCDAVIS public server
      console.log('GADM file not found — attempting automatic download...');
      try {
        await downloadGadmFile(gadmDir, gadmPath);
        await loadGadmGeometries(client, gadmPath);
      } catch (err: any) {
        console.warn(`GADM download failed: ${err.message}`);
        console.log('Continuing with centroid-only geometries (re-run seed after placing GTM_adm2.geojson in data/gadm/)');
      }
    }

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function downloadGadmFile(gadmDir: string, finalPath: string): Promise<void> {
  const GADM_URL     = 'https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_GTM_2.json.zip';
  const INSIDE_ZIP   = 'gadm41_GTM_2.json';
  const zipPath      = path.join(gadmDir, 'gadm41_GTM_2.json.zip');

  fs.mkdirSync(gadmDir, { recursive: true });

  // Download zip with redirect support and 60-second socket timeout
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);

    const doRequest = (url: string, redirects = 0) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return; }

      const req = https.get(url, { timeout: 60_000 }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location;
          if (!loc) { reject(new Error(`Redirect with no Location header (HTTP ${res.statusCode})`)); return; }
          res.resume();
          doRequest(loc, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', (e) => { fs.unlink(zipPath, () => {}); reject(e); });
      });

      req.on('error',   (e) => { fs.unlink(zipPath, () => {}); reject(e); });
      req.on('timeout', ()  => { req.destroy(); reject(new Error('Download timed out after 60 seconds')); });
    };

    doRequest(GADM_URL);
  });

  console.log('Download complete. Extracting...');

  // Extract using system unzip (available on Ubuntu/Debian containers)
  execSync(`unzip -o "${zipPath}" "${INSIDE_ZIP}" -d "${gadmDir}"`, { stdio: 'inherit' });

  // Rename to the expected filename and remove zip
  fs.renameSync(path.join(gadmDir, INSIDE_ZIP), finalPath);
  fs.unlinkSync(zipPath);

  console.log(`GADM file saved to ${finalPath}`);
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
