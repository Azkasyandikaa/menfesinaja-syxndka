import { db } from '../database/store.js';
import type { LimitBonusItem } from '../database/store.js';
import { extractNumber } from '../utils/jid.js';
import { getPhoneForLid } from '../utils/lid-map.js';
import { config } from '../config/settings.js';
import { isOwner } from './owner.middleware.js';

export type Role = 'owner' | 'admin' | 'user';

/**
 * SISTEM HAK AKSES
 * ─────────────────────────────────────────────────────────
 * owner : akses penuh, tanpa limit (OWNER_NUMBERS)
 * admin : nomor tambahan yang diangkat jadi Admin Bot — bisa memakai
 *         fitur pengaturan bot (listlapor, balaslapor, addlimit, dst),
 *         tanpa limit (db.settings.adminNumbers + ADMIN_NUMBERS env)
 * user  : hanya fitur publik, dengan limit harian per fitur
 */

/** Perintah khusus OWNER (manajemen admin bot & nomor tujuan menfess IG). */
export const OWNER_COMMANDS: ReadonlySet<string> = new Set([
  'addadmin',
  'deladmin',
  // Menfess IG & lapor: pengaturan nomor tujuan hanya boleh owner
  'setmenfessig',
  'setlapor',
]);

/** Perintah pengaturan bot: OWNER + ADMIN BOT (tanpa limit). */
export const ADMIN_COMMANDS: ReadonlySet<string> = new Set([
  // Limit user
  'addlimit',
  'listadmin',
  // Menfess IG & lapor (manajemen laporan; setmenfessig = khusus owner)
  'listlapor', 'balaslapor', 'dellapor',
]);

/** Perintah publik: semua nomor bisa memakai, dengan limit harian per fitur. */
export const PUBLIC_COMMANDS: ReadonlySet<string> = new Set([
  'menu', 'help', 'status', 'info', 'limit',
  // Menfess / confess (chat perantara bot)
  'menfess', 'confess', 'kirim', 'terima', 'endsession', 'stopmenfess',
  // Menfess IG (foto quote ke nomor tetap) & lapor
  'menfesig', 'menfessig', 'igmenfess', 'menfes', 'lapor',
  // Monitoring ringan
  'runtime',
]);

/** Limit pemakaian harian per fitur publik (per nomor, reset 00:00 WIB). */
export const COMMAND_LIMITS: Record<string, number> = {
  menu: 30, help: 30,
  status: 10, info: 10, limit: 100,
  menfess: 20, confess: 20, kirim: 20, terima: 20, endsession: 20, stopmenfess: 20,
  menfesig: 10, menfessig: 10, igmenfess: 10, menfes: 10, lapor: 10,
  runtime: 30,
};

/** Limit default untuk fitur publik yang tidak terdaftar di COMMAND_LIMITS. */
export const DEFAULT_DAILY_LIMIT = 10;

/**
 * Bonus limit harian via .addlimit (khusus owner/admin bot).
 * Berlaku untuk SEMUA fitur publik, kadaluarsa saat reset harian (00:00 WIB).
 */
export function getLimitBonus(number: string): number {
  const stored: LimitBonusItem | undefined = db.limitBonus?.[number];
  if (!stored || stored.date !== todayWib()) return 0;
  return stored.amount || 0;
}

/** Beri bonus limit harian ke nomor (tanpa +). Amount negatif = kurangi bonus. */
export function addLimit(number: string, amount: number): number {
  let key = number.replace(/[^0-9]/g, '');
  if (key.startsWith('0')) key = '62' + key.slice(1);
  const current = getLimitBonus(key);
  const next = Math.max(0, current + amount);
  db.limitBonus[key] = { date: todayWib(), amount: next };
  db.save();
  return next;
}

/** Buat JID user dari nomor telanjang (untuk reply/mention .addlimit). */
export function formatUserJid(number: string): string {
  return `${number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
}

export function getAllAdminNumbers(): string[] {
  const dbAdmins = Array.isArray(db.settings.adminNumbers)
    ? db.settings.adminNumbers.map((n) => n.replace(/[^0-9]/g, ''))
    : [];
  const envAdmins = Array.isArray(config.adminNumbers) ? config.adminNumbers : [];
  return [...new Set([...dbAdmins, ...envAdmins])].filter(Boolean);
}

export function isAdmin(senderJid: string): boolean {
  const number = extractNumber(senderJid);
  const allAdmins = getAllAdminNumbers();

  if (allAdmins.includes(number)) return true;

  // Pengirim @lid -> resolve ke nomor HP via mapping (sama seperti isOwner)
  if (senderJid.endsWith('@lid')) {
    const phone = getPhoneForLid(number);
    if (phone && allAdmins.includes(phone)) return true;
  }

  return false;
}

export function getRole(senderJid: string): Role {
  if (isOwner(senderJid)) return 'owner';
  if (isAdmin(senderJid)) return 'admin';
  return 'user';
}

/** true untuk owner & admin bot (pengaturan bot + tanpa limit). */
export function isAdminRole(senderJid: string): boolean {
  return getRole(senderJid) !== 'user';
}

// ─────────────────────────────────────────────────────────
// LIMIT HARIAN (persist di data/db.json, reset 00:00 WIB)
// ─────────────────────────────────────────────────────────

function todayWib(): string {
  // en-CA => format YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}

/** Nomor untuk kunci limit: @lid di-resolve ke nomor HP bila diketahui. */
export function resolveLimitNumber(senderJid: string): string {
  const number = extractNumber(senderJid);
  if (senderJid.endsWith('@lid')) {
    return getPhoneForLid(number) || number;
  }
  return number;
}

function limitKey(number: string, command: string): string {
  return `${number}|${command}`;
}

interface UsageEntry {
  key: string;
  date: string;
  count: number;
}

function getEntry(number: string, command: string): UsageEntry {
  const key = limitKey(number, command);
  const today = todayWib();
  const stored = db.usageLimits?.[key];
  if (!stored || stored.date !== today) {
    return { key, date: today, count: 0 };
  }
  return { key, date: stored.date, count: stored.count };
}

export function getLimitFor(command: string): number {
  return COMMAND_LIMITS[command] ?? DEFAULT_DAILY_LIMIT;
}

/**
 * Limit efektif = limit per fitur + bonus .addlimit nomor tersebut.
 * Kunci selalu nomor HP (LID di-resolve dulu), jadi pemakaian di grup dan
 * chat pribadi dihitung dari saldo yang sama.
 */
export function getLimitForUser(senderJid: string, command: string): number {
  return getLimitFor(command) + getLimitBonus(resolveLimitNumber(senderJid));
}

export function getUsage(senderJid: string, command: string): { used: number; limit: number } {
  return { used: getEntry(resolveLimitNumber(senderJid), command).count, limit: getLimitForUser(senderJid, command) };
}

/** Usage berdasarkan nomor telanjang (untuk cek limit user lain via .limit @user). */
export function getUsageFor(number: string, command: string): { used: number; limit: number } {
  return { used: getEntry(number, command).count, limit: getLimitFor(command) + getLimitBonus(number) };
}

/** Catat 1 pemakaian fitur publik oleh user. */
export function consumeLimit(senderJid: string, command: string): void {
  const number = resolveLimitNumber(senderJid);
  const entry = getEntry(number, command);
  db.usageLimits[entry.key] = { date: entry.date, count: entry.count + 1 };

  // Cegah db.json membengkak: buang entri tanggal lama jika sudah banyak
  if (Object.keys(db.usageLimits).length > 2000) {
    pruneOldLimits();
  }
  db.save();
}

/** Hapus semua entri limit yang bukan hari ini. */
export function pruneOldLimits(): void {
  const today = todayWib();
  if (!db.usageLimits) return;
  for (const [key, value] of Object.entries(db.usageLimits)) {
    if (value?.date !== today) delete db.usageLimits[key];
  }
  db.save();
}

export interface CommandAccessResult {
  allowed: boolean;
  reason?: 'owner' | 'admin' | 'limit';
  used?: number;
  limit?: number;
  message?: string;
}

function limitReachedMessage(command: string, used: number, limit: number): string {
  const prefix = db.settings.prefix;
  return (
    `🚦 *Limit harian tercapai!*\n\n` +
    `▸ Fitur: \`${prefix}${command}\`\n` +
    `▸ Pemakaian hari ini: *${used}/${limit}*\n` +
    `▸ Reset otomatis: pukul *00:00 WIB*\n\n` +
    `💡 Limit berlaku per nomor (grup & chat pribadi digabung).\n` +
    `👑 Butuh akses lebih? Hubungi owner untuk dijadikan *Admin Bot*.`
  );
}

/**
 * Cek apakah pengirim boleh menjalankan command.
 * - owner/admin bot: semua command, tanpa limit (kecuali OWNER_COMMANDS untuk admin)
 * - user: hanya PUBLIC_COMMANDS, dengan limit harian
 * - command yang tidak terdaftar: diizinkan lewat (nanti jatuh ke keyword auto-reply)
 */
export function checkCommandAccess(senderJid: string, command: string): CommandAccessResult {
  const role = getRole(senderJid);

  if (role === 'owner') return { allowed: true };

  if (OWNER_COMMANDS.has(command)) {
    return {
      allowed: false,
      reason: 'owner',
      message: '❌ Perintah ini khusus *Owner* bot!',
    };
  }

  if (role === 'admin') return { allowed: true };

  if (ADMIN_COMMANDS.has(command)) {
    return {
      allowed: false,
      reason: 'admin',
      message: '⚠️ Perintah ini khusus *Owner & Admin* bot.\n💡 Hubungi owner jika ingin diberi akses.',
    };
  }

  if (PUBLIC_COMMANDS.has(command)) {
    const { used, limit } = getUsageFor(resolveLimitNumber(senderJid), command);
    if (used >= limit) {
      return {
        allowed: false,
        reason: 'limit',
        used,
        limit,
        message: limitReachedMessage(command, used, limit),
      };
    }
    return { allowed: true, used, limit };
  }

  // Command tidak dikenal -> biarkan diproses lebih lanjut (keyword auto-reply)
  return { allowed: true };
}
