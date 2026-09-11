# Catatan Keuangan — PWA GitHub Pages

Frontend GitHub ini menjadi cangkang PWA dan memuat Google Apps Script Web App di dalamnya. Cara ini membuat `google.script.run` tetap bekerja dan menghindari error CORS/`Failed to fetch`.

## 1. Perbarui Apps Script

1. Pastikan `Code.gs` dan `Index.html` yang sebelumnya dibuat masih ada di project Apps Script. Salinan tampilannya tersedia sebagai `Index-appscript.html`; kalau dipakai, ubah nama filenya menjadi `Index.html` saat ditempel di Apps Script.
2. Pastikan `doGet()` memakai `.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)` agar bisa dimuat dari GitHub Pages.
3. Klik **Save**.
4. Buka **Deploy → Manage deployments → Edit**.
5. Pilih **New version**, atur **Who has access: Anyone**, lalu klik **Deploy**.
6. Salin URL Web App yang berakhiran `/exec`.

## 2. Hubungkan frontend

Buka `config.js`, lalu ganti:

```js
appScriptUrl: 'PASTE_APPS_SCRIPT_WEB_APP_URL_HERE'
```

dengan URL `/exec` dari langkah sebelumnya.

## 3. Upload ke GitHub

Upload seluruh isi folder ini ke root repository, termasuk folder `assets`.

Di repository GitHub buka **Settings → Pages**:

- **Source:** Deploy from a branch
- **Branch:** `main`
- **Folder:** `/ (root)`

Setelah Pages selesai diproses, buka link yang diberikan GitHub.

## 4. Install sebagai aplikasi

- **Android/Chrome:** menu tiga titik → **Install app** atau **Add to Home screen**.
- **iPhone/Safari:** tombol Share → **Add to Home Screen**.
- **Desktop Chrome/Edge:** klik ikon Install di sisi kanan address bar.

Jika setelah update tampilan masih versi lama, tutup aplikasi lalu buka ulang. Bila perlu hapus aplikasi dari perangkat dan install kembali.
