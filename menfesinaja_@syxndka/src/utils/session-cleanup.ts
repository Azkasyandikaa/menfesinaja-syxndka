import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Clean up stale or corrupted session files
 * AMAN: hanya sentuh pre-key & session-*.json lama.
 * TIDAK PERNAH menyentuh: creds.json, app-state-sync-version-*.json,
 * app-state-sync-key-*.json (file krusial, menghapusnya = harus scan ulang).
 *
 * @param force true = jalankan walau bot sedang terhubung (default: skip jika connected)
 */
export function cleanupSessionFiles(force = false): void {
  try {
    const sessionDir = path.resolve('session');

    if (!fs.existsSync(sessionDir)) {
      logger.info('Session directory does not exist, skipping cleanup');
      return;
    }

    // File yang HARUS dijaga
    const PROTECTED = [
      'creds.json',
    ];
    const isProtected = (f: string) =>
      f === 'creds.json' ||
      f.startsWith('app-state-sync-version-') ||
      f.startsWith('app-state-sync-key-');

    const files = fs.readdirSync(sessionDir).filter((f) => !isProtected(f));
    let cleanedCount = 0;

    // Remove pre-key files older than 7 days (they get regenerated)
    // HATI-HATI: minimal sisakan 10 pre-key terbaru agar koneksi tetap stabil
    const preKeyFiles = files
      .filter((f) => f.startsWith('pre-key-'))
      .map((f) => {
        const p = path.join(sessionDir, f);
        return { file: f, path: p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime); // terbaru dulu

    const KEEP_MIN_PREKEYS = 10;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    preKeyFiles.forEach((entry, idx) => {
      if (idx < KEEP_MIN_PREKEYS) return; // jaga minimal 10 pre-key
      const ageMs = Date.now() - entry.mtime;
      if (ageMs > sevenDaysMs) {
        try {
          fs.unlinkSync(entry.path);
          cleanedCount++;
          logger.debug(`Removed old pre-key: ${entry.file}`);
        } catch (err) {
          logger.warn(`Failed to remove ${entry.file}: ${(err as any).message}`);
        }
      }
    });

    // Keep only recent session files (keep last 3) - jangan sentuh file terproteksi
    const sessionFiles = files
      .filter((f) => f.startsWith('session-') && !isProtected(f))
      .sort()
      .reverse();

    if (sessionFiles.length > 3) {
      for (let i = 3; i < sessionFiles.length; i++) {
        try {
          const filePath = path.join(sessionDir, sessionFiles[i]);
          fs.unlinkSync(filePath);
          cleanedCount++;
          logger.debug(`Removed old session: ${sessionFiles[i]}`);
        } catch (err) {
          logger.warn(`Failed to remove ${sessionFiles[i]}: ${(err as any).message}`);
        }
      }
    }

    if (cleanedCount > 0) {
      logger.info(`Session cleanup completed: ${cleanedCount} files removed`);
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'Session cleanup error');
  }
}

/**
 * Full session reset - use only if bot is completely broken
 * This will require re-pairing with WhatsApp
 * HATI-HATI: buat backup creds.json dulu sebelum reset.
 */
export function fullSessionReset(): void {
  try {
    const sessionDir = path.resolve('session');

    if (fs.existsSync(sessionDir)) {
      // Backup creds.json dulu ke data/creds.backup.json
      const credsPath = path.join(sessionDir, 'creds.json');
      if (fs.existsSync(credsPath)) {
        fs.copyFileSync(credsPath, path.resolve('data', 'creds.backup.json'));
        logger.info('Backup creds.json dibuat ke data/creds.backup.json');
      }
      fs.rmSync(sessionDir, { recursive: true, force: true });
      logger.info('Session directory completely reset');
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to reset session');
  }
}
