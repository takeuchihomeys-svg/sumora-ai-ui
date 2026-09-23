// app/lib/brain-layers.ts
// 2層ブレイン（2026-09-13 竹内さんの設計）の単一の定義（純関数・依存なし・単体テストあり）。
//
//   ・今回の発言の層（毎回・軽く）: お客様の意向・質問・懸念・条件変更・迷い・感情・今の物件・推奨 AIX・返信の方向。
//       前回の全体分析（BrainStrategy の JSON）を前提に、今回の発言で変わった点だけを判断する。
//   ・会話全体の戦略の層（たまに・まとめて）: 成約戦略・勝ちパターン・次の手順・お客様のタイプ・繰り返しの懸念・決断の時期・フェーズ・購買シグナルの蓄積。
//       前回の戦略＋それ以降の毎回の分析の要点（digest）＋それ以降のメッセージを整理して作り直す（3回に1回はゼロから）。
//
// 組み合わせ（mergeBrainLayers）はコードで決める（LLM 任せにしない）:
//   今回の発言が優先 … 意向・質問・懸念・条件・迷い・感情・今の物件・推奨 AIX・返信の方向・避ける話題・押し引き（今回の層の全項目）
//   戦略が持つ     … closing_strategy / winning_pattern / next_steps / human_type_label（今回の層は出力しない）
//   新しい情報を優先 … repeated_concern / future_timeline / checkpoint_stage（今回の発言で出たら今回、無ければ戦略）
//   高い方         … purchase_signal_level（戦略の蓄積と今回の発言の強さ。設計知見 ae0b17a2: 蓄積はリセットしない）
//
// 下流（generate-reply の reply-context.ts toBrainMessageLocal / toBrainConversationScope）は「返信生成でどう使うか」の分類で、
// ここは「どちらの層が作るか」の分類。両者が食い違っても下流の挙動は変えない（作り手だけを分ける）。

// 2026-09-23: 戦略の項目にも家賃交渉の守りを通す（純関数同士なので依存なしのまま）
import { stripRentNegotiation, stripRentNegotiationFromList } from "./rent-negotiation-guard";

export type BrainStrategy = {
  closing_strategy?: string | null;
  winning_pattern?: string | null;
  next_steps?: string[] | null;
  human_type_label?: string | null;
  repeated_concern?: string | null;
  future_timeline?: string | null;
  checkpoint_stage?: string | null;
  purchase_signal_level?: string | null;
  /** 戦略が見た最新のお客様発言の時刻（古い戦略で新しい戦略を上書きしない単調比較の基準） */
  strategy_msg_ts?: string | null;
  strategy_analyzed_at?: string | null;
  /** 何回目の戦略か（3回に1回はゼロから作り直す＝前回の判断に引きずられない） */
  strategy_count?: number;
  source?: "combined" | "consolidated" | "scratch" | "seed_last_meta";
};

/** 戦略の層が持つ項目（今回の発言の層はこれを出力しない） */
export const STRATEGY_OWNED_FIELDS = ["closing_strategy", "winning_pattern", "next_steps", "human_type_label"] as const;
/** 今回の発言で新しく出たら今回、無ければ戦略 */
export const STRATEGY_FALLBACK_FIELDS = ["repeated_concern", "future_timeline", "checkpoint_stage"] as const;
export const ALL_STRATEGY_FIELDS = [...STRATEGY_OWNED_FIELDS, ...STRATEGY_FALLBACK_FIELDS, "purchase_signal_level"] as const;

const SIGNAL_RANK: Record<string, number> = { none: 0, soft: 1, strong: 2, peak: 3 };
export function maxSignal(a: string | null | undefined, b: string | null | undefined): string | null {
  const ra = a && a in SIGNAL_RANK ? SIGNAL_RANK[a] : -1;
  const rb = b && b in SIGNAL_RANK ? SIGNAL_RANK[b] : -1;
  if (ra < 0 && rb < 0) return null;
  return ra >= rb ? (a as string) : (b as string);
}

const nonEmpty = (v: unknown): boolean =>
  v !== null && v !== undefined && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && v.length === 0);

/** 今回の発言の層の結果に戦略の層を合成して、suggested_aix_meta に保存する形にする */
export function mergeBrainLayers<T extends Record<string, unknown>>(fresh: T, strategy: BrainStrategy | null | undefined): T & { strategy_msg_ts: string | null; strategy_source: string | null } {
  const out: Record<string, unknown> = { ...fresh };
  if (strategy) {
    for (const f of STRATEGY_OWNED_FIELDS) {
      if (nonEmpty(strategy[f])) out[f] = strategy[f];
    }
    for (const f of STRATEGY_FALLBACK_FIELDS) {
      if (!nonEmpty(out[f]) && nonEmpty(strategy[f])) out[f] = strategy[f];
    }
    out.purchase_signal_level = maxSignal(strategy.purchase_signal_level ?? null, (fresh.purchase_signal_level as string | null | undefined) ?? null);
  }
  return { ...(out as T), strategy_msg_ts: strategy?.strategy_msg_ts ?? null, strategy_source: strategy?.source ?? null };
}

/**
 * 戦略の項目から「家賃・賃料の値下げ交渉をこれからする」節を落とす（rent-negotiation-guard と同じ純関数）。
 * consolidateStrategy（普段の整理）と extractStrategy（ゼロから・種まき）の両方がこれを通す（四者同名）
 */
export function sanitizeStrategyFields(s: { closing_strategy?: string | null; winning_pattern?: string | null; next_steps?: string[] | null }, opts: { customerAsked?: boolean } = {}): { closing_strategy: string | null; winning_pattern: string | null; next_steps: string[] | null } {
  const cs = stripRentNegotiation(s.closing_strategy ?? null, opts);
  const wp = stripRentNegotiation(s.winning_pattern ?? null, opts);
  const ns = s.next_steps ? stripRentNegotiationFromList(s.next_steps, opts).items : null;
  return { closing_strategy: cs.text, winning_pattern: wp.text, next_steps: ns && ns.length ? ns : (s.next_steps ? [] : null) };
}

/** 全項目の判断（本分析・ゼロからの分析・前回の判断）から戦略の層を取り出す */
export function extractStrategy(meta: Record<string, unknown> | null | undefined, src: NonNullable<BrainStrategy["source"]>, prevCount: number, nowIso: string): BrainStrategy | null {
  if (!meta) return null;
  const pick = (k: string) => (nonEmpty(meta[k]) ? meta[k] : null);
  // 2026-09-23 反証者の指摘: 戦略の層（closing_strategy / winning_pattern / next_steps）は家賃交渉の守り（rent-negotiation-guard）を通っておらず、
  //   毎ターン fresh 側を上書きする一番長く居座る層だった。同じ純関数を通す（お客様が頼んだ場合は brain-core 側で方向に残るのでここは一律）
  const guardedStrategy = sanitizeStrategyFields({
    closing_strategy: pick("closing_strategy") as string | null,
    winning_pattern: pick("winning_pattern") as string | null,
    next_steps: (Array.isArray(meta.next_steps) ? (meta.next_steps as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 3) : null),
  });
  const s: BrainStrategy = {
    ...guardedStrategy,
    human_type_label: pick("human_type_label") as string | null,
    repeated_concern: pick("repeated_concern") as string | null,
    future_timeline: pick("future_timeline") as string | null,
    checkpoint_stage: pick("checkpoint_stage") as string | null,
    purchase_signal_level: pick("purchase_signal_level") as string | null,
    strategy_msg_ts: (meta.analyzed_msg_ts as string | null | undefined) ?? null,
    strategy_analyzed_at: nowIso,
    strategy_count: prevCount + 1,
    source: src,
  };
  // 戦略らしい中身が1つも無ければ戦略として扱わない（空の戦略で「前提あり」の軽い分析に切り替えない）
  return s.closing_strategy || s.winning_pattern || (s.next_steps && s.next_steps.length) ? s : null;
}

/** 今回の発言の層に渡す「前回の全体分析」のJSON（時刻などの管理用の項目は除く） */
export function strategyForPrompt(s: BrainStrategy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of ALL_STRATEGY_FIELDS) if (nonEmpty(s[f])) out[f] = s[f];
  return out;
}

/** 毎回の分析の要点（戦略の分析が「前回の戦略以降に何があったか」を整理する材料・1件100字前後） */
export type FreshDigest = {
  ts: string | null;
  intent?: string | null; q?: string[]; concern?: string | null; cond?: string | null; hes?: string | null;
  emo?: string | null; aix?: string | null; prop?: string | null; sig?: string | null; dir?: string | null; timeline?: string | null; shift?: string | null;
  /** 2026-09-23: 入口で落とした していない約束（家賃交渉）。「何を落としたか」を次の回でも追えるように残す（dir には入れない） */
  drop?: string | null;
};
export function toFreshDigest(meta: Record<string, unknown>, shift: string | null): FreshDigest {
  const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  const concern = meta.customer_concern as { topic?: unknown; object?: unknown } | null | undefined;
  return {
    ts: (meta.analyzed_msg_ts as string | null | undefined) ?? null,
    intent: str(meta.customer_intent, 20),
    q: Array.isArray(meta.customer_questions) ? (meta.customer_questions as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 2).map((x) => x.slice(0, 40)) : [],
    concern: concern ? str([concern.topic, concern.object].filter(Boolean).join(":"), 40) : null,
    cond: str(meta.condition_change_type, 20),
    hes: str(meta.hesitancy_pattern, 20),
    emo: str(meta.customer_emotion, 10),
    // 2026-09-23 課題③: 初回ガードの行（action=null）は first_contact_pickup（要対応に出した最初の一手）を残す
    aix: str(meta.action, 30) ?? str(meta.first_contact_pickup, 30),
    prop: str(meta.current_property, 40),
    sig: str(meta.purchase_signal_level, 10),
    dir: str(meta.reply_direction, 60),
    timeline: str(meta.future_timeline, 40),
    shift,
    // 2026-09-23 竹内「家賃交渉は基本できないものだからいれない」: 落とした約束は dir と分けて残す。
    //   ここに入れても次の回の方向の材料にはならない（【前回の戦略以降の…要点】は intent/concern/cond/dir を読む）
    drop: str(meta.dropped_direction, 60),
  };
}

/** 決断・断り・他決の語（戦略が変わる発言） */
const DECISION_OR_DECLINE_RE = /申し?込|契約|審査|キャンセル|他(?:の|で|社)[^。\n]{0,8}決|決め(?:ます|ました|たい)|ここにします|やめ(?:ます|ておき|とき)|見送|無しで|なしで/;

/** 今回の発言が前回の戦略とずれたか（ずれたら戦略の分析を後ろで起動する） */
export function detectStrategyShift(i: {
  fresh: Record<string, unknown>;
  strategy: BrainStrategy | null | undefined;
  turnText: string;
}): string | null {
  if (nonEmpty(i.fresh.condition_change_type)) return "condition_change";
  if (i.fresh.customer_intent === "decision") return "decision";
  if (DECISION_OR_DECLINE_RE.test(i.turnText)) return "decision_or_decline";
  const fs = i.fresh.checkpoint_stage, ss = i.strategy?.checkpoint_stage;
  if (typeof fs === "string" && fs && typeof ss === "string" && ss && fs !== ss) return "phase_change";
  return null;
}

/** 戦略の分析をやり直すか。10件・戦略が変わる発言・しばらく間が空いた時。3回に1回はゼロから */
export const STRATEGY_REFRESH_EVERY_CUSTOMER_MSGS = 10;
export const STRATEGY_REFRESH_AFTER_HOURS = 72;
export const STRATEGY_SCRATCH_EVERY = 3;
export function decideStrategyRefresh(i: {
  strategy: BrainStrategy | null | undefined;
  customerMsgsSinceStrategy: number;
  nowMs: number;
  shift: string | null;
}): { kind: "none" | "consolidate" | "scratch"; reason: string | null } {
  if (!i.strategy) return { kind: "none", reason: null };
  const analyzedMs = i.strategy.strategy_analyzed_at ? Date.parse(i.strategy.strategy_analyzed_at) : NaN;
  const hours = Number.isFinite(analyzedMs) ? (i.nowMs - analyzedMs) / 3_600_000 : Infinity;
  const reason = i.shift ? `shift:${i.shift}`
    : i.customerMsgsSinceStrategy >= STRATEGY_REFRESH_EVERY_CUSTOMER_MSGS ? `msgs:${i.customerMsgsSinceStrategy}`
      : hours >= STRATEGY_REFRESH_AFTER_HOURS && i.customerMsgsSinceStrategy >= 1 ? `hours:${Math.round(hours)}`
        : null;
  if (!reason) return { kind: "none", reason: null };
  const next = (i.strategy.strategy_count ?? 1) + 1;
  return { kind: next % STRATEGY_SCRATCH_EVERY === 0 ? "scratch" : "consolidate", reason };
}
