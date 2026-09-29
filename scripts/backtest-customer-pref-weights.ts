// scripts/backtest-customer-pref-weights.ts
// お客様ごとのこだわりの倍率（app/lib/customer-pref-weights.ts）を過去で当て直す（読むだけ・DB に触れない・LLM を呼ばない）。
//
// 材料は scripts/build-customer-pref-episodes.ts が書いた episodes.json（回ごとの札・お客様のこだわりの強さ・帯の材料）。
//   古い (1−holdoutFrac) の回で倍率の表を学び、新しい holdoutFrac の回で「実際に送った物件の順位（相対順位）」「👑が送った物件と一致する率」
//   「10位以内の率」を今の点と比べる。帯（こだわりの強さ・家賃の帯・新規／継続・材料）ごとにも出し、悪くなる帯があれば使わない。
//
// 実行: npx tsx scripts/backtest-customer-pref-weights.ts --in=<episodes.json> [--holdout=0.3] [--min-rounds=10] [--min-gain=0.01] [--split=time|customer] [--out=<json>]
//   （--in の既定: scratchpad の pcs/episodes.json。--split=customer はお客様を2つに分けて2回（学ぶ／確かめを入れ替え）。
//     時期で分けると材料の揃う新しい回が全部確かめ用に寄る（学ぶ期間に家賃・エリアの札が無い）ので、その確かめ）
//
// ■ 2026-09-29 の結果（400日・383回・109人・YUMA 除く）
//   時期で分ける（269 で学び 114 で確かめ）: 変更なし（学ぶ期間の候補に条件の札は間取りしか無い・間取り × stated 32回は倍率で順位が動かない）
//     相対順位 0.435 → 0.435・👑一致 28% → 28%・3位以内 42%・10位以内 77%（帯: 強い 41・弱い 39・普通 34／〜7万 22・7〜10万 51・10万〜 41／
//     新規 15・継続 99／pool 54・snapshot 55・pickup 5 いずれも ±0）
//   お客様で分ける A→B（186 で学び 197 で確かめ）: 間取り × stated ×1.25（学べる 35回 0.508 → 0.497）。確かめ 0.447 → 0.446（+0.001）・
//     👑一致 29% → 29%・10位以内 87% → 87%。帯: 新規 17回 +0.014（👑 49% → 54%）・〜7万 33回 +0.007・pool 80回 +0.003・他は ±0.002 以内
//   お客様で分ける B→A（197 で学び 186 で確かめ）: 変更なし（間取り × stated 23回 +0.0002）
//   → 使わない（改善が線 0.01 未満・良くなる帯が無い）。倍率の下限 0.5 で試すと「家賃 ×0.5」（こだわりを弱める向き）だけが片方で学ばれた＝雑音
// ■ 2026-09-29 反証レビューの後（AD の線 15点・加点だけ・8人／1人3回・その回の時点で読める条件・鍵は物件顧客 ID・通す／保留の件数・悪い帯で止める）:
//   時期 0.435 → 0.435・お客様 A→B 0.450 → 0.450・B→A 0.458 → 0.458（どれも変更なし・通す／保留の変化 0件）→ 使わない
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { baseReasonPoints } from "../app/lib/property-brain";
import { familyJa, type StrengthLevel } from "../app/lib/recommend-score-drift";
import {
  PREF_WEIGHT_CONFIG, backtestPrefWeights, defaultBandsOf, learnableRounds, isPrefFamily, splitByTime, splitByCustomer,
  type PrefWeightConfig, type PrefRankMetrics, type Splitter,
} from "../app/lib/customer-pref-weights";
import { codeFamily } from "../app/lib/recommend-score-drift";
import type { PrefEpisode } from "../app/lib/customer-pref-episodes";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const IN = String(args.in ?? join(process.env.CLAUDE_SCRATCHPAD ?? process.env.TEMP ?? ".", "pcs", "episodes.json"));
const cfg: PrefWeightConfig = {
  ...PREF_WEIGHT_CONFIG,
  holdoutFrac: args.holdout ? parseFloat(String(args.holdout)) : PREF_WEIGHT_CONFIG.holdoutFrac,
  minRounds: args["min-rounds"] ? parseInt(String(args["min-rounds"]), 10) : PREF_WEIGHT_CONFIG.minRounds,
  minGain: args["min-gain"] ? parseFloat(String(args["min-gain"])) : PREF_WEIGHT_CONFIG.minGain,
};

type Ep = PrefEpisode & { strength?: Record<string, { level: StrengthLevel }> | null; klass?: string | null };
const raw = JSON.parse(readFileSync(IN, "utf8")) as { days: number; builtAt: string; episodes: Ep[] };
// お客様の行が読めなかった回（strength=null）は学ぶ回と帯から外す（2026-09-29 反証レビュー）
const episodes = raw.episodes.filter((e) => e.strength != null);
const dropped = raw.episodes.length - episodes.length;
const strengthOf = (e: Ep, f: string): StrengthLevel => e.strength?.[f]?.level ?? "none";

const f3 = (x: number) => x.toFixed(3);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const line = (t: string, b: PrefRankMetrics, w: PrefRankMetrics) =>
  `${t}｜n ${b.episodes}｜相対順位 ${f3(b.relRank)} → ${f3(w.relRank)}（${(b.relRank - w.relRank >= 0 ? "+" : "") + f3(b.relRank - w.relRank)}）｜👑一致 ${pct(b.top1)} → ${pct(w.top1)}｜3位以内 ${pct(b.top3)} → ${pct(w.top3)}｜10位以内 ${pct(b.top10)} → ${pct(w.top10)}｜全部同点 ${b.allTied}`;

console.log(`=== お客様ごとのこだわりの倍率の当て直し（${raw.days}日・回 ${episodes.length}（お客様の行が読めず外した回 ${dropped}）・材料 ${raw.builtAt.slice(0, 16)}・読むだけ）===`);
console.log(`設定: 学ぶ ${Math.round((1 - cfg.holdoutFrac) * 100)}% / 確かめ ${Math.round(cfg.holdoutFrac * 100)}%（新しい順）・倍率 ${cfg.minMult}〜${cfg.maxMult}（目盛り ${cfg.grid}・1回 ±${cfg.maxStep}）・最低 ${cfg.minRounds}回／${cfg.minCustomers}人（1人 ${cfg.maxRoundsPerCustomer}回まで）・学ぶ線 ${cfg.minGain}・帯の最低 ${cfg.bandMinRounds}回`);

// 学べる回の一覧（全部の回・参考）
console.log("\n■ 条件の種類 × 強さ: 学べる回（選んだ物と選ばなかった物で満たすかが違う回）");
const fams = new Set<string>();
for (const e of episodes) for (const c of e.cands) for (const k of c.codes) { const f = codeFamily(k); if (isPrefFamily(f)) fams.add(f); }
for (const f of [...fams].sort()) {
  const s = learnableRounds(episodes, f, "strong", strengthOf as never).length, st = learnableRounds(episodes, f, "stated", strengthOf as never).length;
  if (s || st) console.log(`  ${familyJa(f)}｜strong ${s}｜stated ${st}`);
}

const splits: Array<[string, string, Splitter]> = String(args.split ?? "time") === "customer"
  ? [["お客様A で学び B で確かめ", "A", splitByCustomer(1)], ["お客様B で学び A で確かめ", "B", splitByCustomer(0)]]
  : [["時期（古い 7割で学び・新しい 3割で確かめ）", "time", splitByTime]];
for (const [splitName, splitTag, split] of splits) {
const bt = backtestPrefWeights(episodes, baseReasonPoints, strengthOf as never, defaultBandsOf as never, cfg, null, split);
console.log(`\n━━ 分け方: ${splitName} ━━`);
console.log(`\n■ 学んだ表（学ぶ期間 ${bt.train}回）`);
if (!bt.learned.changes.length) console.log("  変更なし");
for (const c of bt.learned.changes) console.log(`  ${familyJa(c.family)} × ${c.level}: ×${c.from} → ×${c.to}（学べる回 ${c.rounds}・その回の相対順位 ${f3(c.relBefore)} → ${f3(c.relAfter)}）`);
console.log("  学ばなかった:");
for (const s of bt.learned.skipped.filter((x) => !/件数不足/.test(x.reason))) console.log(`    ${familyJa(s.family)} × ${s.level}（${s.rounds}回）: ${s.reason}`);
const few = bt.learned.skipped.filter((x) => /件数不足/.test(x.reason));
console.log(`    件数不足（< ${cfg.minRounds}回）: ${few.map((x) => `${familyJa(x.family)}×${x.level} ${x.rounds}`).join("・")}`);

console.log("\n■ 当て直し（今の点 → 倍率あり）");
console.log("  " + line("確かめ用（新しい）", bt.base, bt.weighted));
console.log("  " + line("学んだ期間（参考）", bt.trainBase, bt.trainWeighted));
console.log("\n■ 帯ごと（確かめ用）");
for (const r of bt.bands) console.log(`  ${line(`${r.band}=${r.value}`, r.base, r.weighted)}｜${r.note}`);
console.log(`\n■ 判定: ${bt.decision.enable ? "使う" : "使わない"} — ${bt.decision.reason}`);
console.log(`  通す／保留（40点の線）が変わった候補（確かめ用 ${bt.verdictFlips.candidates}件中）: 保留→通す ${bt.verdictFlips.toPass}・通す→保留 ${bt.verdictFlips.toHold}`);

if (args.out) { const out = String(args.out).replace(/\.json$/, "") + (splits.length > 1 ? `-${splitTag}` : "") + ".json"; writeFileSync(out, JSON.stringify({ in: IN, cfg, split: splitName, ...bt }, null, 1)); console.log(`→ ${out}`); }
}
