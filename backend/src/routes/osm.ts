import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => res.json({ message: 'OSM endpoint — Module 5' }));

export default router;
