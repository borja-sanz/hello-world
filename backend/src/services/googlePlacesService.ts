/**
 * Google Places API Integration — Competitor Discovery
 *
 * Uses the Places Text Search API to find competitor supermarket chains
 * across Guatemala. Far better coverage than OSM for Central American retail.
 *
 * Pricing: ~$0.017 per Text Search request, ~$0.03 per Nearby Search.
 * A full sync (8 chains × 3 pages each) costs roughly $0.40.
 *
 * API key: passed per-request from the Admin Panel (no redeploy needed),
 * or set via GOOGLE_PLACES_API_KEY env var.
 */

import axios from 'axios';
import { pool } from '../db';

const PLACES_TEXT_SEARCH = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const PAGE_DELAY_MS = 2_000; // Google requires 2s between page_token requests

// Competitor chains to search for — these are the main Guatemala retail chains
// that compete with Despensa Familiar / Maxi Despensa in the D/E segment.
// Multiple queries per chain capture spelling/accent variants so Google Maps
// returns a fuller set of locations (e.g. ~200 Super del Barrio exist but a
// single query only surfaces ~60).
const COMPETITOR_CHAINS: { queries: string[]; chain: string }[] = [
  {
    chain: 'Super del Barrio',
    queries: [
      'Super del Barrio Guatemala',
      'Súper del Barrio Guatemala',
      'Mi Super del Barrio Guatemala',
      'Mi Súper del Barrio Guatemala',
    ],
  },
  {
    chain: 'La Bodegona',
    queries: [
      'La Bodegona supermercado Guatemala',
      'Bodegona supermercado Guatemala',
    ],
  },
  {
    chain: 'La Torre',
    queries: [
      'La Torre supermercado Guatemala',
      'Supermercados La Torre Guatemala',
      'Super La Torre Guatemala',
    ],
  },
  {
    chain: 'Maxi Bodega',
    queries: [
      'Maxi Bodega Guatemala',
      'Maxi Bodega supermercado Guatemala',
    ],
  },
  {
    chain: 'Suma Express',
    queries: [
      'Suma supermercado Guatemala',
      'Suma Express supermercado Guatemala',
      'Súper Suma Guatemala',
      'Súma Express Guatemala',
    ],
  },
  {
    chain: 'Econosuper',
    queries: [
      'Econosuper Guatemala',
      'Econo Super Guatemala',
      'Econosuper supermercado Guatemala',
    ],
  },
  {
    chain: 'Super Más',
    queries: [
      'Super Más Guatemala',
      'Super Mas Guatemala',
      'Supermás Guatemala',
    ],
  },
  {
    chain: 'Unisuper',
    queries: [
      'Unisuper Guatemala',
      'Uni Super Guatemala',
      'Unisuper supermercado Guatemala',
    ],
  },
];

interface PlacesResult {
  place_id: string;
  name: string;
  geometry: { location: { lat: number; lng: number } };
  formatted_address?: string;
  vicinity?: string;
}

interface PlacesResponse {
  status: string;
  results: PlacesResult[];
  next_page_token?: string;
  error_message?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchPage(query: string, apiKey: string, pageToken?: string): Promise<PlacesResponse> {
  const params: Record<string, string> = {
    query,
    key: apiKey,
    language: 'es',
    region: 'gt',
  };
  if (pageToken) params.pagetoken = pageToken;

  const { data } = await axios.get<PlacesResponse>(PLACES_TEXT_SEARCH, {
    params,
    timeout: 15_000,
  });

  return data;
}

async function fetchAllPages(
  query: string,
  apiKey: string,
  maxPages = 3
): Promise<PlacesResult[]> {
  const all: PlacesResult[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && pageToken) {
      // Google requires a short delay before the next_page_token becomes valid
      await sleep(PAGE_DELAY_MS);
    }

    const resp = await fetchPage(query, apiKey, pageToken);

    if (resp.status === 'REQUEST_DENIED') {
      throw new Error(`Google Places API denied: ${resp.error_message ?? 'check API key'}`);
    }
    if (resp.status === 'OVER_QUERY_LIMIT') {
      throw new Error('Google Places API quota exceeded');
    }
    if (resp.status !== 'OK' && resp.status !== 'ZERO_RESULTS') {
      // Non-fatal statuses like INVALID_REQUEST on bad page token
      break;
    }

    all.push(...resp.results);

    if (!resp.next_page_token) break;
    pageToken = resp.next_page_token;
  }

  return all;
}

function extractMunicipioFromAddress(address: string): { municipio: string | null; department: string | null } {
  // Google addresses for Guatemala follow: "Street, Municipio, Department, Guatemala"
  const parts = address.split(',').map(p => p.trim()).filter(Boolean);
  // Remove "Guatemala" country at the end
  const filtered = parts.filter(p => p !== 'Guatemala');
  const department = filtered.length >= 1 ? filtered[filtered.length - 1] : null;
  const municipio  = filtered.length >= 2 ? filtered[filtered.length - 2] : null;
  return { municipio, department };
}

export interface SyncResult {
  chain: string;
  found: number;
  inserted: number;
  skipped: number;
  error?: string;
}

export async function syncCompetitorChain(
  chain: string,
  queries: string | string[],
  apiKey: string
): Promise<SyncResult> {
  const result: SyncResult = { chain, found: 0, inserted: 0, skipped: 0 };
  const queryList = Array.isArray(queries) ? queries : [queries];

  // Fetch all queries and deduplicate by place_id before inserting
  const seenPlaceIds = new Set<string>();
  const places: PlacesResult[] = [];
  for (const q of queryList) {
    let pageResults: PlacesResult[];
    try {
      pageResults = await fetchAllPages(q, apiKey);
    } catch (err: any) {
      result.error = err.message;
      return result;
    }
    for (const p of pageResults) {
      if (!seenPlaceIds.has(p.place_id)) {
        seenPlaceIds.add(p.place_id);
        places.push(p);
      }
    }
    if (queryList.length > 1) await sleep(500);
  }

  result.found = places.length;
  if (places.length === 0) return result;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const place of places) {
      const { lat, lng } = place.geometry.location;
      const address = place.formatted_address ?? place.vicinity ?? null;
      const { municipio, department } = address
        ? extractMunicipioFromAddress(address)
        : { municipio: null, department: null };

      // Deduplicate by place_id stored in osm_id column as negative hash,
      // or use a separate unique constraint on (chain, lat, lng) proximity.
      // We store the place_id in the notes field and use (place_id) for conflict.
      const existing = await client.query(
        `SELECT id FROM competitors WHERE notes LIKE $1 LIMIT 1`,
        [`%place_id:${place.place_id}%`]
      );

      if (existing.rows.length > 0) {
        result.skipped++;
        continue;
      }

      await client.query(
        `INSERT INTO competitors
           (name, chain, lat, lng, address, municipio, department, source, verified, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'google_places', true, $8)`,
        [
          place.name,
          chain,
          lat,
          lng,
          address,
          municipio,
          department,
          `place_id:${place.place_id}`,
        ]
      );
      result.inserted++;
    }

    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK');
    result.error = err.message;
    result.inserted = 0;
  } finally {
    client.release();
  }

  return result;
}

export async function syncAllCompetitors(apiKey: string): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  for (const { queries, chain } of COMPETITOR_CHAINS) {
    console.log(`[googlePlaces] Searching: ${chain} (${queries.length} queries)...`);
    const r = await syncCompetitorChain(chain, queries, apiKey);
    results.push(r);
    console.log(
      `[googlePlaces] ${chain}: found=${r.found} inserted=${r.inserted} skipped=${r.skipped}${r.error ? ` error=${r.error}` : ''}`
    );
    // Brief pause between chains to be polite to the API
    await sleep(500);
  }

  return results;
}

export { COMPETITOR_CHAINS };
