// scripts/audit-r8-style-table.ts — 8巡目: 小場面ごとの「基準の形」の表（人の手打ち・全期間 5/30〜）と AI の下書き（直近30日）の率を並べる（読むだけ・LLM なし）
//   入力: scripts/audit-r8-style-dump.ts の --out と --ai-out
//   人＝手打ち（下書きの記録なし）を主に、直して送った物も別の列で。5/17〜5/23 は前の自動返信の文なので外す
// 実行: npx tsx scripts/audit-r8-style-table.ts --in=<turns.jsonl> --ai=<ai.jsonl> [--min=15] [--keys=...] [--group=sub|scene|stage]
import { readFileSync } from "node:fs";
import { STYLE_JA, type StyleKey } from "./lib/r8-style-targets";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const MIN = Number(arg("min", "15"));
const KEYS = arg("keys", "nanitozo,shokiHiyou,nameNewline,openerBlank,kashikoStart,haiStart,openerEmoji,emojiThenBang,itadakiKanji,greeting").split(",") as StyleKey[];
const GROUP = arg("group", "sub");
const WRITER = arg("writer", ""); // A｜B（書き手の手掛かり・scripts/lib/r8-style-targets.writerOf）で絞る
const load = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const turns = load(arg("in", "")).filter((r: any) => !r.staffOnly && r.at >= "2026-05-30" && (!WRITER || r.w === WRITER));
const ai = load(arg("ai", ""));
const rate = (l: any[], k: StyleKey, f = "t") => { const v = l.map((r) => r[f]?.[k]).filter((x) => x !== null && x !== undefined); return v.length ? { p: v.filter(Boolean).length / v.length, n: v.length } : null; };
const cell = (x: { p: number; n: number } | null) => (x ? `${Math.round(x.p * 100)}%/${x.n}` : "-");
const g = (r: any) => (GROUP === "scene" ? r.scene : GROUP === "stage" ? r.stage : r.sub);
const groups = new Map<string, any[]>(); for (const r of turns) { const k = g(r); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
console.log(`人＝手打ち（下書きなし） 5/30〜／直＝AI の下書きを直して送った／AI＝直近30日の下書き。各 率/数。「基準」＝手打ちで 80% 以上か 20% 以下の時の形（それ以外は「割れ」）`);
for (const k of KEYS) {
  console.log(`\n■ ${STYLE_JA[k]}`);
  const lines: string[] = [];
  for (const [name, l] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const hand = l.filter((r) => r.src === "hand"); const ed = l.filter((r) => r.src === "edited");
    const h = rate(hand, k); if (!h || h.n < MIN) continue;
    const recent = rate(hand.filter((r) => r.at >= "2026-08-01"), k);
    const a = rate(ai.filter((r: any) => g(r) === name), k);
    const std = h.p >= 0.8 ? "入れる" : h.p <= 0.2 ? "入れない" : "割れ";
    const gap = a && a.n >= 5 ? Math.round((a.p - h.p) * 100) : null;
    lines.push(`  ${name.padEnd(28)} 人 ${cell(h).padEnd(8)} 8月〜 ${cell(recent).padEnd(8)} 直 ${cell(rate(ed, k)).padEnd(8)} AI ${cell(a).padEnd(8)} 基準 ${std}${gap !== null && Math.abs(gap) >= 20 ? `  ← AI ${gap > 0 ? "+" : ""}${gap}pt` : ""}`);
  }
  console.log(lines.join("\n"));
}
