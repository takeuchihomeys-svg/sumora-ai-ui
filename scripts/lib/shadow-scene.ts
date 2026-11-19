// scripts/lib/shadow-scene.ts — 影の自動返信の場面選び（本番の物差しを場面ごとに・純関数だけ・LLM も DB も使わない）
//
// 2026-11-12 作業員1（竹内さん 11/12「よい」＝影の自動返信の準備・統括役の頼み・memory project_shadow_auto_reply 9/29 の設計）:
//   場面（返信の場面・AIX の種類＝見張りの scene_key）×直近14日・28日の当たり（今の通＝道）と番の数・95% の下限。
//   自動にできる候補: 14日で n≥20 かつ当たりの下限 ≥ 0.95・スタッフの一手が返信（AIX を出さない）の番がほぼ全部・申込に近い場面は除く。
//   数え方は YARDSTICK_TWO_FRAMES の今の通（2段＝今は返信）。後の通（約束の AIX を果たしたか）は別の欄に出す。
import { wilson } from "./prod-yardstick";

export type ShadowTurn = {
  scene: string | null;
  /** 見張りの番の時刻（ms） */
  at: number;
  writer: "takeuchi" | "staff";
  /** 今の通の当たり（judgeTwoFrames の now） */
  nowHit: boolean;
  /** スタッフの今の一手が返信（AIX でない） */
  staffReply: boolean;
  /** ブレインの今の一手が返信 */
  brainReply: boolean;
  /** 後の通（約束の AIX）が外れ・果たしていない */
  laterBad?: boolean;
};

export type SceneRow = {
  scene: string; writer: "takeuchi" | "staff" | "all";
  n14: number; hit14: number; lo14: number; n28: number; hit28: number; lo28: number;
  replyShare14: number; laterBad14: number;
  verdict: "候補" | "数が足りない" | "当たりが足りない" | "AIX の場面" | "申込に近い";
};

/** 申込に近い場面（自動にしない）: 申込・審査・契約・書類・フォーマット・代理契約・保証会社の審査 */
export const NEAR_APPLY_RE = /申込|申し込|application|審査|screening|契約|書類|フォーマット|本人確認|代理|名義|入金|キャンセル|否決/i;

export function sceneTable(turns: ReadonlyArray<ShadowTurn>, nowMs: number, opts: { minN?: number; minLo?: number; minReplyShare?: number } = {}): SceneRow[] {
  const minN = opts.minN ?? 20, minLo = opts.minLo ?? 0.95, minReply = opts.minReplyShare ?? 0.95;
  const d14 = nowMs - 14 * 86_400_000, d28 = nowMs - 28 * 86_400_000;
  const groups = new Map<string, ShadowTurn[]>();
  for (const t of turns) {
    if (t.at < d28) continue;
    for (const w of [t.writer, "all"] as const) {
      const k = `${t.scene ?? "（場面なし）"}\u0000${w}`;
      const a = groups.get(k) ?? []; a.push(t); groups.set(k, a);
    }
  }
  const out: SceneRow[] = [];
  for (const [k, ts] of groups) {
    const [scene, writer] = k.split("\u0000") as [string, SceneRow["writer"]];
    const t14 = ts.filter((t) => t.at >= d14);
    const hit14 = t14.filter((t) => t.nowHit).length, hit28 = ts.filter((t) => t.nowHit).length;
    const lo14 = wilson(hit14, t14.length).lo, lo28 = wilson(hit28, ts.length).lo;
    const replyShare14 = t14.length ? t14.filter((t) => t.staffReply && t.brainReply).length / t14.length : 0;
    const laterBad14 = t14.filter((t) => t.laterBad).length;
    let verdict: SceneRow["verdict"];
    if (NEAR_APPLY_RE.test(scene)) verdict = "申込に近い";
    else if (t14.length < minN) verdict = "数が足りない";
    else if (replyShare14 < minReply) verdict = "AIX の場面";
    else if (lo14 < minLo) verdict = "当たりが足りない";
    else verdict = "候補";
    out.push({ scene, writer, n14: t14.length, hit14, lo14: +lo14.toFixed(3), n28: ts.length, hit28, lo28: +lo28.toFixed(3), replyShare14: +replyShare14.toFixed(3), laterBad14, verdict });
  }
  return out.sort((a, b) => (a.verdict === "候補" ? -1 : 0) - (b.verdict === "候補" ? -1 : 0) || b.n14 - a.n14);
}

/** 表の1行（報告用） */
export function sceneRowLine(r: SceneRow): string {
  const pct = (h: number, n: number) => (n ? `${Math.round((h / n) * 100)}%` : "—");
  return `| ${r.scene} | ${r.writer} | ${r.n14} | ${pct(r.hit14, r.n14)}（下限 ${r.lo14}） | ${r.n28} | ${pct(r.hit28, r.n28)}（下限 ${r.lo28}） | ${Math.round(r.replyShare14 * 100)}% | ${r.laterBad14} | ${r.verdict} |`;
}
