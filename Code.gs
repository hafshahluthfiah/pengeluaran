const SPREADSHEET_ID = '1vEH4ZRGj8kpDGZtjIHD98MqIjcGlEHBDswgoQ-B7c6M';
const TZ = 'Asia/Jakarta';

const SHEETS = Object.freeze({
  TRANSACTIONS: 'Transaksi',
  ACCOUNTS: 'Master Akun',
  CATEGORIES: 'Master Kategori',
  FINANCING: 'Pembiayaan'
});

const TRANSACTION_HEADER_ROW = 2;
const TRANSACTION_FIRST_ROW = 3;

function doGet(e) {
  if (e && e.parameter && e.parameter.api === '1') {
    return apiResponse_({ ok: true, data: getAppData() });
  }
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Catatan Keuangan')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}

/**
 * Endpoint untuk frontend PWA yang di-host di GitHub Pages.
 * Body dikirim sebagai text/plain berisi JSON agar browser tidak membuat
 * preflight request yang tidak didukung Google Apps Script Web App.
 */
function doPost(e) {
  try {
    const request = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const result = dispatchApi_(request.action, request.payload);
    return apiResponse_({ ok: true, data: result });
  } catch (error) {
    return apiResponse_({ ok: false, error: error && error.message ? error.message : 'Terjadi kesalahan.' });
  }
}

function dispatchApi_(action, payload) {
  switch (cleanText_(action)) {
    case 'getAppData': return getAppData();
    case 'saveTransaction': return saveTransaction(payload);
    case 'saveTransfer': return saveTransfer(payload);
    case 'saveAdjustment': return saveAdjustment(payload);
    case 'payInstallment': return payInstallment(payload);
    case 'deleteTransaction': return deleteTransaction(payload);
    default: throw new Error('Aksi API tidak dikenali.');
  }
}

function apiResponse_(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

function getAppData() {
  const accounts = getAccounts_();
  const categories = getCategories_();
  const financing = getFinancing_();
  const balances = getBalances_(accounts);
  const transactions = getTransactions_(200);
  const debt = financing
    .filter(item => item.status === 'Aktif')
    .reduce((total, item) => total + item.remainingAmount, 0);
  const liquid = accounts
    .filter(account => account.active && account.liquid)
    .reduce((total, account) => total + (balances[account.name] || 0), 0);
  const nonLiquid = accounts
    .filter(account => account.active && !account.liquid)
    .reduce((total, account) => total + (balances[account.name] || 0), 0);
  const now = new Date();
  const monthKey = Utilities.formatDate(now, TZ, 'yyyy-MM');
  const monthlyExpenses = transactions
    .filter(item => item.type === 'Pengeluaran' && item.date.slice(0, 7) === monthKey)
    .reduce((total, item) => total + item.amount, 0);
  const categoryTotals = {};
  transactions.forEach(item => {
    if (item.type !== 'Pengeluaran' || item.date.slice(0, 7) !== monthKey) return;
    categoryTotals[item.category] = (categoryTotals[item.category] || 0) + item.amount;
  });

  return {
    generatedAt: formatDateTime_(now),
    today: Utilities.formatDate(now, TZ, 'yyyy-MM-dd'),
    monthLabel: Utilities.formatDate(now, TZ, 'MMMM yyyy'),
    accounts: accounts.filter(account => account.active).map(account => ({
      ...account,
      balance: balances[account.name] || 0
    })),
    categories: categories.filter(category => category.active),
    financing,
    transactions,
    summary: {
      liquid,
      nonLiquid,
      totalAssets: liquid + nonLiquid,
      debt,
      netWorth: liquid + nonLiquid - debt,
      monthlyExpenses,
      categoryTotals
    }
  };
}

function saveTransaction(payload) {
  return withLock_(() => {
    const data = normalizePayload_(payload);
    if (!['Pengeluaran', 'Pemasukan'].includes(data.type)) {
      throw new Error('Jenis transaksi tidak didukung oleh form ini.');
    }
    validateAccount_(data.account);
    validateCategory_(data.category, data.type);

    if (data.id) {
      updateTransaction_(data);
    } else {
      writeTransactionRow_({
        date: data.date,
        time: data.time,
        type: data.type,
        category: data.category,
        description: data.description,
        account: data.account,
        incoming: data.type === 'Pemasukan' ? data.amount : 0,
        outgoing: data.type === 'Pengeluaran' ? data.amount : 0,
        id: makeId_('TRX'),
        groupId: ''
      });
    }
    SpreadsheetApp.flush();
    return getAppData();
  });
}

function saveTransfer(payload) {
  return withLock_(() => {
    const data = normalizePayload_(payload);
    validateAccount_(data.fromAccount);
    validateAccount_(data.toAccount);
    if (data.fromAccount === data.toAccount) {
      throw new Error('Akun asal dan tujuan tidak boleh sama.');
    }
    const currentBalance = getCurrentAccountBalance_(data.fromAccount);
    if (currentBalance < data.amount) {
      throw new Error('Saldo akun asal tidak mencukupi.');
    }

    const groupId = makeId_('TF');
    const createdAt = new Date();
    writeTransactionRow_({
      date: data.date,
      time: data.time,
      type: 'Transfer',
      category: 'Transfer keluar',
      description: data.description || `Transfer ke ${data.toAccount}`,
      account: data.fromAccount,
      incoming: 0,
      outgoing: data.amount,
      id: makeId_('TRX'),
      groupId,
      createdAt
    });
    writeTransactionRow_({
      date: data.date,
      time: data.time,
      type: 'Transfer',
      category: 'Transfer masuk',
      description: data.description || `Transfer dari ${data.fromAccount}`,
      account: data.toAccount,
      incoming: data.amount,
      outgoing: 0,
      id: makeId_('TRX'),
      groupId,
      createdAt
    });
    SpreadsheetApp.flush();
    return getAppData();
  });
}

function saveAdjustment(payload) {
  return withLock_(() => {
    const data = normalizePayload_(payload);
    validateAccount_(data.account);
    if (!Number.isFinite(data.targetBalance) || data.targetBalance < 0) {
      throw new Error('Saldo sebenarnya harus berupa angka nol atau lebih.');
    }
    const currentBalance = getCurrentAccountBalance_(data.account);
    const difference = data.targetBalance - currentBalance;
    if (difference === 0) throw new Error('Saldo aplikasi sudah sama dengan saldo sebenarnya.');

    writeTransactionRow_({
      date: data.date,
      time: data.time,
      type: 'Penyesuaian',
      category: 'Penyesuaian saldo',
      description: data.description || 'Penyesuaian dengan saldo sebenarnya',
      account: data.account,
      incoming: difference > 0 ? difference : 0,
      outgoing: difference < 0 ? Math.abs(difference) : 0,
      id: makeId_('TRX'),
      groupId: makeId_('ADJ')
    });
    SpreadsheetApp.flush();
    return getAppData();
  });
}

function payInstallment(payload) {
  return withLock_(() => {
    const data = normalizePayload_(payload);
    validateAccount_(data.account);
    const sheet = getSheet_(SHEETS.FINANCING);
    const values = sheet.getDataRange().getValues();
    const headers = headerMap_(values[0]);
    const targetIndex = values.findIndex((row, index) => index > 0 && String(row[headers['ID Pembiayaan']]) === data.financingId);
    if (targetIndex < 1) throw new Error('Data pembiayaan tidak ditemukan.');

    const row = values[targetIndex];
    const installment = Number(row[headers['Angsuran']]) || 0;
    const remaining = Number(row[headers['Sisa Angsuran']]) || 0;
    if (remaining <= 0 || String(row[headers['Status']]) === 'Lunas') {
      throw new Error('Pembiayaan ini sudah lunas.');
    }
    if (getCurrentAccountBalance_(data.account) < installment) {
      throw new Error('Saldo akun pembayaran tidak mencukupi.');
    }

    const groupId = makeId_(`DEBT-${data.financingId}`);
    writeTransactionRow_({
      date: data.date,
      time: data.time,
      type: 'Pembayaran Utang',
      category: 'Pembayaran utang',
      description: `Angsuran ${row[headers['Nama']]}`,
      account: data.account,
      incoming: 0,
      outgoing: installment,
      id: makeId_('TRX'),
      groupId
    });

    const sheetRow = targetIndex + 1;
    const newRemaining = remaining - 1;
    sheet.getRange(sheetRow, headers['Sisa Angsuran'] + 1).setValue(newRemaining);
    sheet.getRange(sheetRow, headers['Status'] + 1).setValue(newRemaining === 0 ? 'Lunas' : 'Aktif');
    SpreadsheetApp.flush();
    return getAppData();
  });
}

function deleteTransaction(reference) {
  return withLock_(() => {
    const id = cleanText_(reference && reference.id);
    const groupId = cleanText_(reference && reference.groupId);
    if (!id && !groupId) throw new Error('Transaksi tidak ditemukan.');

    const sheet = getSheet_(SHEETS.TRANSACTIONS);
    const lastRow = sheet.getLastRow();
    if (lastRow < TRANSACTION_FIRST_ROW) throw new Error('Belum ada transaksi.');
    const values = sheet.getRange(TRANSACTION_FIRST_ROW, 1, lastRow - TRANSACTION_FIRST_ROW + 1, 13).getValues();
    const rowsToDelete = [];
    let debtPaymentAmount = 0;

    values.forEach((row, index) => {
      const matches = groupId ? String(row[10]) === groupId : String(row[9]) === id;
      if (!matches) return;
      if (String(row[2]) === 'Saldo Awal') {
        throw new Error('Saldo awal dilindungi dan tidak dapat dihapus dari aplikasi. Gunakan Sesuaikan Saldo jika ada koreksi.');
      }
      rowsToDelete.push(index + TRANSACTION_FIRST_ROW);
      if (String(row[2]) === 'Pembayaran Utang') debtPaymentAmount += Number(row[7]) || 0;
    });
    if (!rowsToDelete.length) throw new Error('Transaksi tidak ditemukan atau sudah dihapus.');

    if (debtPaymentAmount > 0) restoreOneInstallment_(groupId, debtPaymentAmount);
    rowsToDelete.sort((a, b) => b - a).forEach(rowNumber => sheet.deleteRow(rowNumber));
    rebuildRunningBalances_();
    SpreadsheetApp.flush();
    return getAppData();
  });
}

function getAccounts_() {
  const sheet = getSheet_(SHEETS.ACCOUNTS);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const h = headerMap_(values[0]);
  return values.slice(1)
    .filter(row => row[h['Nama Akun']])
    .map(row => ({
      id: String(row[h['ID Akun']]),
      name: String(row[h['Nama Akun']]),
      kind: String(row[h['Jenis']]),
      liquid: row[h['Likuid']] === true,
      active: row[h['Aktif']] === true,
      order: Number(row[h['Urutan']]) || 999
    }))
    .sort((a, b) => a.order - b.order);
}

function getCategories_() {
  const sheet = getSheet_(SHEETS.CATEGORIES);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const h = headerMap_(values[0]);
  return values.slice(1)
    .filter(row => row[h['Nama Kategori']])
    .map(row => ({
      id: String(row[h['ID Kategori']]),
      name: String(row[h['Nama Kategori']]),
      type: String(row[h['Jenis']]),
      active: row[h['Aktif']] === true,
      order: Number(row[h['Urutan']]) || 999
    }))
    .sort((a, b) => a.order - b.order);
}

function getFinancing_() {
  const sheet = getSheet_(SHEETS.FINANCING);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const h = headerMap_(values[0]);
  return values.slice(1)
    .filter(row => row[h['ID Pembiayaan']])
    .map(row => ({
      id: String(row[h['ID Pembiayaan']]),
      name: String(row[h['Nama']]),
      initialAmount: Number(row[h['Total Awal']]) || 0,
      installment: Number(row[h['Angsuran']]) || 0,
      remainingInstallments: Number(row[h['Sisa Angsuran']]) || 0,
      remainingAmount: Number(row[h['Sisa Kewajiban']]) || 0,
      nextDueDate: row[h['Jatuh Tempo Berikutnya']] instanceof Date
        ? Utilities.formatDate(row[h['Jatuh Tempo Berikutnya']], TZ, 'yyyy-MM-dd')
        : '',
      status: String(row[h['Status']] || ''),
      note: String(row[h['Catatan']] || '')
    }));
}

function getBalances_(accounts) {
  const balances = {};
  accounts.forEach(account => { balances[account.name] = 0; });
  const sheet = getSheet_(SHEETS.TRANSACTIONS);
  const lastRow = sheet.getLastRow();
  if (lastRow < TRANSACTION_FIRST_ROW) return balances;
  const values = sheet.getRange(TRANSACTION_FIRST_ROW, 6, lastRow - TRANSACTION_FIRST_ROW + 1, 3).getValues();
  values.forEach(row => {
    const account = String(row[0] || '');
    if (!account) return;
    balances[account] = (balances[account] || 0) + (Number(row[1]) || 0) - (Number(row[2]) || 0);
  });
  return balances;
}

function getTransactions_(limit) {
  const sheet = getSheet_(SHEETS.TRANSACTIONS);
  const lastRow = sheet.getLastRow();
  if (lastRow < TRANSACTION_FIRST_ROW) return [];
  const values = sheet.getRange(TRANSACTION_FIRST_ROW, 1, lastRow - TRANSACTION_FIRST_ROW + 1, 13).getValues();
  const items = [];
  const transfers = {};

  values.forEach((row, index) => {
    if (!row[0] || !row[5]) return;
    const item = {
      row: index + TRANSACTION_FIRST_ROW,
      date: formatInputDate_(row[0]),
      time: String(row[1] || ''),
      type: String(row[2] || ''),
      category: String(row[3] || ''),
      description: String(row[4] || ''),
      account: String(row[5] || ''),
      incoming: Number(row[6]) || 0,
      outgoing: Number(row[7]) || 0,
      amount: (Number(row[6]) || 0) + (Number(row[7]) || 0),
      balance: Number(row[8]) || 0,
      id: String(row[9] || ''),
      groupId: String(row[10] || ''),
      createdAt: row[11] instanceof Date ? formatDateTime_(row[11]) : '',
      updatedAt: row[12] instanceof Date ? formatDateTime_(row[12]) : ''
    };

    if (item.type !== 'Transfer' || !item.groupId) {
      items.push(item);
      return;
    }
    if (!transfers[item.groupId]) {
      transfers[item.groupId] = {
        ...item,
        id: item.id,
        fromAccount: '',
        toAccount: '',
        amount: 0
      };
      items.push(transfers[item.groupId]);
    }
    const transfer = transfers[item.groupId];
    if (item.outgoing > 0) {
      transfer.fromAccount = item.account;
      transfer.amount = item.outgoing;
      transfer.description = item.description;
    }
    if (item.incoming > 0) transfer.toAccount = item.account;
  });

  return items
    .sort((a, b) => `${b.date} ${b.time} ${String(b.row).padStart(6, '0')}`.localeCompare(`${a.date} ${a.time} ${String(a.row).padStart(6, '0')}`))
    .slice(0, limit || 200);
}

function writeTransactionRow_(entry) {
  const sheet = getSheet_(SHEETS.TRANSACTIONS);
  const rowNumber = Math.max(sheet.getLastRow() + 1, TRANSACTION_FIRST_ROW);
  const templateRow = Math.max(TRANSACTION_FIRST_ROW, sheet.getLastRow());
  if (sheet.getLastRow() >= TRANSACTION_FIRST_ROW) {
    sheet.getRange(templateRow, 1, 1, 13).copyTo(sheet.getRange(rowNumber, 1, 1, 13), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    sheet.getRange(templateRow, 1, 1, 13).copyTo(sheet.getRange(rowNumber, 1, 1, 13), SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  }
  const createdAt = entry.createdAt || new Date();
  sheet.getRange(rowNumber, 1, 1, 13).setValues([[
    parseInputDate_(entry.date),
    entry.time,
    entry.type,
    entry.category,
    entry.description,
    entry.account,
    Number(entry.incoming) || 0,
    Number(entry.outgoing) || 0,
    '',
    entry.id,
    entry.groupId || '',
    createdAt,
    ''
  ]]);
  sheet.getRange(rowNumber, 9).setFormulaR1C1('=SUMIFS(R3C7:RC7,R3C6:RC6,RC6)-SUMIFS(R3C8:RC8,R3C6:RC6,RC6)');
  sheet.getRange(rowNumber, 1).setNumberFormat('dd mmm yyyy');
  sheet.getRange(rowNumber, 7, 1, 3).setNumberFormat('Rp #,##0;[Red]-Rp #,##0;Rp 0');
  sheet.getRange(rowNumber, 12, 1, 2).setNumberFormat('dd mmm yyyy HH:mm');
  return rowNumber;
}

function updateTransaction_(data) {
  const sheet = getSheet_(SHEETS.TRANSACTIONS);
  const lastRow = sheet.getLastRow();
  const ids = sheet.getRange(TRANSACTION_FIRST_ROW, 10, lastRow - TRANSACTION_FIRST_ROW + 1, 2).getValues();
  const index = ids.findIndex(row => String(row[0]) === data.id);
  if (index < 0) throw new Error('Transaksi tidak ditemukan atau sudah dihapus.');
  if (ids[index][1]) throw new Error('Transfer, penyesuaian, dan angsuran dihapus lalu dibuat ulang agar pencatatannya tetap konsisten.');
  const rowNumber = index + TRANSACTION_FIRST_ROW;
  sheet.getRange(rowNumber, 1, 1, 8).setValues([[
    parseInputDate_(data.date),
    data.time,
    data.type,
    data.category,
    data.description,
    data.account,
    data.type === 'Pemasukan' ? data.amount : 0,
    data.type === 'Pengeluaran' ? data.amount : 0
  ]]);
  sheet.getRange(rowNumber, 13).setValue(new Date());
  rebuildRunningBalances_();
}

function rebuildRunningBalances_() {
  const sheet = getSheet_(SHEETS.TRANSACTIONS);
  const lastRow = sheet.getLastRow();
  if (lastRow < TRANSACTION_FIRST_ROW) return;
  sheet.getRange(TRANSACTION_FIRST_ROW, 9, lastRow - TRANSACTION_FIRST_ROW + 1, 1)
    .setFormulaR1C1('=SUMIFS(R3C7:RC7,R3C6:RC6,RC6)-SUMIFS(R3C8:RC8,R3C6:RC6,RC6)');
}

function restoreOneInstallment_(groupId, amount) {
  const sheet = getSheet_(SHEETS.FINANCING);
  const values = sheet.getDataRange().getValues();
  const h = headerMap_(values[0]);
  let index = values.findIndex((row, i) => {
    if (i === 0) return false;
    const financingId = String(row[h['ID Pembiayaan']] || '');
    return financingId && String(groupId).includes(financingId);
  });
  if (index < 1) {
    index = values.findIndex((row, i) => i > 0 && Number(row[h['Angsuran']]) === amount);
  }
  if (index < 1) return;
  const rowNumber = index + 1;
  const remaining = Number(values[index][h['Sisa Angsuran']]) || 0;
  sheet.getRange(rowNumber, h['Sisa Angsuran'] + 1).setValue(remaining + 1);
  sheet.getRange(rowNumber, h['Status'] + 1).setValue('Aktif');
}

function validateAccount_(name) {
  const valid = getAccounts_().some(account => account.active && account.name === name);
  if (!valid) throw new Error('Akun tidak valid atau sedang dinonaktifkan.');
}

function validateCategory_(name, type) {
  const valid = getCategories_().some(category => category.active && category.name === name && category.type === type);
  if (!valid) throw new Error('Kategori tidak sesuai dengan jenis transaksi.');
}

function getCurrentAccountBalance_(accountName) {
  return getBalances_(getAccounts_())[accountName] || 0;
}

function normalizePayload_(payload) {
  const input = payload || {};
  const amount = Number(input.amount);
  const targetBalance = Number(input.targetBalance);
  if (input.amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
    throw new Error('Nominal harus lebih dari nol.');
  }
  const date = cleanText_(input.date) || Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Format tanggal tidak valid.');
  return {
    id: cleanText_(input.id),
    financingId: cleanText_(input.financingId),
    type: cleanText_(input.type),
    category: cleanText_(input.category),
    description: cleanText_(input.description).slice(0, 150),
    account: cleanText_(input.account),
    fromAccount: cleanText_(input.fromAccount),
    toAccount: cleanText_(input.toAccount),
    date,
    time: cleanText_(input.time) || Utilities.formatDate(new Date(), TZ, 'HH.mm'),
    amount,
    targetBalance
  };
}

function parseInputDate_(dateText) {
  return Utilities.parseDate(dateText, TZ, 'yyyy-MM-dd');
}

function formatInputDate_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, TZ, 'yyyy-MM-dd');
  return String(value || '').slice(0, 10);
}

function formatDateTime_(value) {
  return Utilities.formatDate(value, TZ, 'dd MMM yyyy HH:mm');
}

function headerMap_(headers) {
  return headers.reduce((map, header, index) => {
    map[String(header).trim()] = index;
    return map;
  }, {});
}

function makeId_(prefix) {
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss');
  return `${prefix}-${stamp}-${Utilities.getUuid().slice(0, 8).toUpperCase()}`;
}

function cleanText_(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function getSheet_(name) {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
  if (!sheet) throw new Error(`Sheet “${name}” tidak ditemukan.`);
  return sheet;
}

function withLock_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}
