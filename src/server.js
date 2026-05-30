// NoniMail SaaS — entrypoint. Express, multi-tenant, 3 conectores de correo.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, isConfigured } from './config.js';
import { authRouter } from './auth/routes.js';
import { mailRouter } from './mail/routes.js';
import { startMetrics } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => res.json({
  ok: true,
  providers: {
    gmail: isConfigured('gmail'),
    outlook: isConfigured('outlook'),
    imap: isConfigured('imap'),
  },
}));

app.use('/api/auth', authRouter);
app.use('/api', mailRouter);

app.listen(config.port, () => {
  console.log(`NoniMail SaaS escuchando en ${config.publicUrl} (puerto ${config.port})`);
  console.log(`  conectores: gmail=${isConfigured('gmail')} outlook=${isConfigured('outlook')} imap=${isConfigured('imap')}`);
  startMetrics();
});
