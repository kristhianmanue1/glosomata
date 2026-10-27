// Duración wall-clock de la operación completa, incluida limpieza.
// Un fallo inesperado conserva sólo un código contratado.
import { normalizeErrorCode } from './error-codes.mjs';

export async function measureOperation(fn) {
  const startedAt = performance.now();
  let result;
  try {
    result = await fn();
  } catch (e) {
    result = { code: 1, data: { error: normalizeErrorCode(e?.code),
      ...(e?.code === 'channel_busy' && Number.isSafeInteger(e.busy_pid)
        && e.busy_pid > 0 ? { busy_pid: e.busy_pid } : {}) } };
  }
  if (result.data?.error) {
    result = { ...result, data: { ...result.data,
      error: normalizeErrorCode(result.data.error) } };
  }
  const duration_ms = Math.max(0, Math.round(performance.now() - startedAt));
  return { ...result, data: { ...result.data, duration_ms } };
}
