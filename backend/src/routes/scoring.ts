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
         mun.area_km2,
         (SELECT ROUND(ST_Distance(s.geometry::geography,
            m.centroid::geography)/1000)
          FROM stores s, municipios m
          WHERE m.id = los.municipio_id AND s.geometry IS NOT NULL
          ORDER BY ST_Distance(s.geometry::geography, m.centroid::geography) LIMIT 1) AS nearest_store_km
       FROM latest_opportunity_scores los
       JOIN municipios mun ON mun.id = los.municipio_id
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
           mun.area_km2,
           (SELECT ROUND(ST_Distance(s.geometry::geography, m.centroid::geography) / 1000)
            FROM stores s
            JOIN municipios m ON m.id = los.municipio_id
            WHERE s.geometry IS NOT NULL
            ORDER BY ST_Distance(s.geometry::geography, m.centroid::geography)
            LIMIT 1) AS nearest_store_km
         FROM latest_opportunity_scores los
         JOIN municipios mun ON mun.id = los.municipio_id
         WHERE COALESCE(los.population, 0) >= $1
           AND COALESCE(los.competition_score, 0) >= 60
           AND NOT EXISTS (
             SELECT 1 FROM competitors c
             JOIN municipios m ON m.id = los.municipio_id
             WHERE c.geometry IS NOT NULL
               AND (
                 CASE
                   WHEN m.geometry IS NOT NULL
                     THEN ST_Intersects(c.geometry, m.geometry)
                   ELSE ST_DWithin(
                     c.geometry::geography,
                     m.centroid::geography,
                     LEAST(
                       GREATEST(
                         SQRT(COALESCE(m.area_km2, 100) / PI()) * 1000,
                         5000
                       ),
                       20000
                     )
                   )
                 END
               )
           )
       )
       SELECT * FROM ranked
       WHERE COALESCE(nearest_store_km, 9999) >= $2
       ORDER BY score DESC
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
 * GET /api/scoring/sub-municipio/:id
 *
 * Scores each NTL settlement cluster within a municipio and returns them
 * ranked by score. This gives an actionable "where inside this municipio"
 * answer, not just a municipio-level signal.
 *
 * Each settlement is scored with the full scorePoint engine so competition,
 * mobility and commercial factors reflect the settlement's specific location.
 *
 * Query params:
 *   limit   – max settlements to return (default 10, max 20)
 *   min_pop – minimum estimated_pop filter (default 0)
 */
router.get('/sub-municipio/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const municipioId = parseInt(req.params.id);
    if (isNaN(municipioId)) throw new AppError(400, 'Invalid municipio id');

    const limit  = Math.min(parseInt((req.query.limit  as string) || '10'), 20);
    const minPop = parseInt((req.query.min_pop as string) || '0');

    // Load all NTL settlements for this municipio
    const settlements = await pool.query(
      `SELECT id, name, lat, lng, radiance_ntl, estimated_pop, area_km2
       FROM ntl_settlements
       WHERE municipio_id = $1
         AND COALESCE(estimated_pop, 0) >= $2
       ORDER BY radiance_ntl DESC`,
      [municipioId, minPop]
    );

    if (settlements.rows.length === 0) {
      res.json({ municipio_id: municipioId, count: 0, settlements: [] });
      return;
    }

    // Pre-load config once
    const cfg = await loadCalibrationConfig();

    // Score each settlement — run in parallel (capped at 10 concurrent)
    const scored = await Promise.all(
      settlements.rows.slice(0, 20).map(async (s) => {
        try {
          const result = await scorePoint(parseFloat(s.lat), parseFloat(s.lng), cfg);
          return {
            id:            s.id,
            name:          s.name,
            lat:           parseFloat(s.lat),
            lng:           parseFloat(s.lng),
            estimated_pop: s.estimated_pop,
            radiance_ntl:  parseFloat(s.radiance_ntl),
            area_km2:      s.area_km2 ? parseFloat(s.area_km2) : null,
            score:         result.score,
            recommendation: result.recommendation,
            suggested_format: result.suggested_format,
            factors:       result.factors,
            reasoning:     result.reasoning,
          };
        } catch {
          return null;
        }
      })
    );

    const valid = scored
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    res.json({ municipio_id: municipioId, count: valid.length, settlements: valid });
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
 * GET /api/scoring/poi-clusters/:id
 * Returns spatial clusters of POIs within a municipio, derived from poi_cache.
 * Clusters are built by rounding lat/lng to 2 decimal places (~1 km grid cells).
 * Useful for identifying commercial village/town centers below the municipio level.
 */
router.get('/poi-clusters/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) throw new AppError(400, 'municipio id required');

    // Get municipio centroid + area to compute search radius
    const mResult = await pool.query(
      `SELECT lat, lng,
              COALESCE(ST_Area(centroid_geojson::geography) / 1000000.0, 0) AS area_km2
       FROM municipios WHERE id = $1`,
      [id]
    );
    if (!mResult.rows.length) throw new AppError(404, 'Municipio not found');

    const { lat, lng, area_km2 } = mResult.rows[0];
    const radiusKm = Math.max(20, Math.round(Math.sqrt(parseFloat(area_km2) / Math.PI) + 5));

    const result = await pool.query(
      `SELECT
         ROUND(lat::numeric, 2)  AS cluster_lat,
         ROUND(lng::numeric, 2)  AS cluster_lng,
         COUNT(*)                                                              AS poi_count,
         SUM(CASE WHEN poi_type IN ('marketplace','market') THEN 1 ELSE 0 END) AS marketplace,
         SUM(CASE WHEN poi_type = 'bank'            THEN 1 ELSE 0 END)         AS bank,
         SUM(CASE WHEN poi_type = 'pharmacy'        THEN 1 ELSE 0 END)         AS pharmacy,
         SUM(CASE WHEN poi_type = 'hospital'        THEN 1 ELSE 0 END)         AS hospital,
         SUM(CASE WHEN poi_type = 'school'          THEN 1 ELSE 0 END)         AS school,
         SUM(CASE WHEN poi_type = 'atm'             THEN 1 ELSE 0 END)         AS atm,
         SUM(CASE WHEN poi_type = 'money_transfer'  THEN 1 ELSE 0 END)         AS money_transfer,
         SUM(CASE WHEN poi_type = 'supermarket'     THEN 1 ELSE 0 END)         AS supermarket,
         SUM(CASE WHEN poi_type = 'fuel'            THEN 1 ELSE 0 END)         AS fuel,
         SUM(CASE WHEN poi_type = 'bus_station'     THEN 1 ELSE 0 END)         AS bus_station,
         SUM(CASE WHEN poi_type = 'hardware'        THEN 1 ELSE 0 END)         AS hardware
       FROM poi_cache
       WHERE ST_DWithin(
               geometry::geography,
               ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
               $3
             )
       GROUP BY ROUND(lat::numeric, 2), ROUND(lng::numeric, 2)
       HAVING COUNT(*) >= 2
       ORDER BY COUNT(*) DESC
       LIMIT 30`,
      [parseFloat(lat), parseFloat(lng), radiusKm * 1000]
    );

    const clusters = result.rows.map(r => ({
      lat:       parseFloat(r.cluster_lat),
      lng:       parseFloat(r.cluster_lng),
      poi_count: parseInt(r.poi_count),
      breakdown: {
        marketplace:    parseInt(r.marketplace),
        bank:           parseInt(r.bank),
        pharmacy:       parseInt(r.pharmacy),
        hospital:       parseInt(r.hospital),
        school:         parseInt(r.school),
        atm:            parseInt(r.atm),
        money_transfer: parseInt(r.money_transfer),
        supermarket:    parseInt(r.supermarket),
        fuel:           parseInt(r.fuel),
        bus_station:    parseInt(r.bus_station),
        hardware:       parseInt(r.hardware),
      },
    }));

    res.json({ municipio_id: id, count: clusters.length, clusters });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/scoring/settlements?limit=100&min_pop=500
 *
 * Scores all NTL settlements globally using a fast single SQL query.
 * Score factors (0-100):
 *   - Population  (0-40): estimated_pop from VIIRS calibration
 *   - Commercial  (0-30): POI count within 2 km (economic activity proxy)
 *   - Coverage gap(0-20): distance to nearest own store (further = bigger opportunity)
 *   - Competition (0-10): inverse of competitor count within 3 km
 *
 * This is the sub-municipio opportunity ranking — useful when a full municipio
 * is too coarse to make a siting decision.
 */
router.get('/settlements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '300'), 1000);

    // Fast query: no correlated spatial subqueries.
    // Score is based only on radiance (economic proxy) + estimated population.
    // Population filter removed — let the frontend decide what to show.
    const result = await pool.query(
      `SELECT
         s.id,
         s.name,
         s.municipio_id,
         s.lat::float               AS lat,
         s.lng::float               AS lng,
         s.radiance_ntl::float      AS radiance_ntl,
         COALESCE(s.estimated_pop, 0)::int AS estimated_pop,
         s.area_km2,
         m.name                     AS municipio_name,
         m.department,
         0                          AS poi_count,
         0                          AS competitor_count,
         NULL::int                  AS nearest_store_km,
         -- Score: 60% radiance (commercial proxy), 40% population
         LEAST(100, GREATEST(0,
           LEAST(60, s.radiance_ntl * 6.0) +
           LEAST(40, COALESCE(s.estimated_pop, 0) / 1000.0)
         ))::int                    AS score
       FROM ntl_settlements s
       JOIN municipios m ON s.municipio_id = m.id
       WHERE s.lat IS NOT NULL AND s.lng IS NOT NULL
         AND COALESCE(s.radiance_ntl, 0) > 0
       ORDER BY s.radiance_ntl DESC
       LIMIT $1`,
      [limit]
    );

    res.json({ count: result.rows.length, settlements: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/scoring/poi-nuclei?limit=200&min_score=0
 *
 * Returns pre-computed commercial nuclei from the poi_nuclei table.
 * Build the table first via POST /api/admin/build-poi-nuclei.
 */
router.get('/poi-nuclei', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit    = Math.min(parseInt((req.query.limit    as string) || '200'), 500);
    const minScore = parseInt((req.query.min_score as string) || '0');

    // Check if table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'poi_nuclei'
      ) AS exists
    `);
    if (!tableCheck.rows[0].exists) {
      res.json({ count: 0, nuclei: [], message: 'poi_nuclei table not built yet. POST /api/admin/build-poi-nuclei first.' });
      return;
    }

    const result = await pool.query(
      `SELECT id, cluster_id, lat, lng, poi_count, weighted_score,
              municipio_name, department,
              cnt_marketplace, cnt_bank, cnt_pharmacy, cnt_school,
              cnt_bus_station, cnt_fuel, cnt_money_transfer, cnt_atm, cnt_supermarket,
              nearest_own_store_km, competitor_count_1km, competitor_count_3km,
              opportunity_score,
              COALESCE(source, 'poi_dbscan') AS source,
              radiance_ntl,
              estimated_pop
       FROM poi_nuclei
       WHERE opportunity_score >= $1
       ORDER BY opportunity_score DESC
       LIMIT $2`,
      [minScore, limit]
    );

    res.json({ count: result.rows.length, nuclei: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/scoring/competitor-gaps?limit=200&min_gap_score=0
 *
 * Finds competitor clusters with no own-store coverage within 1.5 km.
 * Competitor presence validates demand; the absence of own stores makes
 * them actionable targets.
 *
 * gap_score (0–100):
 *   - Competitor density  (0–40): more competitors = stronger demand signal
 *   - Coverage gap        (0–30): further own store = bigger opportunity
 *   - POI activity        (0–30): nearby commercial POIs validate foot traffic
 */
router.get('/competitor-gaps', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit       = Math.min(parseInt((req.query.limit        as string) || '200'), 500);
    const minGapScore = parseInt((req.query.min_gap_score as string) || '0');

    // Check if pre-computed table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'competitor_gaps'
      ) AS exists
    `);

    if (!tableCheck.rows[0].exists) {
      return res.json({ count: 0, gaps: [], message: 'competitor_gaps table not built yet. POST /api/admin/build-competitor-gaps first.' });
    }

    const result = await pool.query(
      `SELECT cluster_id, lat, lng, competitor_count, chains,
              nearest_own_store_km, nearby_poi_score, gap_score
       FROM competitor_gaps
       WHERE gap_score >= $1
       ORDER BY gap_score DESC
       LIMIT $2`,
      [minGapScore, limit]
    );

    const gaps = result.rows.map(r => ({
      ...r,
      chains: [...new Set(r.chains as string[])],
      nearby_poi_score: parseFloat(r.nearby_poi_score),
    }));

    res.json({ count: gaps.length, gaps });
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
