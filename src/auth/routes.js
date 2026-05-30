// Rutas de auth propias: registro, login, perfil.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { users } from '../db.js';
import { sign, requireAuth } from './jwt.js';

export const authRouter = Router();

authRouter.post('/register', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const pass = String(req.body?.password || '');
  if (!email || pass.length < 8) return res.status(400).json({ error: 'email y contraseña (mín 8) requeridos' });
  if (users.byEmail.get(email)) return res.status(409).json({ error: 'ese email ya está registrado' });
  const hash = bcrypt.hashSync(pass, 10);
  const info = users.create.run(email, hash);
  const user = users.byId.get(info.lastInsertRowid);
  res.json({ token: sign(user), user: { id: user.id, email: user.email, plan: user.plan } });
});

authRouter.post('/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const pass = String(req.body?.password || '');
  const user = users.byEmail.get(email);
  if (!user || !bcrypt.compareSync(pass, user.pass_hash)) return res.status(401).json({ error: 'credenciales inválidas' });
  res.json({ token: sign(user), user: { id: user.id, email: user.email, plan: user.plan } });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const user = users.byId.get(req.user.uid);
  if (!user) return res.status(404).json({ error: 'no encontrado' });
  res.json({ user: { id: user.id, email: user.email, plan: user.plan } });
});
