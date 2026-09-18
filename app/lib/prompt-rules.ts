import { supabase } from "@/app/lib/supabase";
import {
  formatPromptRuleSections, promptRuleMatchesConditions, dedupePromptRules, promptRuleNotExcluded,
  type PromptRuleRow, type PromptRuleConditions,
} from "@/app/lib/prompt-rules-format";

export type { PromptRuleRow, PromptRuleConditions } from "@/app/lib/prompt-rules-format";
// 2026-09-18 上限・下限は prompt-rule-registry.ts の1つの表と同じ値を使う（点検スクリプトが同じ数で数える）
import { PROMPT_RULE_LIMIT_HIGH, PROMPT_RULE_LIMIT_PERMANENT, PROMPT_RULE_MIN_PRIORITY } from "@/app/lib/prompt-rule-registry";

// 2026-09-16 竹内（カイナ事例）: 経路ごとに材料を分ける。会話を合わせる（物件確認した）には、通常返信用の「物件画像→見積書作成宣言」
//   「内覧案内を混ぜるな」（PROP-URL-REPLY-001・FEEDBACK-d6f30f25）や構成を足す DIFF-POLICY-* を渡さない
export type PromptRuleExclude = { keyPrefixes?: string[]; keys?: string[] };

type RuleRows = { permanent: PromptRuleRow[]; high: PromptRuleRow[] };

// ③ DB障害時: サイレント消失を防ぐ。空文字ではなく警告テキストを返してAIに認知させる
const RULES_DB_ERROR_TEXT = "\n\n【重要: ルールDBへの接続に失敗しました。基本的な敬語・正確な情報提供・謝罪禁止の原則を守って回答してください。】";
const RULES_SYSTEM_ERROR_TEXT = "\n\n【重要: ルールシステムエラーが発生しました。基本的な敬語・正確な情報提供・謝罪禁止の原則を守って回答してください。】";

// ── 枠取り方式 ──
// LEARN-* が数千件あり、単一クエリ LIMIT 100 だと priority=8 の LEARN-* が枠を埋め尽くして
// HUMAN-*(priority=10) / FEEDBACK-*(priority=8) / IMPLEMENT-*(priority=7) が届かなくなる。
// → 非LEARN上位70件 + LEARN上位60件を別枠で取得してから priority 降順で結合する。
function buildBaseQuery(actionType: string | null, includeGlobal: boolean, includeLearnAix: boolean, exclude: PromptRuleExclude) {
  let q = supabase
    .from("ai_prompt_rules")
    .select("rule_key, rule_text, condition_key, condition_value, priority")
    .eq("is_active", true);
  if (actionType) {
    // includeGlobal=true（デフォルト）: 専用ルール + global共通ルール（action_type IS NULL）
    // includeGlobal=false: 専用ルールのみ（global混入を防ぐ。final_check等で使用）
    if (includeGlobal) {
      q = q.or(`action_type.eq.${actionType},action_type.is.null`);
    } else {
      q = q.eq("action_type", actionType);
    }
  } else {
    q = q.is("action_type", null);
  }
  // LEARN-* 除外フィルタ（両クエリ共通のためここで適用）
  // includeLearnAix=true: LEARN-AIX-* のみ許可（PostgRESTのor構文はワイルドカードに * を使う）
  if (includeLearnAix) {
    q = q.or("rule_key.not.like.LEARN-*,rule_key.like.LEARN-AIX-*");
  } else {
    q = q.not("rule_key", "like", "LEARN-%");
  }
  for (const p of exclude.keyPrefixes ?? []) q = q.not("rule_key", "like", `${p}%`);
  if (exclude.keys?.length) q = q.not("rule_key", "in", `(${exclude.keys.join(",")})`);
  return q;
}

// ── 2クエリを並列実行（Promise.all）──
// [1] 永久ルール（is_permanent=true）: 通常の150件上限・priority閾値とは独立した別枠（上限80件）。
// [2] FEEDBACK-* / IMPLEMENT-* 等（LEARN-*はPhase1で廃止済み・HUMAN-*はRAGへ完全移行）
// ナレッジはfetchKnowledge()のpgvector RAGで届くため ai_prompt_rules への重複注入不要
//
// priority >= 4 のみ注入（decayを実際に機能させるための閾値）:
// ai-feedback/route.ts の90日decayは古いFEEDBACK-*を priority=2 に demote するが、
// 閾値なしで priority 降順 LIMIT 150 だと総件数が150未満の間は demote 済みルールも
// 全件注入され続け、decayが no-op になる。priority 3以下は注入対象から外す。
// （BOUNDARY-* は priority=9 かつ decay 対象外のため、この閾値の影響を受けない）
//
// 2026-09-17 竹内（AIX キャッシュ点検）: order の最終キーに rule_key を足す。priority・updated_at が同値の行の並びが
//   呼び出しごとに揺れると、同じルール集合でも文字列が変わってプロンプトキャッシュの鍵が外れる
async function queryRuleRows(actionType: string | null, includeGlobal: boolean, includeLearnAix: boolean, exclude: PromptRuleExclude): Promise<RuleRows | { error: unknown }> {
  const [permanentRes, highPrioRes] = await Promise.all([
    buildBaseQuery(actionType, includeGlobal, includeLearnAix, exclude)
      .eq("is_permanent", true)
      .order("priority", { ascending: false })
      .order("updated_at", { ascending: false, nullsFirst: false })
      .order("rule_key", { ascending: true })
      .limit(PROMPT_RULE_LIMIT_PERMANENT)
      .abortSignal(AbortSignal.timeout(8_000)),
    buildBaseQuery(actionType, includeGlobal, includeLearnAix, exclude)
      .eq("is_permanent", false)
      .gte("priority", PROMPT_RULE_MIN_PRIORITY)
      .order("priority", { ascending: false })
      .order("updated_at", { ascending: false, nullsFirst: false })
      .order("rule_key", { ascending: true })
      .limit(PROMPT_RULE_LIMIT_HIGH)
      .abortSignal(AbortSignal.timeout(8_000)),
  ]);
  if (highPrioRes.error || permanentRes.error) return { error: highPrioRes.error ?? permanentRes.error };
  const permanent = (permanentRes.data ?? []) as PromptRuleRow[];
  const high = (highPrioRes.data ?? []) as PromptRuleRow[];
  // 2026-09-18 竹内「改善おねがい」: 上限に張り付いた時は「後ろが落ちている」ことを必ず出す。
  //   generate_reply は該当 429 件に対して上限 200 で **229 件が黙って落ちていた**（priority 7 の境目で、
  //   同じ priority の中は更新日の新しい順。古い方は永久に入らない）。件数が見えないと誰も気付けない。
  if (high.length >= PROMPT_RULE_LIMIT_HIGH || permanent.length >= PROMPT_RULE_LIMIT_PERMANENT) {
    console.warn(JSON.stringify({
      tag: "prompt-rules:limit-hit",
      actionType: actionType ?? "(global)",
      includeGlobal,
      high: high.length,
      permanent: permanent.length,
      lowestPriorityKept: high.length ? high[high.length - 1]?.priority ?? null : null,
      note: "上限に達しました。これより priority の低い（同値なら更新の古い）ルールは注入されていません",
    }));
  }
  return { permanent, high };
}

/**
 * ai_prompt_rules テーブルから適用可能なルールを取得し、プロンプト注入用文字列を返す
 * DB取得失敗はサイレントに "" を返してメイン処理を止めない。
 *
 * @param actionType アクション種別 ('application_push'/'viewing_invite'/'generate_reply'/null=globalのみ)
 * @param conditions 現在の条件マップ (例: { has_estimate: 'true', app_sub_mode: 'push' })
 *
 * 2026-09-17 竹内（AIX キャッシュ点検）: global と action 別を分けて受けたい時は fetchPromptRulesSplit。
 *   こちらは従来どおり「global＋action 別を1つの query で取り priority 順に混ぜて1本の文字列」を返す（generate_reply は
 *   action 別 326件＋global 102件で上限 200 に掛かるため、split と同じ2本のクエリに寄せると届くルールが変わる。既存の出力を変えない）。
 */
export async function fetchPromptRules(
  actionType: string | null,
  conditions: PromptRuleConditions = {},
  includeGlobal = true, // false のとき globalフォールバック（action_type IS NULL）を除外する。
                        // final_check など「専用ルールのみ」を取りたい場合に使う。
                        // DB に専用ルールが0件なら空文字を返す（汚染なし）。
  includeLearnAix = false,  // true のとき LEARN-AIX-* ルール（aix-weekly-learning / analyze-diffs が
                           // action_type=AIXアクション別に蓄積する編集差分学習ルール）を除外対象から外す。
                           // 旧世代の generate_reply 向け LEARN-*（廃止済み・数千件）は引き続き除外。
  exclude: PromptRuleExclude = {},
): Promise<string> {
  try {
    const rows = await queryRuleRows(actionType, includeGlobal, includeLearnAix, exclude);
    if ("error" in rows) {
      console.error("[fetchPromptRules] CRITICAL: DBクエリ失敗 — ルールが注入されません", rows.error);
      return RULES_DB_ERROR_TEXT;
    }

    // 条件フィルタ（永久ルールにも条件は適用する）
    const permanentApplicable = rows.permanent.filter((r) => promptRuleMatchesConditions(r, conditions));
    const applicable = rows.high.filter((r) => promptRuleMatchesConditions(r, conditions));

    // rule_textで重複排除（priority降順ソート済みなので最初の出現を残す）
    const deduped = dedupePromptRules(applicable);

    // ── 永久ルール（卒業済み・絶対に漏れない）── → 【永久ルール】節
    // FEEDBACK-* / IMPLEMENT-* 等を priority 降順で注入 → 【AI学習ルール】節
    // HUMAN-* は is_active=false（RAGへ完全移行済み）のためここには現れない
    return formatPromptRuleSections(permanentApplicable, deduped);
  } catch (error) {
    console.error("[fetchPromptRules] CRITICAL: 予期しないエラー — ルールが注入されません", error);
    return RULES_SYSTEM_ERROR_TEXT;
  }
}

// ── global（action_type IS NULL）の行のモジュール変数キャッシュ（5分・Promise ごと）──────────────
// 2026-09-17 竹内（AIX キャッシュ点検）: global は 113 件（≈12k tokens）で不変。AIX の全経路が同じ文字列を準静的ブロック（1h）に
//   置けるよう、行を1回だけ取ってメモリに持つ。exclude・conditions は取得後にコードで掛ける（経路ごとの exclude でキャッシュを分けない）。
//   ・global に condition_key 付きの行は 0 件（2026-09-17 SQL で確認: 113件中 with_condition=0）。付いた場合は conditions で global の文字列も
//     変わり得る（＝その経路だけ準静的ブロックの鍵が別になる）。global にルールを足す時は condition_key を付けない
//   ・global に LEARN-AIX-* の行は 0 件（同 SQL）。ここでは LEARN-% を常に除外して取る（includeLearnAix は action 側だけに効く）
//   ・exclude が global の行に当たる経路は global の文字列が1行分ずれ、準静的ブロックの鍵がその経路だけ別になる
//     （2026-09-17 SQL で確認: 物件確認結果・会話を合わせる（aix/action 4216）の exclude keys のうち PROP-URL-REPLY-001 は global。
//     FEEDBACK-d6f30f25 は存在せず、DIFF-POLICY-* は global に無い）。そのままでも動くが、全経路で鍵を共有したいなら
//     除外を global 側でなく経路固有ブロックの打ち消し文で行うか、その行を action 別に移す
//   ・失敗した Promise はキャッシュに残さない（次の呼び出しで取り直す）
const GLOBAL_RULES_TTL_MS = 5 * 60 * 1000;
let _globalRulesCache: { p: Promise<RuleRows>; exp: number } | null = null;

function loadGlobalRuleRows(): Promise<RuleRows> {
  const now = Date.now();
  if (_globalRulesCache && now < _globalRulesCache.exp) return _globalRulesCache.p;
  const p = queryRuleRows(null, true, false, {}).then((r) => {
    if ("error" in r) throw r.error;
    return r;
  });
  const entry = { p, exp: now + GLOBAL_RULES_TTL_MS };
  _globalRulesCache = entry;
  p.catch(() => { if (_globalRulesCache === entry) _globalRulesCache = null; });
  return p;
}

export type PromptRulesSplit = {
  /** global（action_type IS NULL）の整形済み文字列。全 AIX で同じ（exclude が空で、global に condition_key 付きの行が無い限り） */
  global: string;
  /** action 別の整形済み文字列（actionType が null なら ""） */
  action: string;
};

/**
 * ai_prompt_rules を global（action_type IS NULL）と action 別に分けて返す。
 * それぞれ fetchPromptRules と同じ整形（【永久ルール】【AI学習ルール】の見出し・【線引き】接頭辞・先頭 "\n\n"）。
 * 呼び出し側は global を準静的ブロック（cache 1h）、action を経路固有ブロック（5m）に置く（app/lib/aix-system-blocks.ts）。
 *
 * 2026-09-17 竹内（AIX キャッシュ点検）: AIX では fetchPromptRules の結果をキャッシュ外の dynamicSystemSuffix に入れている経路が多く、
 *   不変の global ≈12k tokens を毎回割引なしで送っていた。
 * ・global は 5 分のモジュール変数キャッシュ（loadGlobalRuleRows）。action 別は毎回取る（2本のクエリ・上限 80/200 は action 側だけに使える）
 * ・rule_text の重複は global 側を優先して action 側から落とす（従来の「priority 順で最初の出現を残す」に合わせて二重注入を防ぐ）
 * ・DB 障害時は global に従来と同じ警告テキストを入れて返す（action は ""）
 */
export async function fetchPromptRulesSplit(
  actionType: string | null,
  conditions: PromptRuleConditions = {},
  opts: { includeLearnAix?: boolean; exclude?: PromptRuleExclude } = {},
): Promise<PromptRulesSplit> {
  const includeLearnAix = opts.includeLearnAix ?? false;
  const exclude = opts.exclude ?? {};
  try {
    const [globalRes, actionRes] = await Promise.all([
      loadGlobalRuleRows().catch((error: unknown) => ({ error })),
      actionType
        ? queryRuleRows(actionType, false, includeLearnAix, exclude)
        : Promise.resolve<RuleRows>({ permanent: [], high: [] }),
    ]);
    if ("error" in globalRes || "error" in actionRes) {
      const err = "error" in globalRes ? globalRes.error : (actionRes as { error: unknown }).error;
      console.error("[fetchPromptRulesSplit] CRITICAL: DBクエリ失敗 — ルールが注入されません", err);
      return { global: RULES_DB_ERROR_TEXT, action: "" };
    }

    const keep = (r: PromptRuleRow) => promptRuleNotExcluded(r, exclude) && promptRuleMatchesConditions(r, conditions);
    const globalPermanent = globalRes.permanent.filter(keep);
    const globalHigh = dedupePromptRules(globalRes.high.filter(keep));

    // action 側: exclude は SQL で掛かっている。global にある文は落とす
    const seen = new Set(globalHigh.map((r) => r.rule_text));
    const actionPermanent = actionRes.permanent.filter((r) => promptRuleMatchesConditions(r, conditions));
    const actionHigh = dedupePromptRules(actionRes.high.filter((r) => promptRuleMatchesConditions(r, conditions)), seen);

    return {
      global: formatPromptRuleSections(globalPermanent, globalHigh),
      action: formatPromptRuleSections(actionPermanent, actionHigh),
    };
  } catch (error) {
    console.error("[fetchPromptRulesSplit] CRITICAL: 予期しないエラー — ルールが注入されません", error);
    return { global: RULES_SYSTEM_ERROR_TEXT, action: "" };
  }
}
