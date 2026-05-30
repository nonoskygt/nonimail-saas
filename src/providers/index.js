// Registro de proveedores + fábrica de clientes con credenciales descifradas.
import { GmailProvider } from './gmail.js';
import { GmailBridgeProvider } from './gmail-bridge.js';
import { OutlookProvider } from './outlook.js';
import { ImapProvider } from './imap.js';
import { accounts } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';

export const PROVIDERS = {
  gmail: GmailProvider,
  'gmail-bridge': GmailBridgeProvider, // Gmail vía Apps Script bridge (sin OAuth)
  outlook: OutlookProvider,
  imap: ImapProvider,
};

export function providerClass(key) {
  const P = PROVIDERS[key];
  if (!P) throw new Error(`proveedor desconocido: ${key}`);
  return P;
}

// Construye un cliente listo para operar a partir de una fila de accounts.
// Descifra credenciales y refresca el access token OAuth si hace falta (y lo persiste).
export async function getClient(accountRow) {
  const P = providerClass(accountRow.provider);
  const account = {
    ...accountRow,
    secret: accountRow.secret_enc ? decrypt(accountRow.secret_enc) : null, // refresh token (OAuth) o JSON IMAP
    access: accountRow.access_enc ? decrypt(accountRow.access_enc) : null,
  };
  const client = new P(account);
  const refreshed = await client.refreshIfNeeded();
  if (refreshed?.access) {
    accounts.updateTokens.run(encrypt(refreshed.access), refreshed.expiry || null, accountRow.id);
    client.account.access = refreshed.access;
    client.account.expiry = refreshed.expiry || null;
  }
  return client;
}
