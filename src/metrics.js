// Métricas de máquina (CPU/GPU) emitidas por SSE a todos los clientes.
// El SaaS corre local (misma laptop con GPU), así que estos medidores son reales
// — idéntico al cleaner. En un deploy a server sin GPU, gpuQuery devuelve null y se muestra n/a.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { broadcast, clientCount } from './mail/live.js';

let last = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
function cpuPercent() {
  const now = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
  let idleD = 0, totalD = 0;
  for (let i = 0; i < now.length; i++) { idleD += now[i].idle - last[i].idle; totalD += now[i].total - last[i].total; }
  last = now;
  return totalD > 0 ? Math.round(100 * (1 - idleD / totalD)) : 0;
}
function gpuQuery() {
  return new Promise(res => {
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 4000 }, (err, out) => {
      if (err || !out) return res(null);
      const p = out.trim().split('\n')[0].split(',').map(x => parseInt(x.trim()));
      res({ util: p[0] || 0, vramUsed: p[1] || 0, vramTotal: p[2] || 0 });
    });
  });
}

export function startMetrics() {
  setInterval(async () => {
    if (clientCount() === 0) { cpuPercent(); return; } // mantené el baseline pero no spawnees nvidia-smi sin clientes
    const cpu = cpuPercent();
    const gpu = await gpuQuery().catch(() => null);
    broadcast({ t: 'metrics', cpu, gpu });
  }, 2500);
}
