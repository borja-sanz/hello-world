import { Router, Request, Response, NextFunction } from 'express';
import {
  listStores, getStoreById, createStore, updateStore,
  deleteStore, bulkCreateStores, getStoresGeoJSON,
} from '../models/store';
import { getMunicipioContaining } from '../models/municipio';
import { validateStoreBody, validateId } from '../middleware/validation';
import { upload } from '../utils/upload';
import { parseStoreCSV } from '../utils/csvParser';
import { AppError } from '../middleware/errorHandler';

const router = Router();

/** GET /api/stores — list all stores with optional filters */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { format, status, department } = req.query as Record<string, string>;
    const stores = await listStores({ format, status, department });
    res.json({ count: stores.length, stores });
  } catch (err) {
    next(err);
  }
});

/** GET /api/stores/geojson — all stores as GeoJSON FeatureCollection */
router.get('/geojson', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const geojson = await getStoresGeoJSON();
    res.json(geojson);
  } catch (err) {
    next(err);
  }
});

/** POST /api/stores/import — upload CSV file to bulk-import stores */
router.post(
  '/import',
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw new AppError(400, 'No file uploaded — use multipart/form-data with field "file"');
      }

      const { rows, errors } = await parseStoreCSV(req.file.buffer);

      if (rows.length === 0 && errors.length > 0) {
        res.status(400).json({ error: 'CSV validation failed', errors });
        return;
      }

      const inputs = await Promise.all(rows.map(async r => {
        const lat = parseFloat(r.lat);
        const lng = parseFloat(r.lng);
        let municipio = r.municipio || null;
        let department = r.department || null;

        if (!municipio || !department) {
          const mun = await getMunicipioContaining(lat, lng).catch(() => null);
          if (mun) {
            municipio = municipio ?? mun.name;
            department = department ?? mun.department;
          }
        }

        return {
          name: r.store_name,
          format: r.format,
          lat,
          lng,
          status: r.status,
          department: department ?? undefined,
          municipio: municipio ?? undefined,
          open_date: r.open_date || undefined,
          notes: r.notes,
        };
      }));

      const result = await bulkCreateStores(inputs);

      res.status(201).json({
        message: 'Import complete',
        inserted: result.inserted,
        skipped: result.skipped,
        validation_errors: errors,
      });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /api/stores/:id */
router.get('/:id', validateId, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const store = await getStoreById(parseInt(req.params.id));
    if (!store) throw new AppError(404, 'Store not found');
    res.json(store);
  } catch (err) {
    next(err);
  }
});

/** POST /api/stores — create a single store */
router.post('/', validateStoreBody, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const store = await createStore({
      name: req.body.name,
      format: req.body.format,
      lat: parseFloat(req.body.lat),
      lng: parseFloat(req.body.lng),
      chain: req.body.chain,
      status: req.body.status,
      open_date: req.body.open_date,
      address: req.body.address,
      department: req.body.department,
      municipio: req.body.municipio,
      notes: req.body.notes,
    });
    res.status(201).json(store);
  } catch (err) {
    next(err);
  }
});

/** PUT /api/stores/:id — update store fields */
router.put('/:id', validateId, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const store = await updateStore(parseInt(req.params.id), req.body);
    if (!store) throw new AppError(404, 'Store not found');
    res.json(store);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/stores/:id/performance — tag store performance for model calibration */
router.patch(
  '/:id/performance',
  validateId,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { performance } = req.body;
      const valid = ['success', 'on-plan', 'underperforming'];
      if (!valid.includes(performance)) {
        throw new AppError(400, `performance must be one of: ${valid.join(', ')}`);
      }
      const store = await updateStore(parseInt(req.params.id), { performance });
      if (!store) throw new AppError(404, 'Store not found');
      res.json(store);
    } catch (err) {
      next(err);
    }
  }
);

/** DELETE /api/stores/:id */
router.delete('/:id', validateId, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await deleteStore(parseInt(req.params.id));
    if (!deleted) throw new AppError(404, 'Store not found');
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
