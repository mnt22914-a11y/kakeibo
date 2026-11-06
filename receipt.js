// レシート読み取り係。写真を小さくして中継役(Supabase)に送り、店名・日付・合計・カテゴリ・内訳を受け取る。
// AI への指示や API キーは中継役(supabase/functions/read-receipt/index.ts)の側にある。
'use strict';

const Receipt = (() => {
  const MAX_SIDE = 1600; // 写真の長い辺をこのピクセル数まで縮める

  // 写真を縮小して JPEG にする
  async function shrink(file) {
    const bitmap = await createImageBitmap(file); // スマホ写真の向きも自動で直る
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を変換できませんでした'))), 'image/jpeg', 0.85));
  }

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // 中継役が返すエラーの種類 → 日本語の説明
  const MESSAGES = {
    passcode: '合言葉が違います。設定を確認してください',
    not_configured: '中継役の準備がまだです(Supabase の Secrets を確認)',
    api_key: '中継役に預けた API キーが正しくありません',
    credit: 'API の残高が足りません。Anthropic のサイトでチャージしてください',
    busy: '混み合っています。少し待ってからもう一度どうぞ',
    bad_input: 'この写真は送れませんでした',
    unreadable: 'うまく読めませんでした',
    upstream: 'AI 側の調子が悪いようです。少し待ってからもう一度どうぞ',
  };

  // file: 撮影した写真 → { image: 縮小した写真, data: 読み取り結果 | null, error: 説明 | null }
  async function read(file, passcode, categories, today) {
    const image = await shrink(file);
    if (!RELAY_URL) return { image, data: null, error: '中継役の URL がまだ設定されていません(config.js)' };
    try {
      const res = await fetch(RELAY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-passcode': passcode },
        body: JSON.stringify({ image: await toBase64(image), categories, today }),
      });
      const body = await res.json().catch(() => null);
      if (!body?.ok) return { image, data: null, error: MESSAGES[body?.error] || 'うまく読めませんでした' };
      if (!body.data.is_receipt) return { image, data: null, error: 'レシートが見つかりませんでした' };
      return { image, data: body.data, error: null };
    } catch (err) {
      console.error(err);
      return { image, data: null, error: 'インターネットにつながっていないようです' };
    }
  }

  return { read };
})();
