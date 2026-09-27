// app/lib/brain-stage.ts
// ブレインの段階（suggested_aix_meta.checkpoint_stage）と会話の方向の段階（conversation_direction.current_phase）を
// 一次事実（customer-state の12段階・status）から決める純関数（DB 依存なし・単体テスト app/lib/__tests__/brain-stage.test.ts）。
//
// 2026-09-27 竹内「この問題直して大丈夫」（お客様役 YUMA で見つかった2つ・穴:G1）
//   ① ブレインの段階に内覧（viewing）が出てこない:
//      毎回の分析の出力の説明（STATIC_BRAIN_SYSTEM の checkpoint_stage）が「hearing・proposing・applying・contract」で viewing が無かった
//      （型・許可リスト・戦略の層の説明には viewing がある）。本番30日の status=viewing の13会話はブレインの段階 proposing 12・hearing 1・viewing 0。
//      → 説明に viewing を足し（LLM が内覧の語一覧に無い希望「土曜日行けますか」も拾えるように）、
//        さらに customer-state が「内覧の場面」と決めた会話は決定論で viewing に上げる（LLM の揺れに頼らない）。
//   ② 会話の方向の段階が戦略の文の語で決まっていた（旧 brain-core detectPhaseFromBrainMeta）:
//      「…から申込へつなげる」で applying、「再・また・別」で hearing。YUMA で内覧調整中に applying・内覧確定後に hearing。
//      本番30日で applying 37件中12件がブレインの段階と食い違い。
//      → ①で直したブレインの段階から決める（語は見ない）。
//
// ── 補正の線（scripts/audit-brain-stage.ts で本番30日の前後を目で読んで決めた）──
//   ・上げるだけ（下げない）: customer-state の段階が内覧の場面（内覧調整中・内覧予定・内覧後）で、LLM が hearing / proposing / 空 の時だけ viewing。
//     LLM が viewing と言い customer-state が提案中 … LLM のまま（customer-state の内覧の希望は語の一覧で拾うので漏れがある。generate-reply resolveState の注記と同じ考え）
//     LLM が applying（申込検討中〜）で customer-state が内覧 … LLM のまま（内覧の後に「申し込みたい」は先へ進んでいる）
//   ・申込以降（申込準備・申込中・成約・見送り）は補正しない（申込以降の会話は今の改善の対象外・2026-09-26 竹内）
//   ・内覧調整中（日時がまだ）で今回お客様が新しい条件を出した（condition_change_type）時は上げない（内覧の話が止まっている）
//   ・内覧後（viewed）は「最後の内覧から VIEWED_FRESH_DAYS 日以内」だけ上げる。
//     その後に新しく物件を送れば customer-state は提案中に戻るが、送らないまま何週間も経った会話を「内覧後フォロー」の型にしない
//
// ⚠ サーバー専用ライブラリを import しない（画面・スクリプトから import する）
import type { CustomerStage } from "./customer-state";

export type BrainStage = "hearing" | "proposing" | "viewing" | "applying" | "contract";
export type DirectionPhase = "hearing" | "proposing" | "viewing" | "applying";

const BRAIN_STAGES: ReadonlySet<string> = new Set(["hearing", "proposing", "viewing", "applying", "contract"]);
export function isBrainStage(v: unknown): v is BrainStage {
  return typeof v === "string" && BRAIN_STAGES.has(v);
}

/** customer-state の段階のうち「内覧の場面」（ブレインの viewing に当たる） */
export const VIEWING_CUSTOMER_STAGES: ReadonlySet<CustomerStage> = new Set<CustomerStage>(["viewing_arranging", "viewing_scheduled", "viewed"]);
/** 内覧後（viewed）を viewing に上げる期間（最後の内覧の出来事から） */
export const VIEWED_FRESH_DAYS = 14;

export type BrainStageCorrection = {
  stage: BrainStage | null;
  /** llm＝LLM の値のまま／customer_state＝customer-state から上げた */
  source: "llm" | "customer_state";
  /** 補正した時の理由（ログ・監査用） */
  reason: string | null;
};

/**
 * ブレインの段階を customer-state の事実で補正する（上げるだけ）。
 * @param llmStage    LLM の checkpoint_stage（許可リストを通した後の値）
 * @param customer    customer-state の段階と、その段階になった時刻（since）。読めなかった時は null（LLM のまま）
 * @param nowMs       今の時刻（内覧後の鮮度の判定）
 */
export function correctBrainStage(
  llmStage: string | null | undefined,
  customer: { stage: CustomerStage; since: string | null } | null | undefined,
  nowMs: number = Date.now(),
  opts: { conditionChangeType?: string | null } = {},
): BrainStageCorrection {
  const llm = isBrainStage(llmStage) ? llmStage : null;
  const keep: BrainStageCorrection = { stage: llm, source: "llm", reason: null };
  if (!customer) return keep;
  if (!VIEWING_CUSTOMER_STAGES.has(customer.stage)) return keep;
  if (llm !== null && llm !== "hearing" && llm !== "proposing") return keep;
  // 日時の決まっていない内覧の調整中に、今回お客様が新しい条件で探してと言った（ブレインの condition_change_type）→ 内覧の話は止まっている。
  //   実物 3db9db75: 「内覧してみたいです」→ こちら「既にご契約が決まったお部屋」→「芦原橋らへんも探してほしいです」（customer-state は内覧調整中のまま）
  if (customer.stage === "viewing_arranging" && opts.conditionChangeType) return keep;
  if (customer.stage === "viewed") {
    const sinceMs = customer.since ? Date.parse(customer.since) : NaN;
    if (!Number.isFinite(sinceMs) || nowMs - sinceMs > VIEWED_FRESH_DAYS * 86_400_000) return keep;
  }
  return { stage: "viewing", source: "customer_state", reason: `customer_state:${customer.stage}` };
}

/** 状態（status）のうち申込以降（スタッフ・審査管理が決める＝正） */
const APPLY_STATUSES: ReadonlySet<string> = new Set(["applying", "application", "screening"]);

/**
 * 会話の方向の段階（conversation_direction.current_phase）。戦略の文の語は見ない。
 *   1. status が申込以降 → applying（旧 detectPhaseFromBrainMeta の P7 と同じ最優先）
 *   2. ブレインの段階（補正後・今回の層と戦略の層を合成した値）。contract は applying に畳む（方向の段階は4つ）
 *   3. 段階が無い時は status から粗く（旧 STATUS_TO_PHASE と同じ写像・status=viewing は審査管理の同期で古いことが多いので proposing）
 *   4. それも無ければ hearing（旧の既定）
 *   申込経験者（2番手落ち・審査落ち・キャンセル後に別の物件を探す）は hearing に降格しない（旧の「フェーズ降格バグ修正」を引き継ぐ）
 */
export function resolveDirectionPhase(i: {
  checkpointStage: string | null | undefined;
  status: string | null | undefined;
  hasApplicationHistory?: boolean;
}): DirectionPhase {
  const status = (i.status ?? "").trim();
  if (APPLY_STATUSES.has(status)) return "applying";
  let phase: DirectionPhase;
  const cs = isBrainStage(i.checkpointStage) ? i.checkpointStage : null;
  if (cs) phase = cs === "contract" ? "applying" : cs;
  else phase = STATUS_FALLBACK_PHASE[status] ?? "hearing";
  if (phase === "hearing" && i.hasApplicationHistory) return "proposing";
  return phase;
}

const STATUS_FALLBACK_PHASE: Record<string, DirectionPhase> = {
  first_reply: "hearing",
  hearing: "hearing",
  condition_hearing: "hearing",
  property_search: "hearing",
  proposing: "proposing",
  property_recommendation: "proposing",
  estimate_request: "proposing",
  availability_check: "proposing",
  viewing: "proposing",
};
