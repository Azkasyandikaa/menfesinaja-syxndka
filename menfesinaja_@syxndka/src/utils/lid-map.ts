import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Pemetaan LID <-> nomor HP.
 *
 * WhatsApp semakin sering mengirim pesan dengan JID @lid (mis. 146897041911942@lid)
 * alih-alih nomor @s.whatsapp.net. Nomor LID TIDAK sama dengan nomor HP, sehingga
 * cek owner via OWNER_NUMBERS gagal dan semua perintah prefix ditolak diam-diam.
 *
 * Baileys 6.7.24 tidak membawa remoteJidAlt, tapi sock.onWhatsApp() (USync dengan
 * LID protocol) mengembalikan { jid, exists, lid } - kita pakai itu untuk membangun
 * mapping yang dipersist ke data/lid-map.json.
 */

const DATA_DIR = path.resolve('data');
const MAP_FILE = path.join(DATA_DIR, 'lid-map.json');

// lidNumber -> phoneNumber
const lidToPhone = new Map<string, string>();
// phoneNumber -> lidNumber
const phoneToLid = new Map<string, string>();

let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (fs.existsSync(MAP_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8'));
      for (const [lid, phone] of Object.entries(raw.lidToPhone || {})) {
        if (typeof lid === 'string' && typeof phone === 'string') {
          lidToPhone.set(lid, phone);
          phoneToLid.set(phone, lid);
        }
      }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Gagal memuat lid-map.json, mulai dengan mapping kosong');
  }
  loaded = true;
}

function persist(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MAP_FILE, JSON.stringify({ lidToPhone: Object.fromEntries(lidToPhone) }, null, 2), 'utf-8');
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Gagal menyimpan lid-map.json');
  }
}

/** Normalisasi ke digit saja (tanpa @...). */
function digits(jidOrNumber: string): string {
  return jidOrNumber.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

/** Simpan/refresh mapping. Menerima JID atau nomor telanjang. */
export function setLidMapping(lidOrJid: string, phoneOrJid: string): void {
  const lid = digits(lidOrJid);
  const phone = digits(phoneOrJid);
  if (!lid || !phone) return;
  if (lidToPhone.get(lid) === phone) return;
  lidToPhone.set(lid, phone);
  phoneToLid.set(phone, lid);
  persist();
}

/** Dapatkan nomor HP untuk LID, atau null jika belum dikenal. */
export function getPhoneForLid(lidOrJid: string): string | null {
  ensureLoaded();
  return lidToPhone.get(digits(lidOrJid)) || null;
}

/** Dapatkan LID untuk nomor HP, atau null jika belum dikenal. */
export function getLidForPhone(phoneOrJid: string): string | null {
  ensureLoaded();
  return phoneToLid.get(digits(phoneOrJid)) || null;
}

/** Apakah JID berupa @lid. */
export function isLidJid(jid: string): boolean {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

/**
 * Daftarkan mapping untuk daftar nomor owner saat bot connect.
 * Mengembalikan jumlah mapping yang berhasil dibuat/diperbarui.
 */
export async function registerLidMappings(
  onWhatsApp: (...jids: string[]) => Promise<any> | any,
  phoneNumbers: string[]
): Promise<number> {
  ensureLoaded();
  let count = 0;
  const pending = phoneNumbers.filter((p) => p && !getLidForPhone(p));
  if (pending.length === 0) return 0;

  try {
    const results = await onWhatsApp(...pending);
    if (!Array.isArray(results)) return 0;
    for (const r of results) {
      if (r?.exists && r?.lid && r?.jid) {
        setLidMapping(String(r.lid), String(r.jid));
        count++;
      }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Gagal query onWhatsApp untuk mapping LID owner');
  }
  return count;
}

/**
 * Sinkronkan mapping LID <-> nomor HP dari metadata anggota grup.
 * Berguna agar limit/role user yang diketahui bot hanya sebagai @lid di grup
 * tetap terhubung ke nomor HP aslinya (limit per nomor, bukan per chat).
 */
export function syncGroupLidMappings(groupJid: string, participants: Array<{ id?: string; lid?: string; phoneNumber?: string }>): number {
  ensureLoaded();
  let count = 0;
  for (const p of participants || []) {
    const idDigits = digits(p.id || '');
    if (!idDigits) continue;
    if (p.id?.endsWith('@lid')) {
      const phone = p.phoneNumber ? digits(p.phoneNumber) : getPhoneForLid(idDigits);
      if (phone && phone !== idDigits) {
        setLidMapping(idDigits, phone);
        count++;
      }
    } else if (p.lid) {
      const lid = digits(p.lid);
      if (lid && lid !== idDigits) {
        setLidMapping(lid, idDigits);
        count++;
      }
    }
  }
  if (count > 0) {
    logger.debug({ groupJid, synced: count }, 'Mapping LID grup disinkronkan');
  }
  return count;
}
