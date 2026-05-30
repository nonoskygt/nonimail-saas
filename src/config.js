// Carga de configuración central desde .env (con defaults sanos para local).
import 'dotenv/config';

function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
}

export const config = {
  port: parseInt(process.env.PORT || '8780', 10),
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:8780',
  jwtSecret: req('JWT_SECRET', 'dev-insecure-secret-change-me'),
  encryptionKey: process.env.ENCRYPTION_KEY || '', // se valida en crypto.js
  llm: {
    url: process.env.OLLAMA_URL || 'http://localhost:11434',
    model: process.env.LLM_MODEL || 'qwen3:8b',
  },
  // Dominios que SIEMPRE se conservan (nunca se borran). Configurable, sin hardcode.
  // Ej: PROTECT_DOMAINS=miempresa.com,mibanco.com
  protectDomains: (process.env.PROTECT_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // Concurrencia máxima (configurable por env). Lectura/borrado paraleliza fuerte;
  // el LLM encola en Ollama (NUM_PARALLEL=1 óptimo en la 4070) así que subir su pool
  // no degrada, solo llena la cola.
  concurrency: {
    imapConnections: parseInt(process.env.IMAP_POOL || '15', 10), // conexiones IMAP reutilizables por buzón
    httpReads: parseInt(process.env.HTTP_POOL || '25', 10),       // Gmail/Outlook (HTTP) lecturas en paralelo
    gmailWrites: parseInt(process.env.GMAIL_WRITE_POOL || '12', 10), // escrituras Gmail (con reintentos backoff absorbe topes)
    llm: parseInt(process.env.LLM_POOL || '8', 10),               // llamadas LLM en vuelo (Ollama serializa)
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: (process.env.PUBLIC_URL || 'http://localhost:8780') + '/api/connect/gmail/callback',
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify', // leer + mover a papelera (no delete permanente)
      'https://www.googleapis.com/auth/userinfo.email',
      'openid',
    ],
  },
  microsoft: {
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    tenant: process.env.MS_TENANT || 'common',
    redirectUri: (process.env.PUBLIC_URL || 'http://localhost:8780') + '/api/connect/outlook/callback',
    scopes: ['Mail.ReadWrite', 'Mail.Send', 'User.Read', 'offline_access'],
  },
};

export function isConfigured(provider) {
  if (provider === 'gmail') return !!(config.google.clientId && config.google.clientSecret);
  if (provider === 'outlook') return !!(config.microsoft.clientId && config.microsoft.clientSecret);
  if (provider === 'imap') return true; // no necesita app credentials globales
  return false;
}
