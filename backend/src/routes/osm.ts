import { Router, Request, Response, NextFunction } from 'express';
import {
  refreshSupermarkets,
  refreshCommercialPois,
  refreshRoads,
  refreshAll,
  getRefreshLog,
  getPoiCounts,
} from '../services/osmService';

const router = Router();

/** GET /api/osm/status — POI counts + last refresh times */
router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [counts, log] = await Promise.all([getPoiCounts(), getRefreshLog(5)]);
    const total = counts.reduce((s, r) => s + r.count, 0);
    res.json({ total_pois: total, by_type: counts, recent_refreshes: log });
  } catch (err) {
    next(err);
  }
});

/** GET /api/osm/log — full refresh history */
router.get('/log', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt((req.query.limit as string) || '20');
    const log = await getRefreshLog(limit);
    res.json({ count: log.length, log });
  } catch (err) {
    next(err);
  }
});

/** POST /api/osm/refresh/supermarkets */
router.post('/refresh/supermarkets', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ message: 'Fetching supermarkets from Overpass API…', status: 'running' });
    const count = await refreshSupermarkets();
    console.log(`OSM supermarkets refreshed: ${count} records`);
  } catch (err) {
    next(err);
  }
});

/** POST /api/osm/refresh/pois */
router.post('/refresh/pois', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ message: 'Fetching commercial POIs from Overpass API…', status: 'running' });
    const count = await refreshCommercialPois();
    console.log(`OSM commercial POIs refreshed: ${count} records`);
  } catch (err) {
    next(err);
  }
});

/** POST /api/osm/refresh/roads */
router.post('/refresh/roads', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ message: 'Fetching road network from Overpass API…', status: 'running' });
    const count = await refreshRoads();
    console.log(`OSM roads refreshed: ${count} records`);
  } catch (err) {
    next(err);
  }
});

/** POST /api/osm/refresh/all — refresh everything (slow, ~2 minutes) */
router.post('/refresh/all', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ message: 'Full OSM refresh started — may take 2 minutes', status: 'running' });
    const results = await refreshAll();
    console.log('OSM full refresh complete:', results);
  } catch (err) {
    next(err);
  }
});

export default router;
