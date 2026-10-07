💕 Menfesin Aja Bot — Bot WA buat Confess Anonim
Intinya: bot ini bikin kamu bisa chat anonim sama siapa aja lewat WhatsApp, plus bisa kirim pesan dalam bentuk foto chat ala iPhone (yang sering diliat di story IG). Ada fitur laporan juga kalau ada masalah atau mau kasih saran.

Gampang banget pasangannya: clone repo, masukin nomor WA kamu jadi owner, jalankan, scan QR, beres.

✨ Fitur Andalan
💌 Menfess / Confess (chat anonim)
Ini fitur utamanya. Cara kerjanya gini:

Kamu aktifin mode menfess → .menfess

Kirim undangan ke nomor target → .kirim hai boleh kenalan? | 62812xxxx

Orang yang kamu tuju bakal dapet notifikasi, terus dia bisa acc → .terima

Setelah acc, kalian bisa chat anonim lewat bot. Nomor kalian nggak bakal keliatan sama sekali.

Mau berhenti? → .endsession atau .stopmenfess

Bot ini juga pinter dikit — kalau kamu salah ketik command (mis. .kirm, .terimas, .send), dia bakal kasih tau command yang bener.

Pesan teks, foto, video, stiker — semua diterusin apa adanya. Privasi aman.

📸 Menfess IG (foto chat iPhone)
Ini fitur keren buat yang mau kirim pesan anonim tapi dalam bentuk foto chat — persis kayak screenshot chat iPhone yang sering diliat di IG story.

Ketik → .menfesig <pesan>

Bot bakal render pesan kamu jadi foto 1080×1920 (ukuran story IG)

Foto dikirim ke nomor tujuan yang udah diatur owner (mis. akun IG atau nomor publik)

Nama pengirim otomatis jadi Anonim xxx — nggak ada yang tau kamu siapa

Command lain:

.menfessig, .igmenfess, .menfes — semua sama, tinggal pilih yang gampang diketik

Owner bisa ganti nomor tujuan → .setmenfessig 628xxxx

Bot ini butuh 3 file gambar di folder assets/ (background.jpeg, emot.jpeg, pop.jpeg). Kalau nggak ada, dia bakal pake wallpaper WA gelap otomatis.

🛡️ Lapor (report ke owner)
Kalau ada bug, mau kasih saran, atau mau laporin user nakal, pake fitur ini:

.lapor bug | bot error pas kirim menfess

Laporan dapet ID unik → LP-XXXXXX

Status laporan: baru → diproses → selesai

Owner bisa balas → .balaslapor LP-123456 makasih udah lapor, udah diperbaiki

Balasan otomatis dikirim ke pelapor, tapi nomor pelapor nggak ditampilkan di pesan laporan (privasi tetap aman)

Command lain:

.listlapor → liat daftar laporan masuk

.dellapor LP-123456 → hapus laporan

🛠️ Command Lainnya
.menu → liat semua command

.status → cek status bot

.runtime → liat udah berapa lama bot nyala

.limit → cek sisa limit harian (buat user biasa)

.addadmin, .deladmin, .listadmin → kelola admin

.addlimit → tambah limit user (buat owner/admin)

🚀 Cara Pasang (Gampang Banget)
Yang kamu butuhin cuma Node.js 18+ dan git.

bash
# 1. Clone repo
git clone <url-repo-ini>
cd menfesinaja_@syxndka

# 2. Install dependencies
npm install

# 3. Set nomor owner (WAJIB!)
cp .env.example .env
# Buka .env, ganti OWNER_NUMBERS="628123456789" jadi nomor WA kamu

# 4. Jalankan bot
npm start
Nanti muncul QR di terminal. Scan pake WA kamu:

Buka WA → Menu (⋮) → Perangkat Tertaut → Tautkan Perangkat → scan QR

Kalau males pake QR, bisa pake kode 8-digit:

Isi PAIRING_NUMBER="628xxxx" di .env sebelum jalankan bot

Setelah bot nyala, dari chat WA owner:

.setmenfessig 628xxxx → atur nomor tujuan menfess IG

.setlapor 628xxxx → (opsional) atur nomor tujuan laporan

⚙️ Konfigurasi (.env)
Variabel	Wajib?	Fungsi
OWNER_NUMBERS	✅ Ya	Nomor WA owner (format 628xxxx, tanpa + atau spasi)
BOT_NAME	❌	Nama bot (default: Menfesin Aja Bot)
PREFIX	❌	Prefix command (default: .)
ADMIN_NUMBERS	❌	Nomor admin tambahan
MENFESS_IG_TARGET	❌	Nomor tujuan menfess IG (bisa juga via .setmenfessig)
PAIRING_NUMBER	❌	Login pake kode 8-digit (tanpa QR)
📁 Struktur Folder
text
menfesinaja_@syxndka/
├── assets/               # Foto background buat menfess IG
├── data/db.json          # Database (otomatis dibuat pas pertama jalan)
├── src/
│   ├── config/           # Pengaturan bot
│   ├── connection/       # Koneksi ke WA (Baileys)
│   ├── database/         # Schema database
│   ├── handlers/         # Command & relay chat
│   ├── middleware/       # Hak akses (owner/admin/user) + limit
│   ├── services/         # Fitur menfess, render foto, dll
│   └── utils/            # Fungsi bantu
├── .env.example
├── package.json
└── tsconfig.json
❓ Troubleshooting (Kalau Ada Masalah)
"Nomor tujuan menfess IG belum diatur" → jalankan .setmenfessig <nomor> dari chat owner, atau isi MENFESS_IG_TARGET di .env

Foto menfess nggak muncul → cek folder assets/, pastiin 3 file (background.jpeg, emot.jpeg, pop.jpeg) ada dengan nama persis. Kalau kosong, bot pake wallpaper WA gelap otomatis.

Owner command nggak dikenal → pastiin nomor di OWNER_NUMBERS format 628xxxx tanpa + atau spasi

Database lama / corrupt → hapus data/db.json buat reset total (sesi menfess, laporan, limit ikut kehapus)

⚠️ Catatan Penting
Bot ini pake Baileys — library unofficial buat konek ke WhatsApp Web. Risikonya: kalau kelakuan bot terlalu robotik (spam, kirim massal, IP datacenter), nomor bisa kena ban.

Pake nomor sekunder, jangan nomor utama.

Jangan spam, jangan kirim massal, biar aman.