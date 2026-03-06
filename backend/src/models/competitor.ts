/**
 * Competitor model — PostGIS-backed queries
 */

import { pool } from '../db';

export interface Competitor {
  id: number;
  name: string;
  chain: string;
  lat: number;
  lng: number;
  osm_id: number | null;
  verified: boolean;
  source: string;
  address: string | null;
  municipio: string | null;
  department: string | null;
}

export interface NearbyCompetitor extends Competitor {
  dist_km: number;
}

/** Find competitors within radius of a lat/lng point */
export async function getCompetitorsNearPoint(
  lat: number,
  lng: number,
  radiusKm: number
): Promise<NearbyCompetitor[]> {
  const result = await pool.query(
    `SELECT
       id, name, chain, lat, lng, verified, source, address, municipio, department,
       ROUND(
         ST_Distance(geometry::geography, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) / 1000
       ) AS dist_km
     FROM competitors
     WHERE geometry IS NOT NULL
       AND ST_DWithin(
         geometry::geography,
         ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
         $3 * 1000
       )
     ORDER BY dist_km`,
    [lat, lng, radiusKm]
  );
  return result.rows;
}

/** Distance to nearest competitor of any chain */
export async function getNearestCompetitor(
  lat: number,
  lng: number,
  excludeChains: string[] = []
): Promise<{ dist_km: number; chain: string; name: string } | null> {
  const chainFilter = excludeChains.length > 0
    ? `AND chain NOT IN (${excludeChains.map((_, i) => `$${i + 3}`).join(',')})`
    : '';

  const result = await pool.query(
    `SELECT name, chain,
            ROUND(ST_Distance(geometry::geography, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) / 1000) AS dist_km
     FROM competitors
     WHERE geometry IS NOT NULL ${chainFilter}
     ORDER BY geometry <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)
     LIMIT 1`,
    [lat, lng, ...excludeChains]
  );
  return result.rows[0] ?? null;
}

/** Count competitors within radius grouped by chain */
export async function countCompetitorsByChain(
  lat: number,
  lng: number,
  radiusKm: number
): Promise<{ chain: string; count: number }[]> {
  const result = await pool.query(
    `SELECT chain, COUNT(*) AS count
     FROM competitors
     WHERE geometry IS NOT NULL
       AND ST_DWithin(
         geometry::geography,
         ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
         $3 * 1000
       )
     GROUP BY chain
     ORDER BY count DESC`,
    [lat, lng, radiusKm]
  );
  return result.rows.map(r => ({ chain: r.chain, count: parseInt(r.count) }));
}

/** Bulk-insert competitors from CSV, skipping exact name+lat+lng duplicates */
export async function bulkCreateCompetitors(
  rows: Array<{
    name: string;
    chain: string;
    lat: number;
    lng: number;
    address?: string | null;
    municipio?: string | null;
    department?: string | null;
    notes?: string | null;
  }>
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    const result = await pool.query(
      `INSERT INTO competitors (name, chain, lat, lng, address, municipio, department, notes, source, verified)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, 'import', true
       WHERE NOT EXISTS (
         SELECT 1 FROM competitors
         WHERE name = $1
           AND ROUND(lat::numeric, 5) = ROUND($3::numeric, 5)
           AND ROUND(lng::numeric, 5) = ROUND($4::numeric, 5)
       )
       RETURNING id`,
      [row.name, row.chain, row.lat, row.lng,
       row.address ?? null, row.municipio ?? null, row.department ?? null, row.notes ?? null]
    );
    if ((result.rowCount ?? 0) > 0) inserted++;
    else skipped++;
  }

  return { inserted, skipped };
}

/** All competitors as GeoJSON FeatureCollection */
export async function getCompetitorsGeoJSON(): Promise<object> {
  const result = await pool.query(`
    SELECT json_build_object(
      'type', 'FeatureCollection',
      'features', json_agg(
        json_build_object(
          'type', 'Feature',
          'geometry', ST_AsGeoJSON(geometry)::json,
          'properties', json_build_object(
            'id', id, 'name', name, 'chain', chain,
            'verified', verified, 'source', source
          )
        )
      )
    ) AS geojson
    FROM competitors
    WHERE geometry IS NOT NULL
  `);
  return result.rows[0]?.geojson ?? { type: 'FeatureCollection', features: [] };
}
