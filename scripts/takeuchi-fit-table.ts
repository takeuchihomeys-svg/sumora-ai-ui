// scripts/takeuchi-fit-table.ts — 竹内さんに当てはめた分析の表（場面ごと・竹内さん本人の番だけ・LLM なし・数字と札だけ）
//
// 2026-11-04 竹内さん（「統括を実際の竹内に当てはめて、重さや配列・ベクトルを決めていく」・KB 41dadfe6 基準は竹内さんだけ）。
//   入力: 作業員6の夜の集計（exam-cache/compose-night/w6-q7-*.json＝配分・w6-q8-*.json＝メイン／後に回した物／省いた事）と、
//         再生の試験の結果（exam-cache/conductor-intake/results-*.json・あれば効いた倉庫と当たり）。
//   出力: exam-cache/takeuchi-fit/table-<日付>.md（竹内さんに見せる形・お客様の文なし）と .json（conductor_weights の初めの値の元・行の id で1対1）。
//   部品 → ブレインの当て方（案・竹内さんに確かめる）: promise・info・ask＝判断（ask は締めの文が混ざるので 0.5 に割り引く・作業員6）／appeal・support・ack・close＝文。
//   件数 n<12 は「少ない」の印（作業員6の線に揃える）。
// 実行: npx tsx scripts/takeuchi-fit-table.ts [--date=20261104]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ROOT = join(process.cwd(), "..", "..", "exam-cache");
const DATE = arg("date", new Date().toISOString().slice(0, 10).replace(/-/g, ""));
const PART_BRAIN: Record<string, { brain: "judge" | "compose"; w: number }> = {
  promise: { brain: "judge", w: 1 }, info: { brain: "judge", w: 1 }, inform: { brain: "judge", w: 1 }, ask: { brain: "judge", w: 0.5 },
  appeal: { brain: "compose", w: 1 }, support: { brain: "compose", w: 1 },
  // 2026-11-04 統括役: 受け・締め・挨拶はブレインの割合に数えない（ほぼ毎通ある文の型）。文の型として別の列に残す
};
const JA: Record<string, string> = { promise: "約束", info: "答え・案内", inform: "答え・案内", ask: "問い", appeal: "訴求", support: "サポート", ack: "受け", close: "締め", greet: "挨拶", aix: "AIX への受け渡し" };
const ja = (s: string) => s.split(">").map((p) => JA[p] ?? p).join("→");

type Q7Row = { scene: string; purpose: string; scene_purpose_n: number; seq_s: string; n: number; share_pct: number; few: boolean };
type Q7Part = { scene: string; purpose: string; part: string; part_pos_avg: number; part_present_pct: number; few: boolean };
type Q8Row = { scene: string; main_part: string; n: number; share_pct: number; few: boolean };
type Q8Later = { scene: string; main_part: string; later_part: string; n: number };
type Q8Omit = { scene: string; anat_n: number; omitted_rows: number; omitted_avg: number };

const q7 = JSON.parse(readFileSync(join(ROOT, "compose-night", `w6-q7-${DATE}.json`), "utf8")) as { rows: Q7Row[]; parts: Q7Part[] };
const q8 = JSON.parse(readFileSync(join(ROOT, "compose-night", `w6-q8-${DATE}.json`), "utf8")) as { rows: Q8Row[]; later: Q8Later[]; omitted: Q8Omit[] };
const ciDir = join(ROOT, "conductor-intake");
const ciFiles = existsSync(ciDir) ? readdirSync(ciDir).filter((f) => /^results-ci-(?!smoke).*\.json$/.test(f)) : [];
const ci = ciFiles.length ? (JSON.parse(readFileSync(join(ciDir, ciFiles.sort().pop()!), "utf8")) as { label: string; rows: Array<{ scene?: string; ok?: boolean; gold: { route: string } }> }) : null;

const scenes = [...new Set(q8.rows.map((r) => r.scene))];
const table = scenes.map((scene, i) => {
  const mains = q8.rows.filter((r) => r.scene === scene).sort((a, b) => b.n - a.n);
  const n = mains.reduce((a, r) => a + r.n, 0);
  // ブレインの割合: その場面の部品の現れ方（part_present_pct × 重み）を判断と文に寄せる
  const parts = q7.parts.filter((p) => p.scene === scene);
  const score: Record<string, number> = {};
  // 趣旨ごとの件数（scene_purpose_n）で重みを付けて場面全体に寄せる（趣旨の数の偏りで割合がずれないように）
  const spN = (purpose: string) => q7.rows.find((r) => r.scene === scene && r.purpose === purpose)?.scene_purpose_n ?? 0;
  for (const p of parts) { const m = PART_BRAIN[p.part]; if (!m) continue; score[m.brain] = (score[m.brain] ?? 0) + (p.part_present_pct / 100) * spN(p.purpose) * m.w; }
  const tot = Object.values(score).reduce((a, b) => a + b, 0) || 1;
  const shares = Object.entries(score).map(([b, v]) => ({ brain: b, pct: Math.round((v / tot) * 100) })).sort((a, b) => b.pct - a.pct);
  const spTot = [...new Set(parts.map((p) => p.purpose))].reduce((a, pu) => a + spN(pu), 0) || 1;
  const form = ["ack", "greet", "close"].map((k) => { const v = parts.filter((p) => p.part === k).reduce((a, p) => a + (p.part_present_pct / 100) * spN(p.purpose), 0); return v ? `${JA[k]} ${Math.round((v / spTot) * 100)}%` : ""; }).filter(Boolean).join("・") || "—";
  const topSeq = q7.rows.filter((r) => r.scene === scene).sort((a, b) => b.n - a.n)[0];
  const later = q8.later.filter((l) => l.scene === scene).sort((a, b) => b.n - a.n).slice(0, 2);
  const omit = q8.omitted.find((o) => o.scene === scene) ?? null;
  const ciRows = (ci?.rows ?? []).filter((r) => r.scene === scene);
  const ciHit = ciRows.filter((r) => r.ok).length;
  return {
    id: `tf-${DATE}-${i + 1}`, scene, n, few: n < 12,
    brains: shares, form, order: topSeq ? `${ja(topSeq.seq_s)}（${topSeq.share_pct}%）` : "—",
    main: mains[0] ? `${JA[mains[0].main_part] ?? mains[0].main_part}（${mains[0].share_pct}%）` : "—",
    later: later.map((l) => `${JA[l.main_part] ?? l.main_part}の後に${JA[l.later_part] ?? l.later_part}（${l.n}）`).join("・") || "—",
    omitted: omit ? `解剖 ${omit.anat_n}通のうち省いた事のある通 ${omit.omitted_rows}` : "—",
    conflictRule: ((top, lt) => top && lt ? `${JA[top.main_part] ?? top.main_part}を主にし、${JA[lt.later_part] ?? lt.later_part}は後ろに回す` : "—")(mains[0], q8.later.filter((l) => l.scene === scene && mains[0] && l.main_part === mains[0].main_part && l.later_part !== l.main_part).sort((a, b) => b.n - a.n)[0]),
    store: "（再生の試験の後に埋める）", clusters: "（近い番の束は conductor_turn_vectors の後）",
    intake: ciRows.length ? `${ciHit}/${ciRows.length}` : "—",
  };
}).sort((a, b) => b.n - a.n);

mkdirSync(join(ROOT, "takeuchi-fit"), { recursive: true });
writeFileSync(join(ROOT, "takeuchi-fit", `table-${DATE}.json`), JSON.stringify({ date: DATE, source: { q7: `w6-q7-${DATE}`, q8: `w6-q8-${DATE}`, ci: ci?.label ?? null }, rows: table }, null, 1));
const md = [
  `# 竹内さんに当てはめた分析の表（${DATE}・竹内さん本人の番だけ・お客様の文なし）`,
  "部品 → ブレインの当て方: 中身の部品だけで数える（約束・答え・問い＝判断・問いは締めの文が混ざるので半分に割り引く／訴求・サポート＝文）。受け・締め・挨拶は数えず「文の型」の列に。件数12未満は「少ない」。",
  "",
  "| id | 場面 | 件数 | 強く使っているブレイン | 2位以下 | 文の型（受け・締め・挨拶の出る割合） | 1通の中の並び（一番多い形） | メインにした物 | 後に回した物 | 入れなかった物 | ぶつかりを避けている決め方（読み取りの案） | 効いた倉庫 | 近い番の束 | 入口の読みの当たり |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...table.map((r) => `| ${r.id} | ${r.scene}${r.few ? "（少ない）" : ""} | ${r.n} | ${r.brains[0] ? `${r.brains[0].brain} ${r.brains[0].pct}%` : "—"} | ${r.brains.slice(1).map((b) => `${b.brain} ${b.pct}%`).join("・") || "—"} | ${r.form} | ${r.order} | ${r.main} | ${r.later} | ${r.omitted} | ${r.conflictRule} | ${r.store} | ${r.clusters} | ${r.intake} |`),
].join("\n");
writeFileSync(join(ROOT, "takeuchi-fit", `table-${DATE}.md`), md);
console.log(md);
