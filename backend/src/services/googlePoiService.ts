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
const NEARBY_TYPES: { google_type: string; poi_type: string; keyword?: string }[] = [
  { google_type: 'bank',             poi_type: 'bank'              },
  { google_type: 'pharmacy',         poi_type: 'pharmacy'          },
  { google_type: 'hospital',         poi_type: 'hospital'          },
  { google_type: 'school',           poi_type: 'school'            },
  { google_type: 'gas_station',      poi_type: 'fuel'              },
  { google_type: 'transit_station',  poi_type: 'bus_station'       },
  { google_type: 'church',            poi_type: 'church'        },
  { google_type: 'city_hall',         poi_type: 'municipalidad' },
  { google_type: 'convenience_store', poi_type: 'tienda'        },
  { google_type: 'finance',           poi_type: 'cooperativa',  keyword: 'cooperativa' },
];

// ─── Guatemalan anchor retailers (POIs, not competitors) ─────────────────────
// Presence signals consumer credit market + C/D-segment purchasing power.
const ANCHOR_RETAILER_CHAINS = [
  'Gallo más Gallo',
  'Elektra',
  'Tecnofacil',
  'MAX',
  'Distelsa',
];

const NEARBY_SEARCH_URL   = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const TEXT_SEARCH_URL     = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const DISTANCE_MATRIX_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';

const PAGE_DELAY_MS = 2_000; // Google requires ≥2 s between page_token requests

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Nearby Search (single page) ─────────────────────────────────────────────

async function nearbySinglePage(
  lat: number, lng: number, radius: number,
  googleType: string, apiKey: string, pageToken?: string, keyword?: string
): Promise<{ results: any[]; next_page_token?: string }> {
  const params: Record<string, string> = {
    location: `${lat},${lng}`,
    radius:   String(radius),
    type:     googleType,
    key:      apiKey,
    language: 'es',
  };
  if (keyword)   params.keyword   = keyword;
  if (pageToken) params.pagetoken = pageToken;
  const { data } = await axios.get(NEARBY_SEARCH_URL, { params, timeout: 15_000 });
  if (data.status === 'REQUEST_DENIED') throw new Error(`Places API denied: ${data.error_message}`);
  if (data.status === 'OVER_QUERY_LIMIT') throw new Error('Places API quota exceeded');
  return { results: data.results ?? [], next_page_token: data.next_page_token };
}

async function nearbyAllPages(
  lat: number, lng: number, radius: number,
  googleType: string, apiKey: string, maxPages = 3, keyword?: string
): Promise<any[]> {
  const all: any[] = [];
  let token: string | undefined;
  for (let p = 0; p < maxPages; p++) {
    if (p > 0 && token) await sleep(PAGE_DELAY_MS);
    const { results, next_page_token } = await nearbySinglePage(lat, lng, radius, googleType, apiKey, token, keyword);
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

async function upsertPois(places: any[], poiType: string, dept: string, client: any): Promise<number> {
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
               ST_SetSRID(ST_MakePoint($4::float8, $3::float8), 4326),
               $5, 'google_places', NOW())`,
      [
        (place.name ?? '').slice(0, 255),
        poiType,
        lat, lng,
        JSON.stringify({ place_id: placeId, dept, rating: place.rating, types: place.types }),
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

  const depts = Object.keys(DEPT_CENTROIDS);
  startProgress('pois', depts.length * NEARBY_TYPES.length);

  // Fetch + commit one department at a time so partial results are visible immediately.
  // Deduplication is by place_id (stored in tags), so re-runs are safe without a prior DELETE.
  outer: for (const dept of depts) {
    const { lat, lng } = DEPT_CENTROIDS[dept];
    const deptPending: { r: PoiRefreshResult; places: any[] }[] = [];
    let deptFound = 0;

    for (const { google_type, poi_type, keyword } of NEARBY_TYPES) {
      const r: PoiRefreshResult = { dept, poi_type, found: 0, inserted: 0 };
      try {
        const places = await nearbyAllPages(lat, lng, 60_000, google_type, apiKey, 3, keyword);
        r.found = places.length;
        deptFound += places.length;
        deptPending.push({ r, places });
      } catch (err: any) {
        r.error = err.message;
        if (/quota/i.test(err.message)) {
          endProgress(`Cuota agotada en ${dept} – ${poi_type}`);
          results.push(r);
          break outer;
        }
        if (/denied|not authorized|REQUEST_DENIED/i.test(err.message)) {
          endProgress(`API key inválida o sin permiso de Places API: ${err.message}`);
          results.push(r);
          break outer;
        }
      }
      tickProgress(`${dept} – ${poi_type}`, 0);
      results.push(r);
      await sleep(300);
    }

    // Commit this dept's results immediately so the map reflects them right away
    if (deptFound > 0) {
      const client = await pool.connect();
      try {
        for (const { r, places } of deptPending) {
          await client.query('BEGIN');
          r.inserted = await upsertPois(places, r.poi_type, dept, client);
          totalInserted += r.inserted;
          await client.query('COMMIT');
        }
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
      } finally {
        client.release();
      }
    }
  }

  endProgress();

  const duration = Date.now() - start;
  await pool.query(
    `INSERT INTO osm_refresh_log (query_type, records_fetched, duration_ms, status)
     VALUES ('google_pois', $1, $2, 'success')`,
    [totalInserted, duration]
  ).catch(() => {});

  return results;
}

// ─── Refresh: single department (all POI types) ───────────────────────────────
// Lets the user sync one department at a time and see results immediately.

export async function refreshDepartmentPois(dept: string, apiKey: string): Promise<PoiRefreshResult[]> {
  if (!DEPT_CENTROIDS[dept]) throw new Error(`Unknown department: ${dept}`);
  const { lat, lng } = DEPT_CENTROIDS[dept];
  const results: PoiRefreshResult[] = [];
  startProgress('pois', NEARBY_TYPES.length);

  const pending: { r: PoiRefreshResult; places: any[] }[] = [];
  let deptFound = 0;

  for (const { google_type, poi_type, keyword } of NEARBY_TYPES) {
    const r: PoiRefreshResult = { dept, poi_type, found: 0, inserted: 0 };
    try {
      const places = await nearbyAllPages(lat, lng, 60_000, google_type, apiKey, 3, keyword);
      r.found = places.length;
      deptFound += places.length;
      pending.push({ r, places });
    } catch (err: any) {
      r.error = err.message;
      if (/quota/i.test(err.message)) {
        endProgress(`Cuota agotada – ${poi_type}`);
        results.push(r);
        return results;
      }
      if (/denied|not authorized|REQUEST_DENIED/i.test(err.message)) {
        endProgress(`API key inválida o sin permiso de Places API: ${err.message}`);
        results.push(r);
        return results;
      }
    }
    tickProgress(`${dept} – ${poi_type}`, 0);
    results.push(r);
    await sleep(300);
  }

  if (deptFound === 0) {
    const errors = results.filter(r => r.error).map(r => `${r.poi_type}: ${r.error}`);
    const detail = errors.length > 0
      ? `Errores: ${errors.slice(0, 3).join(' | ')}`
      : 'Verifica que la clave tenga Places API habilitada y cuota disponible';
    endProgress(`API devolvió 0 resultados — ${detail}`);
    return results;
  }

  const client = await pool.connect();
  try {
    for (const { r, places } of pending) {
      await client.query('BEGIN');
      r.inserted = await upsertPois(places, r.poi_type, dept, client);
      await client.query('COMMIT');
    }
    endProgress();
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    endProgress(err.message);
  } finally {
    client.release();
  }

  return results;
}

// ─── Refresh: mercados via Nearby Search with keyword ────────────────────────
// Uses keyword="mercado" so any market is found by proximity regardless of its
// proper name (e.g. "Mercado La Palmita"), not just those whose name contains
// the department name.

export async function refreshMercadosInformales(apiKey: string): Promise<{ dept: string; found: number; inserted: number; error?: string }[]> {
  type R = { dept: string; found: number; inserted: number; error?: string };
  const results: R[] = [];
  const depts = Object.keys(DEPT_CENTROIDS);
  startProgress('mercados', depts.length);

  // Pass 1: fetch
  const pending: { r: R; places: any[] }[] = [];
  let totalFound = 0;
  for (const dept of depts) {
    const r: R = { dept, found: 0, inserted: 0 };
    try {
      const places = await nearbyAllPages(
        DEPT_CENTROIDS[dept].lat, DEPT_CENTROIDS[dept].lng,
        60_000, 'establishment', apiKey, 3, 'mercado'
      );
      r.found = places.length;
      totalFound += places.length;
      pending.push({ r, places });
    } catch (err: any) {
      r.error = err.message;
      if (/quota/i.test(err.message)) { endProgress(`Cuota agotada en ${dept}`); results.push(r); break; }
    }
    tickProgress(`Mercados – ${dept}`, 0);
    results.push(r);
    await sleep(300);
  }

  if (totalFound === 0) { endProgress(); return results; }

  // Pass 2: delete then insert
  await pool.query(`DELETE FROM poi_cache WHERE source = 'google_places' AND poi_type = 'marketplace'`);
  const client = await pool.connect();
  try {
    for (const { r, places } of pending) {
      try {
        await client.query('BEGIN');
        r.inserted = await upsertPois(places, 'marketplace', r.dept, client);
        await client.query('COMMIT');
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        r.error = err.message;
      }
    }
    endProgress();
  } finally {
    client.release();
  }

  return results;
}

// ─── Refresh: Guatemalan anchor retailers via Nearby keyword search ───────────
// Fetches Gallo más Gallo, Elektra, Tecnofacil, MAX, Distelsa as poi_type='anchor_retailer'.
// Called only from the full refresh — no dedicated admin button.

export async function refreshAnchorRetailers(apiKey: string): Promise<{ chain: string; dept: string; found: number; inserted: number; error?: string }[]> {
  type R = { chain: string; dept: string; found: number; inserted: number; error?: string };
  const results: R[] = [];
  const depts = Object.keys(DEPT_CENTROIDS);
  startProgress('anchor_retailers', depts.length * ANCHOR_RETAILER_CHAINS.length);

  // Pass 1: fetch
  const pending: { r: R; places: any[] }[] = [];
  let totalFound = 0;
  outer: for (const chain of ANCHOR_RETAILER_CHAINS) {
    for (const dept of depts) {
      const r: R = { chain, dept, found: 0, inserted: 0 };
      try {
        const { lat, lng } = DEPT_CENTROIDS[dept];
        const places = await nearbyAllPages(lat, lng, 60_000, 'establishment', apiKey, 3, chain);
        r.found = places.length;
        totalFound += places.length;
        pending.push({ r, places });
      } catch (err: any) {
        r.error = err.message;
        if (/quota/i.test(err.message)) { endProgress(`Cuota agotada – ${chain} ${dept}`); results.push(r); break outer; }
      }
      tickProgress(`${chain} – ${dept}`, 0);
      results.push(r);
      await sleep(300);
    }
  }

  if (totalFound === 0) { endProgress(); return results; }

  // Pass 2: delete then insert
  await pool.query(`DELETE FROM poi_cache WHERE source = 'google_places' AND poi_type = 'anchor_retailer'`);
  const client = await pool.connect();
  try {
    for (const { r, places } of pending) {
      try {
        await client.query('BEGIN');
        r.inserted = await upsertPois(places, 'anchor_retailer', r.dept, client);
        await client.query('COMMIT');
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        r.error = err.message;
      }
    }
    endProgress();
  } finally {
    client.release();
  }

  return results;
}

// ─── Refresh: LDS churches via Text Search ───────────────────────────────────

export async function refreshLdsChurches(apiKey: string): Promise<{ dept: string; found: number; inserted: number; error?: string }[]> {
  type R = { dept: string; found: number; inserted: number; error?: string };
  const results: R[] = [];
  const depts = Object.keys(DEPT_CENTROIDS);
  startProgress('lds', depts.length);

  // Pass 1: fetch
  const pending: { r: R; places: any[] }[] = [];
  let totalFound = 0;
  for (const dept of depts) {
    const r: R = { dept, found: 0, inserted: 0 };
    try {
      const places = await textSearchAllPages(
        `Iglesia de Jesucristo de los Santos de los Últimos Días ${dept} Guatemala`, apiKey
      );
      r.found = places.length;
      totalFound += places.length;
      pending.push({ r, places });
    } catch (err: any) {
      r.error = err.message;
      if (/quota/i.test(err.message)) { endProgress(`Cuota agotada en ${dept}`); results.push(r); break; }
    }
    tickProgress(`Iglesias SUD – ${dept}`, 0);
    results.push(r);
    await sleep(300);
  }

  if (totalFound === 0) { endProgress(); return results; }

  // Pass 2: delete then insert
  await pool.query(`DELETE FROM poi_cache WHERE source = 'google_places' AND poi_type = 'lds_church'`);
  const client = await pool.connect();
  try {
    for (const { r, places } of pending) {
      try {
        await client.query('BEGIN');
        r.inserted = await upsertPois(places, 'lds_church', r.dept, client);
        await client.query('COMMIT');
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        r.error = err.message;
      }
    }
    endProgress();
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
  startProgress('drive_times', Math.ceil(municipios.length / 100));

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
      endProgress(err.message);
      break;
    }

    tickProgress(`Municipios ${i + 1}–${Math.min(i + BATCH_SIZE, municipios.length)} de ${municipios.length}`, 0);
    if (i + BATCH_SIZE < municipios.length) await sleep(500);
  }

  endProgress(result.error);
  return result;
}

// ─── In-memory refresh progress ──────────────────────────────────────────────
// Allows the frontend to poll GET /api/pois/progress for live status.

export interface RefreshProgress {
  active:     boolean;
  phase:      string;   // e.g. 'drive_times' | 'mercados' | 'lds' | 'pois' | 'osm_seed' | 'idle'
  step:       string;   // human-readable current step, e.g. 'Guatemala – bank'
  current:    number;
  total:      number;
  inserted:   number;
  startedAt:  string | null;
  updatedAt:  string | null;
  error:      string | null;
}

const progress: RefreshProgress = {
  active: false, phase: 'idle', step: '', current: 0, total: 0,
  inserted: 0, startedAt: null, updatedAt: null, error: null,
};

export function getRefreshProgress(): RefreshProgress { return { ...progress }; }

function startProgress(phase: string, total: number) {
  progress.active    = true;
  progress.phase     = phase;
  progress.step      = '';
  progress.current   = 0;
  progress.total     = total;
  progress.inserted  = 0;
  progress.startedAt = new Date().toISOString();
  progress.updatedAt = progress.startedAt;
  progress.error     = null;
}

function tickProgress(step: string, inserted: number) {
  progress.current++;
  progress.step      = step;
  progress.inserted += inserted;
  progress.updatedAt = new Date().toISOString();
}

function endProgress(error?: string) {
  progress.active    = false;
  progress.step      = error ? 'Error' : 'Completo';
  progress.error     = error ?? null;
  progress.updatedAt = new Date().toISOString();
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
