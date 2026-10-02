// scripts/audit-auto-send-readiness.ts
// 2026-10-02 ⑫ 竹内さん「見つかった穴も見つけて改善するようにを繰り返していく。そうすれば最終的に穴なくなって自動返信に切り替えれるようになる」:
//   YUMA の再生（scripts/yuma-replay-scenarios.ts の jsonl）を場面ごとにまとめ、自動送信に切り替えてよいかの一覧（ready / almost / blocked）を出す。読むだけ・LLM なし。
//   竹内さん「AIXボタンの仕組もわかったうえで」: 外れを AIX の仕組みで4つに分ける
//     ボタン違い … ブレインの判断（返信／どの AIX）がスタッフと違う（2段の約束の返信＝竹内さんの決定どおりの差は「約束の差」に別に数える）
//     ピッカー違い … 同じ AIX でピッカー（check_pattern）が違う（スタッフの押下にピッカーがある時だけ）
//     確認が要る … 正しい AIX だが、開いても文が出来ない（スタッフしか確かめられない材料: 見積書の画像・空き状況・番地 等＝aix_fill.level）
//     文が違う … 道は合っていて、送る文（返信の下書き・AIX の文）の判定が different
//   場面ごとの残りの壁: 「返信の文」「AIX の選び方」「AIX にスタッフの確認が要る」
//   線（仮・竹内さんの判断で変える）: ready＝場面 n≥6・道 ≥85%・誤送信の恐れ 0・文が違う ≤10%／almost＝道 ≥70%・誤送信の恐れ ≤1／それ以外 blocked
//     誤送信の恐れ＝関所（canAutoReply）を通る下書きなのに、スタッフは AIX（約束の差は除く）
// 実行: npx tsx scripts/audit-auto-send-readiness.ts --labels=l12-r19,l12-r19s,l12-r19f[,…]
import { readFileSync, existsSync } from "node:fs";

type Rec = {
  id?: string; stage?: string; stage_ja?: string; path_ok?: boolean; decided?: string; accept?: string[]; gate?: string; text_verdict?: string | null;
  brain?: { two_stage?: string | null; check_pattern?: string | null } | null; error?: string; staff_cp?: Array<string | null>; staff_aix?: string[];
  aix_fill?: { level?: string } | null; aix_text_verdict?: string | null;
};
const labels = (process.argv.find((a) => a.startsWith("--labels="))?.slice(9) ?? "").split(",").filter(Boolean);
const rows: Rec[] = [];
for (const l of labels) {
  const f = `scripts/.replay-out/${l}.jsonl`;
  if (!existsSync(f)) { console.log(`（無い: ${f}）`); continue; }
  for (const line of readFileSync(f, "utf8").trim().split("\n")) { try { const r = JSON.parse(line) as Rec; if (r.id && !r.error) rows.push(r); } catch { /* 壊れた行は飛ばす */ } }
}
type Cell = { n: number; path: number; auto: number; wrongSend: number; promiseDiff: number; button: number; picker: number; needStaff: number; textDiff: number; textN: number; aixN: number };
const by = new Map<string, Cell>();
const isAix = (a?: string) => !!a && a !== "reply";
for (const r of rows) {
  const k = r.stage_ja ?? r.stage ?? "?";
  const c = by.get(k) ?? { n: 0, path: 0, auto: 0, wrongSend: 0, promiseDiff: 0, button: 0, picker: 0, needStaff: 0, textDiff: 0, textN: 0, aixN: 0 };
  c.n++;
  if (r.path_ok) c.path++;
  else if (r.brain?.two_stage) c.promiseDiff++;
  else c.button++;
  if (r.gate === "ok") {
    c.auto++;
    if (!r.path_ok && !r.brain?.two_stage) c.wrongSend++;
  }
  if (r.path_ok && isAix(r.decided)) {
    c.aixN++;
    const cps = (r.staff_cp ?? []).filter(Boolean) as string[];
    if (cps.length && r.brain?.check_pattern && !cps.includes(r.brain.check_pattern)) c.picker++;
    if (r.aix_fill?.level && r.aix_fill.level !== "auto") c.needStaff++;
    if (r.aix_text_verdict) { c.textN++; if (r.aix_text_verdict === "different") c.textDiff++; }
  }
  if (r.path_ok && !isAix(r.decided) && r.text_verdict) { c.textN++; if (r.text_verdict === "different") c.textDiff++; }
  by.set(k, c);
}
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const verdict = (c: Cell) => {
  const p = pct(c.path + c.promiseDiff, c.n), td = pct(c.textDiff, c.textN);
  if (c.n >= 6 && p >= 85 && c.wrongSend === 0 && td <= 10) return "ready";
  if (p >= 70 && c.wrongSend <= 1) return "almost";
  return "blocked";
};
const wall = (c: Cell) => {
  const w: string[] = [];
  if (c.button + c.picker > 0) w.push(`AIX の選び方(ボタン${c.button}・ピッカー${c.picker})`);
  if (c.needStaff > 0) w.push(`AIX にスタッフの確認が要る(${c.needStaff}/${c.aixN})`);
  if (c.textDiff > 0) w.push(`文(${c.textDiff}/${c.textN})`);
  return w.join("・") || "-";
};
console.log(`再生 ${labels.join(",")}・場面の番 ${rows.length}`);
console.log("| 場面 | n | 道（約束の差を含む） | 自動で送る | 誤送信の恐れ | 約束の差 | 判定 | 残りの壁 |");
console.log("|---|---|---|---|---|---|---|---|");
for (const [k, c] of [...by].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`| ${k} | ${c.n} | ${pct(c.path + c.promiseDiff, c.n)}%（道 ${pct(c.path, c.n)}%） | ${c.auto} | ${c.wrongSend} | ${c.promiseDiff} | ${verdict(c)} | ${wall(c)} |`);
}
