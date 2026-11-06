// 画面の動き。ボタンを押したときの処理や、合計の計算をここでしている。
'use strict';

// ===== カテゴリ（名前と色）=====
// はじめの設定。設定画面で変えたものはブラウザに保存され、そちらが使われる
const DEFAULT_EXPENSE_CATS = [
  ['食費', '#C9A86A'], ['外食', '#C2876A'], ['日用品', '#8FA383'], ['交通', '#7895AD'],
  ['衣服・美容', '#B08AA6'], ['趣味・娯楽', '#9285BD'], ['交際費', '#CF9A78'], ['医療', '#73A8A0'],
  ['住まい・光熱', '#A39886'], ['通信', '#8496AE'], ['その他', '#77767C'],
].map(([name, color]) => ({ name, color }));

const DEFAULT_INCOME_CATS = [
  ['給料', '#D8BC82'], ['副業', '#B9A06C'], ['その他', '#8E8A80'],
].map(([name, color]) => ({ name, color }));

const CATS_KEY = 'kakeibo.categories';
function loadCategories() {
  try {
    const saved = JSON.parse(localStorage.getItem(CATS_KEY));
    if (saved?.expense?.length && saved?.income?.length) return saved;
  } catch { /* 読めなければはじめの設定 */ }
  return { expense: DEFAULT_EXPENSE_CATS, income: DEFAULT_INCOME_CATS };
}
let { expense: EXPENSE_CATS, income: INCOME_CATS } = loadCategories();

const MONTH_EN = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

// ===== 小さな道具 =====
const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const yen = (n) => '¥' + Math.abs(n).toLocaleString('ja-JP');
const sum = (list) => list.reduce((t, r) => t + r.amount, 0);
const cats = (type) => (type === 'income' ? INCOME_CATS : EXPENSE_CATS);
const catColor = (type, name) => (cats(type).find((c) => c.name === name) || { color: '#77767C' }).color;
const newId = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer;
function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ===== 今の状態 =====
const today = new Date();
const state = {
  year: today.getFullYear(),
  month: today.getMonth(), // 0 = 1月
  type: 'expense',
  category: EXPENSE_CATS[0].name,
  editing: null,           // 編集中の記録（新規なら null）
  breakdown: null,         // レシートのカテゴリ別小計（AI が読んだもの）
  view: 'home',            // 'home' ホーム / 'receipts' レシート一覧
  filter: { type: 'all', category: null }, // 記録一覧の絞り込み
  records: [],             // 表示中の月の記録
};
const ymKey = () => `${state.year}-${pad(state.month + 1)}`;
const isThisMonth = () => state.year === today.getFullYear() && state.month === today.getMonth();

// ===== ホーム画面を描く =====
async function render() {
  $('#monthEn').textContent = MONTH_EN[state.month];
  $('#monthJa').textContent = `${state.year}年${state.month + 1}月`;

  const prevMonth = new Date(state.year, state.month - 1, 1);
  const prevKey = `${prevMonth.getFullYear()}-${pad(prevMonth.getMonth() + 1)}`;
  let records = [];
  let prevRecords = [];
  try {
    [records, prevRecords] = await Promise.all([DB.recordsInMonth(ymKey()), DB.recordsInMonth(prevKey)]);
  } catch (err) {
    console.error(err);
    toast('データを読み込めませんでした');
  }

  const income = sum(records.filter((r) => r.type === 'income'));
  const expense = sum(records.filter((r) => r.type === 'expense'));
  const balance = income - expense;

  countUp($('#balance'), balance, true);
  countUp($('#incomeTotal'), income);
  countUp($('#expenseTotal'), expense);
  $('#balance').classList.toggle('plus', balance > 0);
  $('#balance').classList.toggle('minus', balance < 0);

  const prevExpense = sum(prevRecords.filter((r) => r.type === 'expense'));
  renderCompare(expense, prevExpense, prevMonth.getMonth() + 1);
  renderSpending(byCategory(records), byCategory(prevRecords), expense);

  state.records = records;
  renderFiltered();
  renderReceipts(records);
}

// ===== 前月との比較 =====
function renderCompare(expense, prevExpense, prevMonthNumber) {
  const node = $('#compare');
  node.replaceChildren();
  node.hidden = !expense && !prevExpense;
  if (node.hidden) return;
  if (!prevExpense) {
    node.append(`${prevMonthNumber}月の支出の記録はありません`);
    return;
  }
  const diff = expense - prevExpense;
  const pct = Math.round((diff / prevExpense) * 100);
  const arrow = el('span', 'arrow ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'), diff > 0 ? '▲' : diff < 0 ? '▼' : '＝');
  const text = diff === 0
    ? `支出は${prevMonthNumber}月と同じ`
    : `支出は${prevMonthNumber}月より ${yen(diff)} ${diff > 0 ? '多い' : '少ない'}（${pct > 0 ? '+' : ''}${pct}%）`;
  node.append(arrow, text);
}

// ===== カテゴリ別の支出 =====
// レシートの内訳(小計)があればそれで、なければ記録のカテゴリで集計する
function byCategory(records) {
  const totals = new Map();
  for (const r of records) {
    if (r.type !== 'expense') continue;
    const parts = r.breakdown?.length ? r.breakdown : [{ category: r.category, amount: r.amount }];
    for (const p of parts) totals.set(p.category, (totals.get(p.category) || 0) + p.amount);
  }
  return totals;
}

function renderSpending(totals, prevTotals, expense) {
  const section = $('#spending');
  section.hidden = !expense;
  if (!expense) return;
  const rows = [...totals].sort((a, b) => b[1] - a[1]);
  const max = rows[0][1];
  const list = $('#spendList');
  list.replaceChildren();

  for (const [name, amount] of rows) {
    const row = el('button', 'spend-row' + (state.filter.category === name ? ' active' : ''));
    row.type = 'button';
    row.setAttribute('aria-label', `${name} ${yen(amount)}。タップで${name}の記録だけを表示`);

    const top = el('span', 'spend-top');
    const dot = el('i');
    dot.style.setProperty('--c', catColor('expense', name));
    top.append(dot, el('span', 'spend-name', name), el('b', 'spend-amt', yen(amount)));

    const track = el('span', 'spend-track');
    const bar = el('span', 'spend-bar');
    bar.style.width = `${Math.max(2, (amount / max) * 100)}%`;
    track.append(bar);

    const prev = prevTotals.get(name) || 0;
    const diff = amount - prev;
    const delta = !prev ? '先月はなし' : diff === 0 ? '先月と同じ' : `先月より ${diff > 0 ? '+' : '−'}${yen(diff)}`;
    const meta = el('span', 'spend-meta');
    meta.append(el('span', null, `${Math.round((amount / expense) * 100)}%`), el('span', null, delta));

    row.append(top, track, meta);
    row.addEventListener('click', () => {
      setFilter({ type: 'expense', category: state.filter.category === name ? null : name });
      if (state.filter.category) $('.filters').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    list.append(row);
  }
}

// ===== 記録の絞り込み =====
function setFilter(next) {
  state.filter = { ...state.filter, ...next };
  if (state.filter.type === 'income') state.filter.category = null;
  document.querySelectorAll('.spend-row').forEach((r) =>
    r.classList.toggle('active', r.querySelector('.spend-name').textContent === state.filter.category));
  renderFiltered();
}

function matchesFilter(r) {
  const { type, category } = state.filter;
  if (type !== 'all' && r.type !== type) return false;
  if (category && r.category !== category && !r.breakdown?.some((b) => b.category === category)) return false;
  return true;
}

function renderFiltered() {
  const { type, category } = state.filter;
  document.querySelectorAll('.filters [data-filter]').forEach((b) => b.classList.toggle('active', b.dataset.filter === type));
  const chip = $('#catFilter');
  chip.hidden = !category;
  if (category) chip.textContent = `${category}  ×`;

  const shown = state.records.filter(matchesFilter);
  const filtered = type !== 'all' || category;
  $('#count').textContent = !state.records.length ? '' : filtered ? `${shown.length} / ${state.records.length}件` : `${shown.length}件`;
  renderList(shown, filtered && state.records.length > 0);
}

// 金額をくるくる数え上げて表示する
function countUp(node, to, signed = false) {
  const from = Number(node.dataset.v || 0);
  node.dataset.v = to;
  const format = (v) => {
    const n = Math.round(v);
    return (signed && n > 0 ? '+' : '') + (n < 0 ? '−' : '') + yen(n);
  };
  cancelAnimationFrame(node._raf);
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    node.textContent = format(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / 650);
    node.textContent = format(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) node._raf = requestAnimationFrame(step);
  };
  node._raf = requestAnimationFrame(step);
}

function renderList(records, filtered = false) {
  const list = $('#list');
  list.replaceChildren();

  if (!records.length) {
    const empty = el('div', 'empty');
    if (filtered) empty.append(el('b', null, 'NO MATCH'), '条件に合う記録はありません。');
    else empty.append(el('b', null, 'NO RECORDS'), 'この月の記録はまだありません。', el('br'), '下の「手入力」から追加できます。');
    list.append(empty);
    return;
  }

  // 新しい日付が上。同じ日の中では後から入れたものが上
  records.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  const byDay = new Map();
  for (const r of records) {
    if (!byDay.has(r.date)) byDay.set(r.date, []);
    byDay.get(r.date).push(r);
  }

  for (const [date, items] of byDay) {
    const d = new Date(`${date}T00:00:00`);
    const day = el('div', 'day');

    const head = el('div', 'day-head');
    const when = el('span');
    when.append(el('b', null, `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`), `${WEEK[d.getDay()]}曜日`);
    head.append(when);
    const dayExpense = sum(items.filter((r) => r.type === 'expense'));
    if (dayExpense) head.append(el('span', null, `支出 ${yen(dayExpense)}`));

    const rows = el('div', 'rows');
    for (const r of items) rows.append(rowItem(r));

    day.append(head, rows);
    list.append(day);
  }
}

function rowItem(r) {
  const item = el('button', 'row-item');
  item.type = 'button';

  const dot = el('span', 'cat-dot', r.category.slice(0, 1));
  dot.style.setProperty('--c', catColor(r.type, r.category));

  const title = r.store || r.memo || r.category;
  const sub = [title !== r.category ? r.category : '', r.store && r.memo ? r.memo : ''].filter(Boolean).join(' · ');
  const main = el('span', 'row-main');
  main.append(el('span', 'row-title', title));
  if (sub) main.append(el('span', 'row-sub', sub));

  const isIncome = r.type === 'income';
  const amount = el('span', 'row-amt' + (isIncome ? ' income' : ''), (isIncome ? '+' : '−') + yen(r.amount));

  item.append(dot, main, amount);
  item.addEventListener('click', () => openSheet(r));
  return item;
}

// ===== 下から出てくる画面(入力・設定)の開け閉め =====
let panelTimer;
function openPanel(panel) {
  clearTimeout(panelTimer);
  document.querySelectorAll('.sheet').forEach((s) => { if (s !== panel) { s.classList.remove('show'); s.hidden = true; } });
  const backdrop = $('#backdrop');
  panel.hidden = backdrop.hidden = false;
  panel.scrollTop = 0;
  requestAnimationFrame(() => {
    panel.classList.add('show');
    backdrop.classList.add('show');
  });
}

function closePanel() {
  state.scanToken++; // 読み取り中に閉じたら、その結果は使わない
  const panels = document.querySelectorAll('.sheet');
  panels.forEach((s) => s.classList.remove('show'));
  $('#backdrop').classList.remove('show');
  document.activeElement?.blur();
  clearTimeout(panelTimer);
  panelTimer = setTimeout(() => {
    panels.forEach((s) => { s.hidden = true; });
    $('#backdrop').hidden = true;
  }, 340);
}

// ===== 入力シート =====
function setType(type) {
  state.type = type;
  document.querySelectorAll('#sheet .seg button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  $('#storeField').hidden = type === 'income';
  if (!cats(type).some((c) => c.name === state.category)) state.category = cats(type)[0].name;
  renderChips();
  renderBreakdown();
}

function renderChips() {
  const box = $('#chips');
  box.replaceChildren();
  for (const c of cats(state.type)) {
    const chip = el('button', 'chip' + (c.name === state.category ? ' active' : ''));
    chip.type = 'button';
    chip.style.setProperty('--c', c.color);
    chip.append(el('i'), c.name);
    chip.addEventListener('click', () => { state.category = c.name; renderChips(); renderBreakdown(); });
    box.append(chip);
  }
}

function openSheet(record = null) {
  state.editing = record;
  state.pendingImage = null;
  state.breakdown = record?.breakdown || null;
  $('#sheetTitle').textContent = record ? '記録を編集' : '記録する';
  state.category = record ? record.category : EXPENSE_CATS[0].name;
  setType(record ? record.type : 'expense');
  $('#amount').value = record ? record.amount.toLocaleString('ja-JP') : '';
  sizeAmountInput();
  renderBreakdown();
  // 新規のとき：今月を見ていれば今日、別の月を見ていればその月の1日
  $('#date').value = record ? record.date : (isThisMonth() ? ymd(today) : `${ymKey()}-01`);
  $('#store').value = record?.store || '';
  $('#memo').value = record?.memo || '';
  $('#deleteBtn').hidden = !record;
  $('#sheet').classList.remove('busy');
  document.querySelectorAll('#sheet .check').forEach((n) => n.classList.remove('check'));

  $('#receiptBox').hidden = true;
  if (record?.imageId) showSavedImage(record.imageId);

  openPanel($('#sheet'));
}

// 保存ずみの記録のレシート写真を出す
async function showSavedImage(imageId) {
  const blob = await DB.getImage(imageId).catch(() => null);
  if (!blob || state.editing?.imageId !== imageId) return;
  setPreview(blob);
  setReceiptStatus('', 'レシートの写真', '写真をタップすると拡大します');
}

// ===== レシート読み取り =====
function setPreview(blob) {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(blob);
  $('#receiptImg').src = state.previewUrl;
  $('#receiptBox').hidden = false;
}

// mode: 'scanning' 読み取り中 / 'failed' 失敗 / '' ふつう
function setReceiptStatus(mode, title, note, canRescan = false) {
  const box = $('#receiptBox');
  box.classList.toggle('scanning', mode === 'scanning');
  box.classList.toggle('failed', mode === 'failed');
  $('#receiptTitle').textContent = title;
  $('#receiptNote').textContent = note;
  $('#rescanBtn').hidden = !canRescan;
}

function startScan() {
  if (!getPasscode()) {
    openSettings('レシートを読み取るには、まず合言葉を登録してください');
    return;
  }
  openCamera();
}

// 写真ファイルを選ぶ画面を開く
function pickFile() {
  const input = $('#fileInput');
  input.value = '';
  input.click();
}

// ===== カメラ撮影 =====
async function openCamera() {
  const camera = $('#camera');
  camera.classList.remove('no-camera');
  $('#cameraHint').textContent = 'カメラを準備しています…';
  camera.hidden = false;

  if (!navigator.mediaDevices?.getUserMedia) {
    cameraUnavailable('このブラウザではカメラを使えません。「写真を選ぶ」から選んでください');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    if (camera.hidden) { stream.getTracks().forEach((t) => t.stop()); return; } // 準備中に閉じられた
    state.stream = stream;
    const video = $('#cameraVideo');
    video.srcObject = stream;
    await video.play();
    $('#cameraHint').textContent = 'レシート全体が入るように写して、白いボタンで撮影';
  } catch (err) {
    console.warn(err);
    cameraUnavailable(err.name === 'NotAllowedError'
      ? 'カメラの使用が許可されていません。アドレスバー左のアイコンから許可するか、「写真を選ぶ」から選んでください'
      : 'カメラが見つかりませんでした。「写真を選ぶ」から選んでください');
  }
}

function cameraUnavailable(message) {
  $('#camera').classList.add('no-camera');
  $('#cameraHint').textContent = message;
}

function closeCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  $('#cameraVideo').srcObject = null;
  $('#camera').hidden = true;
}

function takePhoto() {
  const video = $('#cameraVideo');
  if (!state.stream || !video.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const flash = $('#cameraFlash');
  flash.classList.remove('on');
  void flash.offsetWidth;
  flash.classList.add('on');
  canvas.toBlob((blob) => {
    closeCamera();
    if (blob) handleReceiptFile(new File([blob], 'receipt.jpg', { type: 'image/jpeg' }));
    else toast('撮影できませんでした');
  }, 'image/jpeg', 0.92);
}

async function handleReceiptFile(file) {
  openSheet(null);
  const token = ++state.scanToken;
  $('#sheetTitle').textContent = 'レシートを確認';
  setPreview(file);
  setReceiptStatus('scanning', '読み取り中…', 'AI がレシートを読んでいます');
  $('#sheet').classList.add('busy');

  let result;
  try {
    result = await Receipt.read(file, getPasscode(), EXPENSE_CATS.map((c) => c.name), ymd(new Date()));
  } catch (err) {
    console.error(err);
    result = { image: null, data: null, error: 'この写真は読み込めませんでした' };
  }
  if (token !== state.scanToken) return; // 途中で閉じられた

  $('#sheet').classList.remove('busy');
  if (result.image) {
    state.pendingImage = result.image;
    setPreview(result.image);
  }
  if (!result.data) {
    setReceiptStatus('failed', result.error, '金額などを手で入れて保存することもできます', true);
    $('#amount').focus();
    return;
  }
  fillFromReceipt(result.data);
}

function fillFromReceipt(data) {
  const sure = data.confidence === 'high';
  const check = (node, needed) => node.classList.toggle('check', needed);

  setType('expense');
  state.category = data.category;
  state.breakdown = data.breakdown;
  renderChips();

  $('#amount').value = data.total > 0 ? data.total.toLocaleString('ja-JP') : '';
  sizeAmountInput();
  check($('#amountField'), !sure || !(data.total > 0));

  // 日付：読めない・未来・1年以上前なら今日を入れて点線で知らせる
  const d = /^\d{4}-\d{2}-\d{2}$/.test(data.date) ? new Date(`${data.date}T00:00:00`) : null;
  const valid = d && !isNaN(d) && d <= new Date() && (new Date() - d) < 366 * 86400000;
  $('#date').value = valid ? data.date : ymd(new Date());
  check($('#date').closest('.field'), !sure || !valid);

  $('#store').value = data.store || '';
  check($('#storeField'), !data.store);

  renderBreakdown();
  const needsCheck = document.querySelector('#sheet .check');
  setReceiptStatus('', '読み取りました',
    needsCheck ? '点線の欄を確かめてから「保存する」を押してください' : '内容を確かめて「保存する」を押してください', true);
}

// ===== 保存・削除 =====
async function save(e) {
  e.preventDefault();
  if ($('#sheet').classList.contains('busy')) return;
  const amount = parseInt($('#amount').value.replace(/\D/g, ''), 10);
  if (!amount) {
    const field = $('#amountField');
    field.classList.remove('shake');
    void field.offsetWidth; // アニメーションをやり直すため
    field.classList.add('shake');
    toast('金額を入力してください');
    return;
  }
  const date = $('#date').value;
  if (!date) { toast('日付を選んでください'); return; }

  const prev = state.editing;
  const now = new Date().toISOString();
  const record = {
    id: prev?.id || newId(),
    type: state.type,
    date,
    amount,
    store: state.type === 'expense' ? $('#store').value.trim() : '',
    category: state.category,
    memo: $('#memo').value.trim(),
    imageId: prev?.imageId || '',
    breakdown: currentBreakdown(amount),
    source: prev?.source || 'manual',
    createdAt: prev?.createdAt || now,
    updatedAt: now,
  };

  try {
    if (state.pendingImage) {
      record.imageId = newId();
      record.source = 'scan';
      await DB.putImage(record.imageId, state.pendingImage);
    }
    await DB.putRecord(record);
  } catch (err) {
    console.error(err);
    toast('保存できませんでした');
    return;
  }

  state.pendingImage = null;
  closePanel();
  // 保存した記録の月を表示する
  const [y, m] = date.split('-').map(Number);
  state.year = y;
  state.month = m - 1;
  await render();
  toast(prev ? '更新しました' : '保存しました');
}

async function removeRecord() {
  const record = state.editing;
  if (!record || !confirm('この記録を削除しますか？')) return;
  try {
    await DB.deleteRecord(record.id);
    if (record.imageId) await DB.deleteImage(record.imageId);
  } catch (err) {
    console.error(err);
    toast('削除できませんでした');
    return;
  }
  closePanel();
  await render();
  toast('削除しました');
}

// 金額欄：数字以外を消して 3 桁ごとにカンマを入れる
function formatAmountInput() {
  const digits = $('#amount').value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 9);
  $('#amount').value = digits ? Number(digits).toLocaleString('ja-JP') : '';
  sizeAmountInput();
  renderBreakdown();
}

// 金額欄の幅を数字の長さに合わせる（¥ マークが数字の横にくっつくように）
function sizeAmountInput() {
  const input = $('#amount');
  input.style.width = `${Math.max(1, input.value.length) * 0.92 + 0.3}ch`;
}

// ===== 設定(中継役の合言葉) =====
const KEY_NAME = 'kakeibo.passcode';
function getPasscode() {
  try { return localStorage.getItem(KEY_NAME) || ''; } catch { return ''; }
}

// ===== 写真の拡大表示 =====
function openViewer() {
  if (!state.previewUrl) return;
  $('#viewerImg').src = state.previewUrl;
  $('#viewer').hidden = false;
}

// ===== レシートのカテゴリ別小計 =====
// 小計の合計がレシートの合計とずれたら、いちばん大きいカテゴリで調整する
function normalizeBreakdown(list, total, mainCategory) {
  const merged = new Map();
  for (const b of list || []) {
    if (b.amount > 0) merged.set(b.category, (merged.get(b.category) || 0) + b.amount);
  }
  const items = [...merged].map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
  if (items.length < 2) return [{ category: mainCategory, amount: total }];
  const diff = total - items.reduce((t, b) => t + b.amount, 0);
  if (items[0].amount + diff <= 0) return [{ category: mainCategory, amount: total }];
  items[0].amount += diff;
  return items;
}

// 入力中の内容から内訳を作る（レシート以外・収入は内訳なし）
function currentBreakdown(amount) {
  if (!state.breakdown || state.type !== 'expense' || !amount) return null;
  return normalizeBreakdown(state.breakdown, amount, state.category);
}

function renderBreakdown() {
  const amount = parseInt($('#amount').value.replace(/\D/g, ''), 10) || 0;
  const items = currentBreakdown(amount);
  const box = $('#breakdownBox');
  box.hidden = !items || items.length < 2;
  if (box.hidden) return;
  const list = $('#breakdownList');
  list.replaceChildren();
  for (const b of items) {
    const row = el('div', 'bd-row');
    const dot = el('i');
    dot.style.setProperty('--c', catColor('expense', b.category));
    row.append(dot, el('span', null, b.category), el('b', null, yen(b.amount)));
    list.append(row);
  }
}

// ===== レシート一覧 =====
function setView(view) {
  state.view = view;
  const home = view === 'home';
  $('#homeView').hidden = !home;
  $('#receiptsView').hidden = home;
  $('#viewLabel').textContent = home ? 'レシート' : 'ホーム';
  $('#iconReceipts').toggleAttribute('hidden', !home);
  $('#iconHome').toggleAttribute('hidden', home);
  window.scrollTo({ top: 0 });
}

function renderReceipts(records) {
  const scanned = records.filter((r) => r.type === 'expense' && r.imageId)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  $('#receiptsSummary').textContent = scanned.length ? `${scanned.length}枚 · ${yen(sum(scanned))}` : '';

  const grid = $('#receiptGrid');
  grid.replaceChildren();
  if (!scanned.length) {
    const empty = el('div', 'empty');
    empty.append(el('b', null, 'NO RECEIPTS'), 'この月に読み取ったレシートはまだありません。', el('br'), '下の SCAN から撮影できます。');
    grid.append(empty);
    return;
  }
  for (const r of scanned) grid.append(receiptCard(r));
}

function receiptCard(r) {
  const d = new Date(`${r.date}T00:00:00`);
  const card = el('button', 'paper');
  card.type = 'button';
  card.append(
    el('span', 'paper-store', r.store || 'お店の名前なし'),
    el('span', 'paper-date', `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} (${WEEK[d.getDay()]})`),
    el('span', 'paper-rule'),
  );
  const lines = r.breakdown?.length ? r.breakdown : [{ category: r.category, amount: r.amount }];
  for (const b of lines) {
    const line = el('span', 'paper-line');
    const dot = el('i');
    dot.style.setProperty('--c', catColor('expense', b.category));
    line.append(dot, el('span', null, b.category), el('b', null, yen(b.amount)));
    card.append(line);
  }
  const total = el('span', 'paper-total');
  total.append(el('span', null, '合計'), el('b', null, yen(r.amount)));
  card.append(el('span', 'paper-rule'), total);
  card.addEventListener('click', () => openSheet(r));
  return card;
}

function shiftMonth(delta) {
  const d = new Date(state.year, state.month + delta, 1);
  state.year = d.getFullYear();
  state.month = d.getMonth();
  render();
}

// ===== ボタンをつなぐ =====
state.scanToken = 0;
$('#prevMonth').addEventListener('click', () => shiftMonth(-1));
$('#nextMonth').addEventListener('click', () => shiftMonth(1));
document.querySelectorAll('.filters [data-filter]').forEach((b) =>
  b.addEventListener('click', () => setFilter({ type: b.dataset.filter })));
$('#catFilter').addEventListener('click', () => setFilter({ category: null }));
$('#viewBtn').addEventListener('click', () => setView(state.view === 'home' ? 'receipts' : 'home'));
$('#monthLabel').addEventListener('click', () => {
  state.year = today.getFullYear();
  state.month = today.getMonth();
  render();
});
$('#addBtn').addEventListener('click', () => {
  openSheet();
  setTimeout(() => $('#amount').focus(), 350);
});
$('#scanBtn').addEventListener('click', startScan);
$('#rescanBtn').addEventListener('click', startScan);
$('#shutterBtn').addEventListener('click', takePhoto);
$('#cameraClose').addEventListener('click', closeCamera);
$('#pickFileBtn').addEventListener('click', () => { closeCamera(); pickFile(); });
$('#fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleReceiptFile(file);
});
$('#closeSheet').addEventListener('click', closePanel);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel));
$('#backdrop').addEventListener('click', closePanel);
$('#sheet').addEventListener('submit', save);
$('#deleteBtn').addEventListener('click', removeRecord);
$('#amount').addEventListener('input', formatAmountInput);
$('#receiptThumb').addEventListener('click', openViewer);
$('#viewer').addEventListener('click', () => { $('#viewer').hidden = true; });
// 点線の欄は、さわったら点線を消す
$('#sheet').addEventListener('input', (e) => e.target.closest('.check')?.classList.remove('check'));
document.querySelectorAll('#sheet .seg button').forEach((b) => b.addEventListener('click', () => setType(b.dataset.type)));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#camera').hidden) closeCamera();
  else if (!$('#viewer').hidden) $('#viewer').hidden = true;
  else if (!$('#backdrop').hidden) closePanel();
});

if (!('indexedDB' in window)) toast('このブラウザでは保存できません');
// 段階2までブラウザに保存していた API キーは、もう使わないので消す(キーは中継役にだけ置く)
try { localStorage.removeItem('kakeibo.apiKey'); } catch { /* 何もしない */ }
// 起動の処理(startup)は、全部のファイルを読み込んだあと settings.js の最後で動かす
