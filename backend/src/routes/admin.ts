import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => res.json({ message: 'Admin endpoint — Module 8' }));

export default router;
