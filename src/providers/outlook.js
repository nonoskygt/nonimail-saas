// ============================================================================
// CONECTOR OUTLOOK / MICROSOFT 365  (NoniMail SaaS)
// ----------------------------------------------------------------------------
// Implementa la interfaz MailProvider (ver base.js) contra Microsoft Graph.
//   - OAuth: @azure/msal-node (ConfidentialClientApplication)
//   - Operaciones de buzón: @microsoft/microsoft-graph-client
//
// Modelo normalizado que devolvemos (ver base.js):
//   MessageRef = { id, threadId, from, subject, snippet, date }
//   ThreadFull = { id, messages: [ MessageMsg ] }
//   MessageMsg = { id, from, to, date, subject, body, listUnsubscribe, listUnsubscribePost }
// ============================================================================

import { ConfidentialClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import { MailProvider, parseFrom } from './base.js';
import { config } from '../config.js';

// Autoridad MS (tenant 'common' por defecto, ver config.microsoft.tenant).
const AUTHORITY = `https://login.microsoftonline.com/${config.microsoft.tenant}`;

// Instancia única de MSAL (las credenciales de app son globales, no por cuenta).
let _cca = null;
function cca() {
  if (!_cca) {
    _cca = new ConfidentialClientApplication({
      auth: {
        clientId: config.microsoft.clientId,
        clientSecret: config.microsoft.clientSecret,
        authority: AUTHORITY,
      },
    });
  }
  return _cca;
}

// ----------------------------------------------------------------------------
// Extrae el refresh token del token cache serializado de MSAL.
// NOTA IMPORTANTE: msal-node NO expone el refresh token directamente en la
// respuesta de acquireTokenByCode (por diseño, para forzar el uso del cache).
// La única vía soportada es serializar el cache y leer el nodo RefreshToken.
// Tras un acquireTokenByCode reciente el cache contiene exactamente un RT.
// TODO: si en el futuro hay múltiples cuentas en una misma instancia de MSAL,
//       habría que filtrar el RT por home_account_id; aquí asumimos cache fresco.
// ----------------------------------------------------------------------------
function extractRefreshToken(serializedCache) {
  try {
    const parsed = JSON.parse(serializedCache || '{}');
    const rts = parsed.RefreshToken || {};
    const first = Object.values(rts)[0];
    return first?.secret || null;
  } catch {
    return null;
  }
}

export class OutlookProvider extends MailProvider {
  // ===== capacidades / metadatos =====
  static get key() { return 'outlook'; }
  static get oauth() { return true; }

  capabilities() {
    return { search: true, threads: true, trash: true, labels: false, unsubscribe: true };
  }

  // Microsoft Graph es HTTP: alta concurrencia (limita el rate-limit, no conexiones).
  readConcurrency() { return config.concurrency.httpReads; }

  // ===== FLUJO OAuth (estático: aún no hay account) =====

  // URL de consentimiento de Microsoft.
  static async getAuthUrl(state) {
    return cca().getAuthCodeUrl({
      scopes: config.microsoft.scopes,
      redirectUri: config.microsoft.redirectUri,
      state,
    });
  }

  // Intercambia el code por tokens y devuelve la forma que espera el caller.
  static async exchangeCode(code) {
    const response = await cca().acquireTokenByCode({
      code,
      scopes: config.microsoft.scopes,
      redirectUri: config.microsoft.redirectUri,
    });

    // El refresh token no viene en `response`; hay que leerlo del cache serializado
    // inmediatamente después del intercambio (ver extractRefreshToken arriba).
    const secret = extractRefreshToken(cca().getTokenCache().serialize());

    return {
      email: response.account?.username,
      secret,                                   // refresh token (se cifra aguas arriba)
      access: response.accessToken,
      expiry: response.expiresOn?.getTime() ?? null, // epoch ms
    };
  }

  // ===== cliente Graph de instancia =====
  // El access token ya viene descifrado y refrescado por getClient (index.js).
  _graph() {
    return Client.init({
      authProvider: (done) => done(null, this.account.access),
    });
  }

  // Refresca el access token si vence en <60s. Usa el refresh token (this.account.secret).
  async refreshIfNeeded() {
    const margin = 60 * 1000; // 60s
    if (this.account.expiry && this.account.expiry - Date.now() > margin) {
      return null; // todavía válido, no hace falta refrescar
    }
    const response = await cca().acquireTokenByRefreshToken({
      refreshToken: this.account.secret,
      scopes: config.microsoft.scopes,
    });
    return {
      access: response.accessToken,
      expiry: response.expiresOn?.getTime() ?? null,
    };
  }

  // ===== OPERACIONES DE BUZÓN =====

  // Lista mensajes de la carpeta (por defecto Inbox), paginando con @odata.nextLink.
  async listMessages({ folder = 'inbox', limit = 50, cursor } = {}) {
    const g = this._graph();

    // Si viene cursor (un @odata.nextLink completo), se consume tal cual.
    // Si no, se construye la query inicial sobre mailFolders/inbox.
    const req = cursor
      ? g.api(cursor)
      : g
          .api('/me/mailFolders/inbox/messages')
          .select('id,subject,from,bodyPreview,receivedDateTime,conversationId')
          .top(limit);

    const response = await req.get();

    const messages = (response.value || []).map((m) => ({
      id: m.id,
      threadId: m.conversationId,
      from: m.from?.emailAddress?.address || '',
      subject: m.subject || '',
      snippet: m.bodyPreview || '',
      date: m.receivedDateTime || null,
    }));

    return {
      messages,
      nextCursor: response['@odata.nextLink'] || null,
    };
  }

  // Hilo completo. En Graph un "hilo" es una conversationId; filtramos por ella.
  async getThread(threadId) {
    const g = this._graph();
    const response = await g
      .api('/me/messages')
      .filter(`conversationId eq '${threadId}'`)
      .select('id,from,toRecipients,subject,receivedDateTime,body,internetMessageHeaders')
      .get();

    const messages = (response.value || []).map((m) => {
      // Header List-Unsubscribe (para bajas) — los headers vienen como [{name,value}].
      const headers = m.internetMessageHeaders || [];
      const findHeader = (name) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || null;

      return {
        id: m.id,
        from: m.from?.emailAddress?.address || '',
        to: (m.toRecipients || [])
          .map((r) => r.emailAddress?.address)
          .filter(Boolean)
          .join(', '),
        date: m.receivedDateTime || null,
        subject: m.subject || '',
        body: htmlToText(m.body?.content || ''),
        listUnsubscribe: findHeader('List-Unsubscribe'),
        listUnsubscribePost: findHeader('List-Unsubscribe-Post'),
      };
    });

    return { id: threadId, messages };
  }

  // Mueve cada mensaje de la conversación a "Elementos eliminados" (Papelera).
  // RECUPERABLE — nunca borrado permanente.
  async trashThread(threadId) {
    const g = this._graph();
    const response = await g
      .api('/me/messages')
      .filter(`conversationId eq '${threadId}'`)
      .select('id')
      .get();

    for (const m of response.value || []) {
      await g.api(`/me/messages/${m.id}/move`).post({ destinationId: 'deleteditems' });
    }
  }

  // Envía un correo (usado para ejecutar bajas por mailto).
  async sendMail({ to, subject, body }) {
    const g = this._graph();
    await g.api('/me/sendMail').post({
      message: {
        subject: subject || '',
        body: { contentType: 'Text', content: body || '' },
        toRecipients: [{ emailAddress: { address: to } }],
      },
    });
  }
}

// Despoja HTML a texto plano de forma simple (sin dependencias).
// Suficiente para que el LLM/engine lea el cuerpo; no busca render fiel.
function htmlToText(content) {
  if (!content) return '';
  return String(content)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// `parseFrom` queda disponible para el engine si necesita separar nombre/email;
// aquí ya devolvemos `from` como dirección cruda según el contrato.
export { parseFrom };
