// ============================================================================
// CONECTOR GMAIL VÍA APPS SCRIPT BRIDGE  (mismo bridge que NoniMail Limpieza)
// ----------------------------------------------------------------------------
// No requiere OAuth ni credenciales de Google Cloud. El usuario conecta su Gmail
// pasando la URL del bridge y la API key. Las credenciales se guardan cifradas
// en la tabla accounts (secret = JSON {bridgeUrl, key}).
// Acciones soportadas: search, read_thread, move_to_trash, send_email.
// ============================================================================
import { MailProvider, parseFrom } from './base.js';

export class GmailBridgeProvider extends MailProvider {
  static get key() { return 'gmail'; }
  static get oauth() { return false; }

  capabilities() { return { search: true, threads: true, trash: true, labels: false, unsubscribe: true }; }
  readConcurrency() { return 20; } // el bridge de Apps Script aguanta ~30 en paralelo
  async refreshIfNeeded() { return null; }

  // Conectar: solo validar que el bridge responde con la key correcta.
  static async connectDirect({ bridgeUrl, key, email }) {
    if (!bridgeUrl || !key || !email) throw new Error('Faltan bridgeUrl, key y email');
    const r = await fetch(bridgeUrl, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, action: 'search', query: 'in:inbox', limit: 1, start: 0 }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (j.status !== 'ok') throw new Error('Bridge no responde correctamente: ' + (j.error || r.status));
    return { email, secret: JSON.stringify({ bridgeUrl, key }), access: null, expiry: null };
  }

  _creds() { return JSON.parse(this.account.secret); }

  async _bridge(payload) {
    const { bridgeUrl, key } = this._creds();
    payload.key = key;
    const r = await fetch(bridgeUrl, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json();
    if (j.status !== 'ok') throw new Error(j.error || 'bridge error');
    return j.data;
  }

  // Pagina el inbox. cursor = start offset numérico.
  // Para Gmail Bridge necesitamos leer cada hilo levemente para obtener el `from`
  // (el bridge's search solo devuelve id+subject+snippet, no from).
  // Usamos includeHeaders:false → no llama getRawContent → barato en cuota.
  async listMessages({ folder = 'inbox', limit = 50, cursor } = {}) {
    const start = cursor != null ? Number(cursor) : 0;
    const data = await this._bridge({ action: 'search', query: `in:${folder}`, limit, start });
    const threads = data?.threads || [];
    if (!threads.length) return { messages: [], nextCursor: null };

    // Leer from en paralelo (pool 20, bridge aguanta ~30 simultáneos)
    const POOL = 20;
    const results = new Array(threads.length);
    let idx = 0;
    const lane = async () => {
      while (idx < threads.length) {
        const i = idx++; const t = threads[i];
        try {
          const d = await this._bridge({ action: 'read_thread', threadId: t.id, includeHeaders: false });
          const from = d?.messages?.[0]?.from || d?.from || '';
          results[i] = { id: t.id, threadId: t.id, from, subject: t.subject || '', snippet: t.snippet || '', date: null };
        } catch { results[i] = { id: t.id, threadId: t.id, from: '', subject: t.subject || '', snippet: t.snippet || '', date: null }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, threads.length) }, lane));
    const nextCursor = threads.length === limit ? start + limit : null;
    return { messages: results, nextCursor };
  }

  async getThread(threadId) {
    const data = await this._bridge({ action: 'read_thread', threadId, includeHeaders: true });
    const msgs = (data?.messages || []).map(m => ({
      id: m.id || threadId,
      from: m.from || '', to: m.to || '', date: m.date || null,
      subject: m.subject || '', body: m.plainBody || m.body || '',
      listUnsubscribe: m.listUnsubscribe || null,
      listUnsubscribePost: m.listUnsubscribePost || null,
    }));
    // si el bridge no devuelve messages, armar uno solo con los datos del thread
    if (!msgs.length && data) msgs.push({
      id: threadId, from: data.from || '', to: '', date: null,
      subject: data.subject || '', body: data.plainBody || data.body || '',
      listUnsubscribe: data.listUnsubscribe || null, listUnsubscribePost: null,
    });
    return { id: threadId, messages: msgs };
  }

  async trashThread(threadId) {
    await this._bridge({ action: 'move_to_trash', threadId });
  }

  async sendMail({ to, subject, body }) {
    await this._bridge({ action: 'send_email', to, subject, body });
  }
}
