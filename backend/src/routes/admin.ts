import { Router, Request, Response, NextFunction } from 'express';
import * as fs   from 'fs';
import * as path from 'path';
import { fromFile } from 'geotiff';
import { pool } from '../db';
import { scoreAllMunicipios, loadCalibrationConfig } from '../services/scoringEngine';
import { syncAllCompetitors, syncCompetitorChain, COMPETITOR_CHAINS } from '../services/googlePlacesService';
import { AppError } from '../middleware/errorHandler';

const router = Router();

/** GET /api/admin/config — current calibration config */
router.get('/config', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT * FROM calibration_config WHERE is_active = true ORDER BY id DESC LIMIT 1`
    );
    if (result.rows.length === 0) throw new AppError(404, 'No calibration config found');
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

/** PUT /api/admin/config — update calibration weights and thresholds */
router.put('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      weight_population, weight_mobility, weight_commercial,
      weight_competition, weight_socioeconomic,
      despensa_familiar_min_pop, maxi_despensa_min_pop,
      mobility_override_threshold, commercial_override_threshold,
    } = req.body;

    // Validate weights sum to ~1.0
    const weights = [
      weight_population, weight_mobility, weight_commercial,
      weight_competition, weight_socioeconomic,
    ].map(Number).filter(n => !isNaN(n));

    if (weights.length === 5) {
      const total = weights.reduce((s, w) => s + w, 0);
      if (Math.abs(total - 1.0) > 0.01) {
        throw new AppError(400, `Weights must sum to 1.0 (got ${total.toFixed(3)})`);
      }
    }

    const result = await pool.query(
      `UPDATE calibration_config
       SET
         weight_population            = COALESCE($1, weight_population),
         weight_mobility              = COALESCE($2, weight_mobility),
         weight_commercial            = COALESCE($3, weight_commercial),
         weight_competition           = COALESCE($4, weight_competition),
         weight_socioeconomic         = COALESCE($5, weight_socioeconomic),
         despensa_familiar_min_pop    = COALESCE($6, despensa_familiar_min_pop),
         maxi_despensa_min_pop        = COALESCE($7, maxi_despensa_min_pop),
         mobility_override_threshold  = COALESCE($8, mobility_override_threshold),
         commercial_override_threshold= COALESCE($9, commercial_override_threshold),
         updated_at                   = NOW()
       WHERE is_active = true
       RETURNING *`,
      [
        weight_population ?? null, weight_mobility ?? null, weight_commercial ?? null,
        weight_competition ?? null, weight_socioeconomic ?? null,
        despensa_familiar_min_pop ?? null, maxi_despensa_min_pop ?? null,
        mobility_override_threshold ?? null, commercial_override_threshold ?? null,
      ]
    );

    res.json({ message: 'Configuration updated', config: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/config/reset — reset to real-data-v2 calibrated defaults */
router.post('/config/reset', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `UPDATE calibration_config SET
         weight_population = 0.28, weight_mobility = 0.22, weight_commercial = 0.22,
         weight_competition = 0.15, weight_socioeconomic = 0.13,
         despensa_familiar_min_pop = 24000, maxi_despensa_min_pop = 55000,
         mobility_override_threshold = 0.80, commercial_override_threshold = 0.85,
         name = 'real-data-v2', updated_at = NOW()
       WHERE is_active = true
       RETURNING *`
    );
    res.json({ message: 'Configuration reset to defaults', config: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/recalculate — trigger full rescore of all municipios */
router.post('/recalculate', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ message: 'Recalculation started — check /api/scoring/municipios in ~60s', status: 'running' });
    const count = await scoreAllMunicipios();
    console.log(`Admin recalculate complete: ${count} municipios`);
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/stores/summary — store counts by format */
router.get('/stores/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT format,
              COUNT(*)                                      AS total,
              COUNT(*) FILTER (WHERE status = 'open')      AS open,
              COUNT(*) FILTER (WHERE status = 'planned')   AS planned,
              COUNT(*) FILTER (WHERE status = 'closed')    AS closed
       FROM stores GROUP BY format ORDER BY total DESC`
    );
    const grand = await pool.query(`SELECT COUNT(*) AS total FROM stores`);
    res.json({ formats: result.rows, total: parseInt(grand.rows[0].total) });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/admin/stores/all — remove all stores to allow re-import of real network.
 *  Body: { confirm: "BORRAR" } required to prevent accidental calls. */
router.delete('/stores/all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.body?.confirm !== 'BORRAR') {
      throw new AppError(400, 'Send { "confirm": "BORRAR" } to confirm');
    }
    const result = await pool.query('DELETE FROM stores RETURNING id');
    res.json({ deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/reclaim-own-stores
 * Moves misclassified own-brand competitors into the stores table.
 * Targets rows in competitors whose chain or name matches our known brand names.
 */
router.post('/reclaim-own-stores', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Find all competitors that are actually our stores
    const found = await pool.query(`
      SELECT id, name, chain, lat, lng, address, municipio, department
      FROM competitors
      WHERE chain ILIKE ANY(ARRAY['%Maxi Despensa%','%Maxi Bodega%','%Despensa Familiar%'])
         OR name  ILIKE ANY(ARRAY['%Maxi Despensa%','%Maxi Bodega%','%Despensa Familiar%'])
    `);

    if (found.rows.length === 0) {
      return res.json({ moved: 0, message: 'No se encontraron tiendas propias mal clasificadas.' });
    }

    const client = await pool.connect();
    let moved = 0;
    try {
      await client.query('BEGIN');

      for (const row of found.rows) {
        // Map chain/name to the correct store format
        const nameUpper = ((row.chain || '') + ' ' + (row.name || '')).toUpperCase();
        let format: string;
        if (nameUpper.includes('MAXI')) {
          format = 'Maxi Despensa';
        } else {
          format = 'Despensa Familiar';
        }

        await client.query(
          `INSERT INTO stores (name, format, chain, lat, lng, address, municipio, department, status, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', 'reclaimed')
           ON CONFLICT DO NOTHING`,
          [row.name, format, format, row.lat, row.lng,
           row.address ?? null, row.municipio ?? null, row.department ?? null]
        );

        await client.query('DELETE FROM competitors WHERE id = $1', [row.id]);
        moved++;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ moved, message: `${moved} tienda(s) propia(s) movidas de competidores a tiendas.` });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/stats — system stats */
router.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM stores)                                                  AS store_count,
        (SELECT COUNT(*) FROM stores WHERE status='open')                              AS open_stores,
        (SELECT COUNT(*) FROM stores WHERE performance IS NOT NULL)                    AS tagged_stores,
        (SELECT COUNT(*) FROM competitors)                                             AS competitor_count,
        (SELECT COUNT(DISTINCT chain) FROM competitors)                                AS competitor_chains,
        (SELECT COUNT(*) FROM municipios)                                              AS municipio_count,
        (SELECT COUNT(*) FROM municipios WHERE drive_time_capital_min IS NOT NULL)     AS drive_time_coverage,
        (SELECT COUNT(*) FROM opportunity_scores)                                      AS score_records,
        (SELECT COUNT(*) FROM poi_cache)                                               AS poi_count,
        (SELECT COUNT(*) FROM poi_cache WHERE source = 'google_places')                AS google_poi_count,
        (SELECT COUNT(*) FROM poi_cache WHERE poi_type = 'marketplace')                AS mercado_count,
        (SELECT MAX(calculated_at) FROM opportunity_scores)                            AS last_scored_at,
        (SELECT MAX(fetched_at) FROM poi_cache WHERE source = 'google_places')         AS last_google_poi_refresh
    `);
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// ─── Google Places competitor sync ────────────────────────────────────────────

/** GET /api/admin/google-places/chains — list chains that will be searched */
router.get('/google-places/chains', (_req: Request, res: Response) => {
  res.json({ chains: COMPETITOR_CHAINS.map(c => ({ chain: c.chain, queries: c.queries })) });
});

/** POST /api/admin/google-places/sync — sync all competitor chains from Google Places.
 *  Body: { api_key: string }  (falls back to GOOGLE_PLACES_API_KEY env var) */
router.post('/google-places/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = (req.body?.api_key as string | undefined)?.trim()
      || process.env.GOOGLE_PLACES_API_KEY;

    if (!apiKey) {
      throw new AppError(400, 'Provide api_key in request body or set GOOGLE_PLACES_API_KEY env var');
    }

    // Respond immediately so the client knows it started; full sync takes ~30s
    res.json({ message: 'Google Places sync started', status: 'running' });

    // Run async — results logged to console
    syncAllCompetitors(apiKey).then(results => {
      const total = results.reduce((s, r) => s + r.inserted, 0);
      console.log(`[googlePlaces] Sync complete: ${total} competitors inserted across ${results.length} chains`);
    }).catch(err => {
      console.error('[googlePlaces] Sync error:', err.message);
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/google-places/sync-chain — sync a single chain synchronously.
 *  Body: { api_key: string, chain: string } */
router.post('/google-places/sync-chain', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = (req.body?.api_key as string | undefined)?.trim()
      || process.env.GOOGLE_PLACES_API_KEY;
    const chainName = req.body?.chain as string | undefined;

    if (!apiKey) throw new AppError(400, 'api_key is required');
    if (!chainName) throw new AppError(400, 'chain is required');

    const entry = COMPETITOR_CHAINS.find(c => c.chain === chainName);
    if (!entry) throw new AppError(400, `Unknown chain "${chainName}". Call GET /api/admin/google-places/chains for valid options.`);

    const result = await syncCompetitorChain(chainName, entry.queries, apiKey);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/load-viirs — load real VIIRS GeoTIFF into ntl_settlements.
 *  Header: Authorization: Bearer <ADMIN_SECRET>
 *  Body (optional): { "tif_path": "/absolute/path/to/file.tif" }
 */
router.post('/load-viirs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Auth check
    const secret = process.env.ADMIN_SECRET;
    const auth   = req.headers.authorization;
    if (secret && auth !== `Bearer ${secret}`) {
      throw new AppError(401, 'Unauthorized — provide Authorization: Bearer <ADMIN_SECRET>');
    }

    // Resolve tif path — try caller-supplied path first, then common locations
    const candidates: string[] = [
      req.body?.tif_path,
      path.resolve(process.cwd(), 'data', 'viirs_ntl_guatemala_2023.tif'),
      path.resolve(process.cwd(), '..', 'data', 'viirs_ntl_guatemala_2023.tif'),
      path.resolve(__dirname, '../../../../data', 'viirs_ntl_guatemala_2023.tif'),
      path.resolve(__dirname, '../../../data', 'viirs_ntl_guatemala_2023.tif'),
    ].filter(Boolean) as string[];

    const tifPath = candidates.find(p => fs.existsSync(p));
    if (!tifPath) {
      throw new AppError(404,
        `GeoTIFF not found. Tried: ${candidates.join(', ')}. ` +
        `Pass { "tif_path": "/absolute/path" } in the request body to override.`
      );
    }

    const NTL_CALIB   = 180 * 4.2;
    const NODATA_LOW  = -9999;
    const NODATA_HIGH = 200000;

    const tiff  = await fromFile(tifPath);
    const image = await tiff.getImage();
    const bbox  = image.getBoundingBox();
    const [west, south, east, north] = bbox;
    const width  = image.getWidth();
    const height = image.getHeight();
    const pixelW = (east  - west)  / width;
    const pixelH = (north - south) / height;

    const rasters = await image.readRasters();
    const band    = rasters[0] as Float32Array | Int16Array | Uint16Array;

    const { rows: settlements } = await pool.query<{ id: number; lat: string; lng: string }>(
      'SELECT id, lat, lng FROM ntl_settlements ORDER BY id'
    );

    let updated = 0;
    let skipped = 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of settlements) {
        const lat = parseFloat(s.lat);
        const lng = parseFloat(s.lng);
        if (lng < west || lng > east || lat < south || lat > north) { skipped++; continue; }
        const col = Math.floor((lng  - west)  / pixelW);
        const row = Math.floor((north - lat)  / pixelH);
        const c   = Math.max(0, Math.min(width  - 1, col));
        const r   = Math.max(0, Math.min(height - 1, row));
        const raw = band[r * width + c];
        if (raw == null || raw <= NODATA_LOW || raw >= NODATA_HIGH) { skipped++; continue; }
        const radiance     = Math.round(raw  * 1000) / 1000;
        const estimatedPop = Math.round(radiance * NTL_CALIB);
        await client.query(
          `UPDATE ntl_settlements SET radiance_ntl=$1, estimated_pop=$2, ntl_source='viirs_2023' WHERE id=$3`,
          [radiance, estimatedPop, s.id]
        );
        updated++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({
      message : 'VIIRS data loaded successfully',
      tif_path: tifPath,
      extent  : { west, south, east, north },
      size    : { width, height },
      updated,
      skipped,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/migrate — apply missing schema columns to production DB.
 *  Safe to run multiple times (uses IF NOT EXISTS).
 *  Header: Authorization: Bearer <ADMIN_SECRET>
 */
router.post('/migrate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const secret = process.env.ADMIN_SECRET;
    const auth   = req.headers.authorization;
    if (secret && auth !== `Bearer ${secret}`) {
      throw new AppError(401, 'Unauthorized — provide Authorization: Bearer <ADMIN_SECRET>');
    }

    const migrations: { name: string; sql: string }[] = [
      {
        name: 'poi_cache.source column',
        sql:  `ALTER TABLE poi_cache ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'osm'`,
      },
      {
        name: 'municipios.drive_time_capital_min column',
        sql:  `ALTER TABLE municipios ADD COLUMN IF NOT EXISTS drive_time_capital_min INTEGER`,
      },
      {
        name: 'municipios.drive_time_capital_min index',
        sql:  `CREATE INDEX IF NOT EXISTS municipios_drive_time_idx ON municipios (drive_time_capital_min) WHERE drive_time_capital_min IS NOT NULL`,
      },
    ];

    const results: { name: string; status: string; error?: string }[] = [];
    for (const m of migrations) {
      try {
        await pool.query(m.sql);
        results.push({ name: m.name, status: 'ok' });
      } catch (err: any) {
        results.push({ name: m.name, status: 'error', error: err.message });
      }
    }

    res.json({ message: 'Migration complete', results });
  } catch (err) {
    next(err);
  }
});

export default router;
