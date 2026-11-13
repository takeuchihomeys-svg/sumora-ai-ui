// scripts/audit-compose-roots.ts — 文の外れを2つの根（KB d16cfe1b・P0）＋材料・道で分ける（AI を呼ばない・DB を読まない・費用0）
//   2026-11-12 作業員10（統括役・竹内さん「文の中身弱い部分も土台や細分化たりていないのではないか」）
//   A 考え方の土台が無い（その場面で竹内さんが何をなぜ書くかの決まり・型が無い）
//   B 細分化されていない（型はあるが粗い＝値は出たが竹内さんと違う）
//   C 材料が文の役に届いていない（ブレインは欄を持っているのに設計図に来ない）
//   D 道・読みの誤りが文に流れた（文の側の問題ではない）
// 材料: ① 竹内さんの正解 53番（gold-1113）× 試験の答案の brain ② 本番の直し（exam-cache/edited-turns/2026-10-16/weak-spots.json の文の直し・返信 151＋AIX の文 148）
// 分け方は決まった線（下の rootOfGold・rootOfEdit）。分からない物は「?」で残す。
// 実行: npx tsx scripts/audit-compose-roots.ts [--gold=scripts/compose-understanding/gold-1113.json]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadGold, loadProbs, loadBrains, evalGoldTurn, ELEMENTS, type El, type Root } from "./lib/compose-gold";

const ROOT = resolve(__dirname, "..");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const gold = loadGold(ROOT, arg("gold", "scripts/compose-understanding/gold-1113.json"));
const probs = loadProbs(ROOT);
const brainOf = loadBrains(ROOT, new Set(gold.map((g) => g.id)));
const tally = new Map<string, { n: number; ex: string }>();
const all: Array<{ el: El; root: Root; src: string; ex: string; detail?: Record<string, string> }> = [];
const add = (el: El, root: Root, src: string, ex: string, detail?: Record<string, string>) => { all.push({ el, root, src, ex, detail }); const k = `${el}|${root}|${src}`; const v = tally.get(k); if (v) v.n++; else tally.set(k, { n: 1, ex }); };

// ── ① 正解 53番（scripts/lib/compose-gold.ts の evalGoldTurn・compose-element-daily と同じ物差し） ──
let gN = 0;
for (const g of gold) {
  const bb = brainOf.get(g.id); const p = probs.get(g.id);
  if (!bb || !p?.staffText) continue;
  gN++;
  for (const r of evalGoldTurn(g, bb.brain, p)) if (r.root) add(r.el, r.root, "正解53", r.ex, r.detail);
}

// ── ② 本番の直し（weak-spots 2026-10-16・文の直しだけ・aix_turn は道なので D に数える） ──
type Spot = { bucket: string; type: string; scene: string; n: number; examples: Array<{ customer: string; draft: string; sent: string }> };
const ws = JSON.parse(readFileSync(resolve(ROOT, "../../exam-cache/edited-turns/2026-10-16/weak-spots.json"), "utf8")) as { spots: Spot[] };
const STAFF_ONLY_RE = /見積|御見積|割引|円|内覧[^。]{0,10}(?:\d{1,2}[:：時]|日)|\d{1,2}[:：]\d{2}|\d{1,2}時/;
function rootOfEdit(s: Spot, e: { customer: string; draft: string; sent: string }): Array<[El, Root]> {
  const aix = s.bucket === "aix_text_edit";
  switch (s.type) {
    case "greeting_added": case "greeting_cut": case "name_line_added": return [["頭", "B"]]; // 決まり（挨拶は基本・了承だけは省く 10/08）はあるが番の分け方が粗い
    case "close_added": case "close_cut": return [["締め", "A"]]; // 締めの決め表が無かった（11/12 に COMPOSE_CLOSING_TABLE を作った）
    case "appeal_added": case "appeal_cut": return [["つなぎ", "B"]]; // 押す強さの上限・刺さり3分岐はあるが粗い
    case "fact_fix": return [["事実", STAFF_ONLY_RE.test(e.sent) && !STAFF_ONLY_RE.test(e.customer) ? "D" : "C"]]; // 人しか知らない値＝AIX の番 / それ以外は材料が届いていない
    case "promise_escape": return [["主の役目", "C"]]; // 答えの材料があるのに確認の約束（材料が答えの役に届いていない）
    case "promise_added": return [["主の役目", "D"]]; // 人が確認の約束にした＝スタッフだけが知る事を返信で言い切った（AIX と返信の分け方）
    case "vague_promise_cut": return [["主の役目", "B"]]; // 約束の型が粗い（対象の無い約束）
    case "extra_cut": return [["信頼", "B"]]; // 信頼の一言（伴走・安心）の出し時が粗い
    case "longer": return [["押さえ", aix ? "B" : "C"]]; // 人が中身を足した＝返信は材料が届いていない・AIX の文は型が粗い
    case "shorter": return [["押さえ", "B"]]; // 長さの型が粗い
    case "rewrite": return [["主の役目", "D"]]; // 近さ0.3未満＝場面・中身が違う（読み違い・AIX の種類違い）
    default: return [["事実", "D"]]; // other: 人しか知らない事・型の網に当たらない
  }
}
let eN = 0;
for (const s of ws.spots) {
  if (s.bucket === "aix_turn") { add("主の役目", "D", "直し", `AIX の番を人が押した ${s.scene}（${s.n}番）`); continue; }
  for (const e of s.examples) { eN++; for (const [el, r] of rootOfEdit(s, e)) add(el, r, s.bucket === "reply_edit" ? "直し・返信" : "直し・AIX の文", `${s.type}「${e.customer.replace(/\s+/g, " ").slice(0, 18)}」→ 人「${e.sent.replace(/\s+/g, " ").slice(0, 40)}」`, { scene: s.scene, type: s.type, customer: e.customer, draft: e.draft, sent: e.sent }); }
}

console.log(`正解 ${gN}番・本番の直しの例 ${eN}通（weak-spots の文の直しの例・aix_turn は種類ごとに1と数える）`);
console.log("要素｜A 土台が無い｜B 細分化が粗い｜C 材料が届いていない｜D 道・読みの誤り");
for (const el of ELEMENTS) {
  const cell = (r: Root) => { const xs = [...tally.entries()].filter(([k]) => k.startsWith(`${el}|${r}|`)); const n = xs.reduce((a, [, v]) => a + v.n, 0); return n ? `${n}（${xs.map(([k, v]) => `${k.split("|")[2]} ${v.n}`).join("・")}）` : "0"; };
  console.log(`${el}｜${cell("A")}｜${cell("B")}｜${cell("C")}｜${cell("D")}`);
}
console.log("\n代表の実物（要素×根の最初の1通）");
for (const el of ELEMENTS) for (const r of ["A", "B", "C", "D"] as Root[]) { const x = [...tally.entries()].find(([k]) => k.startsWith(`${el}|${r}|`)); if (x) console.log(`- ${el}×${r}: ${x[1].ex}`); }
// --dump=<json> [--dump-el=事実|C]: 行ごとに書き出す（他の作業員に渡す時）
if (arg("dump")) { writeFileSync(arg("dump"), JSON.stringify(all.filter((x) => !arg("dump-el") || `${x.el}|${x.root}` === arg("dump-el")), null, 1)); console.log(`書いた: ${arg("dump")}`); }
