import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';

const VALID_FORMATS = ['Despensa Familiar', 'Maxi Despensa', 'Walmart', 'Paiz', 'Other', 'Full Potential'] as const;
const VALID_STATUSES = ['open', 'planned', 'closed', 'under_construction'] as const;
const VALID_PERFORMANCE = ['success', 'on-plan', 'underperforming'] as const;

export type StoreFormat = typeof VALID_FORMATS[number];
export type StoreStatus = typeof VALID_STATUSES[number];
export type StorePerformance = typeof VALID_PERFORMANCE[number];

export function validateStoreBody(req: Request, _res: Response, next: NextFunction): void {
  const { name, format, lat, lng, status } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return next(new AppError(400, 'name is required'));
  }
  if (!format || !VALID_FORMATS.includes(format)) {
    return next(new AppError(400, `format must be one of: ${VALID_FORMATS.join(', ')}`));
  }

  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (isNaN(latNum) || latNum < 13 || latNum > 18) {
    return next(new AppError(400, 'lat must be a valid Guatemala latitude (13–18)'));
  }
  if (isNaN(lngNum) || lngNum < -93 || lngNum > -88) {
    return next(new AppError(400, 'lng must be a valid Guatemala longitude (-93 to -88)'));
  }
  if (status && !VALID_STATUSES.includes(status)) {
    return next(new AppError(400, `status must be one of: ${VALID_STATUSES.join(', ')}`));
  }

  next();
}

export function validateLatLng(req: Request, _res: Response, next: NextFunction): void {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);

  if (isNaN(lat) || isNaN(lng)) {
    return next(new AppError(400, 'lat and lng query params are required'));
  }
  next();
}

export function validateId(req: Request, _res: Response, next: NextFunction): void {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) {
    return next(new AppError(400, 'Invalid id'));
  }
  next();
}
