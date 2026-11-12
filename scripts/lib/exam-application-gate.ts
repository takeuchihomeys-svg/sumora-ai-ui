// scripts/lib/exam-application-gate.ts — 試験の問題を「申込の記録で引く門」（app/lib/turn-application-gate）に通す（純関数＋読み書き）
//
// 2026-11-12 作業員10（統括役の頼み）: brain-exam-add は文の網（test-pii-guard の cutBeforeApplicationMaterial）と「申込へ押下・申込フォーム」で切っていたが、
//   申込の記録で引く門（証明書類・記入済みフォーム・書類の印の通・成約の記録・申込から戻す前の番）は通していなかった
//   → problems.json に門で「申込以降」と出る問題が残り（q036・q054・q100・q139 等）、試験で DeepSeek に材料が渡った。
//   ①作る時（--add・--rebuild）に門で外す ②門で外れた id と理由（本文は書かない）を scripts/brain-exam/gate-excluded.json に残す
//   ③brain-exam の問題選びで、この一覧の id を選ばない（DB を読まずに外せる）
// テスト: npx tsx scripts/lib/__tests__/exam-application-gate.test.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { turnApplicationReason, type TurnApplicationRecords } from "../../app/lib/turn-application-gate";

export const GATE_EXCLUDED_FILE = "scripts/brain-exam/gate-excluded.json";
export type GateExcluded = { checkedAt: string; excluded: Array<{ id: string; reason: string }> };

/** 一覧を読む（無ければ空） */
export function readGateExcluded(cwd = process.cwd()): Map<string, string> {
  const f = join(cwd, GATE_EXCLUDED_FILE);
  if (!existsSync(f)) return new Map();
  try { return new Map((JSON.parse(readFileSync(f, "utf8")) as GateExcluded).excluded.map((x) => [x.id, x.reason])); } catch { return new Map(); }
}
export function writeGateExcluded(list: Array<{ id: string; reason: string }>, cwd = process.cwd()): void {
  const body: GateExcluded = { checkedAt: new Date().toISOString(), excluded: [...new Map(list.map((x) => [x.id, x])).values()].sort((a, b) => a.id.localeCompare(b.id)) };
  writeFileSync(join(cwd, GATE_EXCLUDED_FILE), JSON.stringify(body, null, 1));
}
/** 問題の並びから、門で外れた id を外す（外した id を返す） */
export function filterGateExcluded<T extends { id: string }>(problems: ReadonlyArray<T>, excluded: ReadonlyMap<string, string>): { kept: T[]; dropped: Array<{ id: string; reason: string }> } {
  const kept: T[] = [], dropped: Array<{ id: string; reason: string }> = [];
  for (const p of problems) { const r = excluded.get(p.id); if (r) dropped.push({ id: p.id, reason: r }); else kept.push(p); }
  return { kept, dropped };
}
/** 全部の問題を門に通す（会話ごとに記録を1回だけ引く・読めない会話は外す＝迷えば外す） */
export async function gateCheckSpecs(specs: ReadonlyArray<{ id: string; conv: string; at: string }>, load: (conv: string) => Promise<TurnApplicationRecords>): Promise<Array<{ id: string; reason: string }>> {
  const cache = new Map<string, TurnApplicationRecords>();
  const out: Array<{ id: string; reason: string }> = [];
  for (const s of specs) {
    if (!cache.has(s.conv)) cache.set(s.conv, await load(s.conv));
    const r = turnApplicationReason(cache.get(s.conv), s.at);
    if (r) out.push({ id: s.id, reason: r });
  }
  return out;
}
