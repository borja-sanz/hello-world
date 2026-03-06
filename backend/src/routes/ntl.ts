/**
 * NTL (Nighttime Lights) API
 *
 * Returns VIIRS DNB sub-municipio settlement clusters so the frontend can
 * drill down from municipio-level rankings to specific town locations.
 *
 * Population formula (INE Guatemala Censo 2018):
 *   estimated_pop = ROUND(radiance_ntl × 180 × 4.2)  → × 756
 *   where 180 = households per nW/cm²/sr unit (calibration constant)
 *         4.2 = avg household size (INE Censo 2018)
 */
import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import { AppError } from '../middleware/errorHandler';

const router = Router();

// NTL calibration constants (INE 2018)
const NTL_CALIB_K        = 180;   // households per nW/cm²/sr unit
const NTL_HOUSEHOLD_SIZE = 4.2;   // avg persons per household

/**
 * GET /api/ntl/settlements?municipio_id=X
 *
 * Returns sub-municipio settlements within 20 km of the municipio centroid,
 * sorted by estimated_pop DESC. Includes calibration constants so the UI can
 * show the formula transparently.
 */
router.get('/settlements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const municipioId = parseInt(req.query.municipio_id as string);
    if (isNaN(municipioId)) throw new AppError(400, 'municipio_id is required');

    // Get municipio centroid for proximity search
    const municipioResult = await pool.query(
      `SELECT id, name, department, lat, lng, centroid
       FROM municipios WHERE id = $1`,
      [municipioId]
    );
    if (municipioResult.rows.length === 0) throw new AppError(404, 'Municipio not found');
    const municipio = municipioResult.rows[0];

    // Radius: use sqrt(area_km2/π) + buffer to cover the municipio, min 20km
    const areaResult = await pool.query(
      `SELECT area_km2 FROM municipios WHERE id = $1`, [municipioId]
    );
    const areaKm2 = parseFloat(areaResult.rows[0]?.area_km2 ?? '0');
    const radiusKm = Math.max(20, Math.ceil(Math.sqrt((areaKm2 || 324) / Math.PI) + 5));

    const settlements = await pool.query(
      `SELECT
         id, name, lat, lng, radiance_ntl, estimated_pop, area_km2, ntl_source,
         municipio_id,
         ST_AsGeoJSON(geometry)::text AS geojson,
         ROUND(ST_Distance(
           geometry::geography,
           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
         ) / 1000, 1) AS dist_from_center_km
       FROM ntl_settlements
       WHERE ST_DWithin(
         geometry::geography,
         ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
         $3
       )
       ORDER BY estimated_pop DESC NULLS LAST
       LIMIT 30`,
      [municipio.lat, municipio.lng, radiusKm * 1000]
    );

    res.json({
      municipio_id:   municipioId,
      municipio_name: `${municipio.name}, ${municipio.department}`,
      radius_km:      radiusKm,
      count:          settlements.rows.length,
      // Expose calibration constants so the UI can show the formula
      calibration: {
        calib_k:        NTL_CALIB_K,
        household_size: NTL_HOUSEHOLD_SIZE,
        formula:        'estimated_pop = ROUND(radiance_ntl × calib_k × household_size)',
        note:           'calib_k=180 hh/unit; household_size=4.2 (INE Censo 2018)',
      },
      settlements: settlements.rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ntl/settlements/top?limit=20
 * Returns the brightest settlements across all of Guatemala — useful for
 * national-level map overlay without a specific municipio filter.
 */
router.get('/settlements/top', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '50'), 200);

    const result = await pool.query(
      `SELECT
         ns.id, ns.name, ns.lat, ns.lng, ns.radiance_ntl, ns.estimated_pop,
         ns.area_km2, ns.ntl_source, ns.municipio_id,
         m.name AS municipio_name, m.department
       FROM ntl_settlements ns
       LEFT JOIN municipios m ON m.id = ns.municipio_id
       ORDER BY ns.radiance_ntl DESC
       LIMIT $1`,
      [limit]
    );

    res.json({
      count: result.rows.length,
      calibration: {
        calib_k:        NTL_CALIB_K,
        household_size: NTL_HOUSEHOLD_SIZE,
        formula:        'estimated_pop = ROUND(radiance_ntl × calib_k × household_size)',
      },
      settlements: result.rows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
