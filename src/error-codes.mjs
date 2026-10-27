// Códigos de operación contratados. `stopped` sólo señala listen
// interrumpido; JSON-RPC conserva sus propios códigos de protocolo.
const ERROR_CODES = new Set([
  'engine_unavailable', 'tts_failed', 'stt_failed', 'mic_denied',
  'mic_timeout', 'audio_device_error', 'template_invalid', 'not_found',
  'text_too_long', 'session_invalid', 'session_expired',
  'session_abandoned', 'channel_busy', 'not_supported',
  'config_unreadable', 'config_write_failed', 'usage', 'internal_error',
  'stopped',
]);

export function normalizeErrorCode(code) {
  return ERROR_CODES.has(code) ? code : 'internal_error';
}
