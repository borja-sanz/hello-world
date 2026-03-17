/**
 * Seed competitor locations from Overpass API (OpenStreetMap)
 *
 * Fetches supermarkets in Guatemala and maps known chains to competitor records.
 * Falls back to a curated static dataset if the Overpass API is unavailable.
 */

import { Pool } from 'pg';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const OVERPASS_URL = process.env.OVERPASS_API_URL || 'https://overpass-api.de/api/interpreter';

// Chain name patterns to classify competitors
const CHAIN_PATTERNS: { pattern: RegExp; chain: string }[] = [
  { pattern: /super\s*del\s*barrio/i,  chain: 'Super del Barrio' },
  { pattern: /suma\s*express/i,        chain: 'Suma Express' },
  { pattern: /\bsuma\b/i,             chain: 'Suma' },
  { pattern: /econosuper/i,            chain: 'Econosuper' },
  { pattern: /la\s*bodegona/i,         chain: 'La Bodegona' },
  { pattern: /la\s*torre/i,            chain: 'La Torre' },
  { pattern: /maxi\s*bodega/i,         chain: 'Maxi Bodega' },
  { pattern: /\bpaiz\b/i,             chain: 'Paiz' },
  { pattern: /walmart/i,              chain: 'Walmart' },
  { pattern: /despensa\s*familiar/i,  chain: 'Despensa Familiar' },
  { pattern: /maxi\s*despensa/i,      chain: 'Maxi Despensa' },
];

function classifyChain(name: string): string {
  for (const { pattern, chain } of CHAIN_PATTERNS) {
    if (pattern.test(name)) return chain;
  }
  return 'Unknown';
}

// Static fallback dataset with known competitor locations
const STATIC_COMPETITORS = [
  { name: 'Super del Barrio Zona 12', chain: 'Super del Barrio', lat: 14.5801, lng: -90.5300 },
  { name: 'Super del Barrio Mixco',   chain: 'Super del Barrio', lat: 14.6330, lng: -90.6100 },
  { name: 'Super del Barrio Villa Nueva', chain: 'Super del Barrio', lat: 14.5240, lng: -90.5900 },
  { name: 'La Bodegona Zona 11',      chain: 'La Bodegona',     lat: 14.6100, lng: -90.5400 },
  { name: 'La Bodegona Antigua',      chain: 'La Bodegona',     lat: 14.5560, lng: -90.7380 },
  { name: 'La Torre Zona 9',          chain: 'La Torre',        lat: 14.6050, lng: -90.5130 },
  { name: 'La Torre Xela',            chain: 'La Torre',        lat: 14.8320, lng: -91.5150 },
  { name: 'La Torre Escuintla',       chain: 'La Torre',        lat: 14.3000, lng: -90.7900 },
  { name: 'Suma Xela',                chain: 'Suma',            lat: 14.8390, lng: -91.5100 },
  { name: 'Suma Huehuetenango',       chain: 'Suma',            lat: 15.3200, lng: -91.4780 },
  { name: 'Suma Cobán',               chain: 'Suma',            lat: 15.4700, lng: -90.3780 },
  { name: 'Suma Express Zona 1',      chain: 'Suma Express',    lat: 14.6410, lng: -90.5110 },
  { name: 'Maxi Bodega Zona 7',       chain: 'Maxi Bodega',     lat: 14.6250, lng: -90.5550 },
  { name: 'Econosuper Chimaltenango', chain: 'Econosuper',      lat: 14.6620, lng: -90.8200 },
  { name: 'Econosuper Jalapa',        chain: 'Econosuper',      lat: 14.6340, lng: -89.9870 },
  { name: 'Paiz Zona 10',             chain: 'Paiz',            lat: 14.5990, lng: -90.5160 },
  { name: 'Paiz Miraflores',          chain: 'Paiz',            lat: 14.5990, lng: -90.5450 },
  { name: 'Walmart Aguilar Batres',   chain: 'Walmart',         lat: 14.5930, lng: -90.5430 },
  { name: 'Walmart Pradera Xela',     chain: 'Walmart',         lat: 14.8410, lng: -91.5100 },
];

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function fetchFromOverpass(): Promise<OverpassElement[]> {
  const query = `
[out:json][timeout:60];
area["name"="Guatemala"]["boundary"="administrative"]["admin_level"="2"]->.guatemala;
(
  node["shop"="supermarket"](area.guatemala);
  way["shop"="supermarket"](area.guatemala);
  node["shop"="department_store"]["name"~"despensa|bodega|super|walmart|paiz|suma|bodegona|torre",i](area.guatemala);
);
out center;
  `.trim();

  const response = await axios.post(OVERPASS_URL, `data=${encodeURIComponent(query)}`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 70000,
  });

  return response.data.elements || [];
}

async function seedCompetitors(): Promise<void> {
  const client = await pool.connect();

  try {
    let records: Array<{
      name: string; chain: string; lat: number; lng: number; osmId?: number; source: string;
    }> = [];

    console.log('Fetching competitor data from Overpass API...');
    try {
      const elements = await fetchFromOverpass();
      console.log(`Overpass returned ${elements.length} elements`);

      for (const el of elements) {
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        const name = el.tags?.name || el.tags?.['name:es'] || 'Unknown';

        if (!lat || !lon) continue;
        if (!el.tags?.['shop']) continue;

        records.push({
          name,
          chain: classifyChain(name),
          lat,
          lng: lon,
          osmId: el.id,
          source: 'osm',
        });
      }
    } catch (err: any) {
      console.warn(`Overpass failed: ${err.message} — using static fallback data`);
      records = STATIC_COMPETITORS.map(c => ({ ...c, source: 'manual' as const }));
    }

    console.log(`Processing ${records.length} competitor records...`);

    await client.query('BEGIN');
    let upserted = 0;

    for (const r of records) {
      await client.query(
        `INSERT INTO competitors (name, chain, lat, lng, osm_id, source, verified)
         VALUES ($1, $2, $3, $4, $5, $6, false)
         ON CONFLICT (osm_id) DO UPDATE SET
           name    = EXCLUDED.name,
           chain   = EXCLUDED.chain,
           lat     = EXCLUDED.lat,
           lng     = EXCLUDED.lng,
           source  = EXCLUDED.source
         WHERE competitors.verified = false`,
        [r.name, r.chain, r.lat, r.lng, r.osmId ?? null, r.source]
      );
      upserted++;
    }

    await client.query('COMMIT');
    console.log(`Upserted ${upserted} competitor records`);

    // Log the refresh
    await client.query(
      `INSERT INTO osm_refresh_log (query_type, records_fetched, status)
       VALUES ('competitors', $1, 'success')`,
      [records.length]
    );

  } catch (err) {
    await client.query('ROLLBACK');
    await client.query(
      `INSERT INTO osm_refresh_log (query_type, records_fetched, status, error_msg)
       VALUES ('competitors', 0, 'error', $1)`,
      [String(err)]
    );
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

(async () => {
  try {
    await seedCompetitors();
    console.log('Competitor seed complete');
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
})();
