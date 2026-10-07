import { WASocket } from '@whiskeysockets/baileys';
import { logger } from './logger.js';

/**
 * Tandai pesan sebagai sudah dibaca (centang biru / read receipt).
 */
export async function markAsRead(sock: WASocket, keys: any[]): Promise<void> {
  try {
    await sock.readMessages(keys);
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Gagal mengirim read receipt (centang biru)');
  }
}

/**
 * Tampilkan efek "mengetik..." lalu tunggu selama delayMs sebelum bot mengirim balasan.
 * Durasi dihitung proporsional dengan panjang teks:
 *   ~60ms per karakter, minimal 1200ms, maksimal 3000ms (semakin lama semakin
 *   terasa lambat & menunda respon fitur).
 */
export function calcTypingDelay(text: string): number {
  const len = (text || '').length;
  return Math.min(Math.max(len * 60, 1200), 3000);
}

export async function sendWithTyping(
  sock: WASocket,
  jid: string,
  content: any,
  options?: any,
  typingMs?: number
): Promise<void> {
  const delay = typingMs ?? calcTypingDelay(typeof content?.text === 'string' ? content.text : '');
  try {
    await sock.sendPresenceUpdate('composing', jid);
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Gagal mengirim presence composing');
  }
  await new Promise((res) => setTimeout(res, delay));
  try {
    await sock.sendPresenceUpdate('paused', jid);
  } catch { }
  await sock.sendMessage(jid, content, options);
}
