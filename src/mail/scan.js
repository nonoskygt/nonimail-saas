// Escaneo por remitente + ejecución de borrado + baja (unsubscribe).
// Provider-agnóstico: opera sobre cualquier MailProvider. Multi-tenant: estado por usuario.
import { parseFrom } from '../providers/base.js';
import { isConversation, RX_KEEP, RX_FROM, RX_SUBJ, ruleFor, domainOf, isConfigProtected } from './engine.js';
import { score as llmScore, LLM_PROMPT } from '../llm/ollama.js';
import { emit, line, sender as emitSender, stats as emitStats, job } from './live.js';
import { config } from '../config.js';
import { scanResults } from '../db.js';

// Pool de concurrencia sin dependencias.
async function pMap(items, size, worker, abortFn = () => false) {
  const out = new Array(items.length);
  let i = 0;
  async function lane() { while (i < items.length && !abortFn()) { const k = i++; out[k] = await worker(items[k], k); } }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
  return out;
}

const shortSubj = (s, n = 48) => { s = s || '(sin asunto)'; return s.length > n ? s.slice(0, n) + '…' : s; };

// ===== ESCANEO POR REMITENTE =====
// Lee el inbox, agrupa por remitente, clasifica cada remitente una vez (protegido/regla/heur/LLM)
// y emite eventos en vivo. Guarda en el job los threadIds por remitente para el Ejecutar posterior.
export async function scanSenders(client, userId, { rules, myAddresses, sampleSize = 300 }) {
  const j = job(userId);
  j.scanning = true; j.abort = false; j.senders = new Map();
  j.stats = { revisados: 0, borrados: 0, conservados: 0, remitentes: 0 };
  emitStats(userId, j);
  emit(userId, { t: 'scanstart' });
  const all = !Number.isFinite(sampleSize) || sampleSize <= 0;
  line(userId, 'cpu', `Escaneando ${all ? 'TODO el buzón' : 'muestra ' + sampleSize}…`, 'info');

  const groups = j.senders; // email -> grupo
  const pushSender = (g) => emitSender(userId, {
    email: g.email, name: g.name, count: g.count, samples: g.samples,
    canUnsub: g.canUnsub, score: g.score, reason: g.reason,
    rule: ruleFor(g.email, rules), // considera reglas por remitente Y por dominio
  });

  // ===== FASE A: paginar el inbox y AGRUPAR por remitente (solo envelopes — barato) =====
  // No bajamos cuerpos acá: agrupar 38k correos por `from` es liviano y rápido.
  let cursor = null, total = 0;
  const cap = all ? Infinity : sampleSize;
  while (total < cap && !j.abort) {
    const page = await client.listMessages({ folder: 'inbox', limit: 200, cursor });
    const msgs = page.messages || [];
    if (msgs.length === 0) break;
    for (const ref of msgs) {
      if (total >= cap) break;
      total++;
      const { email, name } = parseFrom(ref.from);
      let g = groups.get(email);
      if (!g) { g = { email, name, count: 0, samples: [], threadIds: [], canUnsub: false, score: null, reason: null }; groups.set(email, g); }
      g.count++;
      g.threadIds.push(ref.threadId || ref.id); // sin límite: el Ejecutar necesita TODOS para borrar completo
      if (g.samples.length < 3 && ref.subject) g.samples.push(shortSubj(ref.subject, 48));
    }
    j.stats.revisados = total; j.stats.remitentes = groups.size; emitStats(userId, j);
    line(userId, 'cpu', `agrupados ${total} correos → ${groups.size} remitentes`, 'scan');
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  for (const g of groups.values()) pushSender(g); // poblar la tabla ya

  // ===== FASE B: clasificar cada remitente (UNA lectura + heur/LLM) =====
  const readPool = client.readConcurrency ? client.readConcurrency() : 8;
  const mine = [client.account?.email, ...(myAddresses || [])].filter(Boolean);
  const senders = [...groups.values()];
  line(userId, 'cpu', `clasificando ${senders.length} remitentes (lectura pool ${readPool}, LLM pool ${config.concurrency.llm})…`, 'info');
  await pMap(senders, readPool, async (g) => {
    if (j.abort) return;
    const rf = ruleFor(g.email, rules);
    if (rf === 'protect') { g.score = 0; g.reason = 'regla'; pushSender(g); return; }
    if (rf === 'delete') { g.score = 100; g.reason = 'regla'; pushSender(g); return; }
    // leer UN mensaje del remitente: cuerpo + List-Unsubscribe + (cadena). La conexión
    // se libera al volver getThread, ANTES de la llamada LLM (no la retiene).
    let thread; try { thread = await client.getThread(g.threadIds[0]); } catch { thread = null; }
    const tmsgs = thread?.messages || [];
    const m0 = tmsgs[0] || {};
    const from = m0.from || g.email;
    const body = m0.body || '';
    if (m0.listUnsubscribe) g.canUnsub = true;
    const subj = g.samples[0] || '';
    if (isConversation(tmsgs, mine)) { g.score = 0; g.reason = 'cadena'; }
    else if (isConfigProtected(g.email) || RX_KEEP.test(subj) || RX_KEEP.test(from) || RX_KEEP.test(body)) { g.score = 0; g.reason = 'protegido'; }
    else if (RX_SUBJ.test(subj)) { g.score = 95; g.reason = 'heur'; }
    else {
      const b = body.replace(/[\r\n\t]+/g, ' ').slice(0, 2500);
      const prompt = `${LLM_PROMPT}\n\nFROM: ${from}\nSUBJECT: ${g.samples.join(' | ')}\nBULK: ${g.canUnsub ? 'si' : 'no'}\nBODY: ${b}\n\nRespuesta (0-100):`;
      g.score = await llmScore(prompt); g.reason = 'llm';
      line(userId, 'gpu', `ruido=${g.score} → ${g.name.slice(0, 30)}`, g.score >= 60 ? 'delete' : g.score <= 40 ? 'keep' : 'dry');
    }
    pushSender(g);
  }, () => j.abort);

  j.stats.remitentes = groups.size;
  j.scanning = false;
  emitStats(userId, j);
  emit(userId, { t: 'scandone', total: groups.size, sampled: total });
  if (client.close) await client.close().catch(() => {});
  // Persistir en SQLite para que sobreviva reinicios del server
  try {
    const arr = [...groups.values()].map(g => ({
      email: g.email, name: g.name, count: g.count, score: g.score, reason: g.reason,
      canUnsub: g.canUnsub, samples: g.samples, rule: g.rule || null,
    }));
    scanResults.save(userId, total, arr);
  } catch(e) { /* no crítico */ }
  return { senders: groups.size, sampled: total };
}

// ===== EJECUTAR =====
// Borra (a Papelera) TODOS los correos de los remitentes indicados.
// Estrategia: para cada remitente, pagina el buzón real buscando sus mensajes en lugar
// de depender de los threadIds del scan (que podían estar incompletos).
// Respeta protección: RX_KEEP + regla protect = nunca borra.
export async function executeDeletes(client, userId, { emails, rules, dryRun = true }) {
  const j = job(userId);
  j.running = true; j.abort = false;
  emitStats(userId, j);

  const pool = client.writeConcurrency ? client.writeConcurrency() : (client.readConcurrency ? client.readConcurrency() : 8);
  line(userId, 'cpu', `EJECUTAR: ${emails.length} remitentes, pool ${pool}${dryRun ? ' [DRY]' : ''}`, 'info');

  // Para cada remitente: borrar todos sus correos del inbox.
  await pMap(emails, pool, async (email) => {
    if (j.abort) return;
    if (ruleFor(email, rules) === 'protect') { line(userId, 'cpu', `omitido (protegido): ${email}`, 'keep'); return; }
    if (isConfigProtected(email) || RX_KEEP.test(email)) { line(userId, 'cpu', `omitido (protegido): ${email}`, 'keep'); return; }

    // RUTA RÁPIDA: el proveedor soporta batch trash (Gmail) → 1 petición por lote de 1000
    if (client.trashByFrom) {
      try {
        const n = await client.trashByFrom(email, { dryRun });
        if (n > 0) { j.stats.borrados += n; line(userId, dryRun ? 'heur' : 'gpu', `${dryRun ? '[DRY] ' : ''}🗑️ ${email} (${n})`, dryRun ? 'dry' : 'delete'); emitStats(userId, j); }
      } catch (e) { line(userId, 'gpu', `ERR ${email}: ${e.message}`, 'err'); }
      return;
    }

    // RUTA ESTÁNDAR: re-consultar threads y borrarlos uno por uno (IMAP, etc.)
    const g = j.senders.get(email) || {};
    let threadIds = g.threadIds || [];
    if (client.listByFrom) { try { threadIds = await client.listByFrom(email); } catch {} }
    if (!threadIds.length) { line(userId, 'cpu', `sin correos en inbox: ${email}`, 'info'); return; }
    let del = 0;
    for (const tid of threadIds) {
      if (j.abort) break;
      if (dryRun) { del++; j.stats.borrados++; }
      else { try { await client.trashThread(tid); del++; j.stats.borrados++; } catch (e) { line(userId, 'gpu', `ERR ${email}: ${e.message}`, 'err'); } }
    }
    if (del > 0) line(userId, dryRun ? 'heur' : 'gpu', `${dryRun ? '[DRY] ' : ''}🗑️ ${email} (${del})`, dryRun ? 'dry' : 'delete');
    emitStats(userId, j);
  }, () => j.abort);

  j.running = false;
  emitStats(userId, j);
  line(userId, 'cpu', `EJECUCIÓN LISTA. Borrados=${j.stats.borrados}${dryRun ? ' [DRY]' : ''}`, 'info');
  if (client.close) await client.close().catch(() => {});
  return { borrados: j.stats.borrados, dryRun };
}

// ===== BAJA (unsubscribe) =====
// Usa el header List-Unsubscribe del primer hilo del remitente: one-click POST (RFC 8058),
// mailto (vía client.sendMail) o GET https.
export async function unsubscribeSender(client, userId, email) {
  const g = job(userId).senders.get(email);
  const tid = g?.threadIds?.[0];
  if (!tid) return { ok: false, error: 'sin hilos del remitente (escaneá primero)' };
  const thread = await client.getThread(tid);
  const m = thread.messages?.[0];
  const lu = m?.listUnsubscribe;
  if (!lu) return { ok: false, error: 'este remitente no expone List-Unsubscribe' };

  const urls = [...String(lu).matchAll(/<([^>]+)>/g)].map(x => x[1].trim());
  const https = urls.find(u => /^https?:/i.test(u));
  const mailto = urls.find(u => /^mailto:/i.test(u));
  try {
    if (https && /one-?click/i.test(m.listUnsubscribePost || '')) {
      const r = await fetch(https, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click', signal: AbortSignal.timeout(20000) });
      return { ok: true, method: 'one-click POST', status: r.status };
    }
    if (mailto) {
      const addr = mailto.replace(/^mailto:/i, '').split('?')[0];
      await client.sendMail({ to: addr, subject: 'unsubscribe', body: 'Please unsubscribe me. Solicito baja.' });
      return { ok: true, method: 'mailto', to: addr };
    }
    if (https) {
      const r = await fetch(https, { method: 'GET', signal: AbortSignal.timeout(20000) });
      return { ok: true, method: 'GET', status: r.status };
    }
    return { ok: false, error: 'header sin url/mailto utilizable' };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
