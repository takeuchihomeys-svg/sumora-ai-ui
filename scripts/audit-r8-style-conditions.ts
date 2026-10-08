// scripts/audit-r8-style-conditions.ts — 8巡目: 人が「半々」で書く形は、どの条件で決まっているか（読むだけ・LLM なし）
//   入力: scripts/audit-r8-style-dump.ts の --out（番の jsonl）
//   形ごとに: 全体の率／月・週の推移と切り替わり点（1本の線で前後の率が一番分かれる週）／条件1つずつの率／決定木（深さ3・葉20番以上）
//            ＝「この条件なら 9割以上入る／入らない」の葉と、決まらずに残る番の割合
//   決定木は2つ: A＝書く前に分かる条件だけ（決まりにできる）／B＝本文の長さ・行数も入れる（説明のため）
// 実行: npx tsx scripts/audit-r8-style-conditions.ts --in=<jsonl> [--since=2026-05-30] [--until=] [--src=hand,edited] [--keys=nanitozo,...] [--depth=3] [--min=20]
import { readFileSync } from "node:fs";
import { STYLE_JA, type StyleKey } from "./lib/r8-style-targets";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const IN = arg("in", "");
const SRC = new Set(arg("src", "hand,edited").split(","));
const KEYS = arg("keys", Object.keys(STYLE_JA).join(",")).split(",") as StyleKey[];
const DEPTH = Number(arg("depth", "3"));
const MIN = Number(arg("min", "20"));
type R = Record<string, any>;
const all: R[] = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const SINCE = arg("since", "2026-05-30"); // 5/17〜5/23 は前の自動返信の文（sender=staff）＝人ではない
const UNTIL = arg("until", "9999");
const WRITER = arg("writer", ""); // A｜B で絞る（書き手の手掛かり）
const KEEP3 = process.argv.includes("--keep-staff-only"); // 既定は③スタッフだけが知る報告（isStaffOnlyReport）を外す＝返信の番だけ
const rows = all.filter((r) => (KEEP3 || !r.staffOnly) && SRC.has(r.src) && r.at >= SINCE && r.at < UNTIL && (!WRITER || r.w === WRITER));
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");

const b = (v: number, cuts: number[], labels: string[]) => { for (let i = 0; i < cuts.length; i++) if (v < cuts[i]) return labels[i]; return labels[labels.length - 1]; };
const PRIOR: Record<string, (r: R) => string> = {
  時期: (r) => r.month,
  アカウント: (r) => r.acc,
  出所: (r) => r.src,
  書き手: (r) => r.w ?? "?",
  段階: (r) => r.stage,
  場面: (r) => r.scene,
  小場面: (r) => r.sub,
  客の長さ: (r) => b(r.cLen, [10, 30, 80], ["〜10字", "10〜30字", "30〜80字", "80字〜"]),
  客の連投: (r) => (r.cMsgs >= 3 ? "3通〜" : `${r.cMsgs}通`),
  客の敬語: (r) => (r.cKeigo ? "あり" : "なし"),
  客の絵文字: (r) => (r.cEmoji ? "あり" : "なし"),
  "客の！": (r) => (r.cBang ? "あり" : "なし"),
  客の問い: (r) => (r.cQ ? "あり" : "なし"),
  客の挨拶: (r) => (r.cGreet ? "あり" : "なし"),
  客のよろしく: (r) => (r.cNanitozo ? "あり" : "なし"),
  客のお礼: (r) => (r.cThanks ? "あり" : "なし"),
  その日の何通目: (r) => (r.nthToday >= 3 ? "3通目〜" : `${r.nthToday}通目`),
  初めての返事: (r) => (r.firstEver ? "はい" : "いいえ"),
  前のこちらの文から: (r) => (r.gapPrevStaffH < 0 ? "なし" : b(r.gapPrevStaffH, [1, 6, 24], ["〜1h", "1〜6h", "6〜24h", "24h〜"])),
  返事までの時間: (r) => b(r.delayH, [1 / 6, 1, 6], ["〜10分", "10〜60分", "1〜6h", "6h〜"]),
  時刻: (r) => b(r.hour, [9, 12, 15, 18, 21], ["夜中〜9時", "9〜12時", "12〜15時", "15〜18時", "18〜21時", "21時〜"]),
  直前にAIX: (r) => (r.aixBefore ? "あり" : "なし"),
  後にAIXが続く: (r) => (r.afterAix > 0 ? "あり" : "なし"),
  後に文が続く: (r) => (r.afterMsgs > 0 ? "あり" : "なし"),
  前のこちらの文がAIX: (r) => (r.prevStaffAix ? "はい" : "いいえ"),
  今日もう何卒: (r) => (r.nanitozoToday ? "はい" : "いいえ"),
  前の文に何卒: (r) => (r.nanitozoPrev ? "はい" : "いいえ"),
  今日もう送った: (r) => (r.greetedToday ? "はい" : "いいえ"),
};
const TEXT: Record<string, (r: R) => string> = {
  本文の長さ: (r) => b(r.sLen, [30, 60, 120, 200], ["〜30字", "30〜60字", "60〜120字", "120〜200字", "200字〜"]),
  行数: (r) => (r.sLines >= 6 ? "6行〜" : r.sLines >= 4 ? "4〜5行" : `${r.sLines}行`),
  下書きの形: (r) => "-",
};

type Node = { n: number; y: number; cond: string; kids?: [Node, Node] };
function gini(y: number, n: number) { if (!n) return 0; const p = y / n; return 2 * p * (1 - p); }
function grow(data: R[], key: StyleKey, feats: Record<string, (r: R) => string>, depth: number, cond: string): Node {
  const n = data.length, y = data.filter((r) => r.t[key]).length;
  const node: Node = { n, y, cond };
  if (depth === 0 || n < MIN * 2 || y === 0 || y === n) return node;
  let best: { g: number; f: string; v: string } | null = null;
  const base = gini(y, n) * n;
  for (const [f, fn] of Object.entries(feats)) {
    const cnt = new Map<string, [number, number]>();
    for (const r of data) { const v = fn(r); const c = cnt.get(v) ?? [0, 0]; c[0]++; if (r.t[key]) c[1]++; cnt.set(v, c); }
    for (const [v, [nv, yv]] of cnt) {
      if (nv < MIN || n - nv < MIN) continue;
      const g = gini(yv, nv) * nv + gini(y - yv, n - nv) * (n - nv);
      if (!best || g < best.g) best = { g, f, v };
    }
  }
  if (!best || base - best.g < n * 0.002) return node;
  const fn = feats[best.f];
  const L = data.filter((r) => fn(r) === best!.v), Rr = data.filter((r) => fn(r) !== best!.v);
  node.kids = [grow(L, key, feats, depth - 1, `${best.f}=${best.v}`), grow(Rr, key, feats, depth - 1, `${best.f}≠${best.v}`)];
  return node;
}
function leaves(nd: Node, path: string[] = []): Array<{ path: string[]; n: number; y: number }> {
  if (!nd.kids) return [{ path, n: nd.n, y: nd.y }];
  return [...leaves(nd.kids[0], [...path, nd.kids[0].cond]), ...leaves(nd.kids[1], [...path, nd.kids[1].cond])];
}
function printTree(nd: Node, ind = "") {
  const tag = nd.n ? (nd.y / nd.n >= 0.9 ? " ★入る" : nd.y / nd.n <= 0.1 ? " ★入らない" : "") : "";
  console.log(`${ind}${nd.cond || "全体"} n=${nd.n} ${pct(nd.y, nd.n)}${nd.kids ? "" : tag}`);
  if (nd.kids) for (const k of nd.kids) printTree(k, ind + "  ");
}
function summary(nd: Node) {
  const ls = leaves(nd); const tot = ls.reduce((a, l) => a + l.n, 0);
  const decided = ls.filter((l) => l.y / l.n >= 0.9 || l.y / l.n <= 0.1).reduce((a, l) => a + l.n, 0);
  const err = ls.reduce((a, l) => a + Math.min(l.y, l.n - l.y), 0);
  const baseErr = Math.min(nd.y, nd.n - nd.y);
  return `9割の線で決まる番 ${pct(decided, tot)}（${decided}/${tot}）・多数派で当てた時の外れ ${pct(err, tot)}（条件なし ${pct(baseErr, tot)}）`;
}
// 切り替わり点: 週の境で前後に分けて、2群の対数尤度が一番上がる所
function changepoint(data: R[], key: StyleKey) {
  const weeks = [...new Set(data.map((r) => r.at.slice(0, 10)))].sort();
  const ll = (y: number, n: number) => { if (!n || y === 0 || y === n) return 0; const p = y / n; return y * Math.log(p) + (n - y) * Math.log(1 - p); };
  const n = data.length, y = data.filter((r) => r.t[key]).length; const base = ll(y, n);
  let best: { d: string; gain: number; a: [number, number]; b: [number, number] } | null = null;
  for (const d of weeks) {
    const A = data.filter((r) => r.at.slice(0, 10) < d); const B = data.length - A.length;
    if (A.length < 40 || B < 40) continue;
    const ya = A.filter((r) => r.t[key]).length;
    const gain = ll(ya, A.length) + ll(y - ya, B) - base;
    if (!best || gain > best.gain) best = { d, gain, a: [ya, A.length], b: [y - ya, B] };
  }
  return best;
}

for (const key of KEYS) {
  const data = rows.filter((r) => r.t[key] !== null && r.t[key] !== undefined);
  const y = data.filter((r) => r.t[key]).length;
  console.log(`\n==================== ${STYLE_JA[key]}（${key}） n=${data.length} 入る ${pct(y, data.length)}`);
  // 月ごと
  const months = [...new Set(data.map((r) => r.month))].sort();
  console.log(`  月: ${months.map((m) => { const d = data.filter((r) => r.month === m); return `${m.slice(5)}月 ${pct(d.filter((r) => r.t[key]).length, d.length)}(${d.length})`; }).join("・")}`);
  const weeks = [...new Set(data.map((r) => r.week))].sort();
  console.log(`  週: ${weeks.map((w) => { const d = data.filter((r) => r.week === w); return `${w} ${pct(d.filter((r) => r.t[key]).length, d.length)}/${d.length}`; }).join("  ")}`);
  const cp = changepoint(data, key);
  if (cp) console.log(`  切り替わり点: ${cp.d}（前 ${pct(cp.a[0], cp.a[1])} n=${cp.a[1]} → 後 ${pct(cp.b[0], cp.b[1])} n=${cp.b[1]}・尤度の上がり ${cp.gain.toFixed(1)}）`);
  // 下書きの影響（直して送った番: 下書きにその形があったか）
  const ed = data.filter((r) => r.src === "edited" && r.dt && r.dt[key] !== null);
  if (ed.length >= 20) {
    const dy = ed.filter((r) => r.dt[key]), dn = ed.filter((r) => !r.dt[key]);
    console.log(`  直して送った番: 下書きにあり→送った文にあり ${pct(dy.filter((r) => r.t[key]).length, dy.length)}(${dy.length})・下書きになし→あり ${pct(dn.filter((r) => r.t[key]).length, dn.length)}(${dn.length})`);
  }
  const asis = all.filter((r) => r.src === "asis" && r.at >= SINCE && r.t[key] !== null);
  console.log(`  参考 下書きそのまま ${pct(asis.filter((r) => r.t[key]).length, asis.length)}(${asis.length})・手打ち ${pct(data.filter((r) => r.src === "hand" && r.t[key]).length, data.filter((r) => r.src === "hand").length)}・直した ${pct(data.filter((r) => r.src === "edited" && r.t[key]).length, data.filter((r) => r.src === "edited").length)}`);
  // 条件1つずつ（全体の率から一番離れる物・n≥MIN）
  const cells: Array<{ f: string; v: string; n: number; y: number }> = [];
  for (const [f, fn] of Object.entries({ ...PRIOR, ...TEXT })) {
    if (f === "下書きの形") continue;
    const m = new Map<string, [number, number]>();
    for (const r of data) { const v = fn(r); const c = m.get(v) ?? [0, 0]; c[0]++; if (r.t[key]) c[1]++; m.set(v, c); }
    for (const [v, [n, yy]] of m) if (n >= MIN) cells.push({ f, v, n, y: yy });
  }
  const p0 = y / data.length;
  const strong = cells.filter((c) => c.y / c.n >= 0.85 || c.y / c.n <= 0.15).sort((a, b) => b.n - a.n).slice(0, 14);
  console.log(`  条件1つで 85% 以上／15% 以下: ${strong.map((c) => `${c.f}=${c.v} ${pct(c.y, c.n)}(${c.n})`).join("・") || "なし"}`);
  const lift = cells.sort((a, b) => Math.abs(b.y / b.n - p0) * Math.sqrt(b.n) - Math.abs(a.y / a.n - p0) * Math.sqrt(a.n)).slice(0, 12);
  console.log(`  効きの大きい条件: ${lift.map((c) => `${c.f}=${c.v} ${pct(c.y, c.n)}(${c.n})`).join("・")}`);
  // 決定木
  const tA = grow(data, key, PRIOR, DEPTH, "");
  console.log(`  [木A 書く前に分かる条件] ${summary(tA)}`); printTree(tA, "    ");
  const tB = grow(data, key, { ...PRIOR, 本文の長さ: TEXT.本文の長さ, 行数: TEXT.行数 }, DEPTH, "");
  console.log(`  [木B 本文の長さ・行数も] ${summary(tB)}`); printTree(tB, "    ");
}
