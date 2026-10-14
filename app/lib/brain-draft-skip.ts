// app/lib/brain-draft-skip.ts — 「この番に返信の下書きを作るか」をブレインの判断で決める（純関数・DB 依存なし）
//
// 2026-10-14 竹内さん「返信なのに下書きが無い番をブレイン基準に直す」（判断も自動入力もブレインが決めた事を使う・規則は候補の網と安全の線だけ）:
//   ① generate-draft-bg-async の「締めの後の受けだけ」「お客様の連絡待ち」の規則（previous-send-note.shouldSkipDraftAfterClosing・waiting-customer-info）は、
//      ブレインとは別に下書きを止めていた。ブレインも同じ場面を見ていて（closed-ack → AIX、連絡待ち → staff_note「返信不要（…）」）、
//      ブレインが「返信」と決めた番を規則が止めると「返信なのに下書きが無い」になる（10/01〜10/14 の実データ 1番: ブレイン「お礼と了承のみ…短く受け止めて待つ」を [返信不要] で止めた）。
//      → ブレインの判断がある時はブレインで決める（「返信不要」と言った時だけ止める）。ブレインの判断が無い時（T3）は旧の規則のまま（安全の線）。
//   ② brain-sweep（webhook の分析が落ちた会話の保険）はブレインだけ走らせて下書きを作らなかった（10/01〜10/14 の手打ちの番で 5番:
//      ブレインは返信／2段なのに下書きなし・スタッフは 20分〜14時間後に手で書いた）。→ ブレインが返信と決めた時は下書きの待ち行列（draft_pending_at）に載せる。
//   戻す: BRAIN_DRAFT_SKIP=off（①）・BRAIN_SWEEP_QUEUE_DRAFT=off（②）

type Env = Record<string, string | undefined>;
const off = (v: string | undefined) => (v ?? "").toLowerCase() === "off";

/** ブレインの判断（suggested_aix_meta の一部） */
export type BrainDraftMeta = {
  reply_mode?: string | null;
  action?: string | null;
  note?: string | null;
  decision_source_no_aix?: string | null;
  reply_direction?: string | null;
  source?: string | null;
} | null | undefined;

/**
 * 2026-10-14 独立レビュー: 分析の省略（source=cached）は今回のお客様の発言を見ていない判断で、note を空・reply_mode=auto_reply に
 *   書き換えてある（brain-core の cachedResult）。これを「ブレインは返信」と読むと、締めの後のお礼で規則の止めを外してしまう → 判断なし（T3）と同じ扱い
 */
function liveBrain(meta: BrainDraftMeta): BrainDraftMeta {
  return meta && meta.source !== "cached" ? meta : null;
}

/** ブレインが「この番は返信しない（返信不要・お客様の連絡待ち）」と決めたか */
export function brainSaysNoReply(meta: BrainDraftMeta): boolean {
  if (!meta) return false;
  if (/^\s*返信不要/.test(String(meta.note ?? ""))) return true;
  if (meta.decision_source_no_aix === "rule:waiting_customer_info") return true;
  return false;
}

/** ブレインが「AIX の番」と決めたか（下書きは作らない＝今まで通り） */
export function brainSaysAix(meta: BrainDraftMeta): boolean {
  return !!meta && meta.reply_mode === "aix";
}

export function brainDraftSkipOn(env: Env = process.env): boolean { return !off(env.BRAIN_DRAFT_SKIP); }
export function brainSweepQueueDraftOn(env: Env = process.env): boolean { return !off(env.BRAIN_SWEEP_QUEUE_DRAFT); }

export type DraftSkipVerdict = { skip: boolean; reason: string; by: "brain" | "rule" };

/**
 * ① 締めの後・連絡待ちの番で下書きを作らないか。
 *   ブレインの判断がある（brainMeta）→ ブレインが「返信不要」と言った時だけ止める（規則が止めたがっていたかは reason に残す）
 *   ブレインの判断が無い → 旧の規則（rule）のまま
 */
export function decideClosedDraftSkip(i: { brainMeta: BrainDraftMeta; rule: { skip: boolean; reason: string } }, env: Env = process.env): DraftSkipVerdict {
  const meta = brainDraftSkipOn(env) ? liveBrain(i.brainMeta) : null;
  if (!meta) return { ...i.rule, by: "rule" };
  if (brainSaysNoReply(meta)) return { skip: true, reason: `ブレイン: ${String(meta.note ?? "返信不要").slice(0, 40)}`, by: "brain" };
  return { skip: false, reason: i.rule.skip ? `規則は止める（${i.rule.reason}）がブレインは返信` : "ブレインは返信", by: "brain" };
}

/** 下書きの欄に入っている値が「下書きが無い」（空・印）か。古い本文が残っている時は触らない（スタッフが直している途中かもしれない） */
export function draftSlotEmpty(aiDraft: string | null | undefined): boolean {
  const t = String(aiDraft ?? "").trim();
  return !t || /^\[[^\]]{1,30}\]$/.test(t);
}

/**
 * ② brain-sweep がブレインを走らせた後、下書きを待ち行列に載せるか。
 *   お客様の番（last_sender=customer）・ブレインが返信（AIX でも返信不要でもない）・下書きの欄が空か印 の時だけ。
 */
export function shouldQueueDraftAfterSweep(i: { meta: BrainDraftMeta; aiDraft: string | null | undefined; lastSender: string | null | undefined }, env: Env = process.env): { queue: boolean; reason: string } {
  if (!brainSweepQueueDraftOn(env)) return { queue: false, reason: "off" };
  if (i.lastSender !== "customer") return { queue: false, reason: "not_customer_turn" };
  if (!liveBrain(i.meta)) return { queue: false, reason: "no_brain" };
  if (brainSaysAix(i.meta)) return { queue: false, reason: "brain_aix" };
  if (brainSaysNoReply(i.meta)) return { queue: false, reason: "brain_no_reply" };
  if (!draftSlotEmpty(i.aiDraft)) return { queue: false, reason: "has_draft" };
  return { queue: true, reason: "brain_reply" };
}
