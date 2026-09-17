// app/lib/reply-warm-prefix.ts
// 返信生成のプロンプトキャッシュを温め続けるための「実際に送った prefix」の取り出し・記録・読み直し対象の選び方
//
// 2026-09-17 竹内（返信生成の keep-warm）: /api/generate-reply の本体（Sonnet 5）は system 2ブロック＋human 2ブロックに cache_control（1h）が付き、
//   hit 93% だが、直前の呼び出しから 62〜643 分空くと 1h TTL が切れて全書き直し（≈115k×2.0 ≈ $0.7）になる（3日で14回・週 ≈$22）。
//   Anthropic のキャッシュは読むたびに TTL が延びるので、実際に使われた prefix を 40〜50 分ごとに読み直せば（1回 read ≈105k ≈ $0.03）失効を防げる。
//   変種（quickPatterns × conversation_state × 送付済み物件数 × promptOverrides）は予測できないので、
//   buildGenerationMessages が返した物から cache_control 付きのブロックまでをそのまま記録し（extractWarmPrefix → recordWarmPrefix）、
//   cron（app/api/cron/keep-warm）が selectWarmTargets で選んだ行を同じ ChatAnthropic の設定で invoke する。
//   費用の暴走は型で防ぐ: 直近 N 時間に実際に使われた prefix だけ・1 prefix あたり 40 分に1回・1回の cron で最大 M 件・深夜は読まない。
//   読み直し自体は「使われた」と数えない（記録は generate-reply の実リクエストだけ）。
//   反証で見つかった穴の直し（同日）:
//   - 温めるのは「最近使われた上位 maxTracked（3）変種」だけ（変種が10あると全部を40分毎に温めて $8/日になる。system 36k は全変種で共有なので効果はほぼ落ちない）
//   - 前回のタッチから maxGapMinutes（55分）を超えて冷えた行は読まない（読み直しが cache_write ≈$0.7 になる。次の実リクエストに書かせる方が安い＝現状と同じ費用）
//   - 読み直しで cache_read 0・cache_write >0（丸ごと冷えていた＝失効か、プロンプトが変わって死んだ行）なら retired_at を書き、実リクエストが来る（last_used_at > retired_at）まで候補から外す
//   - system[0]（priorityOrderNote+GENERATION_SYSTEM）のハッシュ sys0_hash を残し、最新の行と違う sys0_hash の行（コードのデプロイで死んだ行）は候補から外す
import { REPLY_GENERATION_MODEL } from "./reply-generation-model";
import { jstParts } from "./jst-date";

export type WarmBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } };

export type WarmPrefix = {
  /** model・型・text・cache_control を含む JSON のハッシュ（キャッシュの鍵と同じ物が同じ値になる） */
  hash: string;
  model: string;
  systemBlocks: WarmBlock[];
  humanBlocks: WarmBlock[];
  /** 記録したブロックの総文字数（費用の目安・異常値の除外に使う） */
  chars: number;
  /** system[0]（priorityOrderNote+GENERATION_SYSTEM）の text だけのハッシュ。コードのデプロイで変わった瞬間に古い行を候補から外すための印 */
  sys0Hash: string;
};

/** llm_warm_prefixes の行（読み直し対象の選び方に必要な列だけ） */
export type WarmPrefixRow = {
  hash: string;
  use_count: number;
  last_used_at: string | null;
  last_warmed_at: string | null;
  chars?: number | null;
  /** 読み直しが丸ごと冷えていた（cache_read 0・cache_write >0）時刻。last_used_at がこれより後になる（実リクエストが来る）まで候補から外す */
  retired_at?: string | null;
  /** system[0] の text のハッシュ（古い行＝null は比較しない） */
  sys0_hash?: string | null;
};

export type SelectWarmTargetsOptions = {
  /** 直近この時間内に実際に使われた prefix だけ（既定 5h） */
  recentHours?: number;
  /** 繰り返し使われた変種だけ（既定 2） */
  minUseCount?: number;
  /** 前回の使用／読み直しからこの分数以上空いた行だけ（既定 40分。1h TTL の失効前・読みすぎない） */
  minGapMinutes?: number;
  /** 前回の使用／読み直しからこの分数を超えた行は読まない（既定 55分。1h TTL が切れた後の読み直しは全書き込み ≈$0.7 になるので次の実リクエストに書かせる） */
  maxGapMinutes?: number;
  /** 温め続ける変種の数（既定 3。last_used_at の新しい順に上位だけ。変種が多い日に全変種を温めて費用が増えるのを防ぐ） */
  maxTracked?: number;
  /** 1回の cron で読み直す最大件数（既定 4。1件 ≈ $0.03） */
  maxPerRun?: number;
  /** 読み直す時間帯（JST の時）。"7-24" = 7:00〜23:59。既定は KEEP_WARM_HOURS_JST か "7-24" */
  hoursJst?: string;
  /** 1行の文字数の上限（既定 600,000。異常に大きい行は読まない） */
  maxChars?: number;
};

export type SelectWarmTargetsResult = {
  targets: WarmPrefixRow[];
  /** 読み直さない理由（時間帯外・対象なし）。targets がある時は null */
  reason: string | null;
};

export const KEEP_WARM_DEFAULTS = {
  recentHours: 5,
  minUseCount: 2,
  minGapMinutes: 40,
  maxGapMinutes: 55,
  maxTracked: 3,
  maxPerRun: 4,
  hoursJst: "7-24",
  maxChars: 600_000,
} as const;

/** 読み直しの HumanMessage の末尾に足す1文（返事を「.」1つにして出力費用を無くす。cache_control 付きブロックの後ろなので鍵には影響しない） */
export const KEEP_WARM_TAIL_TEXT = "（キャッシュ維持のための読み直し。返事は「.」だけ）";

// ── ハッシュ ──────────────────────────────────────────────────────────────────
// llm-usage-recorder の shortHash と同じ FNV-1a 32bit を2つの基底で計算して 64bit 相当にする（200KB 級の文面で 32bit だと衝突が心配）
function fnv1a32(s: string, basis: number): string {
  let h = basis;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function warmPrefixHash(model: string, systemBlocks: WarmBlock[], humanBlocks: WarmBlock[]): string {
  const json = JSON.stringify({ model, system: systemBlocks.map(normBlock), human: humanBlocks.map(normBlock) });
  return fnv1a32(json, 0x811c9dc5) + fnv1a32(json, 0x050c5d1f);
}

/** 型・text・cache_control だけを決まった順で残す（余計なプロパティ・順序の違いで別のハッシュにならないように） */
function normBlock(b: WarmBlock): WarmBlock {
  const out: WarmBlock = { type: "text", text: b.text };
  if (b.cache_control) {
    out.cache_control = b.cache_control.ttl ? { type: "ephemeral", ttl: b.cache_control.ttl } : { type: "ephemeral" };
  }
  return out;
}

// ── 取り出し ──────────────────────────────────────────────────────────────────
type MessageLike = { content?: unknown; _getType?: () => string; getType?: () => string };

function textBlocksOf(m: MessageLike | undefined): WarmBlock[] | null {
  if (!m || !Array.isArray(m.content)) return null;
  const blocks: WarmBlock[] = [];
  for (const raw of m.content) {
    if (!raw || typeof raw !== "object") return null;
    const b = raw as { type?: unknown; text?: unknown; cache_control?: unknown };
    if (b.type !== "text" || typeof b.text !== "string") return null;
    const cc = b.cache_control as { type?: unknown; ttl?: unknown } | undefined;
    const block: WarmBlock = { type: "text", text: b.text };
    if (cc && cc.type === "ephemeral") block.cache_control = cc.ttl === "1h" || cc.ttl === "5m" ? { type: "ephemeral", ttl: cc.ttl } : { type: "ephemeral" };
    blocks.push(block);
  }
  return blocks;
}

/** 最後に cache_control が付いたブロックまで（それより後ろ＝キャッシュされない部分は含めない） */
function cachedPrefixOf(blocks: WarmBlock[]): WarmBlock[] {
  let last = -1;
  blocks.forEach((b, i) => { if (b.cache_control) last = i; });
  return last < 0 ? [] : blocks.slice(0, last + 1);
}

/**
 * buildGenerationMessages が返す [SystemMessage, HumanMessage] から、キャッシュされる prefix（system の cache_control 付きブロックまで＋
 * human の cache_control 付きブロックまで＝先頭2つ）を取り出す純関数。dynamicBlock（cache_control なし・顧客固有）は含めない。
 * cache_control が1つも無い・形が違う時は null（記録しない）
 */
export function extractWarmPrefix(messages: unknown[], model: string = REPLY_GENERATION_MODEL): WarmPrefix | null {
  if (!Array.isArray(messages) || messages.length < 2) return null;
  const sys = textBlocksOf(messages[0] as MessageLike);
  const human = textBlocksOf(messages[1] as MessageLike);
  if (!sys || !human) return null;
  const systemBlocks = cachedPrefixOf(sys);
  const humanBlocks = cachedPrefixOf(human);
  if (systemBlocks.length === 0 && humanBlocks.length === 0) return null;
  // system に cache_control の無いブロックが混じっていたら、human 側の鍵はその後ろに来るので「system 全部」を含めないと鍵が合わない → 記録しない
  if (systemBlocks.length !== sys.length) return null;
  const chars = [...systemBlocks, ...humanBlocks].reduce((n, b) => n + b.text.length, 0);
  return {
    hash: warmPrefixHash(model, systemBlocks, humanBlocks), model, systemBlocks: systemBlocks.map(normBlock), humanBlocks: humanBlocks.map(normBlock), chars,
    sys0Hash: sys0HashOf(systemBlocks),
  };
}

/** system[0] の text だけのハッシュ（human 側や DB 由来の system[1] が違っても同じ値。コードのデプロイで変わる） */
export function sys0HashOf(systemBlocks: WarmBlock[]): string {
  const text = systemBlocks[0]?.text ?? "";
  return fnv1a32(text, 0x811c9dc5) + fnv1a32(text, 0x050c5d1f);
}

// ── 記録 ──────────────────────────────────────────────────────────────────────
type DbLike = {
  from: (table: string) => {
    select: (cols: string) => { eq: (col: string, v: string) => { maybeSingle: () => Promise<{ data: { use_count?: number | null } | null; error: { message: string } | null }> } };
    update: (v: Record<string, unknown>) => { eq: (col: string, v: string) => Promise<{ error: { message: string } | null }> };
    insert: (v: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
  };
};

/**
 * llm_warm_prefixes に upsert。行があれば last_used_at と use_count だけ更新（200KB の本文を毎回書かない）・無ければ全部 insert。
 * 失敗しても投げない（console.warn のみ）。同じ prefix が同時に2回来て insert が重複しても片方が unique エラーになるだけ（次回は update 側）
 */
export async function recordWarmPrefix(prefix: WarmPrefix, dbArg?: DbLike, nowIso: string = new Date().toISOString()): Promise<"inserted" | "updated" | "failed"> {
  try {
    // テスト（自己完結ハーネス・Supabase の env なし）から純関数だけ使えるように、DB クライアントは必要な時に読み込む
    const db: DbLike = dbArg ?? ((await import("./supabase")).supabase as unknown as DbLike);
    const { data, error } = await db.from("llm_warm_prefixes").select("use_count").eq("hash", prefix.hash).maybeSingle();
    if (error) { console.warn("[reply-warm-prefix] select failed:", error.message); return "failed"; }
    if (data) {
      const { error: upErr } = await db.from("llm_warm_prefixes").update({ last_used_at: nowIso, use_count: (data.use_count ?? 0) + 1 }).eq("hash", prefix.hash);
      if (upErr) { console.warn("[reply-warm-prefix] update failed:", upErr.message); return "failed"; }
      return "updated";
    }
    const { error: insErr } = await db.from("llm_warm_prefixes").insert({
      hash: prefix.hash, model: prefix.model, system_blocks: prefix.systemBlocks, human_blocks: prefix.humanBlocks, chars: prefix.chars,
      sys0_hash: prefix.sys0Hash,
      use_count: 1, first_used_at: nowIso, last_used_at: nowIso, warm_count: 0,
    });
    if (insErr) { console.warn("[reply-warm-prefix] insert failed:", insErr.message); return "failed"; }
    return "inserted";
  } catch (e) {
    console.warn("[reply-warm-prefix] record failed:", e instanceof Error ? e.message : e);
    return "failed";
  }
}

// ── 読み直し対象の選び方（純関数） ──────────────────────────────────────────────
/** "7-24" → { start: 7, end: 24 }。壊れた値は既定（7-24） */
export function parseHoursJst(spec: string | undefined | null): { start: number; end: number } {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(spec ?? "");
  const fallback = { start: 7, end: 24 };
  if (!m) return fallback;
  const start = Number(m[1]), end = Number(m[2]);
  if (!(start >= 0 && start < 24 && end > start && end <= 24)) return fallback;
  return { start, end };
}

/** JST の時が start 以上 end 未満なら読み直す時間帯 */
export function isWarmHourJst(nowMs: number, spec: string | undefined | null): boolean {
  const { start, end } = parseHoursJst(spec);
  const hour = jstParts(nowMs).hour;
  return hour >= start && hour < end;
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/**
 * 絞る順番（費用の上限を「上位 maxTracked 変種 × 1.5回/h」に固定するため、due の判定は最後）:
 *   ① 直近 recentHours に実際に使われ（last_used_at）・use_count ≥ minUseCount・chars 上限内・retired でない（retired_at が無いか、その後に実リクエストが来た）
 *   ② last_used_at 降順に並べ、最新の行と sys0_hash が違う行（コードのデプロイで死んだ行）を外す
 *   ③ 上位 maxTracked 件だけ残す
 *   ④ その中で GREATEST(last_used_at, last_warmed_at) が minGapMinutes 以上前・maxGapMinutes 以内（冷えていない）の行を最大 maxPerRun 件
 * 時間帯外なら targets は空で reason に理由
 */
export function selectWarmTargets(rows: WarmPrefixRow[], nowMs: number, opts: SelectWarmTargetsOptions = {}): SelectWarmTargetsResult {
  const o = { ...KEEP_WARM_DEFAULTS, ...stripUndefined(opts) };
  if (!isWarmHourJst(nowMs, o.hoursJst)) return { targets: [], reason: `outside_hours_jst(${parseHoursJst(o.hoursJst).start}-${parseHoursJst(o.hoursJst).end})` };
  const recentCutoff = nowMs - o.recentHours * 3_600_000;
  const gapCutoff = nowMs - o.minGapMinutes * 60_000;
  const coldCutoff = nowMs - o.maxGapMinutes * 60_000;
  const live = rows
    .filter((r) => {
      const used = ms(r.last_used_at);
      if (!Number.isFinite(used) || used < recentCutoff || used > nowMs + 60_000) return false;
      if ((r.use_count ?? 0) < o.minUseCount) return false;
      if (r.chars != null && r.chars > o.maxChars) return false;
      const retired = ms(r.retired_at);
      if (Number.isFinite(retired) && used <= retired) return false;
      return true;
    })
    .sort((a, b) => ms(b.last_used_at) - ms(a.last_used_at));
  // 最新の行の sys0_hash と違う行は、コードのデプロイで system[0] が変わった＝実リクエストではもう使われない prefix。古い行（sys0_hash 未記録）は比較しない
  const newestSys0 = live[0]?.sys0_hash ?? null;
  const tracked = (newestSys0 ? live.filter((r) => !r.sys0_hash || r.sys0_hash === newestSys0) : live).slice(0, o.maxTracked);
  const targets = tracked
    .filter((r) => {
      const used = ms(r.last_used_at);
      const warmed = ms(r.last_warmed_at);
      const lastTouch = Number.isFinite(warmed) ? Math.max(used, warmed) : used;
      return lastTouch <= gapCutoff && lastTouch >= coldCutoff;
    })
    .slice(0, o.maxPerRun);
  return { targets, reason: targets.length === 0 ? "no_targets" : null };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
