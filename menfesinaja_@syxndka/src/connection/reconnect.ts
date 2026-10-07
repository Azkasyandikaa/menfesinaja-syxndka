import { DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { logger } from '../utils/logger.js';

/**
 * Hanya menjawab: boleh reconnect atau tidak, untuk error TRANSIEN.
 * Kasus khusus (440 connection replaced, 401 logged out, 515 restart required)
 * sudah ditangani langsung di baileys.ts sebelum fungsi ini dipanggil.
 */
export function shouldReconnect(error: any): boolean {
  if (!error) return true;

  const statusCode = (error as Boom)?.output?.statusCode;

  // 403 forbidden: WA menolak koneksi (mis. akun dibatasi). Reconnect perlahan,
  // biarkan exponential backoff yang mengatur ritmenya.
  if (statusCode === DisconnectReason.forbidden) {
    logger.warn({ statusCode }, 'Forbidden (403): mencoba reconnect dengan backoff...');
    return true;
  }

  logger.info({ statusCode }, 'Connection lost. Reconnecting...');
  return true;
}
