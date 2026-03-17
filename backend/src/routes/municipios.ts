import { Router, Request, Response, NextFunction } from 'express';
import {
  getAllMunicipios,
  getMunicipioById,
  getMunicipioContaining,
  getMunicipiosWithinRadius,
  getPopulationWithinRadius,
  getTopMunicipiosByPopulation,
} from '../models/municipio';
import { validateId } from '../middleware/validation';
import { AppError } from '../middleware/errorHandler';

const router = Router();

/** GET /api/municipios — list all municipios */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { department, min_population } = req.query as Record<string, string>;
    let municipios = await getAllMunicipios();

    if (department) {
      municipios = municipios.filter(m =>
        m.department.toLowerCase().includes(department.toLowerCase())
      );
    }
    if (min_population) {
      const minPop = parseInt(min_population);
      municipios = municipios.filter(m => (m.population ?? 0) >= minPop);
    }

    res.json({ count: municipios.length, municipios });
  } catch (err) {
    next(err);
  }
});

/** GET /api/municipios/top — top municipios by population */
router.get('/top', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt((req.query.limit as string) || '20');
    const minPop = parseInt((req.query.min_population as string) || '0');
    const municipios = await getTopMunicipiosByPopulation(limit, minPop);
    res.json({ count: municipios.length, municipios });
  } catch (err) {
    next(err);
  }
});

/** GET /api/municipios/containing?lat=&lng= — which municipio contains a point */
router.get('/containing', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    if (isNaN(lat) || isNaN(lng)) {
      throw new AppError(400, 'lat and lng query params are required');
    }

    const municipio = await getMunicipioContaining(lat, lng);
    if (!municipio) throw new AppError(404, 'No municipio found for this location');
    res.json(municipio);
  } catch (err) {
    next(err);
  }
});

/** GET /api/municipios/near?lat=&lng=&radius= — municipios near a point */
router.get('/near', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const radius = parseFloat((req.query.radius as string) || '50');

    if (isNaN(lat) || isNaN(lng)) {
      throw new AppError(400, 'lat and lng query params are required');
    }

    const municipios = await getMunicipiosWithinRadius(lat, lng, radius);
    const totalPop3km = await getPopulationWithinRadius(lat, lng, 3);
    const totalPop10km = await getPopulationWithinRadius(lat, lng, 10);

    res.json({
      center: { lat, lng },
      radius_km: radius,
      count: municipios.length,
      population_within_3km: totalPop3km,
      population_within_10km: totalPop10km,
      municipios,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/municipios/geojson — all centroids as GeoJSON FeatureCollection */
router.get('/geojson', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const municipios = await getAllMunicipios();
    const features = municipios
      .filter(m => m.centroid_geojson)
      .map(m => ({
        type: 'Feature',
        geometry: m.centroid_geojson,
        properties: {
          id: m.id, name: m.name, department: m.department,
          population: m.population, is_urban: m.is_urban,
          lat: m.lat, lng: m.lng,
        },
      }));
    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    next(err);
  }
});

/** GET /api/municipios/:id */
router.get('/:id', validateId, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const municipio = await getMunicipioById(parseInt(req.params.id));
    if (!municipio) throw new AppError(404, 'Municipio not found');
    res.json(municipio);
  } catch (err) {
    next(err);
  }
});

export default router;
