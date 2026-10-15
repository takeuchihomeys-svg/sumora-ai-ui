// app/lib/prefix-warm.ts
// Claude の固定の前置き（1h キャッシュ）を営業時間（JST 9〜22）だけ温める — 対象の作り方・温める／温めないの判断・効いたかの読み方（純関数・DB なし）
//
// 2026-09-29 竹内「クロードの部分、キャッシュを営業時間中温めるのはどうかな」→「それで進めて大丈夫。設計知見と協力して行う」:
//   対象は3つ（最終チェックの4段・お客様の要約・次の一手の予想）。本番7日（9/22〜29）の llm_usage_logs で命中しない原因を実物の鍵で見ると、
//   ①最終チェック: 鍵は1種類ずつ（DB ルール更新で3回替わっただけ）。書き直し（rule_check 27.5k×29回・書き直し 26k×24回・context 10k×30回）は
//     営業時間中でも1時間以上空くため。system が無く sys_key が null だった → 固定の前置きを system に移した（final-check.ts）
//   ②お客様の要約: 鍵1種類・194回中168回命中。24% は前置き 1.9k／入力 6.7k の構造 → 全お客様共通の改善ルールを system[1] へ
//   ③次の一手: 鍵が毎日替わる（aix_flow_guide の日次書き直しが固定ブロックの末尾）→ ガイドを system[1] に分けた
//   温めはブレインの温め（brain-warm.ts・brain-sweep）と同じ型: 本物と同じ関数で前置きを作る・最後の本物／温めから 50〜58 分の窓だけ・
//   冷えていたら書かずに退く（書き込みは次の本物に払わせる）・1日の上限・claim 先行・失敗したら claim を戻す。判断は decideBrainWarm をそのまま使う。
//   名札は brain で始めない（llm-test-mode.isBrainCall がブレイン扱いにする）。止める: PREFIX_WARM=off。時間帯: PREFIX_WARM_HOURS_JST（既定 "9-22"）
import { decideBrainWarm, type BrainWarmInput, type BrainWarmDecision } from "./brain-warm";
import { systemFullKey } from "./llm-usage-recorder";
import { buildFinalCheckWarmBodies, type FinalCheckWarmInputs } from "./final-check";
import { buildCustomerSummarySystemBlocks, buildCustomerSummaryWarmBody, CUSTOMER_SUMMARY_MODEL } from "./customer-summary-prompt";
import { buildSuggestNextActionSystemBlocks, buildSuggestNextActionWarmBody, SUGGEST_NEXT_ACTION_MODEL, type SuggestNextActionPrefixInputs } from "./suggest-next-action-prompt";
import { aixTemplateStaticSystemText } from "./aix-template-system";
import { aixTemplateCacheTtl } from "./aix-template-cache";
import { isOffSwitch } from "./brain-night-defer";

export const PREFIX_WARM_DEFAULTS = {
  hoursJst: "9-22",
  /** 1対象あたり1日の上限（9〜22時で最大 13〜15 回。暴走の型の上限） */
  maxPerDay: 20,
} as const;

/** llm_warm_prefixes の claim 行の hash の頭。keep-warm（返信生成）の候補クエリは 'warm:%' も除外する */
export const PREFIX_WARM_HASH_PREFIX = "warm:";

export type PrefixWarmName =
  | "final_check_warm_rule_check" | "final_check_warm_anomaly_scan" | "final_check_warm_context_check" | "final_check_warm_revision"
  | "customer_summary_warm" | "suggest_next_action_warm" | "aix_template_warm";

export type WarmSystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } };

export type PrefixWarmTarget = {
  /** 温めの名札（x-sumora-llm-action）。brain で始めない */
  name: PrefixWarmName;
  /** 本物の呼び出しの名札（最後の本物を llm_usage_logs から探す） */
  realActions: string[];
  model: string;
  /** llm_usage_logs.sys_key_full と同じ計算（system 全ブロックの text を "\n\n" で結合 → shortHash） */
  key: string;
  /** そのまま /v1/messages に送る body（max_tokens 1・user "."） */
  body: Record<string, unknown> & { model: string; system: WarmSystemBlock[] };
  /** system が2ブロック以上ある時: cache_read がこれ以上なら「先頭は当たり・後ろのブロックだけ書いた」（DB 更新の前払い）。1ブロックなら Infinity（書きは全部 cold） */
  staticHitMinRead: number;
  /** 前置きの文字数（費用の目安） */
  chars: number;
  /**
   * true: 「最後の本物」を鍵（sys_key_full）で絞らず名札だけで探す。温めるのが本物の system の**先頭ブロックだけ**の時
   * （本物の鍵は後ろのブロック込みで別の値になる）。2026-10-15 aix_template_warm
   */
  anyRealKey?: boolean;
};

export type PrefixWarmInputs = {
  finalCheck: FinalCheckWarmInputs;
  summary: { systemPrompt: string; nextActionRuleContents: string[] };
  /** null＝次の一手の LLM を止めている（2026-10-08 一本化・SUGGEST_NEXT_ACTION_LLM が on でない）→ 温めない */
  nextAction: SuggestNextActionPrefixInputs | null;
  /** true＝AIX の文作り（aix_template）の先頭ブロックも温める（aixTemplateWarmEnabled）。無い／false＝温めない（今まで通り） */
  aixTemplate?: boolean;
  /** 2026-10-15: aix_template の後ろのブロックのうちボタンに依らない部分（aixTemplateSharedParts）。無い＝先頭だけ温める */
  aixTemplateShared?: readonly { text: string }[];
};

function chars(blocks: WarmSystemBlock[]): number { return blocks.reduce((n, b) => n + b.text.length, 0); }

/** 純関数。3つの経路の前置きを本物と同じ関数で作り、温めの対象（6つ）にする */
export function buildPrefixWarmTargets(i: PrefixWarmInputs): PrefixWarmTarget[] {
  const out: PrefixWarmTarget[] = [];
  for (const fc of buildFinalCheckWarmBodies(i.finalCheck)) {
    const system = fc.body.system as WarmSystemBlock[];
    out.push({
      name: `final_check_warm_${fc.pass}` as PrefixWarmName,
      realActions: [`final_check_${fc.pass}`],
      model: fc.model,
      key: systemFullKey(system) ?? "",
      body: fc.body as unknown as PrefixWarmTarget["body"],
      // 書き直し（revision）だけ system が2ブロック（固定の指示 ≈3k → 会社ルール ≈23k）。先頭が当たっていれば read ≥ 2,000
      staticHitMinRead: system.length >= 2 ? 2_000 : Infinity,
      chars: chars(system),
    });
  }
  const sumBlocks = buildCustomerSummarySystemBlocks(i.summary.systemPrompt, i.summary.nextActionRuleContents);
  out.push({
    name: "customer_summary_warm", realActions: ["customer_summary"], model: CUSTOMER_SUMMARY_MODEL,
    key: systemFullKey(sumBlocks) ?? "", body: buildCustomerSummaryWarmBody(sumBlocks),
    // system[0]=SYSTEM ≈1.9k・system[1]=改善ルール。先頭が当たっていれば read ≥ 1,500
    staticHitMinRead: sumBlocks.length >= 2 ? 1_500 : Infinity, chars: chars(sumBlocks),
  });
  if (i.nextAction) {
    const naBlocks = buildSuggestNextActionSystemBlocks(i.nextAction);
    out.push({
      name: "suggest_next_action_warm", realActions: ["suggest_next_action"], model: SUGGEST_NEXT_ACTION_MODEL,
      key: systemFullKey(naBlocks) ?? "", body: buildSuggestNextActionWarmBody(naBlocks),
      // system[0]=絶対ルール＋AIX ロジック ≈5.7k・system[1]=フロー運用ガイド ≈0.4k。先頭が当たっていれば read ≥ 4,000
      staticHitMinRead: naBlocks.length >= 2 ? 4_000 : Infinity, chars: chars(naBlocks),
    });
  }
  if (i.aixTemplate) out.push(buildAixTemplateWarmTarget(i.aixTemplateShared ?? []));
  return out;
}

// ── AIX の文作り（aix_template）の先頭ブロックの温め（2026-10-15 竹内「本番の Claude の API を、質を落とさずに減らす」）──
// 本番7日（10/08〜15）: aix_template 52回 $8.87（1回 $0.17）。前置き 約65〜69k（先頭 35.5k＝コードだけで決まる・後ろ 24〜33k＝DB の原則と
//   状態×ボタンのルール）の 1h 書き直しが 24回（1回 約$0.27）。間隔は 63〜1161 分で、全部 1h の寿命切れ（中身の揺れではない。先頭の鍵はデプロイでしか変わらない）。
// 温めるのは先頭ブロックだけ（後ろは状態×ボタンで変わり、次にどれが来るか分からない）。後ろのブロックは今まで通り本物が書く。
//   同じ実物で計算: 前置きの費用 $7.42 → $5.77／週（温め 約52回 $0.37 込み）。後ろまで含めた最後の鍵を温めても $5.50 で差は小さい。
// 中身は変えない: 先頭の text は route.ts と同じ関数（aix-template-system.aixTemplateStaticSystemText）・同じモデル名・thinking・ttl 1h。
//   名札 aix_template_warm は claude-model-map.cacheGroupOf で aix_template と同じ組（Sonnet 5.5 の置き換えも組で揃う）。
// 止める: AIX_TEMPLATE_WARM=off（PREFIX_WARM=off で全部）。AIX_TEMPLATE_CACHE_TTL=5m の時は温めない（5分の寿命に 55分毎の温めは効かない）
export const AIX_TEMPLATE_MODEL = "claude-sonnet-5";

export function aixTemplateWarmEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !isOffSwitch(env.AIX_TEMPLATE_WARM) && aixTemplateCacheTtl(env) === "1h";
}

/**
 * route.ts の system[0] と同じ物（text・cache_control 1h）＋本物と同じ model・thinking。user は「.」・max_tokens 1
 * 2026-10-15（キャッシュの見直し）: shared（aix-template-cache.aixTemplateSharedParts＝後ろのブロックのうちボタンに依らない
 *   全員共通の原則＋全体のルール・本物と同じ関数）を渡すと、先頭＋共通部分まで温める（本物は route.ts で同じ単位に分けて印を付ける）。
 *   本物のボタン別ルールだけが毎回の書き込みに残る。無い時は先頭だけ（旧）。
 */
export function buildAixTemplateWarmTarget(shared: readonly { text: string }[] = []): PrefixWarmTarget {
  const cc = { type: "ephemeral" as const, ttl: "1h" as const };
  const system: WarmSystemBlock[] = [
    { type: "text", text: aixTemplateStaticSystemText(), cache_control: cc },
    ...shared.filter((p) => p.text.trim()).map((p) => ({ type: "text" as const, text: p.text, cache_control: cc })),
  ];
  return {
    name: "aix_template_warm", realActions: ["aix_template"], model: AIX_TEMPLATE_MODEL,
    key: systemFullKey(system) ?? "",
    body: { model: AIX_TEMPLATE_MODEL, max_tokens: 1, thinking: { type: "disabled" }, system, messages: [{ role: "user", content: "." }] },
    // 1ブロック: 書いたら cold（6h retire・次の本物に書かせる）。共通部分つき: 先頭（約35k）が読めて後ろだけ書いた＝DB の原則・ルールの更新の前払い
    staticHitMinRead: system.length >= 2 ? 30_000 : Infinity, chars: chars(system), anyRealKey: true,
  };
}

export function prefixWarmHash(t: Pick<PrefixWarmTarget, "name" | "key">): string {
  return `${PREFIX_WARM_HASH_PREFIX}${t.name}:${t.key}`;
}

/** 判断はブレインの温めと同じ（disabled → alt_routed → outside_hours_jst → day_cap → no_prior_call → retired → too_soon → cold_skip → warm） */
export function decidePrefixWarm(i: BrainWarmInput): BrainWarmDecision {
  return decideBrainWarm(i);
}

/**
 * 温めの usage から「効いたか」を読む（brain-warm.classifyBrainWarmUsage と同じ4種・閾値は対象ごと）:
 *   hit … write 0・read >0 ／ dynamic_rewrite … write >0・read ≥ staticHitMinRead（後ろのブロックだけ書いた＝DB 更新の前払い）／
 *   cold … write >0（それ以外）／ no_cache … 両方 0（cache_control が効いていない or 最低長未満）
 */
export type PrefixWarmUsageKind = "hit" | "dynamic_rewrite" | "cold" | "no_cache";
export function classifyPrefixWarmUsage(u: { cache_read: number; cache_write_1h: number; cache_write_5m?: number }, staticHitMinRead: number): PrefixWarmUsageKind {
  const read = Number(u.cache_read) || 0;
  const write = (Number(u.cache_write_1h) || 0) + (Number(u.cache_write_5m) || 0);
  if (write === 0 && read > 0) return "hit";
  if (write > 0 && read >= staticHitMinRead) return "dynamic_rewrite";
  if (write > 0) return "cold";
  return "no_cache";
}
