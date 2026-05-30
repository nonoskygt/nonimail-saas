// Cliente LLM para clasificación de "ruido" 0-100. Local (Ollama) por ahora;
// en producción multiusuario apuntar OLLAMA_URL al server CT141 (vLLM/Open-WebUI).
import { config } from '../config.js';

export async function score(prompt) {
  try {
    const r = await fetch(`${config.llm.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.llm.model,
        prompt: prompt + '\n/no_think',
        stream: false, think: false,
        options: { temperature: 0, num_predict: 16, num_ctx: 4096 },
      }),
      signal: AbortSignal.timeout(120000),
    });
    const j = await r.json();
    return parseScore(j.response, 50);
  } catch {
    return 50; // ante fallo del LLM: dudoso (se conserva por sesgo a KEEP)
  }
}

export function parseScore(txt, fallback = 50) {
  if (txt == null) return fallback;
  let m = txt.match(/(?:respuesta|puntaje|puntuaci[oó]n|score)\D{0,8}(\d{1,3})/i);
  if (m) { const n = +m[1]; if (n >= 0 && n <= 100) return n; }
  m = txt.match(/\*\*\s*(\d{1,3})\s*\*\*/);
  if (m) { const n = +m[1]; if (n >= 0 && n <= 100) return n; }
  const t2 = String(txt).replace(/(sobre|de)\s*100/gi, ' ').replace(/\/\s*100/g, ' ').replace(/0\s*[-a]\s*100/gi, ' ');
  const all = [...t2.matchAll(/\b(\d{1,3})\b/g)].map(x => +x[1]).filter(n => n >= 0 && n <= 100);
  return all.length ? all[all.length - 1] : fallback;
}

export const LLM_PROMPT = `Sos un asistente que limpia la bandeja de entrada de una persona. Evalua cuanto RUIDO/PROMOCIONAL es un correo y devolve SOLO un numero entero de 0 a 100 (sin texto):
- 100 = basura segura (marketing, ofertas, newsletters, publicidad, notificaciones automaticas de redes sociales).
- 0 = importante (persona real, factura, recibo, banco, alerta de seguridad, codigo 2FA, pedido propio, cita, tramite).
- Valores medios (40-60) = genuinamente dudoso.
Considera BULK (trae opcion de baja => sube el puntaje), salvo contenido transaccional/importante.

Respuesta (0-100):`;
