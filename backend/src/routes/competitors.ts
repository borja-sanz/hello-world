import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => res.json({ message: 'Competitors endpoint — Module 3' }));

export default router;
