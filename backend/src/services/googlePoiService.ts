/**
 * Google Places & Distance Matrix POI Service
 *
 * Replaces OSM/Overpass for all ambient POI data collection.
 * Three data refresh operations:
 *
 *  1. refreshNearbyPois(apiKey)
 *     — Google Places Nearby Search, one request per department per POI type.
 *     — Radius 60 km covers the full department from its centroid.
 *     — Types: bank, pharmacy, hospital, school, gas_station, transit_station.
 *     — Cost: 22 depts × 6 types × ≤3 pages × $0.032 ≈ $4.00–$12.00
 *
 *  2. refreshMercadosInformales(apiKey)
 *     — Google Places Text Search for "mercado [dept] Guatemala".
 *     — Municipal / informal markets are Guatemala's #1 foot-traffic signal.
 *     — Stored as poi_type = 'marketplace' (3× weight in commercial score).
 *     — Cost: 22 depts × $0.017 = $0.37
 *
 *  3. refreshLdsChurches(apiKey)
 *     — Text Search for "Iglesia de Jesucristo de los Santos [dept]".
 *     — LDS chapels require professional demographic validation before build;
 *       presence signals community crossed D/C-segment critical mass.
 *     — Stored as poi_type = 'lds_church'.
 *     — Cost: 22 depts × $0.017 = $0.37
 *
 *  4. refreshDriveTimes(apiKey)
 *     — Google Distance Matrix, all municipio centroids → Guatemala City.
 *     — Drive time stored in municipios.drive_time_capital_min.
 *     — This is the primary mobility signal replacing road-POI counts.
 *     — Cost: 340 municipios / 100 per request × $0.01/element = $0.34
 *     — Note: Waze For Cities is a government-only programme with no public API.
 *       Distance Matrix is the best available substitute.
 *
 * Total per full refresh: ~$5–13. Run monthly or after major retail changes.
 */

import axios from 'axios';
import { pool } from '../db';

// ─── Guatemala City destination for drive-time calculations ───────────────────
const CAPITAL_LAT = 14.634915;
const CAPITAL_LNG = -90.506882;

// ─── Department centroids (INE 2018 / SEGEPLAN) ───────────────────────────────
const DEPT_CENTROIDS: Record<string, { lat: number; lng: number }> = {
  'Guatemala':        { lat: 14.5937, lng: -90.5137 },
  'El Progreso':      { lat: 14.8508, lng: -90.0753 },
  'Sacatepéquez':     { lat: 14.5414, lng: -90.7339 },
  'Chimaltenango':    { lat: 14.6618, lng: -90.8191 },
  'Escuintla':        { lat: 14.3078, lng: -90.7870 },
  'Santa Rosa':       { lat: 14.2123, lng: -90.2929 },
  'Sololá':           { lat: 14.7693, lng: -91.1896 },
  'Totonicapán':      { lat: 14.9171, lng: -91.3593 },
  'Quetzaltenango':   { lat: 14.8315, lng: -91.5173 },
  'Suchitepéquez':    { lat: 14.4308, lng: -91.3937 },
  'Retalhuleu':       { lat: 14.5281, lng: -91.6862 },
  'San Marcos':       { lat: 14.9668, lng: -91.8000 },
  'Huehuetenango':    { lat: 15.3193, lng: -91.4710 },
  'Quiché':           { lat: 15.0293, lng: -91.1502 },
  'Baja Verapaz':     { lat: 15.1260, lng: -90.2148 },
  'Alta Verapaz':     { lat: 15.4718, lng: -90.3701 },
  'Petén':            { lat: 16.9133, lng: -90.2909 },
  'Izabal':           { lat: 15.4737, lng: -89.1537 },
  'Zacapa':           { lat: 14.9720, lng: -89.5320 },
  'Chiquimula':       { lat: 14.7946, lng: -89.5387 },
  'Jalapa':           { lat: 14.6322, lng: -89.9853 },
  'Jutiapa':          { lat: 14.2924, lng: -89.8949 },
};

// ─── POI types to fetch via Nearby Search ────────────────────────────────────
const NEARBY_TYPES: { google_type: string; poi_type: string }[] = [
  { google_type: 'bank',            poi_type: 'bank'        },
  { google_type: 'pharmacy',        poi_type: 'pharmacy'    },
  { google_type: 'hospital',        poi_type: 'hospital'    },
  { google_type: 'school',          poi_type: 'school'      },
  { google_type: 'gas_station',     poi_type: 'fuel'        },
  { google_type: 'transit_station', poi_type: 'bus_station' },
];

const NEARBY_SEARCH_URL   = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const TEXT_SEARCH_URL     = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const DISTANCE_MATRIX_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';

const PAGE_DELAY_MS = 2_000; // Google requires ≥2 s between page_token requests

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Nearby Search (single page) ─────────────────────────────────────────────

async function nearbySinglePage(
  lat: number, lng: number, radius: number,
  googleType: string, apiKey: string, pageToken?: string
): Promise<{ results: any[]; next_page_token?: string }> {
  const params: Record<string, string> = {
    location: `${lat},${lng}`,
    radius:   String(radius),
    type:     googleType,
    key:      apiKey,
    language: 'es',
  };
  if (pageToken) params.pagetoken = pageToken;
  const { data } = await axios.get(NEARBY_SEARCH_URL, { params, timeout: 15_000 });
  if (data.status === 'REQUEST_DENIED') throw new Error(`Places API denied: ${data.error_message}`);
  if (data.status === 'OVER_QUERY_LIMIT') throw new Error('Places API quota exceeded');
  return { results: data.results ?? [], next_page_token: data.next_page_token };
}

async function nearbyAllPages(
  lat: number, lng: number, radius: number,
  googleType: string, apiKey: string, maxPages = 3
): Promise<any[]> {
  const all: any[] = [];
  let token: string | undefined;
  for (let p = 0; p < maxPages; p++) {
    if (p > 0 && token) await sleep(PAGE_DELAY_MS);
    const { results, next_page_token } = await nearbySinglePage(lat, lng, radius, googleType, apiKey, token);
    all.push(...results);
    if (!next_page_token) break;
    token = next_page_token;
  }
  return all;
}

// ─── Text Search (single page) ───────────────────────────────────────────────

async function textSearchAllPages(
  query: string, apiKey: string, maxPages = 2
): Promise<any[]> {
  const all: any[] = [];
  let token: string | undefined;
  for (let p = 0; p < maxPages; p++) {
    if (p > 0 && token) await sleep(PAGE_DELAY_MS);
    const params: Record<string, string> = { query, key: apiKey, language: 'es', region: 'gt' };
    if (token) params.pagetoken = token;
    const { data } = await axios.get(TEXT_SEARCH_URL, { params, timeout: 15_000 });
    if (data.status === 'REQUEST_DENIED') throw new Error(`Places API denied: ${data.error_message}`);
    if (data.status === 'OVER_QUERY_LIMIT') throw new Error('Places API quota exceeded');
    all.push(...(data.results ?? []));
    if (!data.next_page_token) break;
    token = data.next_page_token;
  }
  return all;
}

// ─── DB upsert helper ────────────────────────────────────────────────────────

async function upsertPois(places: any[], poiType: string, client: any): Promise<number> {
  let inserted = 0;
  for (const place of places) {
    const placeId = place.place_id as string;
    const lat = place.geometry?.location?.lat as number;
    const lng = place.geometry?.location?.lng as number;
    if (!placeId || !lat || !lng) continue;

    // Deduplicate by place_id stored in tags
    const existing = await client.query(
      `SELECT id FROM poi_cache WHERE tags->>'place_id' = $1 LIMIT 1`,
      [placeId]
    );
    if (existing.rows.length > 0) continue;

    await client.query(
      `INSERT INTO poi_cache (name, poi_type, lat, lng, geometry, tags, source, fetched_at)
       VALUES ($1, $2, $3, $4,
               ST_SetSRID(ST_MakePoint($4, $3), 4326),
               $5, 'google_places', NOW())`,
      [
        (place.name ?? '').slice(0, 255),
        poiType,
        lat, lng,
        JSON.stringify({ place_id: placeId, rating: place.rating, types: place.types }),
      ]
    );
    inserted++;
  }
  return inserted;
}

// ─── Refresh: commercial + mobility POIs via Nearby Search ───────────────────

export interface PoiRefreshResult {
  dept: string;
  poi_type: string;
  found: number;
  inserted: number;
  error?: string;
}

export async function refreshNearbyPois(apiKey: string): Promise<PoiRefreshResult[]> {
  const results: PoiRefreshResult[] = [];
  const start = Date.now();
  let totalInserted = 0;

  const client = await pool.connect();
  try {
    // Clear old Google Places POIs before re-fetching (full refresh)
    await client.query(
      `DELETE FROM poi_cache
       WHERE source = 'google_places'
         AND poi_type NOT IN ('marketplace','lds_church')`
    );

    for (const dept of Object.keys(DEPT_CENTROIDS)) {
      const { lat, lng } = DEPT_CENTROIDS[dept];
      for (const { google_type, poi_type } of NEARBY_TYPES) {
        const r: PoiRefreshResult = { dept, poi_type, found: 0, inserted: 0 };
        try {
          const places = await nearbyAllPages(lat, lng, 60_000, google_type, apiKey);
          r.found = places.length;
          await client.query('BEGIN');
          r.inserted = await upsertPois(places, poi_type, client);
          await client.query('COMMIT');
          totalInserted += r.inserted;
        } catch (err: any) {
          await client.query('ROLLBACK').catch(() => {});
          r.error = err.message;
          // Quota exhausted — stop entirely
          if (/quota/i.test(err.message)) {
            results.push(r);
            break;
          }
        }
        results.push(r);
        await sleep(300); // polite delay between requests
      }
    }
  } finally {
    client.release();
  }

  const duration = Date.now() - start;
  await pool.query(
    `INSERT INTO osm_refresh_log (query_type, records_fetched, duration_ms, status)
     VALUES ('google_pois', $1, $2, 'success')`,
    [totalInserted, duration]
  ).catch(() => {});

  return results;
}

// ─── Refresh: mercados informales via Text Search ─────────────────────────────

export async function refreshMercadosInformales(apiKey: string): Promise<{ dept: string; found: number; inserted: number; error?: string }[]> {
  const results: { dept: string; found: number; inserted: number; error?: string }[] = [];

  // Clear old marketplace entries from Google Places before re-fetching
  await pool.query(`DELETE FROM poi_cache WHERE source = 'google_places' AND poi_type = 'marketplace'`);

  const client = await pool.connect();
  try {
    for (const dept of Object.keys(DEPT_CENTROIDS)) {
      const r = { dept, found: 0, inserted: 0, error: undefined as string | undefined };
      try {
        const places = await textSearchAllPages(`mercado ${dept} Guatemala`, apiKey);
        r.found = places.length;
        await client.query('BEGIN');
        r.inserted = await upsertPois(places, 'marketplace', client);
        await client.query('COMMIT');
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        r.error = err.message;
        if (/quota/i.test(err.message)) { results.push(r); break; }
      }
      results.push(r);
      await sleep(300);
    }
  } finally {
    client.release();
  }

  return results;
}

// ─── Refresh: LDS churches via Text Search ───────────────────────────────────

export async function refreshLdsChurches(apiKey: string): Promise<{ dept: string; found: number; inserted: number; error?: string }[]> {
  const results: { dept: string; found: number; inserted: number; error?: string }[] = [];

  await pool.query(`DELETE FROM poi_cache WHERE source = 'google_places' AND poi_type = 'lds_church'`);

  const client = await pool.connect();
  try {
    for (const dept of Object.keys(DEPT_CENTROIDS)) {
      const r = { dept, found: 0, inserted: 0, error: undefined as string | undefined };
      try {
        const places = await textSearchAllPages(
          `Iglesia de Jesucristo de los Santos de los Últimos Días ${dept} Guatemala`, apiKey
        );
        r.found = places.length;
        await client.query('BEGIN');
        r.inserted = await upsertPois(places, 'lds_church', client);
        await client.query('COMMIT');
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        r.error = err.message;
        if (/quota/i.test(err.message)) { results.push(r); break; }
      }
      results.push(r);
      await sleep(300);
    }
  } finally {
    client.release();
  }

  return results;
}

// ─── Refresh: drive times → Guatemala City via Distance Matrix ────────────────

export interface DriveTimeResult {
  total: number;
  updated: number;
  error?: string;
}

export async function refreshDriveTimes(apiKey: string): Promise<DriveTimeResult> {
  const result: DriveTimeResult = { total: 0, updated: 0 };

  // Load all municipios with centroids
  const muniResult = await pool.query(
    `SELECT id,
            ST_Y(centroid::geometry) AS lat,
            ST_X(centroid::geometry) AS lng
     FROM municipios WHERE centroid IS NOT NULL`
  );
  const municipios = muniResult.rows.map(r => ({
    id:  r.id as number,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lng),
  }));
  result.total = municipios.length;

  const DESTINATION = `${CAPITAL_LAT},${CAPITAL_LNG}`;
  const BATCH_SIZE  = 100; // Distance Matrix allows up to 100 origins per request

  for (let i = 0; i < municipios.length; i += BATCH_SIZE) {
    const batch = municipios.slice(i, i + BATCH_SIZE);
    const origins = batch.map(m => `${m.lat},${m.lng}`).join('|');

    try {
      const { data } = await axios.get(DISTANCE_MATRIX_URL, {
        params: { origins, destinations: DESTINATION, key: apiKey, mode: 'driving', language: 'es' },
        timeout: 30_000,
      });

      if (data.status === 'REQUEST_DENIED') throw new Error(`Distance Matrix denied: ${data.error_message}`);
      if (data.status === 'OVER_QUERY_LIMIT') throw new Error('Distance Matrix quota exceeded');

      const rows: any[] = data.rows ?? [];
      for (let j = 0; j < rows.length; j++) {
        const element = rows[j]?.elements?.[0];
        if (element?.status !== 'OK') continue;
        const durationSec = element.duration?.value as number | undefined;
        if (!durationSec) continue;
        const minutes = Math.round(durationSec / 60);
        await pool.query(
          `UPDATE municipios SET drive_time_capital_min = $1 WHERE id = $2`,
          [minutes, batch[j].id]
        );
        result.updated++;
      }
    } catch (err: any) {
      result.error = err.message;
      break;
    }

    if (i + BATCH_SIZE < municipios.length) await sleep(500);
  }

  return result;
}

// ─── Status helpers (same interface as osmService) ───────────────────────────

export async function getPoiCounts(): Promise<{ total: number; by_type: Record<string, number>; drive_time_coverage: number }> {
  const [typeResult, dtResult] = await Promise.all([
    pool.query(`SELECT poi_type, COUNT(*) AS cnt FROM poi_cache GROUP BY poi_type ORDER BY cnt DESC`),
    pool.query(`SELECT COUNT(*) AS cnt FROM municipios WHERE drive_time_capital_min IS NOT NULL`),
  ]);
  const by_type: Record<string, number> = {};
  let total = 0;
  for (const row of typeResult.rows) {
    by_type[row.poi_type] = parseInt(row.cnt);
    total += parseInt(row.cnt);
  }
  return { total, by_type, drive_time_coverage: parseInt(dtResult.rows[0]?.cnt ?? '0') };
}

export async function getRefreshLog(limit = 10): Promise<any[]> {
  const result = await pool.query(
    `SELECT query_type, records_fetched, duration_ms, status, error_msg, executed_at
     FROM osm_refresh_log ORDER BY executed_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}
