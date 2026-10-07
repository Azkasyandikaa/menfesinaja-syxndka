import os from 'os';

/**
 * Waktu mulai bot (module-level, di-set saat proses Node berjalan).
 * Diimpor oleh command handler untuk menghitung runtime bot.
 */
export const BOT_START_TIME = Date.now();

/** Format durasi (detik) menjadi teks "1d 2h 3m 45s". */
export function formatDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

/** Runtime bot dalam detik sejak proses start. */
export function botUptimeSeconds(): number {
  return Math.floor((Date.now() - BOT_START_TIME) / 1000);
}

/** Uptime OS (host) dalam detik — di CasaOS/Linux ini uptime server, bukan bot. */
export function osUptimeSeconds(): number {
  try {
    if (typeof os.uptime === 'function') return Math.floor(os.uptime());
  } catch { /* abaikan */ }
  return Math.floor(process.uptime());
}
