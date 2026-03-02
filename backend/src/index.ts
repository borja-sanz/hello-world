import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool, testConnection } from './db';

// Route imports (populated in later modules)
import storeRoutes from './routes/stores';
import competitorRoutes from './routes/competitors';
import municipioRoutes from './routes/municipios';
import scoringRoutes from './routes/scoring';
import osmRoutes from './routes/osm';
import adminRoutes from './routes/admin';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// --- Middleware ---
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Health check ---
app.get('/health', async (_req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW()');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      db: dbResult.rows[0].now,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
});

// --- API Routes ---
app.use('/api/stores', storeRoutes);
app.use('/api/competitors', competitorRoutes);
app.use('/api/municipios', municipioRoutes);
app.use('/api/scoring', scoringRoutes);
app.use('/api/osm', osmRoutes);
app.use('/api/admin', adminRoutes);

// --- 404 handler ---
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// --- Error handler ---
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// --- Start ---
(async () => {
  await testConnection();
  app.listen(PORT, () => {
    console.log(`GeoRetail Guatemala API running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
})();

export default app;
