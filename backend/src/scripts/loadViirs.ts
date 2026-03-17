/**
 * loadViirs.ts
 *
 * Reads a VIIRS nighttime lights GeoTIFF (VNP46A4 or NOAA monthly export)
 * and updates radiance_ntl + estimated_pop for every row in ntl_settlements
 * by sampling the pixel at each settlement's lat/lng.
 *
 * Usage:
 *   ts-node src/scripts/loadViirs.ts <path-to-file.tif>
 *
 * After running, ntl_source changes from 'osm_places' → 'viirs_2023'
 * for every settlement whose coordinates fall within the raster extent.
 */

import * as path from 'path';
import * as fs   from 'fs';
import { fromFile } from 'geotiff';
import { pool }  from '../db';

const NTL_CALIB   = 180 * 4.2; // 756 — same constant used in autoSeed & scoringEngine
const NODATA_LOW  = -9999;       // common VIIRS nodata sentinel
const NODATA_HIGH = 200000;      // sanity cap (real radiance never this high)

async function loadViirs(tifPath: string): Promise<void> {
  console.log(`[loadViirs] Reading GeoTIFF: ${tifPath}`);

  const tiff  = await fromFile(tifPath);
  const image = await tiff.getImage();

  const bbox   = image.getBoundingBox(); // [west, south, east, north]
  const width  = image.getWidth();
  const height = image.getHeight();
  const [west, south, east, north] = bbox;
  const pixelW = (east  - west)  / width;
  const pixelH = (north - south) / height;

  console.log(`[loadViirs] Extent : W=${west} S=${south} E=${east} N=${north}`);
  console.log(`[loadViirs] Size   : ${width} x ${height} pixels`);

  // Read band 0 fully into memory — Guatemala at 500 m is ~250 MB max, usually <5 MB
  const rasters = await image.readRasters();
  const band    = rasters[0] as Float32Array | Int16Array | Uint16Array;

  const { rows: settlements } = await pool.query<{ id: number; lat: string; lng: string }>(
    'SELECT id, lat, lng FROM ntl_settlements ORDER BY id'
  );
  console.log(`[loadViirs] Sampling ${settlements.length} settlements…`);

  let updated = 0;
  let skipped = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const s of settlements) {
      const lat = parseFloat(s.lat);
      const lng = parseFloat(s.lng);

      // Skip points outside raster extent
      if (lng < west || lng > east || lat < south || lat > north) {
        skipped++;
        continue;
      }

      const col = Math.floor((lng  - west)  / pixelW);
      const row = Math.floor((north - lat)  / pixelH);
      const c   = Math.max(0, Math.min(width  - 1, col));
      const r   = Math.max(0, Math.min(height - 1, row));

      const raw = band[r * width + c];

      // Skip nodata / fill values
      if (raw == null || raw <= NODATA_LOW || raw >= NODATA_HIGH) {
        skipped++;
        continue;
      }

      const radiance     = Math.round(raw  * 1000) / 1000;
      const estimatedPop = Math.round(radiance * NTL_CALIB);

      await client.query(
        `UPDATE ntl_settlements
            SET radiance_ntl  = $1,
                estimated_pop = $2,
                ntl_source    = 'viirs_2023'
          WHERE id = $3`,
        [radiance, estimatedPop, s.id]
      );
      updated++;
    }

    await client.query('COMMIT');
    console.log(`[loadViirs] ✓ Updated: ${updated}  |  Skipped (out of bounds / nodata): ${skipped}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await pool.end();
}

// ── Entry point ────────────────────────────────────────────────────────────────
const tifArg = process.argv[2];
if (!tifArg) {
  console.error('Usage: ts-node src/scripts/loadViirs.ts <path-to-file.tif>');
  process.exit(1);
}

const resolved = path.resolve(tifArg);
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`);
  process.exit(1);
}

loadViirs(resolved).catch(err => {
  console.error('[loadViirs] Fatal error:', err);
  process.exit(1);
});
