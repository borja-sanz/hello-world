import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => res.json({ message: 'Municipios endpoint — Module 2' }));

export default router;
