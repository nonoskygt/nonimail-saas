// Hub de eventos en vivo (SSE) + estado de job por usuario.
// Multi-tenant: cada usuario tiene su propio stream y su propio estado de escaneo.
const clients = new Map();   // userId -> Set(res)
const jobs = new Map();      // userId -> { abort, scanning, running, senders: Map }

export function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  res.on('close', () => clients.get(userId)?.delete(res));
}

export function emit(userId, event) {
  const set = clients.get(userId);
  if (!set) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) { try { res.write(data); } catch { /* cliente caído */ } }
}

// broadcast a TODOS los clientes (para métricas de máquina: CPU/GPU del server local)
export function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const set of clients.values()) for (const res of set) { try { res.write(data); } catch { /* */ } }
}
export function clientCount() { let n = 0; for (const s of clients.values()) n += s.size; return n; }

// helpers de conveniencia
export const line = (userId, lane, text, kind) =>
  emit(userId, { t: 'line', lane, text, kind, ts: new Date().toISOString().slice(11, 19) });
export const sender = (userId, s) => emit(userId, { t: 'sender', sender: s });
export const stats = (userId, j) => emit(userId, { t: 'stats', stats: j.stats, scanning: j.scanning, running: j.running });

export function job(userId) {
  if (!jobs.has(userId)) {
    jobs.set(userId, {
      abort: false, scanning: false, running: false,
      senders: new Map(),
      stats: { revisados: 0, borrados: 0, conservados: 0, remitentes: 0 },
    });
  }
  return jobs.get(userId);
}
