# Catatan Keuangan — PWA GitHub Pages

Frontend ini mengambil dan menyimpan data melalui Google Apps Script Web App.

## 1. Perbarui Apps Script

1. Ganti isi `Code.gs` di project Apps Script dengan file `Code.gs` dari folder ini.
2. Biarkan `Index.html` di Apps Script tetap ada; versi itu masih bisa dibuka langsung dari Apps Script.
3. Klik **Save**.
4. Buka **Deploy → Manage deployments → Edit**.
5. Pilih **New version**, atur **Who has access: Anyone**, lalu klik **Deploy**.
6. Salin URL Web App yang berakhiran `/exec`.

## 2. Hubungkan frontend

Buka `config.js`, lalu ganti:

```js
apiUrl: 'PASTE_APPS_SCRIPT_WEB_APP_URL_HERE'
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
