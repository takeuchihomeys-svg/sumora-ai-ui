// scripts/audit-estimate-cover.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-estimate-cover.ts
//
// 2026-09-20 竹内（H さん事例）の検証中に見つけた2つ目の崩れ:
//   AIX【見積書送る】の2通目（カバーレター）に、**別の物件の金額文がそのまま写っていた**
//     今回の物件＝ハイツカトレア B なのに「【プレサンス阿倍野松崎805号室】初期費用さらに
//     🌟68,000円割引させて頂き／初期費用：152,000円」が入る（手本の中身を写している）。
//   → カバーレターに金額・物件名を書いてよいのかを**実送信で線を引く**。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
import { stripEstimateAmountBlock } from "../app/lib/estimate-cover";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** カバーレター相当＝見積書に添える案内文 */
const COVER_RE = /御見積書|お見積書/;
const AMOUNT_RE = /初期費用[：:]\s*[0-9０-９,，]+\s*円|[0-9０-９,，]+\s*円\s*割引させて頂き|一般的な不動産業者より/;
const BRACKET_RE = /【[^】]+】/;

async function main() {
  const rows: Array<{ text: string; created_at: string }> = [];
  for (let page = 0; ; page++) {
    const { data } = await sb.from("messages").select("text, created_at").eq("sender", "staff")
      .gte("created_at", new Date(Date.now() - 365 * 86400_000).toISOString())
      .order("created_at", { ascending: false }).range(page * 1000, page * 1000 + 999);
    const r = (data ?? []) as Array<{ text: string | null; created_at: string }>;
    if (r.length === 0) break;
    for (const x of r) if (x.text) rows.push({ text: x.text, created_at: x.created_at });
    if (r.length < 1000) break;
    if (page > 14) break;
  }
  const covers = rows.filter((r) => COVER_RE.test(r.text));
  console.log(`=== 実送信365日 ${rows.length}通 / 「御見積書・お見積書」を含む ${covers.length}通 ===\n`);

  // 金額文そのもの（1通目）は除く＝「初期費用：」で始まる形は金額文なのでカバーレターではない
  const pureCovers = covers.filter((r) => !/^\s*[①-⑨0-9.]*【[^】]+】\s*$/m.test(r.text.split("\n")[0] ?? ""));
  const withAmount = pureCovers.filter((r) => AMOUNT_RE.test(r.text));
  const withBracket = pureCovers.filter((r) => BRACKET_RE.test(r.text));
  console.log(`--- カバーレター（金額文の見出しで始まらない）${pureCovers.length}通 ---`);
  console.log(`  金額（初期費用：〇円／〇円割引させて頂き／一般的な不動産業者より）を含む  ${withAmount.length}通 (${Math.round(100 * withAmount.length / Math.max(pureCovers.length, 1))}%)`);
  console.log(`  【物件名】を含む                                                        ${withBracket.length}通 (${Math.round(100 * withBracket.length / Math.max(pureCovers.length, 1))}%)`);

  console.log(`\n--- 金額を含むカバーレターを全部読む（${withAmount.length}通）---`);
  for (const r of withAmount.slice(0, 25)) {
    console.log(`\n[${String(r.created_at).slice(0, 16)}]`);
    console.log(r.text.split("\n").map((l) => `    ${l}`).join("\n"));
  }
  if (withAmount.length > 25) console.log(`\n  …ほか ${withAmount.length - 25}通`);

  // ── 出口の決定論を全件に当てて、誤削除0かを確かめる ──
  console.log(`\n=== stripEstimateAmountBlock を実送信のカバーレター ${pureCovers.length}通に当てる ===`);
  const changed: Array<{ at: string; before: string; removed: string[] }> = [];
  for (const r of pureCovers) {
    const { removed } = stripEstimateAmountBlock(r.text);
    if (removed.length > 0) changed.push({ at: String(r.created_at).slice(0, 16), before: r.text, removed });
  }
  console.log(`  変わらない ${pureCovers.length - changed.length}通 / **落とした行がある ${changed.length}通**\n`);
  console.log(`--- 落とした通を全部読む（1通でも本物の文を消していたら線を引き直す）---`);
  for (const c of changed) {
    console.log(`\n[${c.at}] 落とした行: ${c.removed.map((x) => JSON.stringify(x)).join(" / ")}`);
    console.log(c.before.split("\n").map((l) => `    ${c.removed.includes(l.trim()) ? "✂ " : "  "}${l}`).join("\n"));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
