// 設定画面の係：固定収入・カテゴリの編集・バックアップ・合言葉。
'use strict';

const ymOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const nextYm = (ym) => { const [y, m] = ym.split('-').map(Number); return ymOf(new Date(y, m, 1)); };
const daysIn = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const LAST_DAY = 31; // 「末日」は 31 として保存し、短い月はその月の最終日にする
const dayLabel = (day) => (day >= LAST_DAY ? '末日' : `${day}日`);

// ===== 起動 =====
async function startup() {
  const made = await runRecurring();
  await render();
  if (made) toast(`固定収入を ${made} 件記録しました`);
}

// 別のアプリから戻ってきたときにも、登録日が来た固定収入を記録する
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  const made = await runRecurring();
  if (made) { await render(); toast(`固定収入を ${made} 件記録しました`); }
});

// ===== 固定収入の自動記録 =====
let recurringRun = null;
function runRecurring() {
  // 同時に 2 回動いて二重に記録しないよう、動いている間は同じ処理を待つ
  if (!recurringRun) recurringRun = doRunRecurring().finally(() => { recurringRun = null; });
  return recurringRun;
}

async function doRunRecurring() {
  let made = 0;
  try {
    const items = await DB.getAll('recurring');
    const now = new Date();
    const thisYm = ymOf(now);
    for (const item of items) {
      let ym = item.lastYm ? nextYm(item.lastYm) : item.startYm;
      while (ym <= thisYm) {
        const day = Math.min(item.day, daysIn(ym));
        if (ym === thisYm && day > now.getDate()) break; // 今月の登録日がまだ来ていない
        const stamp = new Date().toISOString();
        await DB.putRecord({
          id: newId(), type: 'income', date: `${ym}-${pad(day)}`, amount: item.amount,
          store: '', category: item.category, memo: item.name, imageId: '', breakdown: null,
          source: 'recurring', recurringId: item.id, createdAt: stamp, updatedAt: stamp,
        });
        item.lastYm = ym;
        await DB.put('recurring', item);
        made++;
        ym = nextYm(ym);
      }
    }
  } catch (err) {
    console.error(err);
    toast('固定収入を記録できませんでした');
  }
  return made;
}

// ===== 設定画面を開く =====
function openSettings(note = '') {
  $('#passcode').value = getPasscode();
  $('#settingsNote').textContent = note;
  $('#settingsNote').hidden = !note;
  closeRecurForm();
  renderRecurList();
  renderCatList();
  renderBackupInfo();
  openPanel($('#settings'));
  if (note) setTimeout(() => $('#keySection').scrollIntoView({ behavior: 'smooth', block: 'start' }), 360);
}

// ===== 固定収入の一覧と編集 =====
let recurEditing = null;  // 編集中の固定収入(新規なら null)
let recurCategory = '給料';

async function renderRecurList() {
  const list = $('#recurList');
  list.replaceChildren();
  const items = await DB.getAll('recurring').catch(() => []);
  for (const item of items) {
    const row = el('button', 'set-row');
    row.type = 'button';
    const dot = el('i', 'dot');
    dot.style.setProperty('--c', catColor('income', item.category));
    const main = el('span', 'set-main');
    main.append(el('span', 'set-name', item.name), el('span', 'set-sub', `毎月${dayLabel(item.day)} · ${item.category}`));
    row.append(dot, main, el('b', 'set-amt', yen(item.amount)));
    row.addEventListener('click', () => openRecurForm(item));
    list.append(row);
  }
}

function renderRecurChips() {
  const box = $('#recurChips');
  box.replaceChildren();
  if (!INCOME_CATS.some((c) => c.name === recurCategory)) recurCategory = INCOME_CATS[0].name;
  for (const c of INCOME_CATS) {
    const chip = el('button', 'chip' + (c.name === recurCategory ? ' active' : ''));
    chip.type = 'button';
    chip.style.setProperty('--c', c.color);
    chip.append(el('i'), c.name);
    chip.addEventListener('click', () => { recurCategory = c.name; renderRecurChips(); });
    box.append(chip);
  }
}

function updateRecurNowText() {
  const day = Number($('#recurDay').value);
  const now = new Date();
  const thisDay = Math.min(day, daysIn(ymOf(now)));
  // 今月の登録日がもう過ぎている新規のときだけ「今月分も記録する?」を聞く
  const ask = !recurEditing && thisDay <= now.getDate();
  $('#recurNowRow').hidden = !ask;
  $('#recurNowText').textContent = `今月(${now.getMonth() + 1}月${thisDay}日)の分も、いま記録する`;
}

function openRecurForm(item = null) {
  recurEditing = item;
  $('#recurName').value = item?.name || '';
  $('#recurAmount').value = item ? item.amount.toLocaleString('ja-JP') : '';
  $('#recurDay').value = String(item?.day || 25);
  recurCategory = item?.category || INCOME_CATS[0].name;
  $('#recurNow').checked = true;
  $('#recurDelete').hidden = !item;
  renderRecurChips();
  updateRecurNowText();
  $('#recurForm').hidden = false;
  $('#recurAdd').hidden = true;
  $('#recurList').hidden = true;
  $('#recurName').focus();
}

function closeRecurForm() {
  recurEditing = null;
  $('#recurForm').hidden = true;
  $('#recurAdd').hidden = false;
  $('#recurList').hidden = false;
}

async function saveRecur(e) {
  e.preventDefault();
  const name = $('#recurName').value.trim();
  const amount = parseInt($('#recurAmount').value.replace(/\D/g, ''), 10);
  const day = Number($('#recurDay').value);
  if (!name) { toast('名前を入れてください'); return; }
  if (!amount) { toast('金額を入れてください'); return; }

  let item;
  if (recurEditing) {
    // 変更はこれから先の記録にだけ効く(もう記録した分はそのまま)
    item = { ...recurEditing, name, amount, day, category: recurCategory };
  } else {
    const now = new Date();
    const thisYm = ymOf(now);
    const dayPassed = Math.min(day, daysIn(thisYm)) <= now.getDate();
    const startYm = dayPassed && !$('#recurNow').checked ? nextYm(thisYm) : thisYm;
    item = { id: newId(), name, amount, day, category: recurCategory, startYm, lastYm: '' };
  }
  try {
    await DB.put('recurring', item);
  } catch (err) {
    console.error(err);
    toast('保存できませんでした');
    return;
  }
  closeRecurForm();
  await renderRecurList();
  const made = await runRecurring();
  await render();
  toast(made ? `保存して、${made} 件記録しました` : '保存しました');
}

async function deleteRecur() {
  if (!recurEditing || !confirm(`「${recurEditing.name}」を削除しますか？\nこれまでに記録した分は残ります。`)) return;
  try {
    await DB.remove('recurring', recurEditing.id);
  } catch (err) {
    console.error(err);
    toast('削除できませんでした');
    return;
  }
  closeRecurForm();
  await renderRecurList();
  toast('削除しました');
}

// 毎月◯日の選択肢
(() => {
  const select = $('#recurDay');
  for (let d = 1; d <= 28; d++) select.append(new Option(`${d}日`, String(d)));
  select.append(new Option('末日', String(LAST_DAY)));
})();

// ===== カテゴリの編集 =====
let catType = 'expense';
const EXTRA_COLORS = ['#B5A36A', '#7FA7B8', '#A88FB8', '#9DB08A', '#C49A8A', '#8A9DC4', '#B8946F', '#6FA3B5', '#B88A9E', '#8FB5A0'];
const OTHER = 'その他';

function saveCategories() {
  try { localStorage.setItem(CATS_KEY, JSON.stringify({ expense: EXPENSE_CATS, income: INCOME_CATS })); }
  catch { toast('カテゴリを保存できませんでした'); }
}

function renderCatList() {
  document.querySelectorAll('#catSeg button').forEach((b) => b.classList.toggle('active', b.dataset.catType === catType));
  const list = $('#catList');
  list.replaceChildren();
  const items = cats(catType);
  items.forEach((c, i) => {
    const row = el('div', 'cat-row');
    const dot = el('i', 'dot');
    dot.style.setProperty('--c', c.color);

    const input = el('input', 'cat-name');
    input.value = c.name;
    input.maxLength = 10;
    input.setAttribute('aria-label', `${c.name} の名前`);
    const isOther = c.name === OTHER;
    input.readOnly = isOther; // 「その他」は名前を変えない(削除したカテゴリの行き先なので)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    input.addEventListener('change', () => renameCategory(c, input));

    const up = iconButton('↑', `${c.name} を上へ`, i === 0, () => moveCategory(i, -1));
    const down = iconButton('↓', `${c.name} を下へ`, i === items.length - 1, () => moveCategory(i, 1));
    const del = iconButton('×', `${c.name} を削除`, isOther || items.length <= 2, () => deleteCategory(c));
    del.classList.add('del');
    row.append(dot, input, up, down, del);
    list.append(row);
  });
}

function iconButton(text, label, disabled, onClick) {
  const b = el('button', 'mini', text);
  b.type = 'button';
  b.disabled = disabled;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

function moveCategory(i, dir) {
  const items = cats(catType);
  [items[i], items[i + dir]] = [items[i + dir], items[i]];
  saveCategories();
  renderCatList();
  render();
}

function addCategory(e) {
  e.preventDefault();
  const name = $('#catNew').value.trim();
  if (!name) return;
  const items = cats(catType);
  if (items.some((c) => c.name === name)) { toast('同じ名前のカテゴリがあります'); return; }
  const used = new Set([...EXPENSE_CATS, ...INCOME_CATS].map((c) => c.color));
  const color = EXTRA_COLORS.find((c) => !used.has(c)) || '#8E8A80';
  // 「その他」はいつも最後に置く
  const otherAt = items.findIndex((c) => c.name === OTHER);
  items.splice(otherAt >= 0 ? otherAt : items.length, 0, { name, color });
  saveCategories();
  $('#catNew').value = '';
  renderCatList();
  toast(`「${name}」を追加しました`);
}

// これまでの記録・固定収入のカテゴリ名を書き換える
async function replaceCategoryInData(type, from, to) {
  const records = (await DB.getAll('records')).filter((r) =>
    r.type === type && (r.category === from || r.breakdown?.some((b) => b.category === from)));
  for (const r of records) {
    if (r.category === from) r.category = to;
    if (r.breakdown) {
      const merged = new Map();
      for (const b of r.breakdown) {
        const name = b.category === from ? to : b.category;
        merged.set(name, (merged.get(name) || 0) + b.amount);
      }
      r.breakdown = [...merged].map(([category, amount]) => ({ category, amount }));
    }
  }
  await DB.putMany('records', records);
  if (type === 'income') {
    const recurring = (await DB.getAll('recurring')).filter((x) => x.category === from);
    recurring.forEach((x) => { x.category = to; });
    await DB.putMany('recurring', recurring);
  }
  return records.length;
}

async function renameCategory(cat, input) {
  const name = input.value.trim();
  if (name === cat.name) return;
  if (!name || cats(catType).some((c) => c.name === name)) {
    toast(!name ? '名前を入れてください' : '同じ名前のカテゴリがあります');
    input.value = cat.name;
    return;
  }
  const old = cat.name;
  try {
    const n = await replaceCategoryInData(catType, old, name);
    cat.name = name;
    saveCategories();
    toast(n ? `「${name}」に変えました(記録 ${n} 件も変更)` : `「${name}」に変えました`);
  } catch (err) {
    console.error(err);
    input.value = old;
    toast('変更できませんでした');
    return;
  }
  renderCatList();
  render();
}

async function deleteCategory(cat) {
  const items = cats(catType);
  if (!confirm(`「${cat.name}」を削除しますか？\nこのカテゴリの記録は「${OTHER}」に移ります。`)) return;
  try {
    await replaceCategoryInData(catType, cat.name, OTHER);
  } catch (err) {
    console.error(err);
    toast('削除できませんでした');
    return;
  }
  items.splice(items.indexOf(cat), 1);
  saveCategories();
  renderCatList();
  render();
  toast(`「${cat.name}」を削除しました`);
}

// ===== バックアップ =====
const BACKUP_KEY = 'kakeibo.lastBackup';

function renderBackupInfo() {
  let last = '';
  try { last = localStorage.getItem(BACKUP_KEY) || ''; } catch { /* なし */ }
  const d = last ? new Date(last) : null;
  $('#backupInfo').textContent = d
    ? `前回の書き出し: ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
    : 'まだ書き出していません';
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

async function exportBackup() {
  try {
    const [records, recurring, images] = await Promise.all(['records', 'recurring', 'images'].map((s) => DB.getAll(s)));
    const data = {
      app: 'kakeibo',
      version: 1,
      exportedAt: new Date().toISOString(),
      categories: { expense: EXPENSE_CATS, income: INCOME_CATS },
      records,
      recurring,
      images: await Promise.all(images.map(async (img) => ({ id: img.id, data: await blobToDataUrl(img.blob) }))),
    };
    const file = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = `kakeibo-backup-${ymd(new Date())}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    try { localStorage.setItem(BACKUP_KEY, data.exportedAt); } catch { /* なし */ }
    renderBackupInfo();
    toast(`書き出しました(記録 ${records.length} 件・写真 ${images.length} 枚)`);
  } catch (err) {
    console.error(err);
    toast('書き出せませんでした');
  }
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (data?.app !== 'kakeibo' || !Array.isArray(data.records)) {
    toast('SCANs のバックアップファイルではないようです');
    return;
  }
  const when = new Date(data.exportedAt);
  const label = isNaN(when) ? '' : `${when.getFullYear()}年${when.getMonth() + 1}月${when.getDate()}日の`;
  if (!confirm(`${label}バックアップ(記録 ${data.records.length} 件)を読み込みます。\n今このブラウザにあるデータは、すべてこの内容に置き換わります。よろしいですか？`)) return;

  try {
    // 写真を元の形(Blob)に戻してから、まとめて置き換える
    const images = await Promise.all((data.images || []).map(async (img) => ({
      id: img.id, blob: await (await fetch(img.data)).blob(),
    })));
    await DB.replaceAll({ records: data.records, recurring: data.recurring || [], images });
    if (data.categories?.expense?.length && data.categories?.income?.length) {
      EXPENSE_CATS = data.categories.expense;
      INCOME_CATS = data.categories.income;
      saveCategories();
    }
  } catch (err) {
    console.error(err);
    toast('読み込めませんでした。データは元のままです');
    return;
  }
  renderRecurList();
  renderCatList();
  await render();
  toast(`読み込みました(記録 ${data.records.length} 件)`);
}

// ===== 合言葉(中継役を使うためのもの) =====
function saveKey(e) {
  e.preventDefault();
  const code = $('#passcode').value.trim();
  if (!code) { toast('合言葉を入れてください'); return; }
  try { localStorage.setItem(KEY_NAME, code); } catch { toast('保存できませんでした'); return; }
  closePanel();
  toast('合言葉を保存しました。SCAN で読み取れます');
}

function clearKey() {
  if (!getPasscode() || !confirm('このブラウザの合言葉を削除しますか？')) return;
  try { localStorage.removeItem(KEY_NAME); } catch { /* 何もしない */ }
  $('#passcode').value = '';
  toast('合言葉を削除しました');
}

// ===== ボタンをつなぐ =====
$('#settingsBtn').addEventListener('click', () => openSettings());
$('#recurAdd').addEventListener('click', () => openRecurForm());
$('#recurCancel').addEventListener('click', closeRecurForm);
$('#recurForm').addEventListener('submit', saveRecur);
$('#recurDelete').addEventListener('click', deleteRecur);
$('#recurDay').addEventListener('change', updateRecurNowText);
$('#recurAmount').addEventListener('input', (e) => {
  const digits = e.target.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 9);
  e.target.value = digits ? Number(digits).toLocaleString('ja-JP') : '';
});
document.querySelectorAll('#catSeg button').forEach((b) =>
  b.addEventListener('click', () => { catType = b.dataset.catType; renderCatList(); }));
$('#catAddForm').addEventListener('submit', addCategory);
$('#exportBtn').addEventListener('click', exportBackup);
$('#importBtn').addEventListener('click', () => { $('#importInput').value = ''; $('#importInput').click(); });
$('#importInput').addEventListener('change', (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); });
$('#keyForm').addEventListener('submit', saveKey);
$('#clearKeyBtn').addEventListener('click', clearKey);

// 起動したら、固定収入の登録日が来ていれば記録してから画面を描く
startup();

// ホーム画面に追加したときにオフラインでも開けるようにする(https か、この PC の localhost のときだけ)
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('service worker', err));
}
