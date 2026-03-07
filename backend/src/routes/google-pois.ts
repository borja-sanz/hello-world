/**
 * Google Places POI Routes
 *
 * Replaces /api/osm/* with /api/pois/*
 *
 * GET  /api/pois/status              — POI counts by type + drive-time coverage
 * POST /api/pois/refresh/pois        — Nearby Search for commercial/mobility POIs
 * POST /api/pois/refresh/mercados    — Text Search for informal markets
 * POST /api/pois/refresh/lds         — Text Search for LDS churches
 * POST /api/pois/refresh/drive-times — Distance Matrix to Guatemala City
 * POST /api/pois/refresh/all         — All four in sequence
 *
 * All refresh endpoints accept { api_key: string } in the request body
 * OR fall back to the GOOGLE_PLACES_API_KEY environment variable.
 * Keys are never logged or persisted.
 */

import { Router, Request, Response, NextFunction } from 'express';
import {
  refreshNearbyPois,
  refreshMercadosInformales,
  refreshLdsChurches,
  refreshAnchorRetailers,
  refreshDriveTimes,
  getPoiCounts,
  getRefreshLog,
  getRefreshProgress,
} from '../services/googlePoiService';
import { exportPoiCacheSeed } from '../scripts/poiSeed';
import { AppError } from '../middleware/errorHandler';

const router = Router();

function resolveKey(req: Request): string {
  const key = req.body?.api_key ?? process.env.GOOGLE_PLACES_API_KEY ?? '';
  if (!key) throw new AppError(400, 'api_key is required (body) or set GOOGLE_PLACES_API_KEY env var');
  return key;
}

/** GET /api/pois/progress — live refresh progress for the frontend to poll */
router.get('/progress', (_req: Request, res: Response) => {
  res.json(getRefreshProgress());
});

/** GET /api/pois/status */
router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [counts, log] = await Promise.all([getPoiCounts(), getRefreshLog(5)]);
    res.json({ ...counts, recent_refreshes: log });
  } catch (err) { next(err); }
});

/** POST /api/pois/refresh/pois — Nearby Search (bank, pharmacy, hospital, school, gas, transit) */
router.post('/refresh/pois', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = resolveKey(req);
    // Run async; respond immediately so the HTTP connection doesn't time out
    refreshNearbyPois(apiKey)
      .then(async r => {
        const n = r.reduce((s, x) => s + x.inserted, 0);
        console.log(`[google-pois] Nearby refresh done: ${n} inserted`);
        await exportPoiCacheSeed().catch(e => console.warn('[poiSeed] Auto-export failed:', e.message));
      })
      .catch(e => console.error('[google-pois] Nearby refresh error:', e.message));
    res.json({ message: 'Nearby POI refresh started (runs in background ~2–5 min)' });
  } catch (err) { next(err); }
});

/** POST /api/pois/refresh/mercados — Text Search for informal markets */
router.post('/refresh/mercados', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = resolveKey(req);
    refreshMercadosInformales(apiKey)
      .then(async r => {
        const n = r.reduce((s, x) => s + x.inserted, 0);
        console.log(`[google-pois] Mercados refresh done: ${n} inserted`);
        await exportPoiCacheSeed().catch(e => console.warn('[poiSeed] Auto-export failed:', e.message));
      })
      .catch(e => console.error('[google-pois] Mercados error:', e.message));
    res.json({ message: 'Mercados informales refresh started (~1 min)' });
  } catch (err) { next(err); }
});

/** POST /api/pois/refresh/lds — Text Search for LDS churches */
router.post('/refresh/lds', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = resolveKey(req);
    refreshLdsChurches(apiKey)
      .then(async r => {
        const n = r.reduce((s, x) => s + x.inserted, 0);
        console.log(`[google-pois] LDS refresh done: ${n} inserted`);
        await exportPoiCacheSeed().catch(e => console.warn('[poiSeed] Auto-export failed:', e.message));
      })
      .catch(e => console.error('[google-pois] LDS error:', e.message));
    res.json({ message: 'LDS church refresh started (~1 min)' });
  } catch (err) { next(err); }
});

/** POST /api/pois/refresh/drive-times — Distance Matrix, all municipios → Guatemala City */
router.post('/refresh/drive-times', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = resolveKey(req);
    refreshDriveTimes(apiKey)
      .then(r => console.log(`[google-pois] Drive times done: ${r.updated}/${r.total} updated`))
      .catch(e => console.error('[google-pois] Drive times error:', e.message));
    res.json({ message: 'Drive-time refresh started (~30 s, ~$0.34)' });
  } catch (err) { next(err); }
});

/** POST /api/pois/refresh/all — All four in sequence */
router.post('/refresh/all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = resolveKey(req);
    (async () => {
      console.log('[google-pois] Full refresh started');
      await refreshDriveTimes(apiKey);
      console.log('[google-pois] Drive times done');
      await refreshMercadosInformales(apiKey);
      console.log('[google-pois] Mercados done');
      await refreshLdsChurches(apiKey);
      console.log('[google-pois] LDS done');
      await refreshAnchorRetailers(apiKey);
      console.log('[google-pois] Anchor retailers done');
      await refreshNearbyPois(apiKey);
      console.log('[google-pois] Nearby POIs done — full refresh complete');
      // Snapshot everything to disk so it survives a container restart
      const saved = await exportPoiCacheSeed().catch(e => { console.warn('[poiSeed] Auto-export failed:', e.message); return 0; });
      console.log(`[poiSeed] Seed file updated: ${saved} rows`);
    })().catch(e => console.error('[google-pois] Full refresh error:', e.message));
    res.json({ message: 'Full Google POI refresh started (runs in background ~5–15 min, estimated cost $5–13)' });
  } catch (err) { next(err); }
});

export default router;
