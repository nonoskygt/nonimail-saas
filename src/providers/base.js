// ============================================================================
// ABSTRACCIÓN DE PROVEEDOR DE CORREO  (el "fix de raíz")
// ----------------------------------------------------------------------------
// Todo el motor de limpieza (engine.js) habla SOLO con esta interfaz, nunca con
// Gmail/Graph/IMAP directamente. Así los 3 conectores se desarrollan en paralelo
// y son intercambiables. Cada conector (gmail.js, outlook.js, imap.js) exporta
// una clase que extiende MailProvider e implementa estos métodos.
//
// MODELO DE DATOS NORMALIZADO (todos los proveedores devuelven esta forma):
//
//   MessageRef  = { id, threadId, from, subject, snippet, date, labels?: string[], unread?: bool }
//   ThreadFull  = { id, messages: [ MessageMsg ] }
//   MessageMsg  = { id, from, to?, date, subject, body, listUnsubscribe?, listUnsubscribePost? }
//
// `account` es la fila de la tabla accounts ya descifrada por el caller
// (ver providers/index.js -> getClient), con credenciales utilizables.
// ============================================================================

export class MailProvider {
  /** @param {object} account fila de accounts con credenciales descifradas */
  constructor(account) { this.account = account; }

  // ---- capacidades (para que la UI/engine sepan qué se puede) ----
  static get key() { return 'base'; }            // 'gmail' | 'outlook' | 'imap'
  static get oauth() { return false; }           // ¿usa OAuth (consent web) o credenciales directas?
  capabilities() { return { search: true, threads: true, trash: true, labels: false, unsubscribe: true }; }

  // máximo de operaciones de lectura en paralelo que tolera el proveedor.
  readConcurrency() { return 8; }
  // máximo de ESCRITURAS (borrar/mover) en paralelo. Por defecto = lectura; los proveedores
  // con límites de escritura más estrictos (Gmail) lo sobreescriben más bajo.
  writeConcurrency() { return this.readConcurrency(); }
  // cierre opcional de recursos (p.ej. pool de conexiones IMAP). No-op por defecto.
  async close() {}

  // ===== FLUJO DE CONEXIÓN =====
  // OAuth (gmail/outlook): getAuthUrl + exchangeCode son ESTÁTICOS (no hay account aún).
  //   getAuthUrl(state) -> string  (URL de consentimiento)
  //   exchangeCode(code) -> { email, secret (refresh token), access, expiry }
  // IMAP: no hay OAuth; connectDirect valida host/usuario/contraseña.
  //   connectDirect(creds) -> { email, secret (JSON cifrable), access:null, expiry:null }
  static async getAuthUrl(/* state */) { throw new Error('no implementado'); }
  static async exchangeCode(/* code */) { throw new Error('no implementado'); }
  static async connectDirect(/* creds */) { throw new Error('no implementado'); }

  // refresca el access token si está por vencer; devuelve { access, expiry } o null si no aplica.
  async refreshIfNeeded() { return null; }

  // ===== OPERACIONES SOBRE EL BUZÓN =====
  // listMessages: pagina mensajes/hilos según query. `query` es un objeto neutro:
  //   { folder?: 'inbox', limit?: 50, cursor?: <opaco>, unreadOnly?: bool }
  //   -> { messages: MessageRef[], nextCursor: <opaco|null> }
  async listMessages(/* query */) { throw new Error('no implementado'); }

  // getThread: hilo completo con cuerpos y headers de baja.
  //   -> ThreadFull
  async getThread(/* threadId */) { throw new Error('no implementado'); }

  // trashThread: mueve a Papelera (RECUPERABLE — nunca borrado permanente).
  async trashThread(/* threadId */) { throw new Error('no implementado'); }

  // sendMail: para ejecutar bajas por mailto. { to, subject, body }
  async sendMail(/* msg */) { throw new Error('no implementado'); }
}

// Util compartido: extrae email/nombre de un header From.
export function parseFrom(from) {
  if (!from) return { email: '(desconocido)', name: '' };
  const m = String(from).match(/<([^>]+)>/);
  const email = (m ? m[1] : from).trim().toLowerCase();
  let name = String(from).replace(/<[^>]*>/, '').replace(/"/g, '').trim();
  if (!name) name = email;
  return { email, name };
}
