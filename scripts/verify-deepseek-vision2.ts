// scripts/verify-deepseek-vision2.ts
// 実行: npx tsx --env-file=.env.local scripts/verify-deepseek-vision2.ts
//
// 2026-09-20 竹内「DeepSheekV4.1は画像よめる」
//   1回目の検証（verify-deepseek-vision.ts）は浅かった。渡し方を変えて確かめ直す:
//     ・モデル: deepseek-flash / deepseek-v4-pro の両方
//     ・画像: URL 形式 と base64（data URL）形式 の両方
//     ・**決定的な検査 = usage.prompt_tokens**（画像を読んでいれば1,000超・無視すれば数十）
//     ・finish_reason と応答全体を出す（空応答の理由を見る）
//   Azure AI Foundry 経由（AZURE_AI_ENDPOINT / AZURE_AI_MODEL）が設定されていればそちらも試す。
export {};
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const KEY = (process.env.DEEPSEEK_API_KEY ?? "").trim();
const OFFICIAL = "https://api.deepseek.com/v1/chat/completions";
const AZ_EP = (process.env.AZURE_AI_ENDPOINT ?? "").trim();
const AZ_KEY = (process.env.AZURE_AI_KEY ?? "").trim();
const AZ_MODEL = (process.env.AZURE_AI_MODEL ?? "").trim();

const SYSTEM = `画像から物件情報を抽出してください。JSONのみ返答：
{"property_name":"","room_number":""}`;
const ASK = "この画像から物件名と号室を読み取り、JSONのみ返答してください。";

type Res = { label: string; status: number | string; promptTok: number; completionTok: number; finish: string; content: string; err: string };

async function call(label: string, endpoint: string, headers: Record<string, string>, body: unknown): Promise<Res> {
  try {
    const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const raw = await r.text();
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(raw) as Record<string, unknown>; } catch { return { label, status: r.status, promptTok: 0, completionTok: 0, finish: "-", content: "", err: raw.slice(0, 160) }; }
    const ch = (j.choices as Array<{ message?: { content?: string }; finish_reason?: string }> | undefined)?.[0];
    const u = j.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const e = j.error as { message?: string } | undefined;
    return {
      label, status: r.status,
      promptTok: u?.prompt_tokens ?? 0, completionTok: u?.completion_tokens ?? 0,
      finish: ch?.finish_reason ?? "-", content: String(ch?.message?.content ?? "").replace(/\s+/g, " ").trim(),
      err: e?.message ?? "",
    };
  } catch (e) { return { label, status: "例外", promptTok: 0, completionTok: 0, finish: "-", content: "", err: e instanceof Error ? e.message : String(e) }; }
}

const msgUrl = (url: string) => [
  { role: "system", content: SYSTEM },
  { role: "user", content: [{ type: "text", text: ASK }, { type: "image_url", image_url: { url } }] },
];
const msgNoImg = () => [
  { role: "system", content: SYSTEM },
  { role: "user", content: [{ type: "text", text: ASK }] },
];

async function main() {
  const { data } = await sb.from("messages").select("image_url, created_at")
    .eq("sender", "staff").not("image_url", "is", null)
    .gte("created_at", new Date(Date.now() - 20 * 86400_000).toISOString())
    .order("created_at", { ascending: false }).limit(1);
  const img = ((data ?? []) as Array<{ image_url: string }>)[0]?.image_url;
  if (!img) { console.log("画像が見つからず"); return; }
  const buf = await (await fetch(img)).arrayBuffer();
  const dataUrl = `data:image/jpeg;base64,${Buffer.from(buf).toString("base64")}`;
  console.log(`── 画像: ${Math.round(buf.byteLength / 1024)}KB\n`);

  const out: Res[] = [];
  const dsHeaders = { Authorization: `Bearer ${KEY}` };
  for (const model of ["deepseek-flash", "deepseek-v4-pro"]) {
    out.push(await call(`公式 ${model} / 画像URL`, OFFICIAL, dsHeaders, { model, messages: msgUrl(img), max_tokens: 200, temperature: 0 }));
    out.push(await call(`公式 ${model} / base64`, OFFICIAL, dsHeaders, { model, messages: msgUrl(dataUrl), max_tokens: 200, temperature: 0 }));
    out.push(await call(`公式 ${model} / 画像なし`, OFFICIAL, dsHeaders, { model, messages: msgNoImg(), max_tokens: 200, temperature: 0 }));
  }
  if (AZ_EP && AZ_KEY && AZ_MODEL) {
    const ep = `${AZ_EP.replace(/\/$/, "")}/chat/completions?api-version=2024-05-01-preview`;
    out.push(await call(`Azure ${AZ_MODEL} / base64`, ep, { "api-key": AZ_KEY }, { model: AZ_MODEL, messages: msgUrl(dataUrl), max_tokens: 200, temperature: 0 }));
    out.push(await call(`Azure ${AZ_MODEL} / 画像なし`, ep, { "api-key": AZ_KEY }, { model: AZ_MODEL, messages: msgNoImg(), max_tokens: 200, temperature: 0 }));
  } else {
    console.log(`  ※ Azure の設定（AZURE_AI_ENDPOINT / AZURE_AI_KEY / AZURE_AI_MODEL）はローカルに無いので試せない\n`);
  }

  console.log(`${"".padEnd(30)} ${"状態".padStart(5)} ${"入力tok".padStart(8)} ${"出力tok".padStart(7)} ${"終了".padStart(10)}  応答`);
  for (const r of out) {
    console.log(`${r.label.padEnd(30)} ${String(r.status).padStart(5)} ${String(r.promptTok).padStart(8)} ${String(r.completionTok).padStart(7)} ${r.finish.padStart(10)}  ${(r.content || r.err).slice(0, 70)}`);
  }
  console.log(`\n  ★ 入力tok が「画像なし」と同じくらいなら**画像を読んでいない**（画像を読めば1,000超になる）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
