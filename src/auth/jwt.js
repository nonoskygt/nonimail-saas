// Emisión/verificación de JWT y middleware de Express.
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function sign(user) {
  return jwt.sign({ uid: user.id, email: user.email }, config.jwtSecret, { expiresIn: '30d' });
}

export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.cookies?.token || null);
  if (!token) return res.status(401).json({ error: 'no autenticado' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'token inválido' });
  }
}
