/**
 * Municipio model — PostGIS-backed queries
 */

import { pool } from '../db';

export interface Municipio {
  id: number;
  name: string;
  department: string;
  code: string;
  population: number | null;
  population_year: number;
  area_km2: number | null;
  lat: number;
  lng: number;
  is_urban: boolean;
  centroid_geojson?: object;
}

export interface MunicipioNearPoint {
  id: number;
  name: string;
  department: string;
  population: number | null;
  dist_km: number;
}

/** Get all municipios (centroid + population) */
export async function getAllMunicipios(): Promise<Municipio[]> {
  const result = await pool.query(`
    SELECT
      id, name, department, code,
      population, population_year, area_km2,
      lat, lng, is_urban,
      ST_AsGeoJSON(centroid)::jsonb AS centroid_geojson
    FROM municipios
    ORDER BY department, name
  `);
  return result.rows;
}

/** Get a single municipio by id */
export async function getMunicipioById(id: number): Promise<Municipio | null> {
  const result = await pool.query(
    `SELECT
       id, name, department, code,
       population, population_year, area_km2,
       lat, lng, is_urban,
       ST_AsGeoJSON(centroid)::jsonb AS centroid_geojson
     FROM municipios
     WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

/** Find the municipio that contains a given lat/lng point */
export async function getMunicipioContaining(
  lat: number,
  lng: number
): Promise<Municipio | null> {
  // First try polygon containment (if GADM geometry loaded)
  const polygonResult = await pool.query(
    `SELECT id, name, department, code, population, lat, lng, is_urban
     FROM municipios
     WHERE ST_Contains(geometry, ST_SetSRID(ST_MakePoint($2, $1), 4326))
     LIMIT 1`,
    [lat, lng]
  );
  if (polygonResult.rows.length > 0) return polygonResult.rows[0];

  // Fallback: nearest centroid
  const nearestResult = await pool.query(
    `SELECT id, name, department, code, population, lat, lng, is_urban
     FROM municipios
     WHERE centroid IS NOT NULL
     ORDER BY centroid <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)
     LIMIT 1`,
    [lat, lng]
  );
  return nearestResult.rows[0] ?? null;
}

/** Find municipios within radius_km of a point */
export async function getMunicipiosWithinRadius(
  lat: number,
  lng: number,
  radiusKm: number
): Promise<MunicipioNearPoint[]> {
  const result = await pool.query(
    `SELECT
       id, name, department, population,
       ROUND(
         ST_Distance(centroid::geography, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) / 1000
       ) AS dist_km
     FROM municipios
     WHERE centroid IS NOT NULL
       AND ST_DWithin(
         centroid::geography,
         ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
         $3 * 1000
       )
     ORDER BY dist_km`,
    [lat, lng, radiusKm]
  );
  return result.rows;
}

/** Get population within a radius in km, summing municipio populations */
export async function getPopulationWithinRadius(
  lat: number,
  lng: number,
  radiusKm: number
): Promise<number> {
  const result = await pool.query(
    `SELECT COALESCE(SUM(population), 0) AS total_pop
     FROM municipios
     WHERE population IS NOT NULL
       AND centroid IS NOT NULL
       AND ST_DWithin(
         centroid::geography,
         ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
         $3 * 1000
       )`,
    [lat, lng, radiusKm]
  );
  return parseInt(result.rows[0]?.total_pop ?? '0');
}

/** Top N municipios by population, optionally above minimum */
export async function getTopMunicipiosByPopulation(
  limit = 20,
  minPop = 0
): Promise<Municipio[]> {
  const result = await pool.query(
    `SELECT
       id, name, department, code,
       population, lat, lng, is_urban
     FROM municipios
     WHERE population >= $1
     ORDER BY population DESC
     LIMIT $2`,
    [minPop, limit]
  );
  return result.rows;
}
