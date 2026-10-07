import { db } from '../database/store.js';
import { extractNumber } from '../utils/jid.js';
import { getPhoneForLid } from '../utils/lid-map.js';
import { config } from '../config/settings.js';

export function getAllOwnerNumbers(): string[] {
  const dbOwners = db.settings.ownerNumbers.map((n) => n.replace(/[^0-9]/g, ''));
  const configOwners = config.ownerNumbers;
  return [...new Set([...dbOwners, ...configOwners])].filter(Boolean);
}

export function isOwner(senderJid: string): boolean {
  const number = extractNumber(senderJid);
  const allOwners = getAllOwnerNumbers();

  // Pengirim biasa (@s.whatsapp.net) -> cocokkan langsung dengan nomor owner
  if (allOwners.includes(number)) return true;

  // Pengirim @lid -> nomor LID bukan nomor HP. Resolve lewat mapping
  // yang dibangun saat bot connect (registerLidMappings via onWhatsApp).
  if (senderJid.endsWith('@lid')) {
    const phone = getPhoneForLid(number);
    if (phone && allOwners.includes(phone)) return true;
  }

  return false;
}
