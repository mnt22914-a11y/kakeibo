// レシート読み取りの中継役(Supabase Edge Function)。
// アプリから「合言葉」と写真を受け取り、ここに預けた API キーで Claude に読み取りを頼んで結果を返す。
// API キーはここ(Supabase の Secrets)にだけあり、アプリやスマホには入らない。
//
// Supabase の Secrets に入れるもの:
//   ANTHROPIC_API_KEY  … Anthropic で発行した API キー(sk-ant-...)
//   APP_PASSCODE       … アプリの設定画面に入れる合言葉(自分で決める。16 文字以上がおすすめ)
import Anthropic from "npm:@anthropic-ai/sdk@1.0.0";

const MODEL = "claude-haiku-5-5"; // 精度が足りなければ "claude-sonnet-5-5"(料金は約20倍)
const MAX_IMAGE_CHARS = 8_000_000; // 写真の大きさの上限(アプリ側で縮めてから送るので普段は 1MB 未満)

// このアプリ以外のページからは呼べないようにする(本当の鍵は合言葉)
const ALLOWED_ORIGINS = [
  "https://mnt22914-a11y.github.io",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
];

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-app-passcode, authorization, apikey, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function reply(origin: string | null, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "content-type": "application/json; charset=utf-8" },
  });
}

// 合言葉を、かかる時間で中身が推測されない方法で比べる
function samePasscode(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function instructions(categories: string[], today: string): string {
  return `この画像は日本の買い物のレシートです。次のルールで読み取ってください。

- is_receipt: レシートや領収書が写っていれば true。違う画像なら false にして、ほかは空文字や 0 でよい
- store: お店の名前(チェーン名＋店舗名が分かればそれも)。分からなければ空文字
- date: 購入日を YYYY-MM-DD で。和暦(令和8年=2026年)や「26/11/05」のような 2 桁の年も西暦に直す。読めなければ空文字。今日は ${today}
- total: 税込の支払い合計(「合計」「お買上計」「ご請求額」など)を円の整数で。「お預り」「お釣り」「小計」は使わない。ポイントや値引きがあれば値引き後の支払額
- breakdown: 買った品目を次のカテゴリに分け、カテゴリごとに金額を足した小計の一覧: ${categories.join(" / ")}。外税・値引き・割引はそれぞれのカテゴリに振り分け、小計を全部足すと total とぴったり同じになるようにする。品目が読めなければ category 1 つに total 全額
- category: breakdown の中でいちばん金額が大きいカテゴリ。迷ったら「その他」
- confidence: 合計金額と日付をはっきり読めたら high、一部あやしければ medium、ほとんど読めなければ low`;
}

function schema(categories: string[]) {
  return {
    type: "object",
    properties: {
      is_receipt: { type: "boolean" },
      store: { type: "string" },
      date: { type: "string" },
      total: { type: "integer" },
      breakdown: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: categories },
            amount: { type: "integer" },
          },
          required: ["category", "amount"],
          additionalProperties: false,
        },
      },
      category: { type: "string", enum: categories },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["is_receipt", "store", "date", "total", "breakdown", "category", "confidence"],
    additionalProperties: false,
  };
}

// 受け取った中身が正しい形かを確かめる(おかしなものは AI に送らない)
function parseInput(body: unknown): { image: string; categories: string[]; today: string } | null {
  if (!body || typeof body !== "object") return null;
  const { image, categories, today } = body as Record<string, unknown>;
  if (typeof image !== "string" || !image || image.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/=]+$/.test(image)) return null;
  if (!Array.isArray(categories) || categories.length < 1 || categories.length > 30) return null;
  if (!categories.every((c) => typeof c === "string" && c.length >= 1 && c.length <= 20)) return null;
  if (new Set(categories).size !== categories.length) return null;
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  return { image, categories, today };
}

export async function handle(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return reply(origin, 405, { ok: false, error: "method" });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  const passcode = Deno.env.get("APP_PASSCODE") ?? "";
  if (!apiKey || !passcode) return reply(origin, 500, { ok: false, error: "not_configured" });
  if (!samePasscode(req.headers.get("x-app-passcode") ?? "", passcode)) {
    return reply(origin, 401, { ok: false, error: "passcode" });
  }

  let input;
  try {
    input = parseInput(await req.json());
  } catch {
    input = null;
  }
  if (!input) return reply(origin, 400, { ok: false, error: "bad_input" });

  const client = new Anthropic({ apiKey, maxRetries: 1 });
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low", format: { type: "json_schema", schema: schema(input.categories) } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: input.image } },
          { type: "text", text: instructions(input.categories, input.today) },
        ],
      }],
    });
    if (response.stop_reason !== "end_turn") {
      console.warn("stop_reason", response.stop_reason, response.stop_details);
      return reply(origin, 200, { ok: false, error: "unreadable" });
    }
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    return reply(origin, 200, { ok: true, data: JSON.parse(text) });
  } catch (err) {
    console.error(err);
    // くわしいものから順に見分ける
    if (err instanceof Anthropic.AuthenticationError) return reply(origin, 502, { ok: false, error: "api_key" });
    if (err instanceof Anthropic.RateLimitError) return reply(origin, 503, { ok: false, error: "busy" });
    if (err instanceof Anthropic.APIConnectionError) return reply(origin, 502, { ok: false, error: "upstream" });
    if (err instanceof Anthropic.InternalServerError) return reply(origin, 503, { ok: false, error: "busy" });
    if (err instanceof Anthropic.APIError && (err.status === 402 || /credit balance/i.test(err.message))) {
      return reply(origin, 502, { ok: false, error: "credit" });
    }
    return reply(origin, 502, { ok: false, error: "upstream" });
  }
}

Deno.serve(handle);
