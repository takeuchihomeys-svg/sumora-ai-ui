// app/lib/aix-system-blocks.ts
// AIX の system プロンプトを「キャッシュの鍵が揃うブロック」に分ける純関数（DB・env に依存しない・単体テストあり）
//
// 2026-09-17 竹内（AIX キャッシュ点検）: aix/action の callClaude 系は system 文字列を丸ごと1ブロック（1h）にしていたため、
//   「会話を合わせる」系 11 経路が `${GENERATION_SYSTEM}\n\n${SMORA_COMMON_RULES}\n\n…固有文` の共通部（≈41.7k tokens）を
//   経路ごとに別のキャッシュとして書いていた（3日で write 25回・1.10M）。キャッシュの鍵は「ブロックの先頭からの完全一致」なので、
//   共通 prefix を最初の独立ブロックに置き、経路ごとの差分は後ろのブロックに分ける。
//   並び: [0] shared（全経路共通・1h）→ [1] semiStatic（global DB ルール等・1h）→ [2] routeStatic（経路固有文＋action 別 DB ルール・5m）→ [3] dynamic（cache なし）
//   ・1h のブロックは 5m のブロックより前（Anthropic の制約）・区切りは system で最大3（messages と合わせて4まで）
//   ・LLM に届く文字列は変えない: ブロックを "\n\n" で結合すると従来の system 文字列（＋動的接尾）と同一になる
//   ・短いブロック（AIX_CACHE_MIN_CHARS 未満）には cache_control を付けない（Sonnet の最小キャッシュ 1,024 tokens 未満は書き込まれず、
//     llm_usage_logs の cache_breakpoints の集計で誤読するだけ）
import { GENERATION_SYSTEM, SMORA_COMMON_RULES } from "./line-reply-prompts";
import { LLM_ACTION_HEADER, LLM_CONVERSATION_HEADER } from "./llm-usage-recorder";

/** 全経路共通の prefix（末尾の "\n\n" は含めない。結合時に "\n\n" で繋ぐので従来の文字列と一致する） */
export const AIX_SHARED_SYSTEM_PREFIX = `${GENERATION_SYSTEM}\n\n${SMORA_COMMON_RULES}`;

/** これ未満の文字数のブロックには cache_control を付けない（≈1,024 tokens。Sonnet の最小キャッシュ長） */
export const AIX_CACHE_MIN_CHARS = 1500;

export type SystemTtl = "1h" | "5m" | "none";

export type SystemSpecBlocks = {
  /** 全経路共通（cache 1h）。文字列で呼ばれた時は splitSharedPrefix が自動で埋める */
  shared?: string;
  /** 準静的（global DB ルール等・全 AIX で同じ文字列・cache 1h） */
  semiStatic?: string;
  /** 経路固有文＋action 別 DB ルール（cache は ttl。既定 5m） */
  routeStatic: string;
  /** 呼び出しごとに変わる物（顧客名・日付・会話・ブレインの判断・OCR・カレンダー）。cache なし */
  dynamic?: string;
  /** routeStatic の ttl。"none" なら cache_control を付けない */
  ttl?: SystemTtl;
};

/** callClaude 系が受ける system。文字列なら従来どおり（共通 prefix だけ自動で分ける） */
export type SystemSpec = string | SystemSpecBlocks;

export type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl: "1h" | "5m" };
};

/**
 * 文字列の system を共通 prefix と経路固有文に分ける。
 * ・`${AIX_SHARED_SYSTEM_PREFIX}\n\n` で始まり残りがあれば shared＝prefix・routeStatic＝残り
 * ・prefix と完全一致なら shared だけ
 * ・それ以外は shared なし（全文が routeStatic）
 * `[shared, routeStatic].filter(Boolean).join("\n\n") === system` が常に成り立つ
 */
export function splitSharedPrefix(system: string): { shared: string; routeStatic: string } {
  const head = `${AIX_SHARED_SYSTEM_PREFIX}\n\n`;
  if (system.startsWith(head) && system.length > head.length) {
    return { shared: AIX_SHARED_SYSTEM_PREFIX, routeStatic: system.slice(head.length) };
  }
  if (system === AIX_SHARED_SYSTEM_PREFIX) return { shared: AIX_SHARED_SYSTEM_PREFIX, routeStatic: "" };
  return { shared: "", routeStatic: system };
}

/** 文字列・オブジェクトどちらの spec も同じ形に揃える（dynamicSuffix は従来の第4引数。spec.dynamic と両方あれば "\n\n" で繋ぐ） */
export function normalizeSystemSpec(spec: SystemSpec, opts: { defaultTtl?: SystemTtl; dynamicSuffix?: string } = {}): Required<SystemSpecBlocks> {
  const defaultTtl = opts.defaultTtl ?? "5m";
  const base: SystemSpecBlocks = typeof spec === "string" ? splitSharedPrefix(spec) : spec;
  const dynamic = [base.dynamic ?? "", opts.dynamicSuffix ?? ""].filter(Boolean).join("\n\n");
  return {
    shared: base.shared ?? "",
    semiStatic: base.semiStatic ?? "",
    routeStatic: base.routeStatic ?? "",
    dynamic,
    ttl: base.ttl ?? defaultTtl,
  };
}

function cacheControlFor(text: string, ttl: SystemTtl): SystemBlock["cache_control"] | undefined {
  if (ttl === "none") return undefined;
  if (text.length < AIX_CACHE_MIN_CHARS) return undefined;
  return { type: "ephemeral", ttl };
}

/**
 * Anthropic に送る system ブロック配列を作る。空のブロックは入れない。
 * shared・semiStatic は 1h、routeStatic は ttl（既定 5m）、dynamic は cache なし。
 */
export function buildSystemBlocks(spec: SystemSpec, opts: { defaultTtl?: SystemTtl; dynamicSuffix?: string } = {}): SystemBlock[] {
  const n = normalizeSystemSpec(spec, opts);
  const blocks: SystemBlock[] = [];
  const push = (text: string, ttl: SystemTtl) => {
    if (!text) return;
    const cache_control = cacheControlFor(text, ttl);
    blocks.push(cache_control ? { type: "text", text, cache_control } : { type: "text", text });
  };
  push(n.shared, "1h");
  push(n.semiStatic, "1h");
  push(n.routeStatic, n.ttl);
  push(n.dynamic, "none");
  return blocks;
}

/** ブロックを従来の1本の文字列に戻す（テスト・比較用。LLM に届く文字列の同一性を確認する） */
export function joinSystemBlocks(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}

// ── 計測用ヘッダ ─────────────────────────────────────────────────────────────
// Anthropic への fetch に付け、llm_usage_recorder（fetch の出口）が「どの AIX か・どの会話か」を読んで Anthropic に送る前に取り除く。
// 値は ASCII でなければ encodeURIComponent 済み（HTTP ヘッダ値は ISO-8859-1 の範囲のみ・undici は非 ASCII で TypeError）。
// 読む側は decodeURIComponent で戻す（失敗したらそのまま）。ヘッダ名の定義は読む側（llm-usage-recorder）と1つ（ずれると印が Anthropic に届く）
export const LLM_META_HEADER_ACTION = LLM_ACTION_HEADER;
export const LLM_META_HEADER_CONVERSATION = LLM_CONVERSATION_HEADER;

export function llmMetaHeaderValue(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : encodeURIComponent(v);
}

/** 静的部分（dynamic を除く）の文字数。warnIfTruncated の入力長に使う（従来の system.length 相当） */
export function systemStaticLength(spec: SystemSpec): number {
  const n = normalizeSystemSpec(spec);
  return [n.shared, n.semiStatic, n.routeStatic].filter(Boolean).join("\n\n").length;
}
