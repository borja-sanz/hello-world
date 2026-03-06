import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import {
  scorePoint,
  analyzeTradeArea,
  scoreAllMunicipios,
  loadCalibrationConfig,
} from '../services/scoringEngine';
import { AppError } from '../middleware/errorHandler';

const router = Router();

/**
 * GET /api/scoring/municipios?limit=20&min_score=0&min_population=0
 * Returns top opportunity municipios from the cached scores table.
 * Falls back to live scoring if cache is empty.
 */
router.get('/municipios', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit   = Math.min(parseInt((req.query.limit as string) || '20'), 50);
    const minScore = parseFloat((req.query.min_score as string) || '0');
    const minPop   = parseInt((req.query.min_population as string) || '0');

    const result = await pool.query(
      `SELECT
         los.municipio_id, los.municipio_name, los.department,
         los.population, los.score,
         los.pop_score, los.mobility_score, los.commercial_score,
         los.competition_score, los.socioeconomic_score,
         los.recommendation, los.suggested_format, los.reasoning,
         los.calculated_at,
         los.centroid_geojson::text AS centroid,
         (SELECT ROUND(ST_Distance(s.geometry::geography,
            m.centroid::geography)/1000)
          FROM stores s, municipios m
          WHERE m.id = los.municipio_id AND s.geometry IS NOT NULL
          ORDER BY ST_Distance(s.geometry::geography, m.centroid::geography) LIMIT 1) AS nearest_store_km
       FROM latest_opportunity_scores los
       WHERE los.score >= $1 AND COALESCE(los.population, 0) >= $2
       ORDER BY los.score DESC
       LIMIT $3`,
      [minScore, minPop, limit]
    );

    // If cache is empty, tell client to trigger a calculation
    if (result.rows.length === 0) {
      res.json({
        cached: false,
        message: 'No scores cached. POST /api/scoring/calculate-all to generate scores.',
        opportunities: [],
      });
      return;
    }

    res.json({ cached: true, count: result.rows.length, opportunities: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/scoring/blue-ocean?min_population=15000&min_nearest_store_km=15&limit=30
 *
 * "Blue ocean" municipios: enough population to be viable, few/no competitors,
 * and no existing own-store coverage within min_nearest_store_km.
 *
 * Sorted by competition_score DESC then population DESC so the most underserved
 * large markets appear first — these won't necessarily rank high on the overall
 * score because other factors (e.g. socioeconomic) may be modest.
 */
router.get('/blue-ocean', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const minPop          = parseInt((req.query.min_population as string) || '15000');
    const minNearestKm    = parseFloat((req.query.min_nearest_store_km as string) || '15');
    const limit           = Math.min(parseInt((req.query.limit as string) || '30'), 50);

    // Use a CTE so we can filter on the computed nearest_store_km
    const result = await pool.query(
      `WITH ranked AS (
         SELECT
           los.municipio_id, los.municipio_name, los.department,
           los.population, los.score,
           los.pop_score, los.mobility_score, los.commercial_score,
           los.competition_score, los.socioeconomic_score,
           los.recommendation, los.suggested_format, los.reasoning,
           los.calculated_at,
           los.centroid_geojson::text AS centroid,
           (SELECT ROUND(ST_Distance(s.geometry::geography, m.centroid::geography) / 1000)
            FROM stores s
            JOIN municipios m ON m.id = los.municipio_id
            WHERE s.geometry IS NOT NULL
            ORDER BY ST_Distance(s.geometry::geography, m.centroid::geography)
            LIMIT 1) AS nearest_store_km
         FROM latest_opportunity_scores los
         WHERE COALESCE(los.population, 0) >= $1
           AND COALESCE(los.competition_score, 0) >= 60
       )
       SELECT * FROM ranked
       WHERE COALESCE(nearest_store_km, 9999) >= $2
       ORDER BY competition_score DESC, population DESC
       LIMIT $3`,
      [minPop, minNearestKm, limit]
    );

    if (result.rows.length === 0) {
      res.json({
        count: 0,
        message: 'No blue ocean results. Run calculate-all to generate scores first.',
        opportunities: [],
      });
      return;
    }

    res.json({ count: result.rows.length, opportunities: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/scoring/config
 * Returns the active calibration config.
 */
router.get('/config', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await loadCalibrationConfig();
    res.json(config);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/scoring/municipio/:id
 * Returns (or calculates on demand) the score for a specific municipio.
 */
router.get('/municipio/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) throw new AppError(400, 'Invalid municipio id');

    // Check cache first
    const cached = await pool.query(
      `SELECT * FROM latest_opportunity_scores WHERE municipio_id = $1`, [id]
    );
    if (cached.rows.length > 0) {
      res.json({ cached: true, ...cached.rows[0] });
      return;
    }

    // Live score
    const municipio = await pool.query(
      `SELECT lat, lng FROM municipios WHERE id = $1`, [id]
    );
    if (municipio.rows.length === 0) throw new AppError(404, 'Municipio not found');
    const { lat, lng } = municipio.rows[0];
    const score = await scorePoint(parseFloat(lat), parseFloat(lng));
    res.json({ cached: false, municipio_id: id, ...score });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/scoring/point
 * Body: { lat, lng }
 * Scores any arbitrary point on demand.
 */
router.post('/point', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lat = parseFloat(req.body.lat);
    const lng = parseFloat(req.body.lng);
    if (isNaN(lat) || isNaN(lng)) throw new AppError(400, 'lat and lng are required');

    const result = await scorePoint(lat, lng);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/scoring/trade-area
 * Body: { lat, lng }
 * Full trade area analysis: 3/5/10km rings + score + recommendation.
 */
router.post('/trade-area', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lat = parseFloat(req.body.lat);
    const lng = parseFloat(req.body.lng);
    if (isNaN(lat) || isNaN(lng)) throw new AppError(400, 'lat and lng are required');

    const analysis = await analyzeTradeArea(lat, lng);
    res.json(analysis);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/scoring/calculate-all
 * Recalculates scores for all municipios. Can take 30–60s for full dataset.
 */
router.post('/calculate-all', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Respond immediately, run async
    res.json({ message: 'Scoring started — this may take up to 60 seconds', status: 'running' });
    const count = await scoreAllMunicipios();
    console.log(`Scoring complete: ${count} municipios scored`);
  } catch (err) {
    next(err);
  }
});

export default router;
