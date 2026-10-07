export function toJid(number: string): string {
  // JID yang sudah lengkap (termasuk @lid dari grup WA baru) dikembalikan apa adanya.
  // JANGAN dibersihkan: participants @lid yang dipaksa jadi @s.whatsapp.net akan
  // gagal saat kick/promote/demote ("item not found" / not in group).
  if (number.includes('@')) return number;
  let cleaned = number.replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.slice(1);
  }
  return `${cleaned}@s.whatsapp.net`;
}

export function extractNumber(jid: string): string {
  return jid.replace(/@s\.whatsapp\.net|@g\.us|@lid/g, '').split(':')[0];
}

export function isGroup(jid: string): boolean {
  return jid.endsWith('@g.us');
}

export function formatPhoneNumber(jid: string): string {
  const num = extractNumber(jid);
  if (num.startsWith('62')) {
    return `+${num.slice(0, 2)} ${num.slice(2, 5)}-${num.slice(5, 9)}-${num.slice(9)}`;
  }
  return `+${num}`;
}
