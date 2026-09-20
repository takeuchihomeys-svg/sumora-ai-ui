// scripts/verify-deepseek-vision.ts
// 実行: npx tsx --env-file=.env.local scripts/verify-deepseek-vision.ts
//
// 2026-09-20 竹内「その画像の読み込みに限定して deepseek V4.1 Flash のモデルを使う」
//   → **本当に画像を読めるのか**を実物のスタッフ送信画像で1回試す（設計知見「実データで確かめる」）。
//   現状 llm-alt-provider は「画像（Vision）と streaming は対象外」と明示的に除外しているので、
//   使うなら新しい経路が要る。その前に対応可否を確かめる。
// 読み取りのみ（DB は読むだけ・API は数回呼ぶ）。
export {};
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const KEY = (process.env.DEEPSEEK_API_KEY ?? "").trim();
const ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
/** 試すモデル名（どれが通るか分からないので順に試す） */
const MODELS = ["deepseek-v4.1-flash", "deepseek-v4-1-flash", "deepseek-flash", "deepseek-vl2", "deepseek-chat"];

const SYSTEM = `画像から物件情報を抽出してください。JSONのみ返答（説明文・コードブロック・前置き一切不要）：
{"property_name":"","room_number":"","rent":0,"is_property":true}
- property_name: マンション名のみ（号室は含めない）。読み取れなければ""
- room_number: 号室番号のみ（例: 502）。読み取れなければ""
- rent: 月額家賃（整数）。なければ0
- is_property: 物件の資料・マイソク・室内写真なら true、それ以外（見積書・書類・スクショ）なら false`;

async function tryModel(model: string, imageUrl: string): Promise<{ ok: boolean; body: string; ms: number }> {
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: [
            { type: "text", text: "この画像から物件情報を抽出し、JSONのみ返答してください。" },
            { type: "image_url", image_url: { url: imageUrl } },
          ] },
        ],
        max_tokens: 200, temperature: 0,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const raw = await res.text();
    return { ok: res.ok, body: raw, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, body: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
  }
}

async function main() {
  if (!KEY) { console.error("DEEPSEEK_API_KEY が設定されていません"); process.exit(1); }

  // 実物: スタッフが送った画像（物件資料の可能性が高い＝物件名の本文の直前後）
  const { data } = await sb.from("messages").select("conversation_id, image_url, created_at")
    .eq("sender", "staff").not("image_url", "is", null)
    .gte("created_at", new Date(Date.now() - 20 * 86400_000).toISOString())
    .order("created_at", { ascending: false }).limit(3);
  const imgs = (data ?? []) as Array<{ image_url: string; created_at: string }>;
  if (imgs.length === 0) { console.log("画像が見つからず"); return; }
  const img = imgs[0].image_url;
  console.log(`── 試す画像: ${String(imgs[0].created_at).slice(0, 16)} のスタッフ送信画像\n`);

  console.log(`=== ① DeepSeek が画像を受け付けるか（モデル名を順に試す）===`);
  let worked: string | null = null;
  for (const m of MODELS) {
    const r = await tryModel(m, img);
    const head = r.body.replace(/\s+/g, " ").slice(0, 130);
    console.log(`  ${m.padEnd(22)} ${r.ok ? "✅ 200" : "⚠ NG "} ${String(r.ms).padStart(6)}ms  ${head}`);
    if (r.ok && !worked) worked = m;
  }
  if (!worked) {
    console.log(`\n  ⚠ **DeepSeek では画像を読めなかった**（上のエラーを参照）`);
    console.log(`     → 画像の読み取りは今まで通り Claude Vision を使うか、対応モデル名を確認する必要がある`);
    return;
  }
  console.log(`\n  ✅ 200 が返るモデル: ${worked}（※200 が返る＝読めた ではない）`);

  // ── ② 中身を見る ＋ 画像なしと比べる（画像を無視していないか）──
  //   200 でも画像を無視して答えているなら、画像を渡さない時と同じ答えになる。ここが決定的。
  const pick = (raw: string) => {
    try { return String((JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").trim(); }
    catch { return raw.slice(0, 160); }
  };
  const withImg = await tryModel(worked, img);
  const noImgRes = await fetch(ENDPOINT, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: worked, messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: [{ type: "text", text: "この画像から物件情報を抽出し、JSONのみ返答してください。" }] },
    ], max_tokens: 200, temperature: 0 }),
    signal: AbortSignal.timeout(90_000),
  });
  const noImg = await noImgRes.text();

  console.log(`\n=== ② 画像あり / 画像なし を比べる（決定的な検査）===`);
  console.log(`  画像あり: ${pick(withImg.body)}`);
  console.log(`  画像なし: ${pick(noImg)}`);
  const same = pick(withImg.body) === pick(noImg);
  console.log(`\n  ${same ? "⚠ **同じ答え＝画像を読んでいない**" : "✅ 違う答え＝画像を読んでいる可能性あり"}`);

  // ── ③ Claude Vision と比べる（正解の物差し）──
  const anthKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (anthKey) {
    try {
      const b = await (await fetch(img)).arrayBuffer();
      const b64 = Buffer.from(b).toString("base64");
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 200, system: SYSTEM, messages: [
          { role: "user", content: [
            { type: "text", text: "この画像から物件情報を抽出し、JSONのみ返答してください。" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
          ] },
        ] }),
        signal: AbortSignal.timeout(90_000),
      });
      const raw = await r.text();
      const txt = (() => { try { return String((JSON.parse(raw) as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "").replace(/\s+/g, " ").trim(); } catch { return raw.slice(0, 200); } })();
      console.log(`\n=== ③ Claude Vision（今使っている方）の答え ===`);
      console.log(`  ${txt}`);
    } catch (e) { console.log(`\n=== ③ Claude Vision: ⚠ ${e instanceof Error ? e.message : String(e)}`); }
  }
  console.log(`\n  画像URL: ${img.slice(0, 100)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
