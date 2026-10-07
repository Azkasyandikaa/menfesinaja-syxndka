import pino from 'pino';
import fs from 'fs';
import path from 'path';

const LOG_DIR = path.resolve('logs');
const LOG_FILE = path.join(LOG_DIR, 'bot-app.log');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch { /* abaikan */ }

/**
 * Destination file - dishare oleh logger app & baileys (satu penulis saja
 * agar tidak saling timpa). Log app selalu tersimpan ke file meskipun
 * jendela terminal ditutup, supaya bisa debug kenapa bot tidak merespon.
 */
const fileDest = pino.destination({ dest: LOG_FILE, mkdir: true, sync: false });

// Stream terminal: pino-pretty jika tersedia, fallback ke stdout mentah
let consoleStream: any = process.stdout;
try {
  const { default: pretty } = await import('pino-pretty');
  consoleStream = pretty({
    colorize: true,
    ignore: 'pid,hostname',
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
  });
} catch { /* pino-pretty tidak terpasang -> JSON mentah ke stdout */ }

export const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pino.multistream([
    { level: 'info', stream: consoleStream },
    { level: 'info', stream: fileDest },
  ])
);

export const baileysLogger = pino(
  {
    // Set LOG_BAILEYS=debug di .env untuk melihat frame & error dekripsi WA
    // Default 'error' agar spam libsignal (Closing session, dll) tidak membanjiri console
    level: process.env.LOG_BAILEYS || 'error',
    redact: {
      paths: ['SessionEntry', '*._chains', '*.currentRatchet'],
      censor: '[redacted]',
    },
  },
  fileDest
);
