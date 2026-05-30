// ============================================================================
// CONECTOR IMAP GENÉRICO  (Carbonio y cualquier servidor IMAP estándar)
// ----------------------------------------------------------------------------
// ImapFlow + mailparser. IMAP NO usa OAuth: credenciales host/puerto/usuario/pass.
//
// CONCURRENCIA (fix de raíz): ImapFlow no es multiplex (1 conexión procesa 1
// comando a la vez). En vez de abrir/cerrar una conexión POR operación (lento y
// agota el límite de conexiones del servidor), mantenemos un POOL de conexiones
// reutilizables (config.concurrency.imapConnections). Cada operación toma una
// conexión libre del pool, opera y la devuelve. close() las cierra al terminar.
// ============================================================================
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { MailProvider } from './base.js';
import { config } from '../config.js';

const TRASH_FALLBACKS = ['Trash', 'INBOX.Trash', 'Papelera', 'INBOX.Papelera', 'Deleted Items', 'Deleted Messages'];

export class ImapProvider extends MailProvider {
  static get key() { return 'imap'; }
  static get oauth() { return false; }

  capabilities() { return { search: false, threads: false, trash: true, labels: false, unsubscribe: true }; }
  // El pool define cuántas operaciones simultáneas tolera (= conexiones abiertas).
  readConcurrency() { return config.concurrency.imapConnections; }

  // ===== VALIDACIÓN DE CREDENCIALES AL DAR DE ALTA (conexión de prueba) =====
  static async connectDirect(creds) {
    const { host, user, pass } = creds || {};
    if (!host || !user || !pass) throw new Error('Faltan credenciales IMAP: host, user y pass son obligatorios.');
    const port = Number(creds.port) || 993;
    const secure = creds.secure !== false;
    const client = new ImapFlow({ host, port, secure, auth: { user, pass }, logger: false });
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX'); lock.release();
    } catch (err) {
      throw new Error(`No se pudo conectar al servidor IMAP (${host}:${port}): ${err.message}`);
    } finally { try { await client.logout(); } catch {} }
    return { email: user, secret: JSON.stringify({ host, port, user, pass, secure }), access: null, expiry: null };
  }

  async refreshIfNeeded() { return null; }

  // ===== POOL DE CONEXIONES =====
  _creds() { try { return JSON.parse(this.account.secret); } catch { throw new Error('Credenciales IMAP inválidas (secret no es JSON).'); } }
  _init() {
    if (this._pool) return;
    this._pool = [];          // todas las conexiones vivas
    this._idle = [];          // conexiones libres
    this._waiters = [];       // resolvers esperando una conexión
    this._max = config.concurrency.imapConnections;
    this._cr = this._creds();
    this._trashPath = undefined;
  }
  async _mkConn() {
    const { host, port, user, pass, secure } = this._cr;
    const c = new ImapFlow({ host, port: Number(port) || 993, secure: secure !== false, auth: { user, pass }, logger: false });
    await c.connect();
    await c.mailboxOpen('INBOX');   // queda seleccionado para fetch/download/move
    return c;
  }
  async _acquire() {
    this._init();
    if (this._idle.length) return this._idle.pop();
    if (this._pool.length < this._max) { const c = await this._mkConn(); this._pool.push(c); return c; }
    return new Promise(res => this._waiters.push(res));
  }
  _release(c) { const w = this._waiters.shift(); if (w) w(c); else this._idle.push(c); }
  // si una conexión falla, la descartamos del pool y, si hay quien espere, creamos otra.
  async _drop(c) {
    this._pool = (this._pool || []).filter(x => x !== c);
    try { await c.logout(); } catch {}
    const w = this._waiters.shift();
    if (w) { try { const n = await this._mkConn(); this._pool.push(n); w(n); } catch { w(null); } }
  }
  // helper: ejecuta fn(conn) con una conexión del pool, gestionando release/drop.
  async _withConn(fn) {
    const c = await this._acquire();
    if (!c) throw new Error('no se pudo obtener conexión IMAP');
    try { const r = await fn(c); this._release(c); return r; }
    catch (e) { await this._drop(c); throw e; }
  }
  async close() {
    const all = this._pool || [];
    this._pool = []; this._idle = []; this._waiters = [];
    await Promise.all(all.map(c => c.logout().catch(() => {})));
  }

  // ===== LISTADO (paginación por número de secuencia — solo trae la ventana pedida) =====
  // `cursor` = cantidad de mensajes ya consumidos desde el más nuevo. Traemos los
  // `limit` más nuevos siguientes por rango de SECUENCIA (no UID), evitando bajar
  // todos los envelopes del buzón en cada página (lo que era O(N²) en buzones grandes).
  async listMessages({ folder = 'inbox', limit = 50, cursor } = {}) {
    return this._withConn(async (c) => {
      const total = c.mailbox?.exists ?? 0;
      const consumed = cursor != null ? Number(cursor) : 0;
      if (total === 0 || consumed >= total) return { messages: [], nextCursor: null };
      const hi = total - consumed;            // secuencia del más nuevo no visto
      const lo = Math.max(1, hi - limit + 1);  // ventana de `limit` mensajes
      const collected = [];
      for await (const m of c.fetch(`${lo}:${hi}`, { uid: true, envelope: true })) collected.push(m);
      collected.sort((a, b) => b.seq - a.seq); // más nuevos primero
      const messages = collected.map((m) => {
        const env = m.envelope || {};
        return {
          id: String(m.uid), threadId: String(m.uid),
          from: env.from?.[0]?.address || '(desconocido)',
          subject: env.subject || '(sin asunto)', snippet: '', date: env.date || null,
        };
      });
      const newConsumed = consumed + collected.length;
      const nextCursor = newConsumed < total ? newConsumed : null;
      return { messages, nextCursor };
    });
  }

  // ===== HILO COMPLETO (un UID) =====
  async getThread(threadId) {
    const uid = Number(threadId);
    if (!Number.isFinite(uid)) throw new Error(`threadId IMAP inválido: ${threadId}`);
    return this._withConn(async (c) => {
      const dl = await c.download(uid, undefined, { uid: true });
      if (!dl || !dl.content) throw new Error(`Mensaje UID ${uid} no encontrado.`);
      const parsed = await simpleParser(dl.content);
      return {
        id: String(uid),
        messages: [{
          id: String(uid),
          from: parsed.from?.text || '', to: parsed.to?.text || '', date: parsed.date || null,
          subject: parsed.subject || '', body: parsed.text || '',
          listUnsubscribe: parsed.headers?.get('list-unsubscribe') || null,
          listUnsubscribePost: parsed.headers?.get('list-unsubscribe-post') || null,
        }],
      };
    });
  }

  // ===== MOVER A PAPELERA (recuperable) =====
  async trashThread(threadId) {
    const uid = Number(threadId);
    if (!Number.isFinite(uid)) throw new Error(`threadId IMAP inválido: ${threadId}`);
    return this._withConn(async (c) => {
      const trashPath = await this._resolveTrashPath(c);
      if (!trashPath) throw new Error('No se encontró carpeta de Papelera/Trash en el servidor IMAP.');
      await c.messageMove(uid, trashPath, { uid: true });
    });
  }

  // resuelve la ruta de Papelera una vez y la cachea.
  async _resolveTrashPath(c) {
    if (this._trashPath !== undefined) return this._trashPath;
    const boxes = await c.list();
    const special = boxes.find((b) => b.specialUse === '\\Trash');
    let path = special?.path || null;
    if (!path) {
      const lower = new Map(boxes.map((b) => [b.path.toLowerCase(), b.path]));
      for (const cand of TRASH_FALLBACKS) { const hit = lower.get(cand.toLowerCase()); if (hit) { path = hit; break; } }
    }
    this._trashPath = path;
    return path;
  }

  async sendMail() { throw new Error('IMAP no soporta envío (configurar SMTP aparte)'); }
}
