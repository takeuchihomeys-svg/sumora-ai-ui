// scripts/audit-turn-referent.ts — 主語の抜けた番の物件の候補（turn-referent.ts・property-thread の台帳の文）を、竹内さんの返事の物件（正解）に当てる（読むだけ・LLM なし・$0）
// 2026-10-09: 正解は scripts/audit-hidden-subject.ts の結果（scripts/.replay-out/hidden-subject.json の truthKey）を使う（同じ番・同じ正解で前後を比べる）。
//   各番の時刻で loadPropertyThreads(asOf) を作り直し、turnTargets（引用・名指し）→ turnReferent（主語の抜け）の順に今の番の物件を読む。
// 実行: npx tsx --env-file=.env.local scripts/audit-turn-referent.ts [--in=scripts/.replay-out/hidden-subject.json] [--show=5]
import { readFileSync } from "node:fs";
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");

async function main() {
  const rows = JSON.parse(readFileSync(arg("in", "scripts/.replay-out/hidden-subject.json"), "utf8")) as Array<Record<string, any>>;
  const show = Number(arg("show", "5"));
  const { loadPropertyThreads } = await import("../app/lib/property-thread-server");
  const { buildingKeyOf, voicingFold } = await import("../app/lib/customer-state");
  const { similarity } = await import("../app/lib/property-name-match");
  // 読み取りの化け（濁点・空白・1〜2字）は同じ物件として数える（正解の側も化けている事がある）。--strict で文字の一致だけ
  const strict = process.argv.includes("--strict");
  const same = (a: string | null | undefined, key: string) => { const k = buildingKeyOf((a ?? "").replace(/[（(][^）)]*[）)]/g, "").replace(/\s*[0-9]{2,4}号室?$/, "")); if (!k) return false; if (k.includes(key) || key.includes(k)) return true; return !strict && similarity(voicingFold(k), voicingFold(key)) >= 0.75; };
  const out: Record<string, number> = {};
  const add = (k: string) => { out[k] = (out[k] ?? 0) + 1; };
  const bad: string[] = []; const many: string[] = [];
  const target = rows.filter((r) => r.truthKey);
  for (const r of target) {
    const s = await loadPropertyThreads(r.convFull, { asOf: new Date(Date.parse(r.lastAt) + 1000).toISOString() });
    if (!s) { add("読めない"); continue; }
    const tt = s.turnTargets.at(-1);
    if (tt) { const ok = same(tt.display, r.truthKey); add(`台帳(${tt.by}):${ok ? "同じ" : "別"}`); if (!ok) bad.push(`台帳 ${r.conv} 「${r.text}」 正解=${r.truth} 出した=${tt.display}`); continue; }
    const ref = s.turnReferent;
    if (!ref) { add("候補なし"); continue; }
    if (ref.kind === "one") { const ok = same(ref.display, r.truthKey); add(`${ref.step}:${ok ? "同じ" : "別"}`); if (!ok) bad.push(`${ref.step} ${r.conv} 「${r.text}」 正解=${r.truth} 出した=${ref.display}`); }
    else { const has = ref.candidates.some((c) => same(c.display, r.truthKey)); add(`${ref.step}:候補に${has ? "含む" : "無い"}(${ref.candidates.length}件)`); many.push(`${ref.step} ${r.conv} 「${r.text}」 正解=${r.truth} 候補=${ref.candidates.map((c) => c.display).join("・")}`); }
  }
  console.log(`正解の決まる番 ${target.length}`);
  for (const [k, v] of Object.entries(out).sort()) console.log(`  ${k}: ${v}`);
  console.log("\n■ 外れ"); for (const b of bad.slice(0, show * 3)) console.log("  " + b);
  console.log("\n■ 決めなかった（候補）"); for (const b of many.slice(0, show)) console.log("  " + b);
}
main().catch((e) => { console.error(e); process.exit(1); });
