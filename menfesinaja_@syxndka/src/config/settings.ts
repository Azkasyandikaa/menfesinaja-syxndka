import dotenv from 'dotenv';
dotenv.config();

export const config = {
  botName: process.env.BOT_NAME || 'Menfesin Aja Bot',
  // WAJIB diisi: nomor owner bot (pisahkan dengan koma jika lebih dari satu)
  ownerNumbers: (process.env.OWNER_NUMBERS || '')
    .split(',')
    .map((num) => num.trim().replace(/[^0-9]/g, ''))
    .filter(Boolean),
  // Admin Bot: nomor tambahan dengan akses fitur pengaturan (tanpa limit)
  adminNumbers: (process.env.ADMIN_NUMBERS || '')
    .split(',')
    .map((num) => num.trim().replace(/[^0-9]/g, ''))
    .filter(Boolean),
  defaultPrefix: process.env.PREFIX || '.',
  // Nomor tujuan tetap untuk fitur menfess IG (semua menfess user dikirim ke nomor ini)
  menfessIgTarget: (process.env.MENFESS_IG_TARGET || '')
    .split(',')
    .map((num) => num.trim().replace(/[^0-9]/g, ''))
    .filter(Boolean),
};
