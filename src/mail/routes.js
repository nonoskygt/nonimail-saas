// Rutas de conexión de buzones (los 3 conectores) + listado + limpieza.
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config, isConfigured } from '../config.js';
import { requireAuth } from '../auth/jwt.js';
import { accounts, rules } from '../db.js';
import { encrypt } from '../crypto.js';
import { providerClass, getClient } from '../providers/index.js';
import { runClean } from './engine.js';
import { addClient, job, emit } from './live.js';
import { scanSenders, executeDeletes, unsubscribeSender } from './scan.js';
import { RX_KEEP, RX_SUBJ, RX_FROM } from './engine.js';
import { LLM_PROMPT } from '../llm/ollama.js';
import { scanResults } from '../db.js';

export const mailRouter = Router();

// estado OAuth firmado (liga el callback al usuario logueado) — vida corta.
function signState(uid, provider) { return jwt.sign({ uid, provider }, config.jwtSecret, { expiresIn: '60m' }); }
function verifyState(s) { try { return jwt.verify(s, config.jwtSecret); } catch { return null; } }

// --- iniciar conexión OAuth (gmail/outlook) ---
mailRouter.get('/connect/:provider/start', requireAuth, async (req, res) => {
  const { provider } = req.params;
  if (!['gmail', 'outlook'].includes(provider)) return res.status(400).json({ error: 'usar POST /connect/imap para IMAP' });
  if (!isConfigured(provider)) return res.status(503).json({ error: `${provider} no configurado (faltan credenciales OAuth en .env)` });
  try {
    const url = await providerClass(provider).getAuthUrl(signState(req.user.uid, provider));
    res.json({ url }); // el front redirige a esta URL
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- redirect directo a consentimiento (URL corta, token por query) ---
mailRouter.get('/connect/:provider/go', (req, res) => {
  const { provider } = req.params;
  let uid;
  try { uid = jwt.verify(String(req.query.token || ''), config.jwtSecret).uid; }
  catch { return res.status(401).send('token inválido'); }
  if (!['gmail', 'outlook'].includes(provider)) return res.status(400).send('proveedor inválido');
  providerClass(provider).getAuthUrl(signState(uid, provider))
    .then(url => res.redirect(url))
    .catch(e => res.status(500).send(String(e.message || e)));
});

// --- callback OAuth ---
for (const provider of ['gmail', 'outlook']) {
  mailRouter.get(`/connect/${provider}/callback`, async (req, res) => {
    const st = verifyState(req.query.state);
    if (!st || st.provider !== provider) return res.status(400).send('state inválido o vencido');
    if (req.query.error) return res.status(400).send('consentimiento denegado: ' + req.query.error);
    try {
      const tok = await providerClass(provider).exchangeCode(String(req.query.code));
      accounts.upsert.run({
        user_id: st.uid, provider, email: tok.email,
        secret_enc: tok.secret ? encrypt(tok.secret) : null,
        access_enc: tok.access ? encrypt(tok.access) : null,
        expiry: tok.expiry || null,
      });
      res.send(`<script>window.location='/?connected=${provider}';</script>Conectado ${tok.email}. Volviendo…`);
    } catch (e) { res.status(500).send('error al conectar: ' + (e.message || e)); }
  });
}

// --- conectar IMAP (credenciales directas) ---
mailRouter.post('/connect/imap', requireAuth, async (req, res) => {
  try {
    const tok = await providerClass('imap').connectDirect(req.body || {});
    accounts.upsert.run({
      user_id: req.user.uid, provider: 'imap', email: tok.email,
      secret_enc: encrypt(tok.secret), access_enc: null, expiry: null,
    });
    res.json({ ok: true, email: tok.email });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// --- conectar Gmail vía bridge (Apps Script) ---
mailRouter.post('/connect/gmail-bridge', requireAuth, async (req, res) => {
  try {
    const { GmailBridgeProvider } = await import('../providers/gmail-bridge.js');
    const tok = await GmailBridgeProvider.connectDirect(req.body || {});
    accounts.upsert.run({
      user_id: req.user.uid, provider: 'gmail-bridge', email: tok.email,
      secret_enc: encrypt(tok.secret), access_enc: null, expiry: null,
    });
    res.json({ ok: true, email: tok.email });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// --- listar buzones conectados ---
mailRouter.get('/accounts', requireAuth, (req, res) => {
  res.json({ accounts: accounts.byUser.all(req.user.uid) });
});

// --- desconectar ---
mailRouter.delete('/accounts/:id', requireAuth, (req, res) => {
  accounts.remove.run(req.params.id, req.user.uid);
  res.json({ ok: true });
});

// --- limpiar un buzón (dryRun por defecto: NO borra, solo simula) ---
mailRouter.post('/accounts/:id/clean', requireAuth, async (req, res) => {
  const row = accounts.byId.get(req.params.id, req.user.uid);
  if (!row) return res.status(404).json({ error: 'buzón no encontrado' });
  try {
    const client = await getClient(row);
    const lines = [];
    let result;
    try {
      result = await runClean(client, {
        rules: rules.mapFor(req.user.uid),
        myAddresses: [row.email],
        dryRun: req.body?.dryRun !== false, // default true
        maxThreads: Math.min(500, parseInt(req.body?.maxThreads) || 100),
        onLine: (l) => lines.push(l),
      });
    } finally { if (client.close) await client.close().catch(() => {}); }
    res.json({ ...result, lines });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- stream SSE en vivo (EventSource no puede mandar Authorization => token por query) ---
mailRouter.get('/stream', (req, res) => {
  let uid;
  try { uid = jwt.verify(String(req.query.token || ''), config.jwtSecret).uid; }
  catch { return res.status(401).end(); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  addClient(uid, res);
  const j = job(uid);
  res.write(`data: ${JSON.stringify({ t: 'stats', stats: j.stats, scanning: j.scanning, running: j.running })}\n\n`);
});

// --- escanear remitentes (async; resultados por SSE) ---
mailRouter.post('/accounts/:id/scan', requireAuth, async (req, res) => {
  const row = accounts.byId.get(req.params.id, req.user.uid);
  if (!row) return res.status(404).json({ error: 'buzón no encontrado' });
  if (job(req.user.uid).scanning) return res.status(409).json({ error: 'ya hay un escaneo en curso' });
  try {
    const client = await getClient(row);
    // sampleSize 0 / all:true => TODO el buzón; si no, hasta 100k
    const sampleSize = (req.body?.all || req.body?.sampleSize === 0)
      ? 0
      : Math.max(20, Math.min(100000, parseInt(req.body?.sampleSize) || 300));
    console.log(`[scan] user=${req.user.uid} acct=${row.email} sampleSize=${sampleSize}`);
    scanSenders(client, req.user.uid, { rules: rules.mapFor(req.user.uid), myAddresses: [row.email], sampleSize })
      .catch(e => emit(req.user.uid, { t: 'line', lane: 'cpu', text: 'SCAN ERROR: ' + e.message, kind: 'err' }));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- ejecutar borrado de los remitentes indicados (dryRun por defecto) ---
mailRouter.post('/accounts/:id/execute', requireAuth, async (req, res) => {
  const row = accounts.byId.get(req.params.id, req.user.uid);
  if (!row) return res.status(404).json({ error: 'buzón no encontrado' });
  if (job(req.user.uid).running) return res.status(409).json({ error: 'ya hay una ejecución en curso' });
  const emails = Array.isArray(req.body?.emails) ? req.body.emails.filter(Boolean) : [];
  if (!emails.length) return res.status(400).json({ error: 'no hay remitentes para borrar' });
  try {
    const client = await getClient(row);
    executeDeletes(client, req.user.uid, { emails, rules: rules.mapFor(req.user.uid), dryRun: req.body?.dryRun !== false })
      .catch(e => emit(req.user.uid, { t: 'line', lane: 'gpu', text: 'EXEC ERROR: ' + e.message, kind: 'err' }));
    res.json({ ok: true, count: emails.length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- ⚡ Limpiar TODO (autorun): escanear toda la bandeja y borrar lo claramente ruido ---
mailRouter.post('/accounts/:id/autorun', requireAuth, async (req, res) => {
  const row = accounts.byId.get(req.params.id, req.user.uid);
  if (!row) return res.status(404).json({ error: 'buzón no encontrado' });
  const j = job(req.user.uid);
  if (j.scanning || j.running) return res.status(409).json({ error: 'ocupado' });
  const dureza = Math.max(0, Math.min(100, parseInt(req.body?.dureza) || 50));
  const dryRun = req.body?.dryRun !== false;
  const ruleMap = rules.mapFor(req.user.uid);
  let client;
  try { client = await getClient(row); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  res.json({ ok: true });
  (async () => {
    await scanSenders(client, req.user.uid, { rules: ruleMap, myAddresses: [row.email], sampleSize: 2000 });
    const T = 100 - dureza, BAND = 12;
    const emails = [...job(req.user.uid).senders.values()]
      .filter(s => s.score != null && s.score >= T + BAND && !ruleMap.protect.has(s.email))
      .map(s => s.email);
    if (emails.length) { const c2 = await getClient(row); await executeDeletes(c2, req.user.uid, { emails, rules: ruleMap, dryRun }); }
    else emit(req.user.uid, { t: 'line', lane: 'gpu', text: 'Nada que borrar con esta dureza.', kind: 'info' });
  })().catch(e => emit(req.user.uid, { t: 'line', lane: 'gpu', text: 'AUTORUN ERROR: ' + e.message, kind: 'err' }));
});

// --- config de reglas globales (para el modal ⚙ Reglas) ---
mailRouter.get('/rules-config', requireAuth, (req, res) => {
  res.json({
    model: 'qwen3:8b',
    keepOverride: RX_KEEP.source,
    subject: RX_SUBJ.source,
    from: RX_FROM.source,
    body: '(unsubscribe|darse de baja|view in browser|shop now|comprar ahora)',
    llmPrompt: LLM_PROMPT,
    promptTemplate: LLM_PROMPT + '\n\nFROM: {remitente}\nSUBJECT: {asuntos}\nBULK: {baja?}\nBODY: {cuerpo}',
    editable: false,
  });
});

// --- estado del job + lista de remitentes clasificados ---
// Primero intenta la memoria (job activo), luego la DB (persiste entre reinicios)
mailRouter.get('/job-state', requireAuth, (req, res) => {
  const j = job(req.user.uid);
  // memoria tiene datos recientes
  if (j.senders.size > 0) {
    const senders = [...j.senders.values()].map(s => ({
      email: s.email, name: s.name, count: s.count, score: s.score, reason: s.reason,
      canUnsub: s.canUnsub, rule: s.rule || null, samples: s.samples,
    }));
    return res.json({ stats: j.stats, scanning: j.scanning, running: j.running, senders, source: 'memory' });
  }
  // fallback: cargar desde DB
  const saved = scanResults.load(req.user.uid);
  if (saved) {
    // enriquecer con reglas actuales del usuario
    const ruleMap = rules.mapFor(req.user.uid);
    const senders = saved.senders.map(s => ({
      ...s,
      rule: ruleMap.protect.has(s.email) ? 'protect' : ruleMap.delete.has(s.email) ? 'delete' : (s.rule || null),
    }));
    // IMPORTANTE: reportar el estado REAL del job en memoria (running/scanning/stats),
    // aunque los remitentes vengan de la DB. Si no, un Ejecutar en curso se ve como "idle".
    return res.json({
      stats: { revisados: saved.revisados, borrados: j.stats.borrados || 0, conservados: 0, remitentes: senders.length },
      scanning: j.scanning, running: j.running, senders, source: 'db', scanned_at: saved.scanned_at,
    });
  }
  res.json({ stats: j.stats, scanning: j.scanning, running: j.running, senders: [], source: 'empty' });
});

// --- parar escaneo/ejecución ---
mailRouter.post('/stop', requireAuth, (req, res) => { job(req.user.uid).abort = true; res.json({ ok: true }); });

// --- baja (unsubscribe) de un remitente ---
mailRouter.post('/accounts/:id/unsubscribe', requireAuth, async (req, res) => {
  const row = accounts.byId.get(req.params.id, req.user.uid);
  if (!row) return res.status(404).json({ error: 'buzón no encontrado' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'falta email' });
  try {
    const client = await getClient(row);
    let r;
    try { r = await unsubscribeSender(client, req.user.uid, email); }
    finally { if (client.close) await client.close().catch(() => {}); }
    res.json(r);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- reglas por remitente ---
mailRouter.get('/rules', requireAuth, (req, res) => res.json(rules.listFor(req.user.uid)));
mailRouter.post('/rules', requireAuth, (req, res) => {
  const sender = String(req.body?.sender || '').trim().toLowerCase();
  const rule = req.body?.rule;
  if (!sender) return res.status(400).json({ error: 'falta sender' });
  if (rule === 'none') rules.unset.run(req.user.uid, sender);
  else if (['protect', 'delete'].includes(rule)) rules.set.run(req.user.uid, sender, rule);
  else return res.status(400).json({ error: 'rule inválida' });
  res.json({ ok: true });
});
