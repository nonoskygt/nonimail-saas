// ============================================================================
// CONECTOR GMAIL  (implementa MailProvider sobre la librería googleapis)
// ----------------------------------------------------------------------------
// OAuth2 con refresh token offline. El access token se refresca solo cuando
// está por vencer (refreshIfNeeded) y el caller (providers/index.js) lo persiste.
// Borrado = SIEMPRE papelera (threads.trash), nunca delete permanente.
// ============================================================================
import { google } from 'googleapis';
import { MailProvider, parseFrom } from './base.js';
import { config } from '../config.js';

// Pool de concurrencia mínimo (sin dependencias externas): ejecuta `worker`
// sobre cada item con un máximo de `size` tareas en vuelo a la vez.
async function mapPool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return results;
}

// Decodifica un payload base64url (el formato que usa la API de Gmail).
function decodeB64Url(data) {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

// Busca recursivamente en payload.parts la primera parte text/plain y la decodifica.
function extractPlainBody(payload) {
  if (!payload) return '';
  // Caso simple: el cuerpo viene directo en el payload raíz.
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeB64Url(payload.body.data);
  }
  // Caso multipart: recorrer las partes (puede haber anidamiento).
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const found = extractPlainBody(part);
      if (found) return found;
    }
  }
  return '';
}

// Devuelve el valor (primero) de un header por nombre, case-insensitive.
function headerValue(headers = [], name) {
  const wanted = name.toLowerCase();
  const h = headers.find((x) => x.name?.toLowerCase() === wanted);
  return h ? h.value : undefined;
}

export class GmailProvider extends MailProvider {
  static get key() { return 'gmail'; }
  static get oauth() { return true; }

  // --- OAuth helper estático (sin account todavía) ---
  static _oauthClient() {
    return new google.auth.OAuth2(
      config.google.clientId,
      config.google.clientSecret,
      config.google.redirectUri,
    );
  }

  // URL de consentimiento. offline + prompt:consent => garantiza refresh_token.
  static async getAuthUrl(state) {
    const oauth2Client = GmailProvider._oauthClient();
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: config.google.scopes,
      state,
    });
  }

  // Canjea el código por tokens y resuelve el email del usuario.
  static async exchangeCode(code) {
    const oauth2Client = GmailProvider._oauthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Email vía userinfo (scope userinfo.email). Fallback: decodificar id_token.
    let email;
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const { data } = await oauth2.userinfo.get();
      email = data.email;
    } catch {
      email = undefined;
    }
    if (!email && tokens.id_token) {
      // El id_token es un JWT; el payload (parte central) trae el email.
      const payload = tokens.id_token.split('.')[1];
      try {
        const claims = JSON.parse(decodeB64Url(payload));
        email = claims.email;
      } catch { /* sin email */ }
    }

    return {
      email,
      secret: tokens.refresh_token, // refresh token => se cifra y persiste
      access: tokens.access_token,
      expiry: tokens.expiry_date,   // epoch ms
    };
  }

  // --- Cliente de instancia con credenciales de this.account ---
  _client() {
    const auth = GmailProvider._oauthClient();
    auth.setCredentials({
      refresh_token: this.account.secret,
      access_token: this.account.access,
      expiry_date: this.account.expiry,
    });
    return google.gmail({ version: 'v1', auth });
  }

  // Refresca el access token si vence en <60s. Devuelve {access, expiry} o null.
  async refreshIfNeeded() {
    const expiry = this.account.expiry ? Number(this.account.expiry) : 0;
    if (expiry && expiry - Date.now() > 60_000) return null; // todavía vigente

    const auth = GmailProvider._oauthClient();
    auth.setCredentials({ refresh_token: this.account.secret });
    const { credentials } = await auth.refreshAccessToken();
    return {
      access: credentials.access_token,
      expiry: credentials.expiry_date,
    };
  }

  // Lista refs livianos del inbox. Trae metadata (From/Subject/Date) en paralelo.
  // Dedup por threadId para mostrar un solo ref por conversación.
  async listMessages({ folder = 'inbox', limit = 50, cursor } = {}) {
    const gmail = this._client();
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      q: `in:${folder}`,
      maxResults: limit,
      pageToken: cursor,
    });

    const ids = data.messages || [];
    // Por cada id, un get con format:'metadata' (no baja el cuerpo: barato).
    const refs = await mapPool(ids, 10, async ({ id }) => {
      const { data: msg } = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const headers = msg.payload?.headers || [];
      return {
        id: msg.id,
        threadId: msg.threadId,
        from: headerValue(headers, 'From') || '',
        subject: headerValue(headers, 'Subject') || '',
        snippet: msg.snippet || '',
        date: headerValue(headers, 'Date') || '',
      };
    });

    // Dedup por threadId conservando el orden de aparición.
    const seen = new Set();
    const messages = [];
    for (const ref of refs) {
      if (seen.has(ref.threadId)) continue;
      seen.add(ref.threadId);
      messages.push(ref);
    }

    return { messages, nextCursor: data.nextPageToken || null };
  }

  // Hilo completo: cuerpos en texto plano + headers de baja por mensaje.
  async getThread(threadId) {
    const gmail = this._client();
    const { data } = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    const messages = (data.messages || []).map((msg) => {
      const headers = msg.payload?.headers || [];
      const body = extractPlainBody(msg.payload) || msg.snippet || '';
      return {
        id: msg.id,
        from: headerValue(headers, 'From') || '',
        to: headerValue(headers, 'To') || '',
        date: headerValue(headers, 'Date') || '',
        subject: headerValue(headers, 'Subject') || '',
        body,
        listUnsubscribe: headerValue(headers, 'List-Unsubscribe'),
        listUnsubscribePost: headerValue(headers, 'List-Unsubscribe-Post'),
      };
    });

    return { id: threadId, messages };
  }

  // Mueve el hilo a Papelera (recuperable). NUNCA threads.delete.
  // Reintenta con backoff ante "Too many concurrent requests" / rate limit (429/403).
  async trashThread(threadId) {
    const gmail = this._client();
    for (let intento = 0; intento < 8; intento++) {
      try { await gmail.users.threads.trash({ userId: 'me', id: threadId }); return; }
      catch (e) {
        const msg = String(e?.message || e);
        const retriable = /concurrent|rate limit|rateLimit|userRateLimit|429|quota/i.test(msg);
        if (!retriable || intento === 7) throw e;
        // backoff exponencial con jitter, tope ~6s: 0.3,0.6,1.2,2.4,4.8,6,6...
        const delay = Math.min(6000, 300 * Math.pow(2, intento)) + Math.floor(Math.random() * 400);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // Escrituras Gmail: subimos el paralelismo y dejamos que el backoff de trashThread
  // absorba los "Too many concurrent requests" momentáneos → llega al techo real.
  writeConcurrency() { return config.concurrency.gmailWrites; }

  // Devuelve TODOS los threadIds del inbox de un remitente (frescos, en el momento del borrado).
  // No depende de los threadIds guardados en el scan → robusto entre reinicios.
  async listByFrom(email) {
    const gmail = this._client();
    const ids = new Set();
    let pageToken;
    do {
      const { data } = await gmail.users.messages.list({ userId: 'me', q: `from:${email} in:inbox`, maxResults: 500, pageToken });
      for (const m of (data.messages || [])) ids.add(m.threadId);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return [...ids];
  }

  // Reintento con backoff (compartido por trash y batch).
  async _retry(fn) {
    for (let i = 0; i < 8; i++) {
      try { return await fn(); }
      catch (e) {
        const msg = String(e?.message || e);
        if (!/concurrent|rate limit|rateLimit|userRateLimit|429|quota/i.test(msg) || i === 7) throw e;
        await new Promise(r => setTimeout(r, Math.min(6000, 300 * Math.pow(2, i)) + Math.floor(Math.random() * 400)));
      }
    }
  }

  // ===== BATCH TRASH (el tope de velocidad de Gmail) =====
  // Borra TODOS los correos de un remitente moviéndolos a Papelera en lotes de 1000
  // con messages.batchModify (UNA petición HTTP por lote) en vez de uno por uno.
  // Devuelve la cantidad de mensajes afectados. Si batchModify rechaza la etiqueta TRASH,
  // hace fallback a messages.trash por mensaje (más lento pero seguro).
  async trashByFrom(email, { dryRun = false } = {}) {
    const gmail = this._client();
    const ids = [];
    let pageToken;
    do {
      const { data } = await gmail.users.messages.list({ userId: 'me', q: `from:${email} in:inbox`, maxResults: 500, pageToken });
      for (const m of (data.messages || [])) ids.push(m.id);
      pageToken = data.nextPageToken;
    } while (pageToken);
    if (dryRun || ids.length === 0) return ids.length;

    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      try {
        await this._retry(() => gmail.users.messages.batchModify({
          userId: 'me', requestBody: { ids: chunk, addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] },
        }));
      } catch (e) {
        // Fallback: si batchModify no acepta TRASH, borrar uno por uno
        for (const id of chunk) { try { await this._retry(() => gmail.users.messages.trash({ userId: 'me', id })); } catch {} }
      }
    }
    return ids.length;
  }

  // Envía un correo construyendo un RFC822 crudo en base64url.
  async sendMail({ to, subject, body }) {
    const gmail = this._client();
    // Subject en MIME encoded-word UTF-8 para soportar acentos/emojis.
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject || '', 'utf8').toString('base64')}?=`;
    const lines = [
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      body || '',
    ];
    const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  }

  capabilities() {
    return { search: true, threads: true, trash: true, labels: true, unsubscribe: true };
  }

  // Gmail es HTTP: tolera mucha concurrencia (lo limita su rate-limit, no conexiones).
  readConcurrency() { return config.concurrency.httpReads; }
}
