import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => res.json({ message: 'Scoring endpoint — Module 4' }));

export default router;
