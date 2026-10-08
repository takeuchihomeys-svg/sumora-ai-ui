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

export const PREFIX_WARM_DEFAULTS = {
  hoursJst: "9-22",
  /** 1対象あたり1日の上限（9〜22時で最大 13〜15 回。暴走の型の上限） */
  maxPerDay: 20,
} as const;

/** llm_warm_prefixes の claim 行の hash の頭。keep-warm（返信生成）の候補クエリは 'warm:%' も除外する */
export const PREFIX_WARM_HASH_PREFIX = "warm:";

export type PrefixWarmName =
  | "final_check_warm_rule_check" | "final_check_warm_anomaly_scan" | "final_check_warm_context_check" | "final_check_warm_revision"
  | "customer_summary_warm" | "suggest_next_action_warm";

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
};

export type PrefixWarmInputs = {
  finalCheck: FinalCheckWarmInputs;
  summary: { systemPrompt: string; nextActionRuleContents: string[] };
  /** null＝次の一手の LLM を止めている（2026-10-08 一本化・SUGGEST_NEXT_ACTION_LLM が on でない）→ 温めない */
  nextAction: SuggestNextActionPrefixInputs | null;
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
  if (!i.nextAction) return out;
  const naBlocks = buildSuggestNextActionSystemBlocks(i.nextAction);
  out.push({
    name: "suggest_next_action_warm", realActions: ["suggest_next_action"], model: SUGGEST_NEXT_ACTION_MODEL,
    key: systemFullKey(naBlocks) ?? "", body: buildSuggestNextActionWarmBody(naBlocks),
    // system[0]=絶対ルール＋AIX ロジック ≈5.7k・system[1]=フロー運用ガイド ≈0.4k。先頭が当たっていれば read ≥ 4,000
    staticHitMinRead: naBlocks.length >= 2 ? 4_000 : Infinity, chars: chars(naBlocks),
  });
  return out;
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
