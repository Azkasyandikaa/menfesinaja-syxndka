# Folder Assets — Menfess IG

Taruh 3 file mentahan di folder ini (nama harus persis):

| File           | Fungsi                                    |
| -------------- | ----------------------------------------- |
| `background.jpeg` | Wallpaper chat gelap/hitam (latar penuh kanvas) |
| `pop.jpeg`        | Hiasan kartu di BAWAH bubble chat          |
| `emot.jpeg`       | Hiasan doodle emoji DI ATAS bubble chat    |

- Format yang didukung: `.jpeg`, `.jpg`, `.png`, `.webp` (nama dasar tetap harus `background`, `pop`, atau `emot`).
- Bisa ukuran berapa saja — bot otomatis resize/crop pas ke kanvas potrait 1080×1920 (`cover`).

Catatan tampilan (render terbaru):
- Kanvas potrait 9:16 → 1080×1920, isi di-tengah vertikal.
- TANPA header: nama kontak, ikon video/call, status bar & bar hijau di belakangnya sudah dihapus.
- Bubble chat warna HITAM, teks putih, lebar maksimal hampir selebar kanvas.
- `pop.jpeg` & `emot.jpeg` dibesarkan hampir selebar kanvas (pop di bawah bubble, emot di atas bubble).
- **Background pop & emot dibuang otomatis** — mode dideteksi dari luminance tepi gambar: background GELAP (kartu hitam) maupun TERANG/BLUR (foto blur) sama-sama dibuang via flood-fill dari tepi; tepi kartu di-feather (gradasi alpha) supaya mulus, konten di dalam kartu aman. Hasilnya kartu "mengambang" di wallpaper.
- Kalau folder kosong / salah nama file, bot otomatis pakai wallpaper WA dark (gelap + pola lembut) sehingga fitur tetap jalan.

File haus akan IKUT ke git? Tidak — file di bawah ini diabaikan (lihat `.gitignore`):

```
assets/background.*
assets/pop.*
assets/emot.*
```
