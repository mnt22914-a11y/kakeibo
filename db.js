// データの保存係。ブラウザの中にある「IndexedDB」という保管庫に記録を入れたり出したりする。
'use strict';

const DB = (() => {
  const NAME = 'kakeibo';
  const VERSION = 1;
  let opening;

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // records: 支出・収入の記録 / images: レシート写真(段階2) / recurring: 固定収入(段階4)
        if (!db.objectStoreNames.contains('records')) {
          db.createObjectStore('records', { keyPath: 'id' }).createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('recurring')) db.createObjectStore('recurring', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opening;
  }

  async function run(store, mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = action(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  return {
    // ym は "2026-11" の形。その月の記録をすべて返す
    recordsInMonth: (ym) =>
      run('records', 'readonly', (s) => s.index('date').getAll(IDBKeyRange.bound(`${ym}-01`, `${ym}-31`))),
    putRecord: (record) => run('records', 'readwrite', (s) => s.put(record)),
    deleteRecord: (id) => run('records', 'readwrite', (s) => s.delete(id)),
    // レシート写真
    putImage: (id, blob) => run('images', 'readwrite', (s) => s.put({ id, blob })),
    getImage: (id) => run('images', 'readonly', (s) => s.get(id)).then((row) => row?.blob || null),
    deleteImage: (id) => run('images', 'readwrite', (s) => s.delete(id)),
    // まとめて読む・書く(固定収入・カテゴリ変更・バックアップ用)
    getAll: (store) => run(store, 'readonly', (s) => s.getAll()),
    put: (store, row) => run(store, 'readwrite', (s) => s.put(row)),
    remove: (store, id) => run(store, 'readwrite', (s) => s.delete(id)),
    putMany: async (store, rows) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        rows.forEach((row) => tx.objectStore(store).put(row));
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    },
    // バックアップの読み込み：今のデータを全部消して、渡されたデータに置き換える(途中で失敗したら何も変わらない)
    replaceAll: async ({ records, recurring, images }) => {
      const db = await open();
      const stores = ['records', 'recurring', 'images'];
      return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, 'readwrite');
        stores.forEach((name) => tx.objectStore(name).clear());
        records.forEach((row) => tx.objectStore('records').put(row));
        recurring.forEach((row) => tx.objectStore('recurring').put(row));
        images.forEach((row) => tx.objectStore('images').put(row));
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    },
  };
})();
