// scripts/audit-r7-seams.ts — 7巡目: 対応の取れた文どうしで「文の後ろの区切り（続けて／改行／空行）」と「文末（絵文字・！）」の差を数える（読むだけ・LLM なし）
//   入力は scripts/audit-r7-text-diff.ts の書き出し（jsonl）。人の多数派（同じ位置でスタッフがどう書くか）も出す
// 実行: npx tsx scripts/audit-r7-seams.ts [--in=scripts/.replay-out/r7-diff-14.jsonl]
import { readFileSync } from "node:fs";
import { sentencesOf, coreOf, dice, openerKindOf } from "../app/lib/text-diff-types";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const rows = readFileSync(arg("in", "scripts/.replay-out/r7-diff-14.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { scene: string; draft: string; staff: string; types: string[] });

type Seg = { s: string; sep: "続け" | "改行" | "空行" | "終わり"; tail: string; role: string };
function segs(t: string): Seg[] {
  const ss = sentencesOf(t); const out: Seg[] = []; let pos = 0;
  ss.forEach((s, i) => {
    const at = t.indexOf(s, pos); const end = at + s.length; pos = end;
    const nextAt = i + 1 < ss.length ? t.indexOf(ss[i + 1], end) : -1;
    const gap = nextAt >= 0 ? t.slice(end, nextAt) : "";
    const nl = (gap.match(/\n/g) ?? []).length;
    const sep = i + 1 >= ss.length ? "終わり" : nl >= 2 ? "空行" : nl === 1 ? "改行" : "続け";
    const tail = (s.match(/[\p{Extended_Pictographic}\u{FE0F}！!？?。]*$/u)?.[0] ?? "").replace(/\u{FE0F}/gu, "").replace(/!/g, "！").replace(/[😊😌🌟✨🙇‍♀️🙏]/gu, "E");
    const core = coreOf(s);
    const role = i === 0 && /^(?:はい|かしこまりました|承知)/.test(core) ? "開口語" : /お世話になっております$/.test(core) ? "挨拶" : /^[^\s]{1,14}さん$/.test(core) ? "呼び名" : /はじめまして|鈴木と申します|この度ご連絡/.test(core) ? "自己紹介" : i === ss.length - 1 ? "最後の文" : "本文";
    out.push({ s, sep, tail, role });
  });
  return out;
}
const sepDiff = new Map<string, number>(); const tailDiff = new Map<string, number>();
const sepHuman = new Map<string, Map<string, number>>(); const tailHuman = new Map<string, Map<string, number>>();
const ex = new Map<string, string[]>();
let pairsN = 0;
for (const r of rows) {
  const D = segs(r.draft), S = segs(r.staff);
  for (const s of S) { const k = s.role; if (!sepHuman.has(k)) sepHuman.set(k, new Map()); sepHuman.get(k)!.set(s.sep, (sepHuman.get(k)!.get(s.sep) ?? 0) + 1); if (!tailHuman.has(k)) tailHuman.set(k, new Map()); tailHuman.get(k)!.set(s.tail, (tailHuman.get(k)!.get(s.tail) ?? 0) + 1); }
  const used = new Set<number>();
  for (const d of D) {
    let best = -1, bv = 0; S.forEach((s, j) => { if (used.has(j)) return; const v = dice(coreOf(d.s), coreOf(s.s)); if (v > bv) { bv = v; best = j; } });
    if (best < 0 || bv < 0.8) continue; used.add(best); pairsN++;
    const s = S[best];
    if (d.sep !== s.sep && d.sep !== "終わり" && s.sep !== "終わり") { const k = `${d.role}の後: AI ${d.sep} → 人 ${s.sep}`; sepDiff.set(k, (sepDiff.get(k) ?? 0) + 1); if (!ex.has(k)) ex.set(k, []); if (ex.get(k)!.length < 3) ex.get(k)!.push(`${d.s.slice(0, 40)}`); }
    if (d.tail !== s.tail) { const k = `${d.role}: AI「${d.tail || "なし"}」→ 人「${s.tail || "なし"}」`; tailDiff.set(k, (tailDiff.get(k) ?? 0) + 1); if (!ex.has(k)) ex.set(k, []); if (ex.get(k)!.length < 3) ex.get(k)!.push(`${d.s.slice(0, 40)} ⇔ ${s.s.slice(0, 40)}`); }
  }
}
console.log(`組 ${rows.length}・対応の取れた文 ${pairsN}`);
console.log(`\n■ 区切りの差（多い順）`); for (const [k, v] of [...sepDiff].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${v} ${k}  例: ${(ex.get(k) ?? []).join(" ／ ")}`);
console.log(`\n■ 文末の差（多い順）`); for (const [k, v] of [...tailDiff].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${v} ${k}  例: ${(ex.get(k) ?? []).join(" ／ ")}`);
console.log(`\n■ 人の区切り（役割ごと）`); for (const [k, m] of sepHuman) { const n = [...m.values()].reduce((a, b) => a + b, 0); console.log(`  ${k} n=${n}: ${[...m].sort((a, b) => b[1] - a[1]).map(([s, v]) => `${s} ${Math.round(v / n * 100)}%`).join("・")}`); }
console.log(`\n■ 人の文末（役割ごと・上位）`); for (const [k, m] of tailHuman) { const n = [...m.values()].reduce((a, b) => a + b, 0); console.log(`  ${k} n=${n}: ${[...m].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s, v]) => `「${s || "なし"}」${Math.round(v / n * 100)}%`).join("・")}`); }
void openerKindOf;
