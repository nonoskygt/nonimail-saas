// Motor de clasificación/limpieza PROVIDER-AGNOSTIC.
// Recibe un `client` (cualquier MailProvider) + las reglas del usuario y decide
// por cada hilo: KEEP o TRASH. Conserva todas las protecciones del cleaner:
//   1. CADENAS / conversaciones  -> NUNCA borrar (el user respondió, o 2+ remitentes)
//   2. Protección financiera     -> regex keepOverride sobre asunto/from/cuerpo
//   3. Reglas del usuario         -> protect/delete por remitente
//   4. Heurística + LLM (score 0-100)
// El sesgo es siempre a CONSERVAR.
import { parseFrom } from '../providers/base.js';
import { score as llmScore, LLM_PROMPT } from '../llm/ollama.js';

// Dominio de un email (parte después de @, en minúsculas).
export function domainOf(email) { const p = String(email || '').toLowerCase().split('@'); return p.length > 1 ? p[1] : ''; }

// Regla efectiva de un remitente considerando reglas por REMITENTE y por DOMINIO.
// Devuelve 'protect' | 'delete' | null. La regla de remitente gana sobre la de dominio.
export function ruleFor(email, rules) {
  const e = String(email || '').toLowerCase();
  const d = domainOf(e);
  if (rules?.protect?.has(e)) return 'protect';
  if (rules?.delete?.has(e)) return 'delete';
  if (rules?.protectDomains?.has(d)) return 'protect';
  if (rules?.deleteDomains?.has(d)) return 'delete';
  return null;
}

// ---- protección por palabras clave GENÉRICAS (financiero / transaccional / seguridad) ----
// Aplica a cualquier usuario. Las protecciones específicas (tu dominio, tus proveedores)
// NO van aquí: se configuran con PROTECT_DOMAINS en .env o con las reglas por remitente/dominio.
export const RX_KEEP = new RegExp(
  '(\\bbanco\\b|\\bbank\\b|estado de cuenta|account statement|transferencia|wire transfer|comprobante|' +
  '\\brecibo\\b|receipt|\\bfactura\\b|invoice|\\bsaldo\\b|\\bbalance\\b|tarjeta de cr[eé]dito|credit card|dep[oó]sito|deposit|' +
  'c[oó]digo de (verificaci[oó]n|seguridad)|verification code|\\botp\\b|one-?time code|' +
  'inicio de sesi[oó]n|new (sign-?in|login)|alerta de seguridad|security alert|' +
  'payment|\\bpago\\b|cotizaci[oó]n|\\bquote\\b|purchase order|orden de compra|\\bproveedor\\b|\\bsupplier\\b|\\bfactura electr)', 'i');
// Dominios SIEMPRE protegidos, configurables por env (PROTECT_DOMAINS=midominio.com,banco.com)
import { config as _cfg } from '../config.js';
export function isConfigProtected(email) {
  const d = domainOf(email);
  return !!d && (_cfg.protectDomains || []).includes(d);
}
export const RX_SUBJ = /(\b\d{1,3}\s*%\s*(off|de\s*descuento)\b|\bdeal\b|\bsale\b|\boferta\b|\bdescuento\b|\bgratis\b|\bfree\b|\bnewsletter\b|\bpromo\b|black friday|flash sale|limited time)/i;
export const RX_FROM = /(noreply|no-reply|donotreply|marketing|newsletter|promociones|promotions|deals|news@|notifications@|mailer|campaign)/i;

const T_DELETE = 72; // score >= => borrar (dureza media; configurable a futuro por usuario)

// ¿Es una CADENA/conversación? -> nunca borrar.
export function isConversation(messages, myAddresses = []) {
  if (!messages || messages.length < 2) return false;
  const mine = new Set(myAddresses.map(a => a.toLowerCase()));
  const senders = new Set();
  for (const m of messages) {
    const { email } = parseFrom(m.from || '');
    if (mine.has(email)) return true;            // el usuario participó
    if (email && email !== '(desconocido)') senders.add(email);
  }
  return senders.size >= 2;                        // 2+ participantes => ida y vuelta
}

// Clasifica un hilo ya leído (ThreadFull) -> { decision, score, reason }.
export async function classifyThread(thread, { rules, myAddresses, account }) {
  const msgs = thread.messages || [];
  const first = msgs[0] || {};
  const subj = first.subject || thread.subject || '';
  const from = first.from || '';
  const body = first.body || '';
  const { email } = parseFrom(from);

  // 0) CADENA => KEEP (gana sobre todo)
  if (isConversation(msgs, [account?.email, ...(myAddresses || [])].filter(Boolean)))
    return { decision: 'keep', score: 0, reason: 'cadena' };
  // 1) reglas del usuario
  if (rules?.protect?.has(email)) return { decision: 'keep', score: 0, reason: 'regla-protect' };
  if (rules?.delete?.has(email)) return { decision: 'trash', score: 100, reason: 'regla-delete' };
  // 2) protección: dominios configurados + financiera/transaccional/seguridad
  if (isConfigProtected(email) || RX_KEEP.test(subj) || RX_KEEP.test(from) || RX_KEEP.test(body))
    return { decision: 'keep', score: 0, reason: 'protegido' };
  // 3) heurística rápida
  if (RX_FROM.test(from) || RX_SUBJ.test(subj)) {
    // aún así pasa por LLM si es dudoso por contenido; pero from noreply + subj promo = borrar
    if (RX_SUBJ.test(subj)) return { decision: 'trash', score: 95, reason: 'heur-subject' };
  }
  // 4) LLM score 0-100
  const bulk = first.listUnsubscribe ? 'si' : 'no';
  let b = body.replace(/[\r\n\t]+/g, ' ').slice(0, 2500);
  const s = await llmScore(`${LLM_PROMPT}\n\nFROM: ${from}\nSUBJECT: ${subj}\nBULK: ${bulk}\nBODY: ${b}\n\nRespuesta (0-100):`);
  return { decision: s >= T_DELETE ? 'trash' : 'keep', score: s, reason: 'llm' };
}

// Corre una limpieza sobre el buzón conectado. onLine = callback para SSE/log.
export async function runClean(client, { rules, myAddresses, dryRun = true, maxThreads = 200, onLine = () => {} }) {
  let cursor = null, processed = 0, trashed = 0, kept = 0;
  const seen = new Set();
  while (processed < maxThreads) {
    const page = await client.listMessages({ folder: 'inbox', limit: 50, cursor });
    const refs = (page.messages || []).filter(r => !seen.has(r.threadId || r.id));
    if (refs.length === 0) break;
    for (const ref of refs) {
      const tid = ref.threadId || ref.id;
      seen.add(tid);
      processed++;
      let thread;
      try { thread = await client.getThread(tid); }
      catch (e) { onLine({ kind: 'err', text: `read fallo ${tid}: ${e.message}` }); continue; }
      const verdict = await classifyThread(thread, { rules, myAddresses, account: client.account });
      const subj = (thread.messages?.[0]?.subject || ref.subject || '(sin asunto)').slice(0, 60);
      if (verdict.decision === 'trash') {
        if (!dryRun) { try { await client.trashThread(tid); } catch (e) { onLine({ kind: 'err', text: `trash fallo: ${e.message}` }); continue; } }
        trashed++;
        onLine({ kind: 'delete', text: `${dryRun ? '[DRY] ' : ''}🗑️ (${verdict.score}/${verdict.reason}) ${subj}` });
      } else {
        kept++;
        onLine({ kind: 'keep', text: `✓ (${verdict.score}/${verdict.reason}) ${subj}` });
      }
      if (processed >= maxThreads) break;
    }
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return { processed, trashed, kept, dryRun };
}
