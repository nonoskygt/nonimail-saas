// Capa de datos multi-tenant. Usa el SQLite NATIVO de Node (node:sqlite) para no
// requerir compilación C++ en Windows. Local-first; portable a Postgres al desplegar.
// Tablas:
//   users    — cuentas del SaaS (login propio, JWT)
//   accounts — buzones conectados por usuario (gmail/outlook/imap), credenciales cifradas
//   rules    — reglas por usuario+remitente (protect/delete)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'nonimail.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT UNIQUE NOT NULL,
  pass_hash   TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,            -- 'gmail' | 'outlook' | 'imap'
  email        TEXT NOT NULL,            -- buzón conectado
  secret_enc   TEXT,                     -- refresh token (OAuth) o JSON IMAP, cifrado
  access_enc   TEXT,                     -- access token (OAuth), cifrado
  expiry       INTEGER,                  -- epoch ms de expiración del access token
  status       TEXT NOT NULL DEFAULT 'connected',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, provider, email)
);

CREATE TABLE IF NOT EXISTS rules (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender    TEXT NOT NULL,
  rule      TEXT NOT NULL,
  UNIQUE(user_id, sender)
);

CREATE TABLE IF NOT EXISTS scan_results (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  revisados  INTEGER NOT NULL DEFAULT 0,
  senders    TEXT NOT NULL DEFAULT '[]'
);
`);

// node:sqlite usa parámetros POSICIONALES (?) — los envoltorios mantienen una API
// parecida a better-sqlite3 (.run/.get/.all) para el resto del código.
export const users = {
  create: db.prepare('INSERT INTO users (email, pass_hash) VALUES (?, ?)'),
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
};

const _accUpsert = db.prepare(`
  INSERT INTO accounts (user_id, provider, email, secret_enc, access_enc, expiry, status)
  VALUES (?, ?, ?, ?, ?, ?, 'connected')
  ON CONFLICT(user_id, provider, email) DO UPDATE SET
    secret_enc = COALESCE(excluded.secret_enc, accounts.secret_enc),
    access_enc = excluded.access_enc,
    expiry     = excluded.expiry,
    status     = 'connected'
`);
export const accounts = {
  upsert: { run: (a) => _accUpsert.run(a.user_id, a.provider, a.email, a.secret_enc ?? null, a.access_enc ?? null, a.expiry ?? null) },
  byUser: db.prepare('SELECT id, provider, email, status, expiry, created_at FROM accounts WHERE user_id = ?'),
  byId: db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?'),
  updateTokens: db.prepare('UPDATE accounts SET access_enc = ?, expiry = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM accounts WHERE id = ? AND user_id = ?'),
};

// Reglas por remitente (email con @) o por dominio (sin @). El "scope" se infiere:
// si el valor contiene '@' es un remitente; si no, es un dominio.
export const rules = {
  set: db.prepare(`INSERT INTO rules (user_id, sender, rule) VALUES (?, ?, ?)
                   ON CONFLICT(user_id, sender) DO UPDATE SET rule = excluded.rule`),
  unset: db.prepare('DELETE FROM rules WHERE user_id = ? AND sender = ?'),
  byUser: db.prepare('SELECT sender, rule FROM rules WHERE user_id = ?'),
  // 4 conjuntos: protect/delete por remitente y por dominio
  mapFor(userId) {
    const m = { protect: new Set(), delete: new Set(), protectDomains: new Set(), deleteDomains: new Set() };
    for (const r of this.byUser.all(userId)) {
      const isDomain = !r.sender.includes('@');
      if (r.rule === 'protect') (isDomain ? m.protectDomains : m.protect).add(r.sender);
      else if (r.rule === 'delete') (isDomain ? m.deleteDomains : m.delete).add(r.sender);
    }
    return m;
  },
  // Lista agrupada para el panel lateral
  listFor(userId) {
    const out = { protectSenders: [], deleteSenders: [], protectDomains: [], deleteDomains: [] };
    for (const r of this.byUser.all(userId)) {
      const isDomain = !r.sender.includes('@');
      if (r.rule === 'protect') (isDomain ? out.protectDomains : out.protectSenders).push(r.sender);
      else if (r.rule === 'delete') (isDomain ? out.deleteDomains : out.deleteSenders).push(r.sender);
    }
    return out;
  },
};

// Resultados del último scan (persiste entre reinicios del server)
const _scanUpsert = db.prepare(`
  INSERT INTO scan_results (user_id, revisados, senders, scanned_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(user_id) DO UPDATE SET revisados=excluded.revisados, senders=excluded.senders, scanned_at=excluded.scanned_at
`);
export const scanResults = {
  save: (userId, revisados, sendersArr) => _scanUpsert.run(userId, revisados, JSON.stringify(sendersArr)),
  load: (userId) => {
    const row = db.prepare('SELECT * FROM scan_results WHERE user_id = ?').get(userId);
    if (!row) return null;
    return { revisados: row.revisados, scanned_at: row.scanned_at, senders: JSON.parse(row.senders || '[]') };
  },
};
