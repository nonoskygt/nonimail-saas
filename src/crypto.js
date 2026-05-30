// Cifrado en reposo de tokens OAuth y contraseñas IMAP (AES-256-GCM).
// La clave viene de ENCRYPTION_KEY (hex de 32 bytes). En local, si falta, se deriva una
// efímera y se avisa (NO usar así en producción: al reiniciar se pierden los tokens).
import crypto from 'node:crypto';
import { config } from './config.js';

let KEY;
if (config.encryptionKey && /^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) {
  KEY = Buffer.from(config.encryptionKey, 'hex');
} else {
  KEY = crypto.randomBytes(32);
  console.warn('[crypto] ENCRYPTION_KEY ausente/inválida: usando clave EFÍMERA. ' +
    'Los tokens cifrados NO sobrevivirán a un reinicio. Generá una con: ' +
    'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

export function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // formato: iv.tag.ciphertext (todo base64url)
  return [iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decrypt(blob) {
  if (blob == null) return null;
  const [ivB, tagB, dataB] = String(blob).split('.');
  const iv = Buffer.from(ivB, 'base64url');
  const tag = Buffer.from(tagB, 'base64url');
  const data = Buffer.from(dataB, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
