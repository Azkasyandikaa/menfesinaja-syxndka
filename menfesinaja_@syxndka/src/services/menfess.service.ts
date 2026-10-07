import { db } from '../database/store.js';
import { setLidMapping } from '../utils/lid-map.js';
import { toJid } from '../utils/jid.js';
import { getPhoneForLid } from '../utils/lid-map.js';

/**
 * SISTEM MENFESS / CONFESS
 * ─────────
 * Bot menjadi perantara chat anonim antara 2 nomor.
 * - User1: .menfess (aktifkan fitur) lalu .kirim <pesan> | <nomor>
 * - User2 menerima undangan, acc dengan .terima
 * - Setelah acc, keduanya bisa chat lewat bot sampai salah satu
 *   mengetik .endsession
 * - Selama sesi aktif, fitur bot lain dimatikan khusus untuk kedua
 *   nomor tersebut (per nomor), aktif lagi saat sesi berakhir.
 * - Data sesi dihapus begitu sesi berakhir.
 */

export type MenfessStatus = 'waiting' | 'active';

export interface MenfessSession {
  /** Nomor lawan chat (tanpa +) */
  partner: string;
  /** 'waiting' = menunggu acc, 'active' = chat berjalan */
  status: MenfessStatus;
  /** Nomor yang memulai (pengirim .kirim) */
  initiator: string;
  createdAt: string;
  activatedAt?: string;
  /** JID kanonik pemilik record ini (hasil onWhatsApp, antisipasi @lid) */
  selfJid?: string;
  /** Digit LID pemilik record ini (dipelajari saat target chat bot) */
  selfLid?: string;
  /** JID kanonik partner */
  partnerJid?: string;
  /** Nomor pihak yang acc (harus == partner record initiator) */
  acceptor?: string;
  /** Peran pemilik record ini: 'initiator' = user1 pengirim, 'target' = user2 penerima */
  role: 'initiator' | 'target';
}

/** Normalisasi nomor: buang non-digit, 0x -> 62x */
export function normalizeMenfessNumber(raw: string): string {
  let cleaned = (raw || '').replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) cleaned = '62' + cleaned.slice(1);
  return cleaned;
}

/** Perintah menfess yang sah (tanpa prefix). */
const MENFESS_COMMANDS = ['menfess', 'confess', 'kirim', 'terima', 'endsession', 'stopmenfess'] as const;

/** Perintah menfess IG / lapor (fitur terpisah, tanpa prefix). */
const MENFESS_IG_COMMANDS = ['menfes', 'menfesig', 'menfessig', 'igmenfess', 'lapor'] as const;

/** Nama lama -> nama baru (untuk pemberitahuan command sudah diganti). */
const MENFESS_RENAMED: Record<string, string> = {
  send: 'kirim',
  accmenfes: 'terima',
  accmenfess: 'terima',
};

/** Jarak edit Levenshtein (untuk deteksi salah ketik). */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[n];
}

export interface MenfessTypo {
  /** Command yang kemungkinan dimaksud (tanpa prefix). */
  command: string;
  /** true = karena nama lama sudah diganti (bukan salah ketik). */
  renamed: boolean;
}

/**
 * Deteksi salah ketik command menfess (mis. ".kirm", ".terimas", ".menfes")
 * ATAU nama lama yang sudah diganti (.send, .accmenfes, .accmenfess).
 * Return undefined jika command sudah benar / bukan kemungkinan menfess.
 */
export function detectMenfessTypo(command: string): MenfessTypo | undefined {
  const cmd = (command || '').toLowerCase();
  if (!cmd) return undefined;

  if (MENFESS_RENAMED[cmd]) return { command: MENFESS_RENAMED[cmd], renamed: true };
  if ((MENFESS_COMMANDS as readonly string[]).includes(cmd)) return undefined;
  if ((MENFESS_IG_COMMANDS as readonly string[]).includes(cmd)) return undefined;

  const cleaned = cmd.replace(/[^a-z]/g, '');
  if (!cleaned) return undefined;

  let best: { word: string; dist: number } | undefined;
  for (const word of [...MENFESS_COMMANDS, ...MENFESS_IG_COMMANDS]) {
    const dist = levenshtein(cleaned, word);
    if (!best || dist < best.dist) best = { word, dist };
  }
  if (best && best.dist <= 2) return { command: best.word, renamed: false };
  return undefined;
}

/**
 * Deteksi pesan TANPA prefix yang tampak seperti command menfess
 * (user lupa mengetik titik). Return nama command yang dimaksud.
 *
 * Sengaja ketat agar chat biasa tidak salah tangkap:
 * - 'menfess', 'confess', 'terima', 'endsession' harus pesan utuh.
 * - 'kirim ...' hanya dianggap command jika ada '|' atau nomor HP di pesan.
 */
export function matchBareMenfessCommand(
  body: string
): 'menfess' | 'confess' | 'kirim' | 'terima' | 'endsession' | 'stopmenfess' | undefined {
  const text = (body || '').trim().toLowerCase();
  if (!text) return undefined;

  if (/^(menfess|confess|terima|endsession|stopmenfess)$/.test(text)) {
    return text as 'menfess' | 'confess' | 'terima' | 'endsession' | 'stopmenfess';
  }

  const kirimMatch = text.match(/^kirim[\s.:!-]+([\s\S]+)$/);
  if (kirimMatch) {
    const rest = kirimMatch[1];
    if (rest.includes('|') || /(\+?62|0)\d{8,13}/.test(rest)) return 'kirim';
  }
  return undefined;
}

/** Teks panduan singkat menfess (dipakai handler untuk hint salah ketik). */
export function menfessGuideText(prefix: string, intro: string): string {
  return (
    `${intro}\n\n` +
    `💌 *PANDUAN MENFESS / CONFESS*\n` +
    `▸ Aktifkan mode: \`${prefix}menfess\`\n` +
    `▸ Kirim undangan: \`${prefix}kirim <pesan> | <nomor>\`\n` +
    `    Contoh: \`${prefix}kirim Hai, boleh kenalan? | 6281234567890\`\n` +
    `▸ Penerima acc undangan: \`${prefix}terima\`\n` +
    `▸ Akhiri sesi: \`${prefix}endsession\`\n` +
    `▸ Keluar mode menfess: \`${prefix}stopmenfess\``
  );
}

/** Ambil sesi menfess milik sebuah nomor (jika ada). */
export function getMenfessSession(number: string): MenfessSession | undefined {
  if (!db.menfessSessions) return undefined;
  return db.menfessSessions[number];
}

/** Ambil digit murni dari sebuah JID (buang domain & device part). */
function jidDigits(jid: string): string {
  return (jid || '').split('@')[0].split(':')[0];
}

/**
 * Cari sesi menfess milik pengirim.
 * Urutan cek:
 * 1. By nomor (LID sudah di-resolve ke nomor HP via lid-map).
 * 2. By JID kanonik / LID yang tersimpan di record (selfJid / selfLid).
 * 3. Record initiator yang partner-nya nomor ini.
 */
export function findMenfessSession(number: string, senderJid?: string): MenfessSession | undefined {
  const direct = getMenfessSession(number);
  if (direct) {
    // Catat JID asli pengirim agar lookup berikutnya pasti cocok
    if (senderJid && !direct.selfJid) {
      direct.selfJid = senderJid;
      db.save();
    }
    return direct;
  }
  if (!senderJid || !db.menfessSessions) return undefined;

  const digits = jidDigits(senderJid);
  if (!digits) return undefined;

  // Fallback 1: JID/LID yang tersimpan di salah satu record cocok persis
  for (const s of Object.values(db.menfessSessions)) {
    if ((s.selfJid && jidDigits(s.selfJid) === digits) || s.selfLid === digits) return s;
  }

  // Fallback 2: pengirim adalah partner dari record initiator
  // (record initiator: key == initiator, partner = nomor target)
  for (const s of Object.values(db.menfessSessions)) {
    if (s.partner === digits && s.initiator !== digits) return s;
  }
  return undefined;
}

/**
 * Klaim undangan pending berdasarkan JID @lid pengirim.
 * Dipakai saat target chat bot dengan JID @lid yang belum ada di lid-map.
 * Hanya boleh klaim jika ada TEPAT 1 undangan waiting yang targetnya
 * belum terbind ke LID manapun.
 */
export function claimPendingInviteByLid(senderJid: string): MenfessSession | undefined {
  const digits = jidDigits(senderJid);
  if (!digits || !db.menfessSessions) return undefined;

  // Record TARGET = key-nya bukan initiator (key = nomor HP yang diketik user1)
  const candidates = Object.entries(db.menfessSessions).filter(
    ([key, s]) => s.status === 'waiting' && key !== s.initiator && !s.selfLid
  );
  if (candidates.length !== 1) return undefined;

  const [key, session] = candidates[0];
  session.selfLid = digits;
  session.selfJid = senderJid;
  // Daftarkan ke lid-map global agar resolveLimitNumber bekerja selamanya
  setLidMapping(digits, key);
  db.save();
  return session;
}

/**
 * Klaim undangan pending dari JID pengirim (@lid atau @s.whatsapp.net).
 * Dipakai di message handler SEBELUM resolveLimitNumber.
 *
 * Untuk JID @lid, digit-nya BUKAN nomor HP — nomor HP pengirim diambil
 * dari lid-map yang diisi otomatis dari msg.key.remoteJidAlt (Baileys 7).
 * Klaim hanya terjadi jika nomor HP hasil resolve == nomor target
 * undangan yang masih pending (exact match, bukan tebakan).
 */
export function claimPendingInviteByJid(senderJid: string): MenfessSession | undefined {
  if (!senderJid || !db.menfessSessions) return undefined;

  const digits = jidDigits(senderJid);
  if (!digits || digits.length < 8) return undefined;

  // Sudah terbind ke record manapun? Tidak perlu klaim.
  if (findMenfessSession('', senderJid)) return undefined;

  const isLid = senderJid.endsWith('@lid');
  let phone = digits;
  if (isLid) {
    const mapped = getPhoneForLid(digits);
    if (!mapped) return undefined; // identitas belum bisa dipastikan
    phone = mapped;
  }

  // Hanya klaim record target yang pending & nomornya persis pengirim
  const candidates = Object.entries(db.menfessSessions).filter(
    ([key, s]) => s.status === 'waiting' && key !== s.initiator && !s.selfLid && key === phone
  );
  if (candidates.length !== 1) return undefined;

  const [key, session] = candidates[0];
  if (isLid) {
    session.selfLid = digits;
    // Pakai JID nomor HP (kanonik) agar pengiriman pesan selalu valid
    session.selfJid = session.selfJid || `${phone}@s.whatsapp.net`;
  } else {
    session.selfJid = senderJid;
  }
  db.save();
  return session;
}

/** JID tujuan untuk mengirim ke partner (pakai JID asli mereka jika sudah diketahui). */
export function getMessageJidFor(session: MenfessSession): string {
  const other = findPairRecord(session);
  if (other?.selfJid) return other.selfJid;
  if (session.partnerJid) return session.partnerJid;
  return toJid(session.partner);
}

/**
 * Simpan JID kanonik (dari sock.onWhatsApp) untuk pasangan sesi —
 * dipanggil setelah undangan dibuat agar target @lid tetap dikenali.
 */
export async function resolveAndStoreJid(
  sock: any,
  initiator: string,
  target: string
): Promise<void> {
  try {
    const results = await sock.onWhatsApp(`${target}@s.whatsapp.net`);
    const r = results?.[0];
    if (!r?.jid) return;

    // PENTING: daftarkan LID <-> nomor HP supaya saat target chat bot
    // dengan JID @lid, resolveLimitNumber() menemukan nomor HP-nya dan
    // sesi menfess-nya ketemu (ini akar bug "tidak ada undangan").
    if (r.lid) {
      setLidMapping(String(r.lid), target);
    }

    const targetRec = getMenfessSession(target);
    const initRec = getMenfessSession(initiator);
    if (targetRec) targetRec.selfJid = String(r.jid);
    if (initRec) initRec.partnerJid = String(r.jid);
    db.save();
  } catch {
    /* onWhatsApp gagal -> abaikan, lookup tetap jalan via nomor */
  }
}

/** Aktifkan mode menfess untuk nomor (agar chat biasa bisa jadi undangan). */
export function enableMenfess(number: string): void {
  db.menfessEnabled[number] = new Date().toISOString();
  db.save();
}

/** Cek apakah mode menfess aktif untuk nomor. */
export function isMenfessEnabled(number: string): boolean {
  return !!db.menfessEnabled[number];
}

/** Matikan mode menfess (dipanggil saat undangan dibuat / sesi berakhir). */
export function clearMenfessEnabled(number: string): void {
  if (db.menfessEnabled[number]) {
    delete db.menfessEnabled[number];
    db.save();
  }
}

/**
 * Buat undangan menfess (status waiting).
 * Return false jika salah satu pihak sudah terlibat sesi lain
 * (cek by nomor DAN by JID kanonik).
 */
export function createMenfessInvite(initiator: string, target: string): boolean {
  const sessions = db.menfessSessions;
  if (findMenfessSession(initiator) || findMenfessSession(target)) return false;

  const session: MenfessSession = {
    partner: target,
    status: 'waiting',
    initiator,
    createdAt: new Date().toISOString(),
    role: 'initiator',
  };
  sessions[initiator] = session;
  sessions[target] = { ...session, partner: initiator, role: 'target' };
  clearMenfessEnabled(initiator);
  db.save();
  return true;
}

/**
 * Target (user2) acc undangan -> status jadi active untuk kedua record.
 * PENGIRIM (user1/initiator) TIDAK BOLEH acc undangannya sendiri —
 * kendali penuh ada di tangan user2.
 */
export function acceptMenfess(session: MenfessSession | undefined, senderJid?: string): { session?: MenfessSession; error?: 'none' | 'initiator' } {
  if (!session || session.status !== 'waiting') return { error: 'none' };

  // PENGIRIM (user1/initiator) tidak boleh acc undangannya sendiri —
  // kendali penuh ada di tangan user2 (target). Role disimpan eksplisit
  // saat invite dibuat sehingga tidak bergantung pada resolusi LID.
  if (session.role === 'initiator') return { error: 'initiator' };
  const acceptorNum = senderJid ? resolveAcceptorNumber(session, senderJid) : '';
  if (acceptorNum && acceptorNum === session.initiator) return { error: 'initiator' };

  const now = new Date().toISOString();
  session.status = 'active';
  session.activatedAt = now;
  if (acceptorNum) session.acceptor = acceptorNum;
  // Jangan timpa JID kanonik yang sudah tersimpan (biasanya @s.whatsapp.net
  // hasil onWhatsApp) dengan JID @lid pengirim — JID nomor HP lebih aman
  // untuk pengiriman pesan.
  if (senderJid && !session.selfJid) session.selfJid = senderJid;

  const other = findPairRecord(session);
  if (other) {
    other.status = 'active';
    other.activatedAt = now;
    if (acceptorNum) other.acceptor = acceptorNum;
    if (session.selfJid) other.partnerJid = session.selfJid;
    if (other.selfJid) session.partnerJid = other.selfJid;
  }
  db.save();
  return { session };
}

/** Resolve nomor HP pihak yang acc: coba lid-map dulu, lalu record pasangan. */
function resolveAcceptorNumber(session: MenfessSession, senderJid: string): string {
  const digits = jidDigits(senderJid);
  // Bukan @lid -> langsung nomor HP
  if (!senderJid.includes('@lid')) return digits;
  // @lid -> coba resolve via lid-map
  const mapped = getPhoneForLid(digits);
  if (mapped) return mapped;
  // Belum ter-map: cek apakah cocok dengan LID yang tersimpan di record
  if (session.selfLid === digits) {
    const other = findPairRecord(session);
    // Record ini milik target (bukan initiator) -> acceptor = partner dari initiator record
    return other ? other.partner : digits;
  }
  return digits;
}

/** Cari record pasangan (kedua record punya initiator & createdAt sama). */
function findPairRecord(session: MenfessSession): MenfessSession | undefined {
  return Object.values(db.menfessSessions).find(
    (s) => s !== session && s.initiator === session.initiator && s.createdAt === session.createdAt
  );
}

/**
 * Akhiri sesi (oleh salah satu pihak) dan HAPUS semua catatan
 * sesi kedua nomor. Return nomor partner (untuk notifikasi).
 */
export function endMenfessSession(session: MenfessSession): string | undefined {
  if (!session) return undefined;

  const partner = session.partner;
  const other = findPairRecord(session);
  const sessions = db.menfessSessions;
  for (const [key, val] of Object.entries(sessions)) {
    if (val === session || val === other) {
      clearMenfessEnabled(val.partner);
      clearMenfessEnabled(val.initiator);
      delete sessions[key];
    }
  }
  db.save();
  return partner;
}

/**
 * Keluar dari fitur menfess (command .stopmenfess):
 * - Sesi waiting (undangan belum di-acc) -> undangan dibatalkan.
 * - Sesi active -> sama seperti endsession.
 * Semua catatan kedua nomor dihapus, fitur bot aktif kembali.
 * Return status sebelum dihapus + nomor partner (untuk notifikasi).
 */
export function exitMenfess(session: MenfessSession): { partner: string; wasActive: boolean } {
  const wasActive = session.status === 'active';
  const partner = endMenfessSession(session) || session.partner;
  return { partner, wasActive };
}

/** Hapus SEMUA sesi menfess (pembersihan data uji coba). */
export function clearAllMenfessSessions(): number {
  if (!db.menfessSessions) return 0;
  const keys = Object.keys(db.menfessSessions);
  for (const k of keys) delete db.menfessSessions[k];
  db.save();
  return keys.length;
}

/** Semua nomor yang sedang terlibat sesi menfess aktif (untuk debug/monitoring). */
export function listMenfessSessions(): string[] {
  if (!db.menfessSessions) return [];
  return Object.keys(db.menfessSessions);
}
