import { pool } from '../db';

export interface Store {
  id: number;
  name: string;
  format: string;
  chain: string | null;
  lat: number;
  lng: number;
  status: string;
  open_date: string | null;
  address: string | null;
  department: string | null;
  municipio: string | null;
  notes: string | null;
  performance: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateStoreInput {
  name: string;
  format: string;
  lat: number;
  lng: number;
  chain?: string;
  status?: string;
  open_date?: string;
  address?: string;
  department?: string;
  municipio?: string;
  notes?: string;
}

export async function listStores(filters: {
  format?: string;
  status?: string;
  department?: string;
} = {}): Promise<Store[]> {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters.format) {
    params.push(filters.format);
    conditions.push(`format = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filters.department) {
    params.push(`%${filters.department}%`);
    conditions.push(`department ILIKE $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT id, name, format, chain, lat, lng, status, open_date, address,
            department, municipio, notes, performance, created_at, updated_at
     FROM stores ${where}
     ORDER BY name`,
    params
  );
  return result.rows;
}

export async function getStoreById(id: number): Promise<Store | null> {
  const result = await pool.query(
    `SELECT id, name, format, chain, lat, lng, status, open_date, address,
            department, municipio, notes, performance, created_at, updated_at
     FROM stores WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function createStore(input: CreateStoreInput): Promise<Store> {
  const result = await pool.query(
    `INSERT INTO stores (name, format, chain, lat, lng, status, open_date, address, department, municipio, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, name, format, chain, lat, lng, status, open_date, address,
               department, municipio, notes, performance, created_at, updated_at`,
    [
      input.name, input.format, input.chain ?? null,
      input.lat, input.lng, input.status ?? 'open',
      input.open_date ?? null, input.address ?? null,
      input.department ?? null, input.municipio ?? null, input.notes ?? null,
    ]
  );
  return result.rows[0];
}

export async function updateStore(
  id: number,
  input: Partial<CreateStoreInput> & { performance?: string }
): Promise<Store | null> {
  const fields: string[] = [];
  const params: any[] = [];

  const allowed = [
    'name', 'format', 'chain', 'lat', 'lng', 'status',
    'open_date', 'address', 'department', 'municipio', 'notes', 'performance',
  ];

  for (const key of allowed) {
    if (key in input && (input as any)[key] !== undefined) {
      params.push((input as any)[key]);
      fields.push(`${key} = $${params.length}`);
    }
  }

  if (fields.length === 0) return getStoreById(id);

  params.push(id);
  const result = await pool.query(
    `UPDATE stores SET ${fields.join(', ')}
     WHERE id = $${params.length}
     RETURNING id, name, format, chain, lat, lng, status, open_date, address,
               department, municipio, notes, performance, created_at, updated_at`,
    params
  );
  return result.rows[0] ?? null;
}

export async function deleteStore(id: number): Promise<boolean> {
  const result = await pool.query('DELETE FROM stores WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function bulkCreateStores(inputs: CreateStoreInput[]): Promise<{
  inserted: number;
  skipped: number;
}> {
  if (inputs.length === 0) return { inserted: 0, skipped: 0 };

  const client = await pool.connect();
  let inserted = 0;
  let skipped = 0;

  try {
    await client.query('BEGIN');

    for (const input of inputs) {
      // Skip duplicates by exact name+lat+lng
      const existing = await client.query(
        `SELECT id FROM stores WHERE name = $1 AND lat = $2 AND lng = $3`,
        [input.name, input.lat, input.lng]
      );

      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

      await client.query(
        `INSERT INTO stores (name, format, chain, lat, lng, status, open_date, address, department, municipio, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          input.name, input.format, input.chain ?? null,
          input.lat, input.lng, input.status ?? 'open',
          input.open_date ?? null, input.address ?? null,
          input.department ?? null, input.municipio ?? null, input.notes ?? null,
        ]
      );
      inserted++;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { inserted, skipped };
}

export async function getStoresGeoJSON(): Promise<object> {
  const result = await pool.query(`
    SELECT json_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(json_agg(
        json_build_object(
          'type', 'Feature',
          'geometry', ST_AsGeoJSON(geometry)::json,
          'properties', json_build_object(
            'id', id, 'name', name, 'format', format,
            'status', status, 'department', department,
            'municipio', municipio, 'performance', performance
          )
        )
      ) FILTER (WHERE geometry IS NOT NULL), '[]')
    ) AS geojson
    FROM stores
  `);
  return result.rows[0]?.geojson ?? { type: 'FeatureCollection', features: [] };
}

/** Count stores within radius grouped by format */
export async function countStoresNear(
  lat: number,
  lng: number,
  radiusKm: number
): Promise<{ format: string; count: number; nearest_km: number }[]> {
  const result = await pool.query(
    `SELECT format,
            COUNT(*) AS count,
            ROUND(MIN(ST_Distance(geometry::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography)) / 1000) AS nearest_km
     FROM stores
     WHERE geometry IS NOT NULL
       AND ST_DWithin(
         geometry::geography,
         ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
         $3 * 1000
       )
     GROUP BY format
     ORDER BY count DESC`,
    [lat, lng, radiusKm]
  );
  return result.rows.map(r => ({
    format: r.format,
    count: parseInt(r.count),
    nearest_km: parseInt(r.nearest_km),
  }));
}
