import multer from 'multer';
import { AppError } from '../middleware/errorHandler';

// Store uploads in memory — files are processed immediately and not persisted
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.endsWith('.csv')
    ) {
      cb(null, true);
    } else {
      cb(new AppError(400, 'Only CSV files are accepted'));
    }
  },
});
