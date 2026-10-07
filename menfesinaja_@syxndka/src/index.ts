import { connectToWhatsApp, getConnectionStatus } from './connection/baileys.js';
import { logger } from './utils/logger.js';
import { db } from './database/store.js';
import { startMaintenanceScheduler } from './utils/maintenance.js';
import { cleanupSessionFiles } from './utils/session-cleanup.js';

async function startBot() {
  console.log('\n================================━━━━━━━━━━━');
  console.log(`🤖 Starting ${db.settings.botName}...`);
  console.log('📦 Menfess & Lapor features initialized.');
  console.log('================================━━━━━━━━━━━\n');

  try {
    await connectToWhatsApp();
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to start WhatsApp bot');
    process.exit(1);
  }
}

// Monitor connection status periodically
setInterval(() => {
  try {
    const status = getConnectionStatus();
    if (!status.connected) {
      logger.warn(status, 'Connection status check');
    }
  } catch (err: any) {
    // Jangan biarkan monitor menghantam uncaughtException berulang
    logger.error({ err: err.message }, 'Connection status check failed');
  }
}, 60000);

// Auto maintenance: bersihkan log lama, file tmp, batasi cache (tiap 15 menit)
startMaintenanceScheduler(15);

// Session cleanup ringan tiap 6 jam (aman: creds.json & app-state dijaga)
setInterval(() => cleanupSessionFiles(), 6 * 60 * 60 * 1000);

// Guard anti-loop: uncaughtException hanya boleh menjadwalkan SATU pemeriksaan.
// Tanpa ini, error periodik (mis. dari health check/monitor) memicu
// getConnectionStatus lagi di dalam handler -> exception lagi -> loop tiap 10 detik.
let pendingFatalCheck = false;

// Handle uncaught exceptions gracefully
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Uncaught Exception');
  if (pendingFatalCheck) return;
  pendingFatalCheck = true;
  // Don't exit immediately - allow reconnect to try
  setTimeout(() => {
    pendingFatalCheck = false;
    try {
      if (!getConnectionStatus().connected) {
        logger.error('Bot still not connected after exception, restarting...');
        process.exit(1);
      }
    } catch (statusErr: any) {
      logger.error({ err: statusErr.message }, 'Status check after exception failed, ignoring');
    }
  }, 10000);
});

process.on('unhandledRejection', (err: any) => {
  logger.error({ err: err?.message || err, stack: err?.stack }, 'Unhandled Rejection');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, gracefully shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, gracefully shutting down...');
  process.exit(0);
});

startBot();
