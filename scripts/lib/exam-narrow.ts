// scripts/lib/exam-narrow.ts — 積む時に問題を自動で絞る関所（純関数・LLM なし・DB なし）
//
// 2026-11-24 作業員L（竹内さん 11/24「なんでこんなに試験にお金が必要なのか」・統括役の頼み・作業員A の①の組の絞り（51→16問・$7→$3.1）を全部の組へ）:
//   残すのは次のどれかに当たる問題だけ:
//     ① on にするスイッチの要る材料（exam-switch-reach の対応表）が、前の回の写しで1行以上ある問題（効きうる問題）
//     ② 前の回が無い問題（材料が分からない＝言い切らない）
//     ③ 今の off で外れている問題（前の基準の答えの過半数で道か合格が✕＝直しで良くなりうる・悪化の見張り）
//   守り（比べられる守り 1〜2問）は係の守りの足しがこの後に足す。
//   対応表に要る材料が無いスイッチ（指示文・印だけ）が1つでも on なら絞らない（どの問題に効くか前もって分からない）。
//   止める EXAM_NARROW=off（依頼ごとに --no-narrow）
import type { PriorLedger } from "./exam-preflight-reach";
import { SWITCH_REACH, type SwitchReachDef } from "./exam-switch-reach";

export function examNarrowOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.EXAM_NARROW ?? "").trim().toLowerCase() !== "off";
}
export type NarrowBase = ReadonlyMap<string, { pathOk: boolean; pass: boolean; /** 前の回のどれかで返信の下書きが出た */ hasDraft?: boolean }>;
/**
 * 2026-11-24 作業員L（統括役の頼み①）: スイッチごとの「効く場面」（コードで条件が決まる物だけ・推して埋めない）。
 *   reply_draft＝返信の下書き（app/api/generate-reply の文の設計図 compose-sentence-plan・compose-value-slots の中だけで読まれる）。
 *   brain-exam では、ブレインが AIX を選んだ番（reply_mode=aix・AFTER_AIX_DRAFT が off）と段が brain の問題は generate-reply を呼ばない＝この3つは効かない。
 *   ブレイン（brain-core）や AIX の文（aix-template-generate）でも読むスイッチ（TSUNAGI_ONE_PLACE・BRAIN_SEVEN_FIELDS・BRAIN_COMPOSE_BLUEPRINT）は場面が決まらない＝入れない
 */
export const SWITCH_SCENE: Readonly<Record<string, { where: "reply_draft"; why: string }>> = {
  COMPOSE_CLOSING_TABLE: { where: "reply_draft", why: "compose-value-slots（generate-reply だけ）" },
  COMPOSE_LEAD_JUDGE_FIRST: { where: "reply_draft", why: "compose-sentence-plan（generate-reply だけ）" },
  COMPOSE_DEST_FROM_BRAIN: { where: "reply_draft", why: "compose-sentence-plan（generate-reply だけ）" },
};
export function examNarrowSceneOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.EXAM_NARROW_SCENE ?? "").trim().toLowerCase() !== "off";
}
export type NarrowResult = { applied: boolean; keep: string[]; drop: string[]; why: Record<string, string>; reason: string };

/** 前の基準の答え（問題ごと）→ 過半数の道・合格（純関数） */
export function baseMajorityOf(rows: ReadonlyArray<{ id: string; error?: unknown; path?: { ok?: boolean } | null; score?: { pass?: boolean } | null }>): Map<string, { pathOk: boolean; pass: boolean }> {
  const by = new Map<string, Array<{ p: boolean; s: boolean; d: boolean }>>();
  for (const r of rows) { if (r.error) continue; by.set(r.id, [...(by.get(r.id) ?? []), { p: !!r.path?.ok, s: !!r.score?.pass, d: !!(r as { draft?: { text?: string | null } | null }).draft?.text }]); }
  const out = new Map<string, { pathOk: boolean; pass: boolean; hasDraft: boolean }>();
  for (const [id, xs] of by) out.set(id, { pathOk: xs.filter((x) => x.p).length * 2 > xs.length, pass: xs.filter((x) => x.s).length * 2 > xs.length, hasDraft: xs.some((x) => x.d) });
  return out;
}

export function narrowProblems(o: { ids: readonly string[]; onSwitches: readonly string[]; prior: PriorLedger; base: NarrowBase; table?: Record<string, SwitchReachDef>; scene?: Readonly<Record<string, { where: "reply_draft"; why: string }>> | null }): NarrowResult {
  const table = o.table ?? SWITCH_REACH;
  const ids = [...o.ids];
  const none = (reason: string): NarrowResult => ({ applied: false, keep: ids, drop: [], why: {}, reason });
  if (!o.onSwitches.length) return none("on のスイッチが無い");
  const scene = o.scene === undefined ? (examNarrowSceneOn() ? SWITCH_SCENE : null) : o.scene;
  const unknownSw = o.onSwitches.filter((s) => !(table[s]?.needs?.length) && !scene?.[s]);
  if (unknownSw.length) return none(`材料・場面の表に無いスイッチ（${unknownSw.join(",")}）＝どの問題に効くか分からない`);
  const needs: string[] = [...new Set(o.onSwitches.flatMap((s) => table[s]?.needs ?? []))];
  const replyDraftSw = o.onSwitches.some((s) => scene?.[s]?.where === "reply_draft");
  const keep: string[] = [], drop: string[] = [], why: Record<string, string> = {};
  for (const id of ids) {
    const l = o.prior.get(id);
    const b = o.base.get(id);
    // 返信の下書きのスイッチ: 前の回で返信の下書きが出た問題は効きうる（前の答えが無ければ分からない＝残す）
    if (replyDraftSw && (!b || b.hasDraft)) { keep.push(id); why[id] = b ? "返信の下書きが出る" : "前の答えが無い"; continue; }
    if (needs.length && !l) { keep.push(id); why[id] = "前の回が無い"; continue; }
    if (l && needs.some((t) => (l[t] ?? 0) > 0)) { keep.push(id); why[id] = "材料あり"; continue; }
    if (b && (!b.pathOk || !b.pass)) { keep.push(id); why[id] = "今の off で外れ"; continue; }
    drop.push(id); why[id] = replyDraftSw && !needs.length ? "返信の下書きが出ない番・off で当たり" : "材料0・off で当たり";
  }
  if (!keep.length) return none("絞ると0問（積む前の関所が止める）");
  return { applied: drop.length > 0, keep, drop, why, reason: `材料・場面の決まるスイッチ（${o.onSwitches.join(",")}）` };
}
