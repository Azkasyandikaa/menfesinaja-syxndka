import { db } from '../database/store.js';
import { config } from '../config/settings.js';
import { toJid } from '../utils/jid.js';

/**
 * MENFESS IG & LAPOR
 * ──────────────────
 * Fitur menfess khusus: pesan menfess dari SIAPAPUN yang memakai fitur ini
 * dikirim ke NOMOR TUJUAN YANG SAMA (mis. nomor admin yang mengelola akun IG).
 * Yang dikirim berupa FOTO screenshot chat WhatsApp (quote card iPhone)
 * berisi bubble chat dengan teks menfess — bukan teks biasa.
 * SIFATNYA SATU ARAH: pengirim menfess TIDAK BISA dibalas lewat bot.
 *
 * Fitur lapor: template/format sama dengan menfess IG, tapi dikirim sebagai
 * TEKS berformat (bukan foto), lengkap dengan kategori & ID laporan agar
 * bisa dibalas oleh admin (.balaslapor).
 */

/** Ambil daftar nomor tujuan menfess IG: db.settings override env config. */
export function getMenfessIgTargets(): string[] {
  const fromDb = (db.settings.menfessIgTarget || []).filter(Boolean);
  if (fromDb.length > 0) return fromDb;
  return (config.menfessIgTarget || []).filter(Boolean);
}

/** JID tujuan menfess IG pertama (untuk pengiriman). */
export function menfessIgTargetJid(): string | undefined {
  const targets = getMenfessIgTargets();
  return targets.length > 0 ? toJid(targets[0]) : undefined;
}

/** Ambil daftar nomor tujuan LAPOR: db.settings.laporTarget override; fallback ke nomor menfess IG. */
export function getLaporTargets(): string[] {
  const fromDb = (db.settings.laporTarget || []).filter(Boolean);
  if (fromDb.length > 0) return fromDb;
  return getMenfessIgTargets();
}

/** JID tujuan lapor pertama (untuk pengiriman). */
export function laporTargetJid(): string | undefined {
  const targets = getLaporTargets();
  return targets.length > 0 ? toJid(targets[0]) : undefined;
}

// ─────────────────────────────────────────────────────────
// TEKS PANDUAN
// ─────────────────────────────────────────────────────────

/** Panduan fitur menfess IG. */
export function menfessIgGuideText(prefix: string): string {
  return (
    `╭───「 💌 *MENFESS IG* 」───\n` +
    `│ 🤖 Menfess dikirim ke nomor tujuan tetap\n` +
    `│ 🖼️ Format: FOTO chat iPhone (anonim)\n` +
    `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
    `📖 Cara pakai:\n` +
    `▸ \`${prefix}menfesig <pesan>\`\n` +
    `    Contoh: \`${prefix}menfesig hai kak, aku suka senyumnya :)\`\n\n` +
    `🔒 Identitasmu dirahasiakan — yang terkirim hanya foto chat berisi pesanmu.\n` +
    `🔒 Menfess bersifat SATU ARAH — tidak bisa dibalas lewat bot.`
  );
}

/** Panduan fitur lapor. */
export function laporGuideText(prefix: string): string {
  const cats = Object.keys(LAPOR_CATEGORIES)
    .filter((k) => LAPOR_CATEGORIES[k] !== 'Lainnya' || k === 'lainnya')
    .join(', ');
  return (
    `╭───「 🛡️ *LAPOR* 」───\n` +
    `│ 🤖 Laporkan masalah/saran ke pengelola\n` +
    `│ 📄 Format: TEKS berformat + ID laporan\n` +
    `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
    `📖 Cara pakai:\n` +
    `▸ \`${prefix}lapor <kategori> | <isi laporan>\`\n` +
    `    Contoh: \`${prefix}lapor bug | stiker gagal dibuat tadi malam\`\n\n` +
    `🏷️ Kategori: ${cats}\n` +
    `    (tanpa kategori = otomatis *Lainnya*)\n\n` +
    `💬 Balasan pengelola muncul otomatis di chat ini.`
  );
}

// ─────────────────────────────────────────────────────────
// LAPOR
// ─────────────────────────────────────────────────────────

/** Kategori laporan yang dikenali (prefix case-insensitive). */
export const LAPOR_CATEGORIES: Record<string, string> = {
  bug: 'Bug/Error',
  error: 'Bug/Error',
  saran: 'Saran/Fitur',
  fitur: 'Saran/Fitur',
  pengguna: 'Laporan Pengguna',
  user: 'Laporan Pengguna',
  lainnya: 'Lainnya',
  lain: 'Lainnya',
  other: 'Lainnya',
};

export function resolveLaporCategory(raw: string): { category: string; ok: boolean } {
  const key = (raw || '').toLowerCase().trim();
  if (LAPOR_CATEGORIES[key]) return { category: LAPOR_CATEGORIES[key], ok: true };
  return { category: raw ? raw.toUpperCase() : 'LAINNYA', ok: false };
}

/** ID laporan unik: LP-<base32 pendek dari counter + waktu>. */
export function nextLaporId(): string {
  const n = db.laporCounter + 1;
  db.laporCounter = n;
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // tanpa I,L,O,0,1 (mudah dibaca)
  const noise = Date.now() % 7919;
  const encode = (num: number, len: number): string => {
    let s = '';
    let v = Math.max(1, num);
    while (s.length < len) {
      s = alphabet[v % alphabet.length] + s;
      v = Math.floor(v / alphabet.length) || 7;
    }
    return s;
  };
  return `LP-${encode(n, 3)}${encode(noise, 2)}`;
}

/** Simpan laporan ke database. */
export function saveLaporReport(reporter: string, category: string, message: string): string {
  const id = nextLaporId();
  db.laporReports[id] = {
    id,
    reporter,
    category,
    message,
    createdAt: new Date().toISOString(),
    status: 'baru',
  };
  db.save();
  return id;
}

/** Ambil laporan by ID. */
export function getLaporReport(id: string) {
  return db.laporReports[id?.toUpperCase?.()];
}

/** Daftar laporan terbaru (terbaru dulu), dibatasi. */
export function listLaporReports(limit = 10) {
  return Object.values(db.laporReports)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/** Ubah status laporan (diproses/selesai) oleh admin. */
export function updateLaporStatus(id: string, status: 'diproses' | 'selesai'): boolean {
  const report = db.laporReports[id.toUpperCase()];
  if (!report) return false;
  report.status = status;
  db.save();
  return true;
}

/**
 * Susun teks laporan berformat: header lapor yang SAMA untuk semua laporan
 * (emot konsisten). Nomor pelapor TIDAK ditampilkan di pesan (privasi) —
 * nomor tetap disimpan di db untuk routing balasan `.balaslapor`.
 */
export function buildLaporText(
  id: string,
  category: string,
  message: string
): string {
  const time = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    `╭───「 🛡️ *LAPORAN USER* 」───\n` +
    `│ 🆔 ID   : *${id}*\n` +
    `│ 🏷️ Kategori : ${category}\n` +
    `│ 📅 Waktu : ${time} WIB\n` +
    `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
    `❝ ${message} ❞\n\n` +
    `_Dikirim otomatis oleh bot_`
  );
}

/** Susun teks konfirmasi ke pelapor. */
export function buildLaporConfirmation(id: string, category: string): string {
  return (
    `✅ *Laporan terkirim!*\n\n` +
    `🆔 ID Laporan : *${id}*\n` +
    `🏷️ Kategori : ${category}\n\n` +
    `💬 Laporan Anda sudah diteruskan ke pengelola. Pantau balasan lewat bot ` +
    `(balasan admin muncul otomatis di chat ini).\n\n` +
    `🛡️ Kirim laporan lain kapan saja dengan \`${db.settings.prefix}lapor <kategori> | <isi>\``
  );
}

/** Susun teks balasan admin yang diteruskan ke pelapor. */
export function buildLaporReplyText(id: string, reply: string): string {
  return (
    `╭───「 💬 *BALASAN LAPORAN ${id}* 」───\n` +
    `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
    `${reply}\n\n` +
    `_Balasan dari pengelola bot_`
  );
}
