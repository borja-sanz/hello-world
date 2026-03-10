import { Router, Request, Response, NextFunction } from 'express';
import * as fs   from 'fs';
import * as path from 'path';
import axios from 'axios';
import { fromFile } from 'geotiff';
import { pool } from '../db';
import { scoreAllMunicipios, loadCalibrationConfig } from '../services/scoringEngine';
import { syncAllCompetitors, syncCompetitorChain, COMPETITOR_CHAINS } from '../services/googlePlacesService';
import { exportPoiCacheSeed, importPoiCacheSeed } from '../scripts/poiSeed';
import { getRefreshLog } from '../services/googlePoiService';
import { seedPoiCacheFromOsm } from '../scripts/autoSeed';
import { AppError } from '../middleware/errorHandler';
import {
  generateAllIsochrones,
  getIsochroneCoverage,
  fetchAndSaveIsochrone,
} from '../services/isochroneService';

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

/** DELETE /api/admin/competitors/all — remove all competitors to allow CSV re-import.
 *  Body: { confirm: "BORRAR" } required to prevent accidental calls. */
router.delete('/competitors/all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.body?.confirm !== 'BORRAR') {
      throw new AppError(400, 'Send { "confirm": "BORRAR" } to confirm');
    }
    const result = await pool.query('DELETE FROM competitors RETURNING id');
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
        // Derive format from the store name only — the chain field in competitors
        // was often set generically (e.g. all labelled "Maxi Despensa") so we
        // must NOT use it for format detection.
        const nameUpper = (row.name || '').toUpperCase();
        let format: string;
        if (nameUpper.includes('MAXI')) {
          format = 'Maxi Despensa';
        } else if (nameUpper.includes('DESPENSA FAMILIAR')) {
          format = 'Despensa Familiar';
        } else {
          // Fallback: check original chain value only if name gives no signal
          format = (row.chain || '').toUpperCase().includes('MAXI')
            ? 'Maxi Despensa'
            : 'Despensa Familiar';
        }

        // Skip if an identical store already exists (same name + coords)
        const existing = await client.query(
          `SELECT id FROM stores WHERE name = $1 AND ROUND(lat::numeric,4) = ROUND($2::numeric,4) AND ROUND(lng::numeric,4) = ROUND($3::numeric,4)`,
          [row.name, row.lat, row.lng]
        );
        if (existing.rows.length === 0) {
          await client.query(
            `INSERT INTO stores (name, format, chain, lat, lng, address, municipio, department, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open')`,
            [row.name, format, format, row.lat, row.lng,
             row.address ?? null, row.municipio ?? null, row.department ?? null]
          );
        }

        await client.query('DELETE FROM competitors WHERE id = $1', [row.id]);
        moved++;
      }

      // Also correct any already-moved stores whose format was wrongly set:
      // - name contains "Despensa Familiar" but format says "Maxi Despensa" → fix to Despensa Familiar
      // - name contains "Maxi"              but format says "Despensa Familiar" → fix to Maxi Despensa
      const fixResult = await client.query(`
        UPDATE stores SET
          format = CASE
            WHEN name ILIKE '%Despensa Familiar%' THEN 'Despensa Familiar'
            WHEN name ILIKE '%Maxi%'              THEN 'Maxi Despensa'
            ELSE format
          END,
          chain = CASE
            WHEN name ILIKE '%Despensa Familiar%' THEN 'Despensa Familiar'
            WHEN name ILIKE '%Maxi%'              THEN 'Maxi Despensa'
            ELSE chain
          END
        WHERE (name ILIKE '%Despensa Familiar%' OR name ILIKE '%Maxi Despensa%' OR name ILIKE '%Maxi Bodega%')
          AND (
            (name ILIKE '%Despensa Familiar%' AND format != 'Despensa Familiar') OR
            (name ILIKE '%Maxi%'              AND format != 'Maxi Despensa')
          )
        RETURNING id
      `);
      const fixed = fixResult.rowCount ?? 0;

      await client.query('COMMIT');
      res.json({
        moved,
        fixed,
        message: `${moved} tienda(s) movidas de competidores. ${fixed > 0 ? `${fixed} formato(s) corregido(s) en tiendas existentes.` : ''}`.trim(),
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/fix-store-formats
 * Corrects the format field for own-brand stores based on their name alone.
 * Safe to run any number of times.
 */
router.post('/fix-store-formats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(`
      UPDATE stores SET
        format = CASE
          WHEN name ILIKE '%Despensa Familiar%' THEN 'Despensa Familiar'
          WHEN name ILIKE '%Maxi Despensa%'     THEN 'Maxi Despensa'
          WHEN name ILIKE '%Maxi Bodega%'       THEN 'Maxi Despensa'
          ELSE format
        END,
        chain = CASE
          WHEN name ILIKE '%Despensa Familiar%' THEN 'Despensa Familiar'
          WHEN name ILIKE '%Maxi Despensa%'     THEN 'Maxi Despensa'
          WHEN name ILIKE '%Maxi Bodega%'       THEN 'Maxi Despensa'
          ELSE chain
        END
      WHERE name ILIKE '%Despensa Familiar%'
         OR name ILIKE '%Maxi Despensa%'
         OR name ILIKE '%Maxi Bodega%'
      RETURNING id, name, format
    `);
    res.json({
      fixed: result.rowCount ?? 0,
      message: `${result.rowCount ?? 0} formato(s) de tiendas corregido(s).`,
      stores: result.rows,
    });
  } catch (err) {
    next(err);
  }
});

const OVERPASS_URL = process.env.OVERPASS_API_URL || 'https://overpass-api.de/api/interpreter';
const NTL_CALIB   = 756; // 180 hh/nW × 4.2 persons/hh (INE 2018)

// Fallback places when Overpass is unreachable — covers all 22 departments
// with enough towns that every municipio gets at least one sub-point.
const NTL_FALLBACK_PLACES = [
  // Guatemala dept
  { name: 'Mixco',                lat: 14.6350, lng: -90.5950, pop: 473080 },
  { name: 'Villa Nueva',          lat: 14.5286, lng: -90.5897, pop: 618397 },
  { name: 'San Juan Sacatepéquez',lat: 14.7200, lng: -90.6450, pop: 248019 },
  { name: 'Chinautla',            lat: 14.7000, lng: -90.4900, pop: 141836 },
  { name: 'Amatitlán',            lat: 14.4800, lng: -90.6200, pop:  98169 },
  { name: 'San Miguel Petapa',    lat: 14.5030, lng: -90.5550, pop: 185854 },
  { name: 'Villa Canales',        lat: 14.4800, lng: -90.5300, pop: 162404 },
  { name: 'Palencia',             lat: 14.6700, lng: -90.3700, pop:  66713 },
  { name: 'Santa Catarina Pinula',lat: 14.5700, lng: -90.4800, pop: 116153 },
  // Sacatepéquez
  { name: 'Antigua Guatemala',    lat: 14.5582, lng: -90.7341, pop:  45669 },
  { name: 'Ciudad Vieja',         lat: 14.5180, lng: -90.7670, pop:  39695 },
  { name: 'San Lucas Sacatepéquez',lat:14.6100, lng: -90.6600, pop:  28000 },
  // Chimaltenango
  { name: 'Chimaltenango',        lat: 14.6619, lng: -90.8211, pop: 121105 },
  { name: 'San Andrés Itzapa',    lat: 14.6200, lng: -90.8600, pop:  32000 },
  { name: 'Patzún',               lat: 14.6800, lng: -91.0000, pop:  51000 },
  { name: 'Tecpán Guatemala',     lat: 14.7600, lng: -90.9900, pop:  76000 },
  // Escuintla
  { name: 'Escuintla',            lat: 14.3011, lng: -90.7870, pop: 148809 },
  { name: 'Santa Lucía Cotzumal.',lat: 14.3310, lng: -90.7230, pop:  77000 },
  { name: 'Puerto San José',      lat: 13.9270, lng: -90.8290, pop:  42000 },
  { name: 'Palín',                lat: 14.4058, lng: -90.6965, pop:  55597 },
  // Santa Rosa
  { name: 'Barberena',            lat: 14.3150, lng: -90.3380, pop:  46450 },
  { name: 'Cuilapa',              lat: 14.2780, lng: -90.2990, pop:  45000 },
  { name: 'Chiquimulilla',        lat: 14.0870, lng: -90.3810, pop:  46000 },
  // Sololá
  { name: 'Sololá',               lat: 14.7760, lng: -91.1840, pop:  88749 },
  { name: 'Panajachel',           lat: 14.7400, lng: -91.1581, pop:  18000 },
  { name: 'San Pedro La Laguna',  lat: 14.6980, lng: -91.2700, pop:  15000 },
  // Totonicapán
  { name: 'Totonicapán',          lat: 14.9128, lng: -91.3600, pop:  90839 },
  { name: 'San Cristóbal T.',     lat: 14.9650, lng: -91.4400, pop:  42000 },
  // Quetzaltenango
  { name: 'Quetzaltenango',       lat: 14.8434, lng: -91.5179, pop: 180706 },
  { name: 'Coatepeque',           lat: 14.7030, lng: -91.8570, pop: 111586 },
  { name: 'Cantel',               lat: 14.8200, lng: -91.4700, pop:  30000 },
  { name: 'Almolonga',            lat: 14.8060, lng: -91.4920, pop:  14000 },
  // San Marcos
  { name: 'San Marcos',           lat: 14.9601, lng: -91.7959, pop:  54000 },
  { name: 'Malacatán',            lat: 15.0190, lng: -92.0560, pop: 101635 },
  { name: 'Ayutla (Tecún Umán)',  lat: 14.9290, lng: -92.1410, pop:  55000 },
  { name: 'San Pedro Sacatepéq.', lat: 14.9700, lng: -91.7830, pop:  31000 },
  // Huehuetenango
  { name: 'Huehuetenango',        lat: 15.3207, lng: -91.4703, pop: 102801 },
  { name: 'La Democracia',        lat: 15.3300, lng: -91.7200, pop:  30000 },
  { name: 'Santa Eulalia',        lat: 15.7300, lng: -91.4700, pop:  37000 },
  { name: 'Jacaltenango',         lat: 15.6600, lng: -91.7300, pop:  34000 },
  { name: 'Barillas',             lat: 15.7960, lng: -91.3110, pop:  83000 },
  // Quiché
  { name: 'Santa Cruz del Quiché',lat: 15.0325, lng: -91.1474, pop: 163954 },
  { name: 'Chichicastenango',     lat: 14.9442, lng: -91.1132, pop: 149028 },
  { name: 'Nebaj',                lat: 15.4047, lng: -91.1374, pop:  67000 },
  { name: 'Joyabaj',              lat: 14.9900, lng: -90.8000, pop:  59000 },
  { name: 'Uspantán',             lat: 15.3480, lng: -90.8660, pop:  47000 },
  // Baja Verapaz
  { name: 'Salamá',               lat: 15.1041, lng: -90.3153, pop:  58033 },
  { name: 'Rabinal',              lat: 15.0890, lng: -90.4940, pop:  32000 },
  // Alta Verapaz
  { name: 'Cobán',                lat: 15.4695, lng: -90.3790, pop: 255629 },
  { name: 'Chisec',               lat: 15.8150, lng: -90.2990, pop:  80000 },
  { name: 'Fray Bartolomé',       lat: 15.8410, lng: -89.8740, pop:  64000 },
  { name: 'Tactic',               lat: 15.3180, lng: -90.3550, pop:  30000 },
  // Petén
  { name: 'Flores',               lat: 16.9292, lng: -89.8821, pop:  25000 },
  { name: 'Santa Elena Petén',    lat: 16.9200, lng: -89.8900, pop:  45000 },
  { name: 'San Benito',           lat: 16.9200, lng: -89.9100, pop:  42000 },
  { name: 'Poptún',               lat: 16.3230, lng: -89.4260, pop:  45000 },
  { name: 'Sayaxché',             lat: 16.5280, lng: -90.1810, pop:  68000 },
  // Izabal
  { name: 'Puerto Barrios',       lat: 15.7176, lng: -88.5974, pop:  88028 },
  { name: 'Morales',              lat: 15.4750, lng: -88.8230, pop:  96000 },
  { name: 'Livingston',           lat: 15.8300, lng: -88.7500, pop:  46000 },
  // Zacapa
  { name: 'Zacapa',               lat: 14.9720, lng: -89.5270, pop:  75938 },
  { name: 'Gualán',               lat: 15.1100, lng: -89.3600, pop:  37000 },
  { name: 'Río Hondo',            lat: 15.0040, lng: -89.5800, pop:  21000 },
  // Chiquimula
  { name: 'Chiquimula',           lat: 14.7990, lng: -89.5460, pop: 113066 },
  { name: 'Esquipulas',           lat: 14.5680, lng: -89.3490, pop:  42000 },
  { name: 'Jocotán',              lat: 14.8270, lng: -89.3780, pop:  47000 },
  // Jalapa
  { name: 'Jalapa',               lat: 14.6340, lng: -89.9870, pop:  98023 },
  { name: 'San Pedro Pinula',     lat: 14.6700, lng: -89.8600, pop:  43000 },
  // Jutiapa
  { name: 'Jutiapa',              lat: 14.2895, lng: -89.8985, pop: 105579 },
  { name: 'Asunción Mita',        lat: 14.3370, lng: -89.7130, pop:  37000 },
  { name: 'Moyuta',               lat: 14.0310, lng: -89.9870, pop:  27000 },
  // Retalhuleu
  { name: 'Retalhuleu',           lat: 14.5344, lng: -91.6768, pop:  96342 },
  { name: 'Champerico',           lat: 14.2980, lng: -91.9160, pop:  32000 },
  // Suchitepéquez
  { name: 'Mazatenango',          lat: 14.5364, lng: -91.5030, pop: 108113 },
  { name: 'Samayac',              lat: 14.5970, lng: -91.4700, pop:  20000 },
  { name: 'Patulul',              lat: 14.4230, lng: -91.1680, pop:  28000 },
];

/**
 * POST /api/admin/refresh-ntl-settlements
 *
 * Re-fetches all populated places from OpenStreetMap (Overpass API) and upserts
 * them into ntl_settlements for all 254 municipios. Records tagged
 * ntl_source='admin_zones' (e.g. Guatemala City zones) are preserved.
 *
 * Uses a 100-place static fallback when Overpass is unreachable.
 * Safe to run multiple times.
 */
router.post('/refresh-ntl-settlements', async (_req: Request, res: Response, next: NextFunction) => {
  interface OsmPlace { name: string; lat: number; lng: number; pop: number; }

  async function fetchOsmPlaces(): Promise<OsmPlace[]> {
    const query = `
[out:json][timeout:90];
area["name"="Guatemala"]["boundary"="administrative"]["admin_level"="2"]->.gt;
(
  node["place"~"^(city|town|village|suburb|neighbourhood|hamlet)$"](area.gt);
);
out body;`.trim();

    const resp = await axios.post(
      OVERPASS_URL,
      `data=${encodeURIComponent(query)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 95_000 }
    );
    const FALLBACKS: Record<string, number> = {
      city: 50000, town: 15000, village: 3000,
      suburb: 8000, neighbourhood: 4000, hamlet: 800,
    };
    const out: OsmPlace[] = [];
    for (const el of (resp.data.elements || []) as Array<{
      lat?: number; lon?: number; tags?: Record<string, string>
    }>) {
      if (!el.lat || !el.lon || !el.tags?.name) continue;
      const tagPop = parseInt(el.tags.population ?? '0');
      const pop    = tagPop > 0 ? tagPop : (FALLBACKS[el.tags.place ?? ''] ?? 1000);
      if (pop < 500) continue;
      out.push({ name: el.tags.name, lat: el.lat, lng: el.lon, pop });
    }
    return out;
  }

  try {
    let places: OsmPlace[];
    let source: string;
    try {
      places = await fetchOsmPlaces();
      source = 'osm_places';
    } catch {
      places = NTL_FALLBACK_PLACES;
      source = 'synthetic';
    }

    // Remove non-admin_zones records so we can re-insert cleanly
    await pool.query(`DELETE FROM ntl_settlements WHERE ntl_source != 'admin_zones'`);

    let inserted = 0;
    for (const p of places) {
      const radiance = Math.round((p.pop / NTL_CALIB) * 1000) / 1000;
      await pool.query(
        `INSERT INTO ntl_settlements (name, municipio_id, lat, lng, radiance_ntl, estimated_pop, ntl_source)
         VALUES (
           $1,
           (SELECT id FROM municipios
            ORDER BY ST_Distance(centroid::geography, ST_SetSRID(ST_MakePoint($3,$2),4326)::geography)
            LIMIT 1),
           $2, $3, $4, $5, $6
         )`,
        [p.name, p.lat, p.lng, radiance, Math.round(p.pop), source]
      );
      inserted++;
    }

    const { rows } = await pool.query(`SELECT COUNT(*) AS c FROM ntl_settlements`);
    res.json({
      inserted,
      total: parseInt(rows[0].c),
      source,
      message: `${inserted} asentamientos actualizados (fuente: ${source === 'osm_places' ? 'OpenStreetMap live' : 'fallback estático'}). Total en DB: ${rows[0].c}.`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/seed-guatemala-zones
 *
 * Seeds Guatemala City's 22 administrative zones into ntl_settlements so the
 * sub-municipio drill-down panel shows meaningful district-level granularity
 * for the capital (which otherwise collapses to a single OSM place node).
 *
 * Population data: INE Censo 2018 + SEGEPLAN 2020 projections.
 * Coordinates: zone centroid approximations (±1 km accuracy).
 * radiance_ntl is back-calculated as estimated_pop / 756
 *   where 756 = calib_k (180 hh/nW) × household_size (4.2 persons/hh).
 *
 * Safe to run multiple times — deletes existing zone records first.
 */
router.post('/seed-guatemala-zones', async (_req: Request, res: Response, next: NextFunction) => {
  // Zones: [name, lat, lng, estimated_pop, area_km2]
  const ZONES: [string, number, number, number, number][] = [
    ['Zona 1 – Centro Histórico',     14.6409, -90.5133,  25000,   4.0],
    ['Zona 2 – La Parroquia',         14.6508, -90.5044,  30000,   6.5],
    ['Zona 3 – La Verbena',           14.6333, -90.5222,  50000,  14.0],
    ['Zona 4 – Cantón Exposición',    14.6361, -90.5128,   8000,   2.5],
    ['Zona 5 – Cantón Gerona',        14.6275, -90.5100,  28000,   6.0],
    ['Zona 6 – Cantón La Ruedita',    14.6578, -90.5119,  55000,  12.0],
    ['Zona 7 – Ciudad de Plata',      14.6389, -90.5436, 120000,  35.0],
    ['Zona 8 – Cantón Guadalupe',     14.6186, -90.5211,  20000,   5.5],
    ['Zona 9 – Cantón Bella Vista',   14.6078, -90.5256,  18000,   5.0],
    ['Zona 10 – Calzada Aguilar B.',  14.5947, -90.5044,  25000,  10.0],
    ['Zona 11 – Roosevelt',           14.6153, -90.5344,  50000,  13.0],
    ['Zona 12 – San Jorge',           14.5972, -90.5447,  65000,  18.0],
    ['Zona 13 – La Reformita',        14.5933, -90.5356,  30000,   8.5],
    ['Zona 14 – Santa Rosalía',       14.5858, -90.4986,  28000,  12.0],
    ['Zona 15 – Villa Hermosa',       14.5700, -90.4814,  35000,  14.0],
    ['Zona 16 – El Maestro',          14.5631, -90.4883,  32000,  12.0],
    ['Zona 17 – El Limón',            14.5608, -90.5264,  35000,  15.0],
    ['Zona 18 – Peronia',             14.6383, -90.5567, 180000,  85.0],
    ['Zona 19 – El Mezquital',        14.6394, -90.5717,  80000,  40.0],
    ['Zona 21 – Villa Lobos',         14.5503, -90.5456,  90000,  38.0],
    ['Zona 24 – El Naranjo',          14.6653, -90.5044,  35000,  20.0],
    ['Zona 25 – Carolingia',          14.6744, -90.5422,  75000,  30.0],
  ];

  try {
    // Find Guatemala City's municipio id (code '0101' or name 'Guatemala')
    const mResult = await pool.query(
      `SELECT id FROM municipios
       WHERE code = '0101' OR (name ILIKE 'Guatemala' AND department ILIKE 'Guatemala')
       ORDER BY code LIMIT 1`
    );
    if (mResult.rows.length === 0) {
      res.status(404).json({ error: 'No se encontró el municipio de Guatemala en la DB.' });
      return;
    }
    const municipioId: number = mResult.rows[0].id;

    // Remove previously seeded zone records so we can re-seed cleanly
    await pool.query(
      `DELETE FROM ntl_settlements
       WHERE municipio_id = $1 AND name ILIKE 'Zona %'`,
      [municipioId]
    );

    // Insert zones
    let inserted = 0;
    for (const [name, lat, lng, pop, area] of ZONES) {
      const radiance = parseFloat((pop / 756).toFixed(3));
      await pool.query(
        `INSERT INTO ntl_settlements
           (name, municipio_id, lat, lng, radiance_ntl, estimated_pop, area_km2, ntl_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'admin_zones')`,
        [name, municipioId, lat, lng, radiance, pop, area]
      );
      inserted++;
    }

    res.json({
      inserted,
      municipio_id: municipioId,
      message: `${inserted} zonas de Ciudad de Guatemala insertadas en ntl_settlements.`,
    });
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
        (SELECT MAX(fetched_at) FROM poi_cache WHERE source = 'google_places')         AS last_google_poi_refresh,
        (SELECT COUNT(DISTINCT (
           SELECT id FROM municipios m
           WHERE m.centroid IS NOT NULL
           ORDER BY m.centroid <-> ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326)
           LIMIT 1
         )) FROM stores s WHERE s.lat IS NOT NULL AND s.lng IS NOT NULL)             AS covered_municipios,
        (SELECT COUNT(*) FROM ntl_settlements)                                        AS ntl_settlement_count,
        (SELECT COUNT(*) FROM ntl_settlements WHERE ntl_source = 'viirs_2023')        AS ntl_viirs_count,
        (SELECT COUNT(*) FROM ntl_settlements WHERE ntl_source != 'viirs_2023')       AS ntl_synthetic_count
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
      {
        name: 'municipio_isochrones table',
        sql:  `CREATE TABLE IF NOT EXISTS municipio_isochrones (
          id               SERIAL PRIMARY KEY,
          municipio_id     INTEGER NOT NULL REFERENCES municipios(id) ON DELETE CASCADE,
          profile          VARCHAR(50) NOT NULL DEFAULT 'mapbox/driving',
          contour_minutes  INTEGER NOT NULL CHECK (contour_minutes IN (15, 30, 45)),
          geometry         GEOMETRY(MultiPolygon, 4326) NOT NULL,
          mapbox_model     VARCHAR(50),
          fetched_at       TIMESTAMPTZ DEFAULT NOW(),
          bbox_west        DECIMAL(10, 7),
          bbox_east        DECIMAL(10, 7),
          bbox_south       DECIMAL(10, 7),
          bbox_north       DECIMAL(10, 7),
          UNIQUE (municipio_id, profile, contour_minutes)
        )`,
      },
      {
        name: 'municipio_isochrones_geometry_idx',
        sql:  `CREATE INDEX IF NOT EXISTS municipio_isochrones_geometry_idx ON municipio_isochrones USING GIST (geometry)`,
      },
      {
        name: 'municipio_isochrones_municipio_idx',
        sql:  `CREATE INDEX IF NOT EXISTS municipio_isochrones_municipio_idx ON municipio_isochrones (municipio_id)`,
      },
      {
        name: 'municipio_isochrones_profile_contour_idx',
        sql:  `CREATE INDEX IF NOT EXISTS municipio_isochrones_profile_contour_idx ON municipio_isochrones (profile, contour_minutes)`,
      },
      {
        name: 'municipio_isochrones.fetched_at column',
        sql:  `ALTER TABLE municipio_isochrones ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ DEFAULT NOW()`,
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

/**
 * POST /api/admin/build-poi-nuclei
 *
 * Clusters poi_cache using ST_ClusterDBSCAN into commercial nuclei (zones),
 * then enriches each cluster with competitor counts, nearest own-store distance,
 * and an opportunity_score. Rebuilds the poi_nuclei table from scratch.
 *
 * This can take 20-60s depending on poi_cache size. Call once and then use
 * GET /api/scoring/poi-nuclei for fast reads.
 */
router.post('/build-poi-nuclei', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Respond immediately — heavy work runs async
    res.json({ message: 'POI nuclei build started — this may take up to 60 seconds', status: 'running' });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS poi_nuclei (
        id                    SERIAL PRIMARY KEY,
        cluster_id            INTEGER NOT NULL,
        lat                   FLOAT NOT NULL,
        lng                   FLOAT NOT NULL,
        poi_count             INTEGER NOT NULL DEFAULT 0,
        weighted_score        FLOAT   NOT NULL DEFAULT 0,
        municipio_name        TEXT,
        department            TEXT,
        cnt_marketplace       INTEGER DEFAULT 0,
        cnt_bank              INTEGER DEFAULT 0,
        cnt_pharmacy          INTEGER DEFAULT 0,
        cnt_school            INTEGER DEFAULT 0,
        cnt_bus_station       INTEGER DEFAULT 0,
        cnt_fuel              INTEGER DEFAULT 0,
        cnt_money_transfer    INTEGER DEFAULT 0,
        cnt_atm               INTEGER DEFAULT 0,
        cnt_supermarket       INTEGER DEFAULT 0,
        nearest_own_store_km  FLOAT,
        competitor_count_1km  INTEGER DEFAULT 0,
        competitor_count_3km  INTEGER DEFAULT 0,
        opportunity_score     INTEGER DEFAULT 0
      )
    `);

    await pool.query(`DELETE FROM poi_nuclei`);

    await pool.query(`
      INSERT INTO poi_nuclei (
        cluster_id, lat, lng, poi_count, weighted_score,
        municipio_name, department,
        cnt_marketplace, cnt_bank, cnt_pharmacy, cnt_school,
        cnt_bus_station, cnt_fuel, cnt_money_transfer, cnt_atm, cnt_supermarket,
        nearest_own_store_km, competitor_count_1km, competitor_count_3km,
        opportunity_score
      )
      WITH clustered AS (
        SELECT
          p.poi_type,
          p.lat::float  AS pt_lat,
          p.lng::float  AS pt_lng,
          p.geometry,
          ST_ClusterDBSCAN(p.geometry, eps := 0.005, minpoints := 2) OVER () AS cid
        FROM poi_cache p
        WHERE p.geometry IS NOT NULL
          AND p.poi_type IN (
            'marketplace','market','bank','pharmacy','school',
            'bus_station','fuel','money_transfer','atm','supermarket','hospital','hardware'
          )
      ),
      nuclei AS (
        SELECT
          cid,
          AVG(pt_lat)::float AS lat,
          AVG(pt_lng)::float AS lng,
          COUNT(*)::int      AS poi_count,
          SUM(CASE poi_type
            WHEN 'marketplace'    THEN 3.0
            WHEN 'market'         THEN 3.0
            WHEN 'bank'           THEN 2.0
            WHEN 'pharmacy'       THEN 1.5
            WHEN 'bus_station'    THEN 1.2
            WHEN 'fuel'           THEN 0.8
            ELSE 1.0
          END)::float AS weighted_score,
          SUM(CASE WHEN poi_type IN ('marketplace','market') THEN 1 ELSE 0 END)::int AS cnt_marketplace,
          SUM(CASE WHEN poi_type = 'bank'           THEN 1 ELSE 0 END)::int AS cnt_bank,
          SUM(CASE WHEN poi_type = 'pharmacy'       THEN 1 ELSE 0 END)::int AS cnt_pharmacy,
          SUM(CASE WHEN poi_type = 'school'         THEN 1 ELSE 0 END)::int AS cnt_school,
          SUM(CASE WHEN poi_type = 'bus_station'    THEN 1 ELSE 0 END)::int AS cnt_bus_station,
          SUM(CASE WHEN poi_type = 'fuel'           THEN 1 ELSE 0 END)::int AS cnt_fuel,
          SUM(CASE WHEN poi_type = 'money_transfer' THEN 1 ELSE 0 END)::int AS cnt_money_transfer,
          SUM(CASE WHEN poi_type = 'atm'            THEN 1 ELSE 0 END)::int AS cnt_atm,
          SUM(CASE WHEN poi_type = 'supermarket'    THEN 1 ELSE 0 END)::int AS cnt_supermarket
        FROM clustered
        WHERE cid IS NOT NULL
        GROUP BY cid
      ),
      enriched AS (
        SELECT
          n.*,
          mun.name       AS municipio_name,
          mun.department,
          (
            SELECT ROUND(MIN(ST_Distance(
              s.geometry::geography,
              ST_SetSRID(ST_MakePoint(n.lng, n.lat), 4326)::geography
            )) / 1000)
            FROM stores s
            WHERE s.geometry IS NOT NULL AND s.status = 'open'
          )::float AS nearest_own_store_km,
          (
            SELECT COUNT(*) FROM competitors c
            WHERE c.geometry IS NOT NULL
              AND ST_DWithin(
                c.geometry::geography,
                ST_SetSRID(ST_MakePoint(n.lng, n.lat), 4326)::geography,
                1000
              )
          )::int AS competitor_count_1km,
          (
            SELECT COUNT(*) FROM competitors c
            WHERE c.geometry IS NOT NULL
              AND ST_DWithin(
                c.geometry::geography,
                ST_SetSRID(ST_MakePoint(n.lng, n.lat), 4326)::geography,
                3000
              )
          )::int AS competitor_count_3km
        FROM nuclei n
        CROSS JOIN LATERAL (
          SELECT name, department
          FROM municipios
          WHERE centroid IS NOT NULL
          ORDER BY centroid <-> ST_SetSRID(ST_MakePoint(n.lng, n.lat), 4326)
          LIMIT 1
        ) mun
      )
      SELECT
        cid,
        lat, lng,
        poi_count, weighted_score,
        municipio_name, department,
        cnt_marketplace, cnt_bank, cnt_pharmacy, cnt_school,
        cnt_bus_station, cnt_fuel, cnt_money_transfer, cnt_atm, cnt_supermarket,
        nearest_own_store_km,
        competitor_count_1km,
        competitor_count_3km,
        LEAST(100, GREATEST(0,
          LEAST(50, weighted_score * 3.0) +
          LEAST(30, COALESCE(nearest_own_store_km, 10) * 3.0) +
          CASE
            WHEN competitor_count_1km = 0 AND competitor_count_3km = 0 THEN 5
            WHEN competitor_count_1km BETWEEN 1 AND 3               THEN 20
            WHEN competitor_count_1km BETWEEN 4 AND 8               THEN 10
            ELSE -5
          END
        ))::int AS opportunity_score
      FROM enriched
      ORDER BY opportunity_score DESC
    `);

    console.log('POI nuclei build complete');
  } catch (err: any) {
    console.error('build-poi-nuclei error:', err.message);
  }
});

/**
 * POST /api/admin/build-competitor-gaps
 *
 * Pre-computes competitor gaps into the competitor_gaps table so the GET
 * endpoint is just a fast SELECT. Run once after competitors / stores change.
 */
router.post('/build-competitor-gaps', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ message: 'Competitor gaps build started — this may take up to 60 seconds', status: 'running' });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS competitor_gaps (
        id                    SERIAL PRIMARY KEY,
        cluster_id            INTEGER NOT NULL,
        lat                   FLOAT NOT NULL,
        lng                   FLOAT NOT NULL,
        competitor_count      INTEGER NOT NULL DEFAULT 0,
        chains                TEXT[] NOT NULL DEFAULT '{}',
        nearest_own_store_km  FLOAT NOT NULL DEFAULT 0,
        nearby_poi_score      FLOAT NOT NULL DEFAULT 0,
        gap_score             INTEGER NOT NULL DEFAULT 0
      )
    `);

    await pool.query(`DELETE FROM competitor_gaps`);

    await pool.query(`
      INSERT INTO competitor_gaps (
        cluster_id, lat, lng, competitor_count, chains,
        nearest_own_store_km, nearby_poi_score, gap_score
      )
      WITH distances AS (
        SELECT
          c.name,
          c.chain,
          c.lat::float  AS lat,
          c.lng::float  AS lng,
          c.geometry,
          COALESCE(
            (SELECT ROUND(MIN(ST_Distance(
               s.geometry::geography,
               c.geometry::geography
             )) / 1000)
             FROM stores s
             WHERE s.geometry IS NOT NULL AND s.status = 'open'
               AND ST_DWithin(s.geometry::geography, c.geometry::geography, 200000)),
            50
          )::float AS nearest_own_store_km
        FROM competitors c
        WHERE c.geometry IS NOT NULL
      ),
      uncovered AS (
        SELECT * FROM distances WHERE nearest_own_store_km > 1.5
      ),
      clustered AS (
        SELECT *,
          ST_ClusterDBSCAN(geometry, eps := 0.009, minpoints := 1) OVER () AS cluster_id
        FROM uncovered
      ),
      aggregated AS (
        SELECT
          cluster_id,
          AVG(lat)::float                    AS lat,
          AVG(lng)::float                    AS lng,
          COUNT(*)::int                      AS competitor_count,
          ARRAY_AGG(chain)                   AS chains,
          MIN(nearest_own_store_km)::float   AS nearest_own_store_km
        FROM clustered
        WHERE cluster_id IS NOT NULL
        GROUP BY cluster_id
        HAVING COUNT(*) >= 1
      ),
      enriched AS (
        SELECT
          a.*,
          COALESCE((
            SELECT SUM(CASE p.poi_type
              WHEN 'marketplace'    THEN 3.0
              WHEN 'market'         THEN 3.0
              WHEN 'bank'           THEN 2.0
              WHEN 'pharmacy'       THEN 1.5
              WHEN 'bus_station'    THEN 1.2
              WHEN 'fuel'           THEN 0.8
              ELSE 1.0 END)
            FROM poi_cache p
            WHERE p.geometry IS NOT NULL
              AND ST_DWithin(
                p.geometry::geography,
                ST_SetSRID(ST_MakePoint(a.lng, a.lat), 4326)::geography,
                800
              )
          ), 0)::float AS nearby_poi_score
        FROM aggregated a
      )
      SELECT
        cluster_id,
        lat, lng,
        competitor_count,
        chains,
        nearest_own_store_km::int,
        nearby_poi_score,
        LEAST(100, GREATEST(0,
          LEAST(40, competitor_count::float * 10.0) +
          LEAST(30, nearest_own_store_km * 2.0) +
          LEAST(30, nearby_poi_score * 2.0)
        ))::int AS gap_score
      FROM enriched
      ORDER BY gap_score DESC
    `);

    console.log('Competitor gaps build complete');
  } catch (err: any) {
    console.error('build-competitor-gaps error:', err.message);
  }
});

// ─── POI Cache seed persistence ───────────────────────────────────────────────

/**
 * POST /api/admin/refresh-pois-osm
 * Populates poi_cache from OpenStreetMap (Overpass API) — free, no API key needed.
 * Falls back to a hand-curated static dataset if Overpass is unreachable.
 * Body: { force: true } to overwrite even when poi_cache already has rows.
 */
router.post('/refresh-pois-osm', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const force = req.body?.force === true;
    // Run async; respond immediately
    seedPoiCacheFromOsm(force)
      .then(n => console.log(`[admin] OSM POI refresh done: ${n} rows`))
      .catch(e => console.error('[admin] OSM POI refresh error:', e.message));
    res.json({ message: 'OSM POI refresh started (~30s). Toggle "Zonas" in the map once complete.' });
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/save-poi-seed
 * Exports current Google Places poi_cache rows to backend/data/poi_cache_seed.json.
 * Commit that file so the next session auto-restores the data on startup.
 */
router.post('/save-poi-seed', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const count = await exportPoiCacheSeed();
    if (count === 0) {
      const log = await getRefreshLog(3).catch(() => []);
      res.json({
        message: 'poi_cache has no Google Places rows to export — sync POIs first',
        count: 0,
        hint: log.length > 0
          ? `Last refresh: ${log[0].query_type} at ${log[0].executed_at} — status: ${log[0].status}, rows: ${log[0].records_fetched}${log[0].error_msg ? `, error: ${log[0].error_msg}` : ''}`
          : 'No refresh has been run yet in this session',
        recent_log: log,
      });
    } else {
      res.json({ message: `Exported ${count} POIs to backend/data/poi_cache_seed.json — commit this file to persist across sessions`, count });
    }
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/download-poi-seed
 * Returns the poi_cache_seed.json file as a downloadable attachment.
 * Use this to pull the file out of a Render/Docker container and commit it locally.
 */
router.get('/download-poi-seed', (req: Request, res: Response, next: NextFunction) => {
  try {
    const seedFile = path.resolve(__dirname, '../../data/poi_cache_seed.json');
    if (!fs.existsSync(seedFile)) {
      res.status(404).json({ message: 'Seed file not found — run POST /api/admin/save-poi-seed first' });
      return;
    }
    res.download(seedFile, 'poi_cache_seed.json');
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/load-poi-seed
 * Manually triggers seed import (normally runs on startup).
 * Useful when the server is already running and poi_cache is empty.
 */
router.post('/load-poi-seed', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const count = await importPoiCacheSeed();
    if (count === 0) {
      res.json({ message: 'Nothing imported: either seed file missing or poi_cache already has data', count: 0 });
    } else {
      res.json({ message: `Loaded ${count} POIs from seed file into poi_cache`, count });
    }
  } catch (err) { next(err); }
});

// ─── Isochrone generation ─────────────────────────────────────────────────────

/**
 * POST /api/admin/isochrones/generate
 *
 * Batch-fetches drive-time isochrone polygons for all ~334 Guatemala municipios
 * using the Mapbox Isochrone API (one request per municipio, 3 contours each).
 *
 * Cost: 334 requests — well within the Mapbox free tier (75,000 req/month).
 * Time: ~85 seconds at 4 req/s.
 *
 * Responds immediately with 200; generation runs async.
 * Poll GET /api/admin/isochrones/status for coverage progress.
 *
 * Body: {
 *   mapbox_token?: string,  // pk.ey… token — falls back to MAPBOX_SERVER_TOKEN env var
 *   force?: boolean,        // re-fetch even if already fresh (default: false)
 *   max_age_days?: number   // skip municipios fetched within N days (default: 30)
 * }
 */
router.post('/isochrones/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mapboxToken = ((req.body?.mapbox_token as string | undefined)?.trim())
      || process.env.MAPBOX_SERVER_TOKEN;

    if (!mapboxToken) {
      throw new AppError(400, 'Provide mapbox_token in request body or set MAPBOX_SERVER_TOKEN env var');
    }

    const force      = Boolean(req.body?.force ?? false);
    const maxAgeDays = parseInt(String(req.body?.max_age_days ?? '30'), 10);

    // Respond immediately — generation runs async and takes ~85 seconds
    res.json({
      message:      'Isochrone generation started — ~334 municipios at 4 req/s ≈ 85 seconds',
      status:       'running',
      force,
      max_age_days: maxAgeDays,
    });

    generateAllIsochrones(mapboxToken, force, maxAgeDays, (done, total, result) => {
      if (done % 50 === 0 || done === total) {
        console.log(`[isochrones] ${done}/${total} — municipio ${result.municipio_id} ${result.skipped ? 'skipped (fresh)' : result.success ? `ok (${result.contours_saved} contours)` : `FAIL: ${result.error}`}`);
      }
    }).then(results => {
      const fetched = results.filter(r => r.success && !r.skipped).length;
      const skipped = results.filter(r => r.skipped).length;
      const failed  = results.filter(r => !r.success).length;
      console.log(`[isochrones] Complete: ${fetched} fetched, ${skipped} skipped (fresh), ${failed} failed`);
    }).catch(err => {
      console.error('[isochrones] Batch generation error:', err.message);
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/isochrones/status
 *
 * Returns isochrone coverage summary: how many municipios have polygons
 * and how many have all 3 contours (15/30/45 min).
 */
router.get('/isochrones/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const coverage = await getIsochroneCoverage();
    res.json(coverage);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/isochrones/inspect/:municipio_id
 *
 * Returns the stored isochrone polygons for a municipio with area stats.
 * Use this to verify Mapbox returned real drive-time polygons (not tiny blobs).
 *
 * A valid 30-min driving isochrone in Guatemala should cover ~200–2000 km².
 * If area_km2 < 5 the polygon is degenerate — Mapbox had no road data.
 */
router.get('/isochrones/inspect/:municipio_id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const municipioId = parseInt(req.params.municipio_id, 10);
    if (isNaN(municipioId)) throw new AppError(400, 'municipio_id must be an integer');

    const { rows: meta } = await pool.query(
      `SELECT name, department, lat, lng FROM municipios WHERE id = $1`,
      [municipioId]
    );
    if (!meta.length) throw new AppError(404, `Municipio ${municipioId} not found`);

    const { rows } = await pool.query(
      `SELECT
         contour_minutes,
         fetched_at,
         ROUND(ST_Area(geometry::geography) / 1e6) AS area_km2,
         ST_AsGeoJSON(geometry)::jsonb             AS geojson
       FROM municipio_isochrones
       WHERE municipio_id = $1 AND profile = 'mapbox/driving'
       ORDER BY contour_minutes`,
      [municipioId]
    );

    res.json({
      municipio_id: municipioId,
      municipio:    `${meta[0].name}, ${meta[0].department}`,
      centroid:     { lat: parseFloat(meta[0].lat), lng: parseFloat(meta[0].lng) },
      contours:     rows.map(r => ({
        contour_minutes: r.contour_minutes,
        area_km2:        Number(r.area_km2),
        fetched_at:      r.fetched_at,
        geojson:         r.geojson,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/isochrones/single
 *
 * Fetches and stores isochrones for a single municipio. Useful for testing
 * the integration before running the full batch.
 *
 * Body: {
 *   municipio_id: number,
 *   mapbox_token?: string  // falls back to MAPBOX_SERVER_TOKEN env var
 * }
 */
router.post('/isochrones/single', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const municipioId = parseInt(String(req.body?.municipio_id ?? ''), 10);
    const mapboxToken = ((req.body?.mapbox_token as string | undefined)?.trim())
      || process.env.MAPBOX_SERVER_TOKEN;

    if (isNaN(municipioId)) throw new AppError(400, 'municipio_id (integer) is required');
    if (!mapboxToken)       throw new AppError(400, 'Provide mapbox_token in body or set MAPBOX_SERVER_TOKEN env var');

    const mResult = await pool.query(
      `SELECT lat, lng, name, department FROM municipios WHERE id = $1`,
      [municipioId]
    );
    if (!mResult.rows.length) throw new AppError(404, `Municipio ${municipioId} not found`);

    const { lat, lng, name, department } = mResult.rows[0];
    const result = await fetchAndSaveIsochrone(
      municipioId,
      parseFloat(lat),
      parseFloat(lng),
      mapboxToken
    );

    res.json({
      municipio_id:  municipioId,
      municipio:     `${name}, ${department}`,
      lat:           parseFloat(lat),
      lng:           parseFloat(lng),
      success:       result.success,
      contours_saved: result.contours_saved,
      error:         result.error,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

