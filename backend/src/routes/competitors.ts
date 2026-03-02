import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import {
  getCompetitorsNearPoint,
  getCompetitorsGeoJSON,
  countCompetitorsByChain,
} from '../models/competitor';
import { validateId, validateLatLng } from '../middleware/validation';
import { AppError } from '../middleware/errorHandler';

const router = Router();

/** GET /api/competitors — list all competitors, optional ?chain= filter */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { chain, verified } = req.query as Record<string, string>;
    const conditions: string[] = [];
    const params: any[] = [];

    if (chain) {
      params.push(`%${chain}%`);
      conditions.push(`chain ILIKE $${params.length}`);
    }
    if (verified !== undefined) {
      params.push(verified === 'true');
      conditions.push(`verified = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT id, name, chain, lat, lng, verified, source, address, municipio, department
       FROM competitors ${where}
       ORDER BY chain, name`,
      params
    );
    res.json({ count: result.rows.length, competitors: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /api/competitors/geojson */
router.get('/geojson', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const geojson = await getCompetitorsGeoJSON();
    res.json(geojson);
  } catch (err) {
    next(err);
  }
});

/** GET /api/competitors/near?lat=&lng=&radius= — competitors near a point */
router.get('/near', validateLatLng, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const radius = parseFloat((req.query.radius as string) || '10');

    const competitors = await getCompetitorsNearPoint(lat, lng, radius);
    const chains = await countCompetitorsByChain(lat, lng, radius);

    res.json({
      center: { lat, lng },
      radius_km: radius,
      count: competitors.length,
      by_chain: chains,
      competitors,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/competitors/chains — distinct chains in DB */
router.get('/chains', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT chain, COUNT(*) AS count
       FROM competitors
       GROUP BY chain
       ORDER BY count DESC`
    );
    res.json(result.rows.map(r => ({ chain: r.chain, count: parseInt(r.count) })));
  } catch (err) {
    next(err);
  }
});

/** GET /api/competitors/:id */
router.get('/:id', validateId, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT id, name, chain, lat, lng, osm_id, verified, source, address, municipio, department, notes
       FROM competitors WHERE id = $1`,
      [parseInt(req.params.id)]
    );
    if (result.rows.length === 0) throw new AppError(404, 'Competitor not found');
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

/** POST /api/competitors — add a competitor manually */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, chain, lat, lng, address, municipio, department, notes } = req.body;

    if (!chain) throw new AppError(400, 'chain is required');
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (isNaN(latNum) || isNaN(lngNum)) {
      throw new AppError(400, 'lat and lng are required numbers');
    }

    const result = await pool.query(
      `INSERT INTO competitors (name, chain, lat, lng, address, municipio, department, notes, source, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', true)
       RETURNING id, name, chain, lat, lng, verified, source`,
      [name ?? chain, chain, latNum, lngNum, address ?? null,
       municipio ?? null, department ?? null, notes ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

/** PUT /api/competitors/:id — update / verify a competitor */
router.put('/:id', validateId, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const fields: string[] = [];
    const params: any[] = [];
    const allowed = ['name', 'chain', 'lat', 'lng', 'address', 'municipio', 'department', 'notes', 'verified'];

    for (const key of allowed) {
      if (key in req.body && req.body[key] !== undefined) {
        params.push(req.body[key]);
        fields.push(`${key} = $${params.length}`);
      }
    }

    if (fields.length === 0) throw new AppError(400, 'No fields to update');

    params.push(parseInt(req.params.id));
    const result = await pool.query(
      `UPDATE competitors SET ${fields.join(', ')}
       WHERE id = $${params.length}
       RETURNING id, name, chain, lat, lng, verified, source`,
      params
    );
    if (result.rows.length === 0) throw new AppError(404, 'Competitor not found');
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/competitors/:id */
router.delete('/:id', validateId, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      'DELETE FROM competitors WHERE id = $1',
      [parseInt(req.params.id)]
    );
    if ((result.rowCount ?? 0) === 0) throw new AppError(404, 'Competitor not found');
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
