// scripts/audit-vision-swap.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-vision-swap.ts [--n=8]
//
// 2026-09-20 竹内「AIXの見積書や、物件オススメの画像読み取りの部分 deepseek V4.1 に置き換えても
//   問題ないかテストして調査おねがい」
//
// **同じ画像**を Claude Sonnet5（今）と DeepSeek-V4.1-Flash に通して、
// 抽出結果が一致するかを1項目ずつ比べる。見積書は**数値の正確さが命**なので、
// 「だいたい合っている」では足りない（金額が1桁違えばお客様に誤った金額が届く）。
// 読み取りのみ。
export {};
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const N = Number((process.argv.find((a) => a.startsWith("--n=")) ?? "--n=8").split("=")[1]);
const ANTH = (process.env.ANTHROPIC_API_KEY ?? "").trim();
const DSK = (process.env.DEEPSEEK_API_KEY ?? "").trim();

// aix/action/route.ts の見積書OCR と同じ system（そのまま使う＝本番と同じ条件で比べる）
const OCR_SYSTEM = `以下の画像から初期費用情報を抽出してください。JSON形式のみ返答（説明文・コードブロック・前置き・後置き一切不要）：
{"property_name":"","room_number":"","rent":0,"management_fee":0,"total":0,"discount":0,"commission":0,"commission_tax":0}

- property_name: マンション名のみ（号室は含めない）。読み取れなければ""
- room_number: 号室番号のみ（例: 502）。読み取れなければ""
- rent: 月額家賃（整数。円・¥・カンマ除く。共益費・管理費は含めない）。なければ0
- management_fee: 共益費または管理費（月額・整数）。なければ0
- total: 初期費用合計（割引後・整数）。なければ0
- discount: 割引額（整数）。なければ0
- commission: 仲介手数料税抜（整数）。なければ0
- commission_tax: 仲介手数料消費税（整数）。なければ0`;

type Est = Record<string, string | number>;
const pickJson = (s: string): Est | null => {
  const b = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = (b ? b[1] : s).trim();
  const m = body.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Est; } catch { return null; }
};

async function claude(url: string): Promise<{ est: Est | null; inTok: number; outTok: number; ms: number }> {
  const t0 = Date.now();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTH, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 500, system: OCR_SYSTEM, thinking: { type: "disabled" },
      messages: [{ role: "user", content: [
        { type: "text", text: "画像から指定の項目を抽出し、JSONのみ返答してください。" },
        { type: "image", source: { type: "url", url } },
      ] }] }),
    signal: AbortSignal.timeout(120_000),
  });
  const j = await r.json() as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number } };
  const txt = j.content?.find((b) => b.type === "text")?.text ?? "";
  return { est: pickJson(txt), inTok: j.usage?.input_tokens ?? 0, outTok: j.usage?.output_tokens ?? 0, ms: Date.now() - t0 };
}

async function deepseek(url: string): Promise<{ est: Est | null; inTok: number; outTok: number; ms: number }> {
  const t0 = Date.now();
  const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${DSK}` },
    body: JSON.stringify({ model: "deepseek-flash", max_tokens: 8000,
      messages: [{ role: "user", content: [
        { type: "text", text: `${OCR_SYSTEM}\n\n画像から指定の項目を抽出し、JSONのみ返答してください。` },
        { type: "image_url", image_url: { url } },
      ] }] }),
    signal: AbortSignal.timeout(180_000),
  });
  const j = await r.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } };
  return { est: pickJson(String(j.choices?.[0]?.message?.content ?? "")), inTok: j.usage?.prompt_tokens ?? 0, outTok: j.usage?.completion_tokens ?? 0, ms: Date.now() - t0 };
}

const KEYS = ["property_name", "room_number", "rent", "management_fee", "total", "discount", "commission", "commission_tax"];
const norm = (v: unknown) => typeof v === "number" ? String(v) : String(v ?? "").trim();

async function main() {
  // 見積書の画像＝「初期費用：」の金額文の直前に送られた画像
  const { data: texts } = await sb.from("messages").select("conversation_id, created_at")
    .eq("sender", "staff").like("text", "%初期費用：%")
    .gte("created_at", new Date(Date.now() - 60 * 86400_000).toISOString())
    .order("created_at", { ascending: false }).limit(60);
  const urls: string[] = [];
  for (const t of (texts ?? []) as Array<{ conversation_id: string; created_at: string }>) {
    const at = Date.parse(t.created_at);
    const { data: im } = await sb.from("messages").select("image_url")
      .eq("conversation_id", t.conversation_id).eq("sender", "staff").not("image_url", "is", null)
      .gte("created_at", new Date(at - 5 * 60_000).toISOString())
      .lte("created_at", new Date(at + 60_000).toISOString()).limit(1);
    const raw = ((im ?? []) as Array<{ image_url: string }>)[0]?.image_url;
    if (!raw) continue;
    const u = raw.trim().startsWith("[") ? (() => { try { return (JSON.parse(raw) as string[])[0]; } catch { return ""; } })() : raw;
    if (u?.startsWith("http") && !urls.includes(u)) urls.push(u);
    if (urls.length >= N) break;
  }
  console.log(`=== 見積書の画像 ${urls.length}枚で Claude Sonnet5 と DeepSeek-V4.1-Flash を比べる ===\n`);

  let same = 0, diff = 0, cFail = 0, dFail = 0;
  let cIn = 0, cOut = 0, dIn = 0, dOut = 0, cMs = 0, dMs = 0;
  const mismatches: Array<{ i: number; key: string; c: string; d: string }> = [];

  // ⚠ 2026-09-20: 最初 8枚で比べたら 63% しか一致せず「置き換えられない」と読んだが、
  //   食い違った2枚を**目で見たら物件資料（マイソク）**で、見積書ではなかった。
  //   しかも片方は DeepSeek の方が正しかった（画像の「保証会社…55,000円」＝保証料を
  //   Claude が仲介手数料と誤読／DeepSeek は 0）。
  //   → **見積書だけで比べる**。見分けは「初期費用の合計が読めるか」（物件資料には無い）。
  let skipped = 0;
  for (let i = 0; i < urls.length; i++) {
    const [c, d] = await Promise.all([claude(urls[i]), deepseek(urls[i])]);
    const totalC = Number(c.est?.total ?? 0), totalD = Number(d.est?.total ?? 0);
    if (!(totalC > 0 || totalD > 0)) {
      skipped++;
      console.log(`  ${i + 1}. －見積書ではない（初期費用の合計が無い＝物件資料）  ${c.est?.property_name ?? ""}`);
      continue;
    }
    cIn += c.inTok; cOut += c.outTok; dIn += d.inTok; dOut += d.outTok; cMs += c.ms; dMs += d.ms;
    if (!c.est) cFail++;
    if (!d.est) dFail++;
    if (!c.est || !d.est) { console.log(`  ${i + 1}. ⚠ 読めず（Claude ${c.est ? "○" : "×"} / DeepSeek ${d.est ? "○" : "×"}）`); continue; }
    const bad = KEYS.filter((k) => norm(c.est![k]) !== norm(d.est![k]));
    if (bad.length === 0) { same++; console.log(`  ${i + 1}. ✅ 全項目一致  ${c.est.property_name} ${c.est.room_number} / 合計${c.est.total}`); }
    else {
      diff++;
      console.log(`  ${i + 1}. ⚠ ${bad.length}項目 違う  ${c.est.property_name} ${c.est.room_number}`);
      console.log(`        画像: ${urls[i]}`);
      for (const k of bad) { console.log(`        ${k.padEnd(16)} Claude=${norm(c.est[k]).padEnd(14)} DeepSeek=${norm(d.est[k])}`); mismatches.push({ i: i + 1, key: k, c: norm(c.est[k]), d: norm(d.est[k]) }); }
    }
  }

  const n = same + diff;
  console.log(`\n--- まとめ（${urls.length}枚のうち見積書 ${n}枚・物件資料 ${skipped}枚は対象外）---`);
  console.log(`  全項目一致        ${same}枚 (${Math.round(100 * same / Math.max(n, 1))}%)`);
  console.log(`  どこか違う        ${diff}枚`);
  console.log(`  読めず            Claude ${cFail}枚 / DeepSeek ${dFail}枚`);
  console.log(`\n  速度   Claude ${(cMs / n / 1000).toFixed(1)}秒 / DeepSeek ${(dMs / n / 1000).toFixed(1)}秒`);
  const cost = (i: number, o: number, pi: number, po: number) => (i * pi + o * po) / 1e6;
  console.log(`  1枚費用 Claude $${(cost(cIn, cOut, 3, 15) / n).toFixed(5)} / DeepSeek $${(cost(dIn, dOut, 0.30, 1.20) / n).toFixed(5)}`);
  console.log(`  トークン Claude 入${Math.round(cIn / n)}/出${Math.round(cOut / n)} / DeepSeek 入${Math.round(dIn / n)}/出${Math.round(dOut / n)}`);
  if (mismatches.length > 0) {
    console.log(`\n--- 違った項目の内訳 ---`);
    const byKey = new Map<string, number>();
    for (const m of mismatches) byKey.set(m.key, (byKey.get(m.key) ?? 0) + 1);
    for (const [k, v] of [...byKey.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${v}件`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
