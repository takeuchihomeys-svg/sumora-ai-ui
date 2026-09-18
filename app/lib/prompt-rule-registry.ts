// app/lib/prompt-rule-registry.ts
// 「ai_prompt_rules のこの行は、本当にプロンプトに届くのか」を1か所で決める（純関数・DB 依存なし）。
//
// 2026-09-18 竹内「改善おねがい」: 本番ログに毎回出ていた
//   [fetchPromptRules] unknown condition_key "vacancy_status" in rule — rule skipped
// を追ったところ、ルールが DB にあるのに**一度も届いていない**行が11件見つかった。
//   ・PROP-VCC-001（2026-07-09）… condition_key='vacancy_status' を渡す呼び出しが存在しない
//   ・CLOSEDWON-ALL-1/2/3（2026-08-29・priority 80）… action_type='all' は fetch されない値
//   ・DIFF-POLICY-AIX-* 7件 … action_type に conversation_state（applying / zenryoku_support）が入っている
//
// 根本原因: action_type という1つの列に**4種類の意味**が混ざっていた
//   ①AIX アクション名（property_send…）②generate_reply / final_check ③conversation_state（applying…）④"all"
// ②③は書き込む側が「表に無い値でも黙って保存する」ため、保存には成功して配信だけが黙って落ちる。
//
// 設計知見「知らないキーが黙ってデフォルトに落ちる」「未対応の分岐は静かにデータを消す」「タグが割れると
//   貯まっているのに読まれない」と同じ形。**読む側の表を1つ持ち、書く側もそれで検証する**（四者同名）。

/** 1つの action_type で fetch する経路の仕様 */
export type PromptRuleRouteSpec = {
  /** どのファイルが取りに行くか（監査の表示用） */
  callers: string[];
  /** この action_type の**すべての**呼び出しが conditions に渡すキー */
  always: readonly string[];
  /** 一部の呼び出しだけが渡すキー（渡さない経路ではそのルールは落ちる） */
  sometimes?: readonly string[];
};

/**
 * AIX アクション名（画面のボタン）。aix-template-generate は actionType をそのまま
 * getCachedPromptRules(actionType, { conversation_state }) に渡すので、**この一覧は全部が到達可能**。
 * aix/action 側は一部のアクションだけが自前で fetchPromptRulesSplit を呼ぶ（呼ばないアクションは
 * 「✨ 会話を合わせる」経由でしか届かない＝下の callers に aix/action が無い物）。
 * 一覧は app/api/aix/adapt-feedback/route.ts の VALID_ADAPT_ACTION_TYPES と揃える。
 */
const AIX_ROUTE = (opts: { fromAixAction?: boolean; sometimes?: readonly string[] } = {}): PromptRuleRouteSpec => ({
  callers: opts.fromAixAction
    ? ["app/api/aix/action/route.ts", "app/api/aix-template-generate/route.ts"]
    : ["app/api/aix-template-generate/route.ts"],
  always: [],
  sometimes: ["conversation_state", ...(opts.sometimes ?? [])],
});

/**
 * 実際に fetchPromptRules / fetchPromptRulesSplit / getCachedPromptRules が渡している action_type。
 * ここに無い値で保存された行は DB にあってもプロンプトに届かない。
 * ※ 呼び出しを足したらこの表も足す（テスト prompt-rule-registry.test.ts が表の自己整合を見る）
 */
export const PROMPT_RULE_ROUTES: Readonly<Record<string, PromptRuleRouteSpec>> = {
  // 返信生成（最も広い経路。global＝action_type IS NULL もここに乗る）
  generate_reply: {
    callers: ["app/api/generate-reply/route.ts", "app/api/aix-template-generate/route.ts"],
    always: ["conversation_state"],
    // generate-reply だけが渡す（aix-template-generate は渡さない）
    sometimes: ["is_first_reply"],
  },
  final_check: { callers: ["app/api/generate-reply/route.ts"], always: [] },

  // ── AIX アクション（aix/action が自前で引く物）──
  property_recommendation: AIX_ROUTE({ fromAixAction: true }),
  property_send: AIX_ROUTE({ fromAixAction: true, sometimes: ["send_mode"] }),
  property_check_result: AIX_ROUTE({ fromAixAction: true, sometimes: ["check_pattern"] }),
  application_push: AIX_ROUTE({ fromAixAction: true, sometimes: ["has_estimate", "app_sub_mode"] }),
  greeting_viewing: AIX_ROUTE({ fromAixAction: true, sometimes: ["sub_mode"] }),
  followup_revive: AIX_ROUTE({ fromAixAction: true, sometimes: ["follow_sub_mode"] }),
  viewing_invite: AIX_ROUTE({ fromAixAction: true }),
  estimate_sheet: AIX_ROUTE({ fromAixAction: true }),
  condition_hearing: AIX_ROUTE({ fromAixAction: true }),
  meeting_place: AIX_ROUTE({ fromAixAction: true }),
  acknowledge_check: AIX_ROUTE({ fromAixAction: true }),
  cost_breakdown: AIX_ROUTE({ fromAixAction: true }),
  phone_followup: AIX_ROUTE({ fromAixAction: true }),
  guarantor_info: AIX_ROUTE({ fromAixAction: true }),
  // ── AIX アクション（aix/action は自前で引かない＝「✨ 会話を合わせる」経由でだけ届く）──
  //   2026-09-18: zenryoku_support（全力サポート）はここ。action_type としては正しい値なので
  //   「誰も取りに行かない」ではないが、AIX 本体の生成には効かない
  zenryoku_support: AIX_ROUTE(),
  property_search: AIX_ROUTE(),
  acknowledge_result: AIX_ROUTE(),
};

/** fetch される action_type（これ以外の値で保存された行は届かない） */
export const PROMPT_RULE_ACTION_TYPES: ReadonlySet<string> = new Set(Object.keys(PROMPT_RULE_ROUTES));

/** どこかの経路が渡す condition_key の全体 */
export const PROMPT_RULE_CONDITION_KEYS: ReadonlySet<string> = new Set(
  Object.values(PROMPT_RULE_ROUTES).flatMap((r) => [...r.always, ...(r.sometimes ?? [])]),
);

/** 非永久ルールがプロンプトに入る下限（prompt-rules.ts queryRuleRows と同じ値） */
export const PROMPT_RULE_MIN_PRIORITY = 4;
/** 1回のフェッチで取る上限（prompt-rules.ts queryRuleRows と同じ値） */
export const PROMPT_RULE_LIMIT_PERMANENT = 80;
export const PROMPT_RULE_LIMIT_HIGH = 200;

export type RuleReachability =
  | {
      reachable: true;
      /** その condition_key を渡さない経路がある（そこでは落ちる） */
      partial?: { routes: string[]; conditionKey: string };
      /** AIX 本体（aix/action）は引かず、「✨ 会話を合わせる」経由でだけ届く */
      templateOnly?: boolean;
    }
  | { reachable: false; reason: ReachabilityFailure; detail: string };

export type ReachabilityFailure =
  | "inactive"              // is_active=false
  | "unknown_action_type"   // その action_type を取りに行く呼び出しが無い
  | "unknown_condition_key" // その condition_key を渡す呼び出しが無い（＝永久に skip）
  | "condition_without_value" // condition_key があるのに condition_value が無い（条件が効かない）
  | "below_priority"        // priority < 4（is_permanent=false）
  | "learn_excluded";       // LEARN-*（LEARN-AIX-* 以外）は既定で除外される

export type PromptRuleAuditRow = {
  rule_key: string;
  action_type: string | null;
  condition_key: string | null;
  condition_value: string | null;
  priority: number | null;
  is_active: boolean | null;
  is_permanent: boolean | null;
};

/**
 * この行がプロンプトに届くか。届かないなら理由を返す。
 * 上限（200件）で落ちるかは他の行との相対なのでここでは見ない（点検スクリプトが別に数える）。
 */
export function classifyPromptRuleReachability(row: PromptRuleAuditRow): RuleReachability {
  if (row.is_active === false) return { reachable: false, reason: "inactive", detail: "is_active=false" };

  if (row.rule_key.startsWith("LEARN-") && !row.rule_key.startsWith("LEARN-AIX-")) {
    return { reachable: false, reason: "learn_excluded", detail: "LEARN-* は既定で除外（includeLearnAix でも LEARN-AIX-* のみ）" };
  }

  // action_type: null は global（includeGlobal=true の全経路に乗る）
  const at = row.action_type;
  if (at !== null && at !== undefined && !PROMPT_RULE_ACTION_TYPES.has(at)) {
    return { reachable: false, reason: "unknown_action_type", detail: `action_type="${at}" を取りに行く呼び出しが無い（global にするなら null）` };
  }

  if (row.is_permanent !== true && (row.priority ?? 0) < PROMPT_RULE_MIN_PRIORITY) {
    return { reachable: false, reason: "below_priority", detail: `priority=${row.priority} < ${PROMPT_RULE_MIN_PRIORITY}` };
  }

  const templateOnly = !!at && PROMPT_RULE_ROUTES[at]?.callers.length === 1
    && PROMPT_RULE_ROUTES[at].callers[0].includes("aix-template-generate");

  const ck = row.condition_key;
  if (ck) {
    if (row.condition_value === null || row.condition_value === undefined) {
      // 実装上は「条件なし」として通るが、条件を付けたつもりの行なので設定ミスとして出す
      return { reachable: false, reason: "condition_without_value", detail: `condition_key="${ck}" に condition_value が無い（条件が効かない）` };
    }
    // global（null）は全経路に乗るので、全経路が渡すキーでなければ落ちる経路がある
    const routes = at ? [at] : Object.keys(PROMPT_RULE_ROUTES);
    const passedBy = routes.filter((r) => {
      const spec = PROMPT_RULE_ROUTES[r];
      return !!spec && ([...spec.always, ...(spec.sometimes ?? [])].includes(ck));
    });
    if (passedBy.length === 0) {
      return { reachable: false, reason: "unknown_condition_key", detail: `condition_key="${ck}" を渡す呼び出しが無い（この行は永久に skip される）` };
    }
    const alwaysBy = routes.filter((r) => PROMPT_RULE_ROUTES[r]?.always.includes(ck));
    if (alwaysBy.length < routes.length) {
      return { reachable: true, partial: { routes: routes.filter((r) => !alwaysBy.includes(r)), conditionKey: ck }, ...(templateOnly ? { templateOnly } : {}) };
    }
  }
  return templateOnly ? { reachable: true, templateOnly } : { reachable: true };
}

/**
 * 書き込む側が使う: 表に無い action_type は global（null）に倒す。
 * 「保存はできたが誰にも届かない」行を新しく作らないための門（analyze-diffs / ai-feedback）。
 */
export function normalizePromptRuleActionType(raw: string | null | undefined): {
  actionType: string | null;
  fellBackToGlobal: boolean;
  original: string | null;
} {
  const v = (raw ?? "").trim();
  if (!v) return { actionType: null, fellBackToGlobal: false, original: null };
  if (PROMPT_RULE_ACTION_TYPES.has(v)) return { actionType: v, fellBackToGlobal: false, original: v };
  return { actionType: null, fellBackToGlobal: true, original: v };
}

/** 届かない理由の日本語ラベル（ログ・点検スクリプト共通） */
export const REACHABILITY_LABELS: Record<ReachabilityFailure, string> = {
  inactive: "無効（is_active=false）",
  unknown_action_type: "誰も取りに行かない action_type",
  unknown_condition_key: "誰も渡さない condition_key",
  condition_without_value: "条件の値が無い",
  below_priority: "priority が下限未満",
  learn_excluded: "LEARN-* は既定で除外",
};
