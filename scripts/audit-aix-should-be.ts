// scripts/audit-aix-should-be.ts — 「本来の AIX」の当てはめ（app/lib/aix-should-be.ts）の正解率を、竹内さん自身の AIX の送信で測る（DB は読むだけ・LLM なし・送らない）
//   ラベル＝竹内さんが押したボタン×ピッカー（catalogKeyOfPress）。ピッカーの正解率は「押した記録にピッカーがある」送信だけ（文からの推定は当てはめと同じ読みなので外す）。
//   あわせて、手打ちの文（竹内さん・従業員）と従業員の AIX の送信の当てはめの数（押し間違いの候補）を出す。
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-should-be.ts [--days=150] [--dump=path.json] [--from=path.json] [--show-miss]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { loadShouldBeData } from "./lib/aix-should-be-data";
import { shouldBeAixOf, shouldBeButtons } from "../app/lib/aix-should-be";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

(async () => {
  const from = arg("from");
  const d = from ? JSON.parse(readFileSync(from, "utf8")) as Awaited<ReturnType<typeof loadShouldBeData>>
    : await loadShouldBeData(createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""), { sinceDays: Number(arg("days", "150")) || 150 });
  if (arg("dump")) writeFileSync(arg("dump"), JSON.stringify(d));
  // ── 1. 竹内さんの AIX の送信（ラベルあり） ──
  let n = 0, mapped = 0, btnOk = 0, btnAny = 0, pkN = 0, pkOk = 0, pkN2 = 0, pkOk2 = 0;
  const byBtn: Record<string, { n: number; mapped: number; ok: number }> = {};
  const miss: string[] = [];
  for (const r of d.owner) {
    n++;
    const lb = r.key.split("/")[0];
    const s = shouldBeAixOf(r.text, { mode: "aix" });
    const b = (byBtn[lb] ??= { n: 0, mapped: 0, ok: 0 }); b.n++;
    if (!s) { if (miss.length < 60) miss.push(`[なし] ${r.key}: ${r.text.replace(/\s+/g, " ").slice(0, 110)}`); continue; }
    mapped++; b.mapped++;
    if (s.button === lb) { btnOk++; b.ok++; } else if (miss.length < 60) miss.push(`[${s.key}] ${r.key}: ${r.text.replace(/\s+/g, " ").slice(0, 110)}`);
    if (shouldBeButtons(s).includes(lb)) btnAny++;
    if (r.source === "recorded" && r.key.includes("/")) {
      pkN++; if (s.key === r.key) pkOk++;
      // 物件ピックアップした・物件オススメのピッカー（新着／通常／条件広げ…）は「いつ出すか」で分かれる＝文では決まらない（aix-meaning-learn の注）。それを外した正解率
      if (!/^property_(?:send|recommendation)\//.test(r.key)) { pkN2++; if (s.key === r.key) pkOk2++; }
    }
  }
  console.log(`## 竹内さんの AIX の送信 ${n}件`);
  console.log(`当てた ${mapped}（${pct(mapped, n)}）・当てた中でボタンが同じ ${btnOk}/${mapped}＝${pct(btnOk, mapped)}（同じ文の他の中身も含め ${pct(btnAny, mapped)}）・全体で ${pct(btnOk, n)}`);
  console.log(`ボタン×ピッカー（押した記録にピッカーがある ${pkN}件）: ${pkOk}/${pkN}＝${pct(pkOk, pkN)}・時期で分かれる物件の束/1件のピッカーを外すと ${pkOk2}/${pkN2}＝${pct(pkOk2, pkN2)}`);
  console.log(Object.entries(byBtn).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `  ${k}: ${v.ok}/${v.mapped}（当てた ${v.mapped}/${v.n}）`).join("\n"));
  if (process.argv.includes("--show-miss")) console.log(miss.join("\n"));
  // ── 2. 従業員の AIX の送信: 中身の本来の AIX が押したボタンと違う＝押し間違いの候補 ──
  let sm = 0, sMis = 0;
  const misC: Record<string, number> = {};
  for (const r of d.staffAix) {
    const s = shouldBeAixOf(r.text, { mode: "aix" }); if (!s || s.strength !== "strong") continue;
    sm++;
    const lb = r.key.split("/")[0];
    if (!shouldBeButtons(s).includes(lb)) { sMis++; const k = `${lb} → ${s.button}`; misC[k] = (misC[k] ?? 0) + 1; }
  }
  console.log(`\n## 従業員の AIX の送信 ${d.staffAix.length}件: はっきり当てた ${sm}・押したボタンと違う（押し間違いの候補）${sMis}（${pct(sMis, sm)}）`);
  console.log(Object.entries(misC).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
  // ── 3. 手打ちの文 ──
  const hand: Record<string, { n: number; hit: number; strong: number; keys: Record<string, number> }> = {};
  for (const h of d.hand) {
    const w = h.writer.replace(/\?$/, "");
    const o = (hand[w] ??= { n: 0, hit: 0, strong: 0, keys: {} }); o.n++;
    const s = shouldBeAixOf(h.text, { mode: "hand" }); if (!s) continue;
    o.hit++; if (s.strength === "strong") o.strong++; o.keys[s.key] = (o.keys[s.key] ?? 0) + 1;
  }
  console.log(`\n## 手打ちの文（AIX でない送信）`);
  for (const [w, o] of Object.entries(hand)) console.log(`  ${w}: ${o.n}通中 本来は AIX ${o.hit}（はっきり ${o.strong}）— ${Object.entries(o.keys).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join("・")}`);
})().catch((e) => { console.error(e); process.exit(1); });
