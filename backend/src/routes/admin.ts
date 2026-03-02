import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import { scoreAllMunicipios, loadCalibrationConfig } from '../services/scoringEngine';
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

/** POST /api/admin/config/reset — reset to factory defaults */
router.post('/config/reset', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `UPDATE calibration_config SET
         weight_population = 0.30, weight_mobility = 0.25, weight_commercial = 0.25,
         weight_competition = 0.15, weight_socioeconomic = 0.05,
         despensa_familiar_min_pop = 24000, maxi_despensa_min_pop = 55000,
         mobility_override_threshold = 0.80, commercial_override_threshold = 0.85,
         updated_at = NOW()
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

/** GET /api/admin/stats — system stats */
router.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM stores)                          AS store_count,
        (SELECT COUNT(*) FROM stores WHERE status='open')     AS open_stores,
        (SELECT COUNT(*) FROM stores WHERE performance IS NOT NULL) AS tagged_stores,
        (SELECT COUNT(*) FROM competitors)                    AS competitor_count,
        (SELECT COUNT(DISTINCT chain) FROM competitors)       AS competitor_chains,
        (SELECT COUNT(*) FROM municipios)                     AS municipio_count,
        (SELECT COUNT(*) FROM opportunity_scores)             AS score_records,
        (SELECT COUNT(*) FROM poi_cache)                      AS poi_count,
        (SELECT MAX(calculated_at) FROM opportunity_scores)   AS last_scored_at,
        (SELECT MAX(fetched_at) FROM poi_cache)               AS last_osm_refresh
    `);
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
