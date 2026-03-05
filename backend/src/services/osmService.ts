/**
 * OpenStreetMap / Overpass API Integration
 *
 * Fetches POI data for Guatemala and populates the poi_cache table.
 * Used by the scoring engine for mobility, commercial, and socioeconomic factors.
 */

import axios from 'axios';
import { pool } from '../db';

const OVERPASS_URL = process.env.OVERPASS_API_URL || 'https://overpass-api.de/api/interpreter';
const TIMEOUT_MS = 90_000;

// Guatemala bounding box: south, west, north, east
const BBOX = '13.7,-92.3,18.0,-88.2';

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

// Tag → poi_type mapping used for scoring
const TAG_TO_TYPE: { test: (tags: Record<string, string>) => boolean; type: string }[] = [
  { test: t => t.shop === 'supermarket',                  type: 'supermarket' },
  { test: t => t.amenity === 'bank',                      type: 'bank' },
  { test: t => t.amenity === 'pharmacy',                  type: 'pharmacy' },
  { test: t => t.amenity === 'marketplace' || t.shop === 'market', type: 'marketplace' },
  { test: t => t.shop === 'hardware' || t.shop === 'doityourself', type: 'hardware' },
  { test: t => t.amenity === 'school',                    type: 'school' },
  { test: t => t.amenity === 'university' || t.amenity === 'college', type: 'university' },
  { test: t => t.amenity === 'hospital',                  type: 'hospital' },
  { test: t => t.amenity === 'clinic' || t.amenity === 'health_centre', type: 'clinic' },
  // LDS church: must come before generic place_of_worship so meetinghouses are
  // classified as 'lds_church' rather than the broader category. Used as a
  // community-threshold leading indicator in the socioeconomic score.
  {
    test: t => t.denomination === 'latter_day_saints' ||
               /santos de los.ltimos d.as|jesucristo de los santos/i.test(t.name ?? ''),
    type: 'lds_church',
  },
  { test: t => t.amenity === 'place_of_worship',          type: 'place_of_worship' },
  { test: t => t.amenity === 'bus_station',               type: 'bus_station' },
  { test: t => t.highway === 'bus_stop',                  type: 'bus_stop' },
  { test: t => t.amenity === 'fuel',                      type: 'fuel' },
  { test: t => t.highway === 'primary' || t.highway === 'trunk', type: 'highway_primary' },
  { test: t => t.highway === 'secondary',                 type: 'highway_secondary' },
  // Money-transfer agents: direct observable signal of remittance activity.
  // Western Union, MoneyGram, Banrural Remesas, and Gi Go are densely mapped
  // in OSM for Guatemala and confirm active household remittance income in an area.
  {
    test: t => t.amenity === 'money_transfer' ||
               /western.?union|moneygram|remesa|gi\.?go/i.test(t.name ?? ''),
    type: 'money_transfer',
  },
  // ATMs: Banrural, BI, BAC, and G&T ATMs are widely mapped in OSM and are
  // strong indicators of formal banking infrastructure and purchasing power.
  { test: t => t.amenity === 'atm', type: 'atm' },
];

function classifyPoi(tags: Record<string, string>): string {
  for (const { test, type } of TAG_TO_TYPE) {
    if (test(tags)) return type;
  }
  return 'other';
}

async function runOverpassQuery(query: string): Promise<OverpassElement[]> {
  const response = await axios.post(
    OVERPASS_URL,
    `data=${encodeURIComponent(query)}`,
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: TIMEOUT_MS,
    }
  );
  return response.data.elements || [];
}

async function upsertPois(elements: OverpassElement[], defaultType?: string): Promise<number> {
  if (elements.length === 0) return 0;

  const client = await pool.connect();
  let count = 0;

  try {
    await client.query('BEGIN');

    for (const el of elements) {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!lat || !lon) continue;

      const tags = el.tags ?? {};
      const poiType = defaultType ?? classifyPoi(tags);
      const name = tags.name || tags['name:es'] || null;

      await client.query(
        `INSERT INTO poi_cache (osm_id, osm_type, name, poi_type, lat, lng, geometry, tags)
         VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($6,$5),4326), $7)
         ON CONFLICT (osm_id, osm_type) DO UPDATE SET
           poi_type   = EXCLUDED.poi_type,
           lat        = EXCLUDED.lat,
           lng        = EXCLUDED.lng,
           geometry   = EXCLUDED.geometry,
           tags       = EXCLUDED.tags,
           fetched_at = NOW()`,
        [el.id, el.type, name, poiType, lat, lon, JSON.stringify(tags)]
      );
      count++;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return count;
}

async function logRefresh(
  queryType: string,
  records: number,
  durationMs: number,
  error?: string
): Promise<void> {
  await pool.query(
    `INSERT INTO osm_refresh_log (query_type, records_fetched, duration_ms, status, error_msg)
     VALUES ($1, $2, $3, $4, $5)`,
    [queryType, records, durationMs, error ? 'error' : 'success', error ?? null]
  );
}

// ─── Public refresh functions ─────────────────────────────────────────────────

export async function refreshSupermarkets(): Promise<number> {
  const start = Date.now();
  const query = `
[out:json][timeout:60];
(
  node["shop"="supermarket"](${BBOX});
  way["shop"="supermarket"](${BBOX});
  node["shop"="convenience"]["name"~"despensa|bodega|super|suma|torre|bodegona",i](${BBOX});
);
out center;`.trim();

  try {
    const elements = await runOverpassQuery(query);
    const count = await upsertPois(elements, 'supermarket');
    await logRefresh('supermarkets', count, Date.now() - start);
    return count;
  } catch (err: any) {
    await logRefresh('supermarkets', 0, Date.now() - start, err.message);
    throw err;
  }
}

export async function refreshCommercialPois(): Promise<number> {
  const start = Date.now();
  const query = `
[out:json][timeout:90];
(
  node["amenity"~"bank|pharmacy|marketplace|bus_station|fuel|school|hospital|clinic|place_of_worship|money_transfer|atm"](${BBOX});
  node["shop"~"market|hardware|doityourself"](${BBOX});
  node["highway"="bus_stop"](${BBOX});
  node["name"~"western union|moneygram|remesa|gi go",i](${BBOX});
  node["denomination"="latter_day_saints"](${BBOX});
  way["denomination"="latter_day_saints"](${BBOX});
);
out center;`.trim();

  try {
    const elements = await runOverpassQuery(query);
    const count = await upsertPois(elements);
    await logRefresh('commercial_pois', count, Date.now() - start);
    return count;
  } catch (err: any) {
    await logRefresh('commercial_pois', 0, Date.now() - start, err.message);
    throw err;
  }
}

export async function refreshRoads(): Promise<number> {
  const start = Date.now();
  // Sample major roads only to keep response size manageable
  const query = `
[out:json][timeout:90];
(
  way["highway"~"motorway|trunk|primary|secondary"](${BBOX});
);
out center;`.trim();

  try {
    const elements = await runOverpassQuery(query);
    // For roads we store the center point of each way segment
    const count = await upsertPois(elements);
    await logRefresh('roads', count, Date.now() - start);
    return count;
  } catch (err: any) {
    await logRefresh('roads', 0, Date.now() - start, err.message);
    throw err;
  }
}

export async function refreshAll(): Promise<{ supermarkets: number; pois: number; roads: number }> {
  const results = { supermarkets: 0, pois: 0, roads: 0 };

  // Run sequentially to avoid overloading Overpass
  try { results.supermarkets = await refreshSupermarkets(); } catch (_) {}
  try { results.pois         = await refreshCommercialPois(); } catch (_) {}
  try { results.roads        = await refreshRoads(); } catch (_) {}

  return results;
}

export async function getRefreshLog(limit = 20): Promise<object[]> {
  const result = await pool.query(
    `SELECT query_type, records_fetched, duration_ms, status, error_msg, executed_at
     FROM osm_refresh_log ORDER BY executed_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getPoiCounts(): Promise<{ type: string; count: number }[]> {
  const result = await pool.query(
    `SELECT poi_type AS type, COUNT(*) AS count
     FROM poi_cache
     GROUP BY poi_type
     ORDER BY count DESC`
  );
  return result.rows.map(r => ({ type: r.type, count: parseInt(r.count) }));
}
