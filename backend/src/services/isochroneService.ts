/**
 * Isochrone Service
 *
 * Fetches drive-time isochrone polygons from the Mapbox Isochrone API for each
 * Guatemala municipio centroid and stores them in the `municipio_isochrones`
 * PostGIS table.
 *
 * One Mapbox request returns all three contours (15/30/45 min) for a single
 * lat/lng, costing 1 API call per municipio (not 3). At 334 municipios that is
 * 334 requests — well within the Mapbox free tier of 75,000 requests/month.
 *
 * Rate limit: free tier allows 300 requests/minute. This service uses a 250ms
 * inter-request delay (≈ 240 req/min, 80% of the limit) plus exponential-
 * backoff retry on HTTP 429.
 */

import axios from 'axios';
import { pool } from '../db';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAPBOX_ISOCHRONE_BASE = 'https://api.mapbox.com/isochrone/v1';
const PROFILE               = 'mapbox/driving';
const CONTOUR_MINUTES       = [15, 30, 45] as const;
type ContourMinute = typeof CONTOUR_MINUTES[number];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IsochroneResult {
  municipio_id:   number;
  municipio_code: string;
  success:        boolean;
  contours_saved: number;
  skipped:        boolean;   // true when already fresh (within maxAgeDays)
  error?:         string;
}

export interface IsochroneCoverage {
  total_municipios: number;
  covered:          number;
  full_coverage:    number;  // all 3 contours present
  last_fetched:     string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

/**
 * Fetches all three isochrone contours for one municipio centroid from Mapbox
 * and upserts the resulting polygons into `municipio_isochrones`.
 *
 * Returns { success: true, contours_saved: N } on success, or
 * { success: false, error: message } when the API call fails after retries.
 */
export async function fetchAndSaveIsochrone(
  municipioId:  number,
  lat:          number,
  lng:          number,
  mapboxToken:  string
): Promise<{ success: boolean; contours_saved: number; error?: string }> {
  const url = `${MAPBOX_ISOCHRONE_BASE}/${PROFILE}/${lng},${lat}`;

  // ── Fetch from Mapbox with exponential-backoff retry on 429 ──────────────
  let geoJson: any;
  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    try {
      const resp = await axios.get(url, {
        params: {
          contours_minutes: CONTOUR_MINUTES.join(','),
          polygons:         true,
          denoise:          1,
          generalize:       500,   // 500m tolerance — reduces vertices ~80%
          access_token:     mapboxToken,
        },
        timeout: 15_000,
      });
      geoJson = resp.data;
      break;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 429 && attempt < maxAttempts - 1) {
        const backoff = 2_000 * Math.pow(2, attempt); // 2s, 4s
        console.warn(`[isochrones] Rate limited for municipio ${municipioId}. Retrying in ${backoff}ms…`);
        await sleep(backoff);
        attempt++;
        continue;
      }
      const msg = err?.response?.data?.message ?? err.message;
      return { success: false, contours_saved: 0, error: `HTTP ${status}: ${msg}` };
    }
  }

  if (!geoJson?.features?.length) {
    return { success: false, contours_saved: 0, error: 'No features returned from Mapbox' };
  }

  // ── Upsert each contour polygon ───────────────────────────────────────────
  let savedCount = 0;

  for (const feature of geoJson.features) {
    const contourMin: number = feature.properties?.contour;
    if (!(CONTOUR_MINUTES as readonly number[]).includes(contourMin)) continue;

    // Normalize: Mapbox may return Polygon or MultiPolygon — always store as MultiPolygon
    let geomJson = feature.geometry;
    if (geomJson.type === 'Polygon') {
      geomJson = { type: 'MultiPolygon', coordinates: [geomJson.coordinates] };
    }

    // Compute bounding box from all coordinate pairs for bbox pre-filter columns
    const allCoords: [number, number][] = [];
    for (const polygon of geomJson.coordinates) {
      for (const ring of polygon) {
        for (const coord of ring) {
          allCoords.push(coord as [number, number]);
        }
      }
    }
    const bboxWest  = Math.min(...allCoords.map(c => c[0]));
    const bboxEast  = Math.max(...allCoords.map(c => c[0]));
    const bboxSouth = Math.min(...allCoords.map(c => c[1]));
    const bboxNorth = Math.max(...allCoords.map(c => c[1]));

    await pool.query(
      `INSERT INTO municipio_isochrones
         (municipio_id, profile, contour_minutes, geometry,
          mapbox_model, fetched_at,
          bbox_west, bbox_east, bbox_south, bbox_north)
       VALUES
         ($1, $2, $3,
          ST_SetSRID(ST_GeomFromGeoJSON($4), 4326),
          $5, NOW(),
          $6, $7, $8, $9)
       ON CONFLICT (municipio_id, profile, contour_minutes)
       DO UPDATE SET
         geometry     = EXCLUDED.geometry,
         mapbox_model = EXCLUDED.mapbox_model,
         fetched_at   = NOW(),
         bbox_west    = EXCLUDED.bbox_west,
         bbox_east    = EXCLUDED.bbox_east,
         bbox_south   = EXCLUDED.bbox_south,
         bbox_north   = EXCLUDED.bbox_north`,
      [
        municipioId, PROFILE, contourMin,
        JSON.stringify(geomJson),
        PROFILE,
        bboxWest, bboxEast, bboxSouth, bboxNorth,
      ]
    );
    savedCount++;
  }

  return { success: savedCount > 0, contours_saved: savedCount };
}

// ─── Batch generation ─────────────────────────────────────────────────────────

/**
 * Batch-fetches isochrone polygons for ALL municipios with known coordinates.
 *
 * Skips municipios that already have all 3 fresh contours (fetched within
 * `maxAgeDays`) unless `force = true`.
 *
 * Rate-limited to 4 requests/second (250ms delay) — safe under the Mapbox
 * free-tier limit of 300 requests/minute.
 *
 * @param mapboxToken  Mapbox public access token (pk.ey…)
 * @param force        Re-fetch even if already present and fresh (default: false)
 * @param maxAgeDays   Consider isochrones fresh if fetched within N days (default: 30)
 * @param onProgress   Optional callback invoked after each municipio is processed
 */
export async function generateAllIsochrones(
  mapboxToken:  string,
  force         = false,
  maxAgeDays    = 30,
  onProgress?:  (done: number, total: number, result: IsochroneResult) => void
): Promise<IsochroneResult[]> {
  // Ensure fetched_at column exists — guards against tables created before this column was added
  try {
    await pool.query(
      `ALTER TABLE municipio_isochrones ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ DEFAULT NOW()`
    );
  } catch (err: any) {
    console.warn('[isochrones] Could not ensure fetched_at column:', err.message);
  }

  // Load all municipios that have coordinates
  const { rows: municipios } = await pool.query<{
    id: number; code: string; lat: string; lng: string;
  }>(
    `SELECT id, code, lat, lng
     FROM municipios
     WHERE lat IS NOT NULL AND lng IS NOT NULL
     ORDER BY id`
  );

  // Find municipios that already have all 3 fresh contours (skip unless forced)
  let skipIds = new Set<number>();
  if (!force) {
    const { rows: fresh } = await pool.query<{ municipio_id: number }>(
      `SELECT municipio_id
       FROM municipio_isochrones
       WHERE profile = $1
         AND fetched_at > NOW() - ($2 || ' days')::interval
       GROUP BY municipio_id
       HAVING COUNT(DISTINCT contour_minutes) = $3`,
      [PROFILE, maxAgeDays, CONTOUR_MINUTES.length]
    );
    skipIds = new Set(fresh.map(r => r.municipio_id));
  }

  const results: IsochroneResult[] = [];
  let done = 0;

  for (const m of municipios) {
    if (skipIds.has(m.id)) {
      const r: IsochroneResult = {
        municipio_id:   m.id,
        municipio_code: m.code,
        success:        true,
        contours_saved: 0,
        skipped:        true,
      };
      results.push(r);
      done++;
      onProgress?.(done, municipios.length, r);
      continue;
    }

    const fetchResult = await fetchAndSaveIsochrone(
      m.id,
      parseFloat(m.lat),
      parseFloat(m.lng),
      mapboxToken
    );

    const r: IsochroneResult = {
      municipio_id:   m.id,
      municipio_code: m.code,
      success:        fetchResult.success,
      contours_saved: fetchResult.contours_saved,
      skipped:        false,
      error:          fetchResult.error,
    };
    results.push(r);
    done++;
    onProgress?.(done, municipios.length, r);

    // 250ms delay = 4 requests/second = 240 req/min (safely under 300/min free-tier limit)
    await sleep(250);
  }

  return results;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Returns the isochrone polygon for a given municipio as GeoJSON,
 * or null if not yet generated.
 */
export async function getIsochroneForMunicipio(
  municipioId:    number,
  contourMinutes: ContourMinute = 30
): Promise<object | null> {
  const { rows } = await pool.query(
    `SELECT ST_AsGeoJSON(geometry)::jsonb AS geojson
     FROM municipio_isochrones
     WHERE municipio_id = $1
       AND profile = $2
       AND contour_minutes = $3
     LIMIT 1`,
    [municipioId, PROFILE, contourMinutes]
  );
  return rows[0]?.geojson ?? null;
}

/**
 * Returns a coverage summary: how many municipios have isochrones and
 * how many have all three contours.
 */
export async function getIsochroneCoverage(): Promise<IsochroneCoverage> {
  await pool.query(
    `ALTER TABLE municipio_isochrones ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ DEFAULT NOW()`
  ).catch(() => {});

  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM municipios WHERE lat IS NOT NULL AND lng IS NOT NULL) AS total,
      COALESCE(COUNT(DISTINCT municipio_id)::int, 0) AS covered,
      COALESCE(SUM(CASE WHEN cnt = $1 THEN 1 ELSE 0 END)::int, 0) AS full_coverage,
      MAX(last_fetched)::text AS last_fetched
    FROM (
      SELECT municipio_id, COUNT(DISTINCT contour_minutes) AS cnt, MAX(fetched_at) AS last_fetched
      FROM municipio_isochrones WHERE profile = $2
      GROUP BY municipio_id
    ) sub
  `, [CONTOUR_MINUTES.length, PROFILE]);

  const r = rows[0];
  return {
    total_municipios: r.total,
    covered:          r.covered,
    full_coverage:    r.full_coverage,
    last_fetched:     r.last_fetched,
  };
}
