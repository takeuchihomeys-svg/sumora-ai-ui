// scripts/verify-recommend-alt.ts
// 実行: VERIFY_BASE_URL=http://localhost:3000 npx tsx --env-file=.env.local scripts/verify-recommend-alt.ts
//
// 2026-09-20 竹内「物件オススメ置き換える」
//   AIX【物件オススメ】を **本番の経路**（/api/aix/action）で通し、DeepSeek に回した文が
//   出口の決定論（🌟始まり・比較フレーム・締めの差し替え）を通っても崩れないかを見る。
//   書き込みを伴うのでテスト会話「YUMA」だけを使う。
export {};
import { createClient } from "@supabase/supabase-js";
import { extractPhraseShapes } from "../app/lib/phrase-shape";
const BASE = process.env.VERIFY_BASE_URL ?? "https://sumora-ai-ui.vercel.app";
const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"; // YUMA
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const BAD = [
  { label: "🌟で始まっていない", test: (t: string) => !t.trimStart().startsWith("🌟") },
  { label: "お待たせ致しました（禁止語）", test: (t: string) => /お待たせ(?:致しました|しました)/.test(t) },
  { label: "作業メモ・箇条書きの記号", test: (t: string) => /^\s*[-*#]|^\s*⚠|```/m.test(t) },
  { label: "前置き・解説", test: (t: string) => /以下の?とおり|作成しました|承知(?:いたし|し)ました。$/.test(t) },
  { label: "〇〇のプレースホルダが残る", test: (t: string) => /[○〇◯]{2,}/.test(t) },
];

async function loadSent(): Promise<Set<string>> {
  const s = new Set<string>();
  for (let p = 0; ; p++) {
    const { data } = await sb.from("messages").select("text").eq("sender", "staff")
      .gte("created_at", new Date(Date.now() - 365 * 86400_000).toISOString())
      .order("id", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as Array<{ text: string | null }>;
    if (r.length === 0) break;
    for (const m of r) for (const x of extractPhraseShapes(m.text ?? "")) s.add(x.predicate);
    if (r.length < 1000) break;
    if (p > 14) break;
  }
  return s;
}

async function main() {
  const sent = await loadSent();
  console.log(`── 実送信365日の言い回し ${sent.size}種類を物差しにする`);
  console.log(`── 生成先: ${BASE}  会話: YUMA\n`);

  const { data: conv } = await sb.from("conversations").select("customer_name, account").eq("id", CONV).maybeSingle();
  const c = conv as { customer_name: string | null; account: string | null } | null;

  // 物件資料の画像（実物）を3枚
  const { data } = await sb.from("messages").select("image_url")
    .eq("sender", "staff").not("image_url", "is", null)
    .gte("created_at", new Date(Date.now() - 25 * 86400_000).toISOString())
    .order("created_at", { ascending: false }).limit(40);
  const urls: string[] = [];
  for (const r of (data ?? []) as Array<{ image_url: string }>) {
    const raw = r.image_url.trim();
    const u = raw.startsWith("[") ? (() => { try { return (JSON.parse(raw) as string[])[0]; } catch { return ""; } })() : raw;
    if (u?.startsWith("http") && !urls.includes(u)) urls.push(u);
    if (urls.length >= 3) break;
  }

  let ng = 0;
  for (let i = 0; i < urls.length; i++) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/aix/action`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "property_recommendation", account: c?.account ?? "sumora",
        conversation_id: CONV, customer_name: c?.customer_name ?? "YUMA",
        image_url: urls[i],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const raw = await res.text();
    console.log(`═══ ${i + 1}枚目（${((Date.now() - t0) / 1000).toFixed(1)}秒）═══`);
    if (!res.ok) { console.log(`  ⚠ HTTP ${res.status}: ${raw.slice(0, 200)}\n`); ng++; continue; }
    const j = JSON.parse(raw) as Record<string, unknown>;
    const text = String(j.message_text ?? "");
    console.log(text.split("\n").map((l) => `    ${l}`).join("\n"));

    for (const b of BAD) if (b.test(text)) { console.log(`  ⚠ ${b.label}`); ng++; }
    const unseen = extractPhraseShapes(text).filter((x) => !sent.has(x.predicate));
    console.log(`  ${unseen.length <= 2 ? "✅" : "⚠"} 実送信0件の言い回し: ${unseen.length}件`);
    for (const u of unseen.slice(0, 3)) console.log(`     0件: ${JSON.stringify(u.clause.slice(0, 54))}`);
    console.log("");
  }
  console.log(ng === 0 ? "✅ 崩れなし" : `⚠ ${ng}件 引っかかりあり`);
}
main().catch((e) => { console.error(e); process.exit(1); });
