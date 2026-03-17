/**
 * buildViirsClusters.ts
 *
 * Generates ntl_settlements directly from a VIIRS nighttime lights GeoTIFF
 * by finding bright pixel clusters via connected-component analysis (iterative
 * BFS, 8-connectivity). No OSM dependency.
 *
 * This replaces the OSM-dependent seeding approach. Expected output:
 * 500–2000+ settlements instead of ~98, including unnamed rural clusters
 * that OSM does not capture.
 *
 * Algorithm:
 *  1. Read GeoTIFF band fully into memory
 *  2. Mark every pixel above MIN_RADIANCE as "lit"
 *  3. Iterative BFS flood-fill to group contiguous lit pixels into clusters
 *  4. Compute radiance-weighted centroid and mean radiance per cluster
 *  5. Drop clusters below MIN_PIXELS (single-pixel noise)
 *  6. Delete existing non-admin_zones settlements (Guatemala City zones kept)
 *  7. Insert clusters, assigning each to nearest municipio centroid via PostGIS
 *  8. Rename: "[Municipio]" (1 cluster) or "[Municipio] - núcleo N" (N ≥ 2)
 *
 * Usage (standalone CLI):
 *   ts-node src/scripts/buildViirsClusters.ts <path-to-file.tif>
 */

import * as path from 'path';
import * as fs   from 'fs';
import { fromFile } from 'geotiff';
import { pool }  from '../db';

// ── Tuning parameters ─────────────────────────────────────────────────────────

/** Pixels below this radiance (nW/cm²/sr) are treated as unlit/background. */
const MIN_RADIANCE = 0.5;

/** Clusters with fewer pixels than this are dropped as single-pixel noise. */
const MIN_PIXELS   = 2;

/**
 * Population calibration constant.
 * 180 households/nW × 4.2 persons/household (INE 2018).
 * Must match NTL_CALIB used elsewhere in the codebase (admin.ts, autoSeed.ts).
 */
const NTL_CALIB = 756;

/** VIIRS nodata sentinels — skip these pixel values. */
const NODATA_LOW  = -9999;
const NODATA_HIGH = 200_000;

/**
 * Approximate km per degree at Guatemala's mean latitude (~15°N).
 * Used only for area_km2 estimation; not used for coordinate conversion.
 */
const KM_PER_DEG_LAT = 111.32;
const KM_PER_DEG_LNG = 111.32 * Math.cos(15 * Math.PI / 180); // ≈ 107.5

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BuildResult {
  clustersFound : number;
  inserted      : number;
  skippedNoise  : number;
  tifPath       : string;
  extent        : { west: number; south: number; east: number; north: number };
  size          : { width: number; height: number };
  pixelAreaKm2  : number;
}

// ── Core exported function ────────────────────────────────────────────────────

export async function buildViirsClusters(tifPath: string): Promise<BuildResult> {
  console.log(`[buildViirsClusters] Reading GeoTIFF: ${tifPath}`);

  const tiff  = await fromFile(tifPath);
  const image = await tiff.getImage();

  const bbox   = image.getBoundingBox(); // [west, south, east, north]
  const [west, south, east, north] = bbox;
  const width  = image.getWidth();
  const height = image.getHeight();
  const pixelW = (east  - west)  / width;
  const pixelH = (north - south) / height;
  const pixelAreaKm2 = pixelW * KM_PER_DEG_LNG * pixelH * KM_PER_DEG_LAT;

  console.log(`[buildViirsClusters] Extent : W=${west} S=${south} E=${east} N=${north}`);
  console.log(`[buildViirsClusters] Size   : ${width} × ${height} px | pixel ≈ ${pixelAreaKm2.toFixed(3)} km²`);

  const rasters = await image.readRasters();
  const band    = rasters[0] as Float32Array | Int16Array | Uint16Array;

  // ── Connected-component BFS (iterative, 8-connectivity) ───────────────────
  //
  //  labels[i] ===  0  → not yet visited
  //  labels[i] === -1  → visited, unlit or nodata
  //  labels[i] >   0   → visited, belongs to that cluster id (1-based)

  const labels = new Int32Array(width * height); // zero-initialised

  interface ClusterAccum {
    pixels : number; // pixel count
    sumRad : number; // Σ radiance values
    wLat   : number; // Σ (lat_centre × radiance)  — for weighted centroid
    wLng   : number; // Σ (lng_centre × radiance)
  }

  const clusters: ClusterAccum[] = [];
  const stack: number[] = [];

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const idx = r * width + c;

      // Skip already-visited pixels (lit or unlit)
      if (labels[idx] !== 0) continue;

      const raw = band[idx] as number;

      // Mark unlit / nodata pixels and move on.
      // isFinite also rejects IEEE 754 NaN and Infinity — NaN comparisons
      // always return false so NaN would otherwise pass the < MIN_RADIANCE check.
      if (!isFinite(raw) || raw <= NODATA_LOW || raw >= NODATA_HIGH || raw < MIN_RADIANCE) {
        labels[idx] = -1;
        continue;
      }

      // --- New cluster seed ---
      const accum: ClusterAccum = { pixels: 0, sumRad: 0, wLat: 0, wLng: 0 };
      clusters.push(accum);
      const clusterId = clusters.length; // 1-based

      labels[idx] = clusterId;
      stack.length = 0;
      stack.push(idx);

      // BFS expansion
      while (stack.length > 0) {
        const cur = stack.pop()!;
        const cr  = Math.floor(cur / width);
        const cc  = cur % width;
        const val = band[cur] as number;

        // Pixel centre coordinates
        const pixLng = west  + (cc + 0.5) * pixelW;
        const pixLat = north - (cr + 0.5) * pixelH;

        accum.pixels++;
        accum.sumRad += val;
        accum.wLat   += pixLat * val;
        accum.wLng   += pixLng * val;

        // Check all 8 neighbours
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = cr + dr;
            const nc = cc + dc;
            if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;

            const nIdx = nr * width + nc;
            if (labels[nIdx] !== 0) continue; // already visited

            const nVal = band[nIdx] as number;
            if (!isFinite(nVal) || nVal <= NODATA_LOW || nVal >= NODATA_HIGH || nVal < MIN_RADIANCE) {
              labels[nIdx] = -1;
              continue;
            }

            labels[nIdx] = clusterId;
            stack.push(nIdx);
          }
        }
      }
    }
  }

  console.log(`[buildViirsClusters] ${clusters.length} raw clusters (before noise filter)`);

  // ── Build settlement records ───────────────────────────────────────────────

  interface Settlement {
    lat      : number;
    lng      : number;
    radiance : number; // mean radiance (nW/cm²/sr)
    areaKm2  : number; // estimated physical size
    estPop   : number; // estimated population
  }

  const settlements: Settlement[] = [];
  let skippedNoise = 0;

  for (const cl of clusters) {
    if (cl.pixels < MIN_PIXELS) {
      skippedNoise++;
      continue;
    }

    const lat     = cl.wLat / cl.sumRad;              // radiance-weighted centroid
    const lng     = cl.wLng / cl.sumRad;
    const meanRad = Math.round((cl.sumRad / cl.pixels) * 1000) / 1000;
    const areaKm2 = Math.round(cl.pixels * pixelAreaKm2 * 100) / 100;
    const estPop  = Math.round(meanRad * NTL_CALIB);

    settlements.push({ lat, lng, radiance: meanRad, areaKm2, estPop });
  }

  console.log(`[buildViirsClusters] ${settlements.length} settlements after filtering (${skippedNoise} noise clusters dropped)`);

  // ── Write to database ──────────────────────────────────────────────────────

  const client = await pool.connect();
  let inserted = 0;

  try {
    await client.query('BEGIN');

    // Pre-fetch all municipio centroids into JS memory (254 rows).
    // We assign each cluster to its nearest municipio here in JS instead of
    // running a PostGIS subquery per INSERT — turns O(N) round-trips into one.
    const { rows: munRows } = await client.query<{
      id: number; lat: string; lng: string;
    }>('SELECT id, lat, lng FROM municipios WHERE lat IS NOT NULL AND lng IS NOT NULL');

    function nearestMunicipioId(clat: number, clng: number): number {
      let bestId   = munRows[0].id;
      let bestDist = Infinity;
      for (const m of munRows) {
        const dlat = clat - parseFloat(m.lat);
        const dlng = clng - parseFloat(m.lng);
        const d    = dlat * dlat + dlng * dlng; // squared — order is all we need
        if (d < bestDist) { bestDist = d; bestId = m.id; }
      }
      return bestId;
    }

    // Remove all non-admin_zones settlements.
    // Guatemala City admin zones (ntl_source='admin_zones') are preserved.
    await client.query(`DELETE FROM ntl_settlements WHERE ntl_source != 'admin_zones'`);

    // Single batched INSERT using unnest() — one round-trip regardless of N.
    const munIds:  number[] = [];
    const lats:    number[] = [];
    const lngs:    number[] = [];
    const rads:    number[] = [];
    const pops:    number[] = [];
    const areas:   number[] = [];

    for (const s of settlements) {
      munIds.push(nearestMunicipioId(s.lat, s.lng));
      lats.push(s.lat);
      lngs.push(s.lng);
      rads.push(s.radiance);
      pops.push(s.estPop);
      areas.push(s.areaKm2);
    }

    await client.query(
      `INSERT INTO ntl_settlements
         (name, municipio_id, lat, lng, radiance_ntl, estimated_pop, area_km2, ntl_source)
       SELECT
         'temp',
         unnest($1::int[]),
         unnest($2::float[]),
         unnest($3::float[]),
         unnest($4::float[]),
         unnest($5::int[]),
         unnest($6::float[]),
         'viirs_raster_2023'`,
      [munIds, lats, lngs, rads, pops, areas],
    );
    inserted = settlements.length;

    // Rename settlements descriptively:
    //   Municipio with 1 cluster  → "[Municipio name]"
    //   Municipio with N clusters → "[Municipio name] - núcleo 1" … "núcleo N"
    //                               where 1 = brightest (highest mean radiance)
    await client.query(`
      UPDATE ntl_settlements s
      SET name = sub.computed_name
      FROM (
        SELECT
          ns.id,
          m.name ||
            CASE WHEN cnt.total > 1
              THEN ' - núcleo ' || ROW_NUMBER() OVER (
                     PARTITION BY ns.municipio_id
                     ORDER BY ns.radiance_ntl DESC
                   )::text
              ELSE ''
            END AS computed_name
        FROM ntl_settlements ns
        JOIN municipios m ON m.id = ns.municipio_id
        JOIN (
          SELECT municipio_id, COUNT(*) AS total
          FROM ntl_settlements
          WHERE ntl_source = 'viirs_raster_2023'
          GROUP BY municipio_id
        ) cnt ON cnt.municipio_id = ns.municipio_id
        WHERE ns.ntl_source = 'viirs_raster_2023'
      ) sub
      WHERE s.id = sub.id
    `);

    await client.query('COMMIT');
    console.log(`[buildViirsClusters] ✓ Inserted and named ${inserted} settlements`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    clustersFound: clusters.length,
    inserted,
    skippedNoise,
    tifPath,
    extent      : { west, south, east, north },
    size        : { width, height },
    pixelAreaKm2,
  };
}

// ── Standalone CLI entry point ────────────────────────────────────────────────

if (require.main === module) {
  const tifArg = process.argv[2];
  if (!tifArg) {
    console.error('Usage: ts-node src/scripts/buildViirsClusters.ts <path-to-file.tif>');
    process.exit(1);
  }
  const resolved = path.resolve(tifArg);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }
  buildViirsClusters(resolved)
    .then(r => {
      console.log('[buildViirsClusters] Done:', JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('[buildViirsClusters] Fatal error:', err);
      process.exit(1);
    });
}
