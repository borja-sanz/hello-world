import { Router, Request, Response, NextFunction } from 'express';
import { selectSite } from '../services/siteSelectionService';
import { AppError } from '../middleware/errorHandler';

const router = Router();

/**
 * GET /api/site-selection/:municipio_id
 *
 * Returns the top-5 optimal store locations within the given Municipio,
 * ranked by the Stage 2 micro-score (NTL + commercial + gap + catchment).
 *
 * This is additive: the Stage 1 Oportunidades ranking is unchanged.
 */
router.get('/:municipio_id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const municipioId = parseInt(req.params.municipio_id);
    if (isNaN(municipioId)) throw new AppError(400, 'Invalid municipio_id');

    const result = await selectSite(municipioId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
