import { NextRequest, NextResponse } from "next/server";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { createGenerationModel, REPLY_GENERATION_MODEL } from "@/app/lib/reply-generation-model";
import { LLM_ACTION_HEADER } from "@/app/lib/llm-usage-recorder";
import { selectWarmTargets, KEEP_WARM_DEFAULTS, KEEP_WARM_TAIL_TEXT, type WarmBlock, type WarmPrefixRow } from "@/app/lib/reply-warm-prefix";

// ── keep-warm: 返信生成のプロンプトキャッシュを温め続ける（10分毎）──────────────────
// 2026-09-17 竹内（返信生成の keep-warm）: /api/generate-reply の本体（Sonnet 5・system 2＋human 2 の cache_control 1h）は hit 93% だが、
//   直前の呼び出しから 62〜643 分空くと TTL が切れて全書き直し（≈115k×2.0 ≈ $0.7）になる（7日実測: 3日で14回・週 ≈$22）。
//   Anthropic のキャッシュは読むたびに TTL が延びるので、generate-reply が実際に送った prefix（llm_warm_prefixes・app/lib/reply-warm-prefix.ts）を
//   同じ ChatAnthropic の設定（app/lib/reply-generation-model.ts）で読み直す（1回 read ≈105k ≈ $0.03・全書き直しの 1/20）。
//   費用の暴走は型で防ぐ: 直近5時間に実際に使われ・2回以上使われた変種のうち最近の上位3変種だけ・1 prefix あたり40〜55分に1回・1回で最大4件・JST 7〜24時以外は何もしない。
//   読み直し自体は「使われた」と数えない（use_count / last_used_at は generate-reply の実リクエストだけが進める）。
//   効いたかは llm_usage_logs（action = 'keep-warm' の行: cache_read ≈105k・cache_write 0／その後の generate-reply の cache_read）で見る。
//   止める時は環境変数 KEEP_WARM=off。時間帯は KEEP_WARM_HOURS_JST（既定 "7-24"）
//   反証で見つかった穴の直し（同日）:
//   - claim を先にする: last_warmed_at / warm_count を invoke の前に書き（前回の値と一致した時だけ）、書けなければ読まない。
//     invoke の後に update すると、update の失敗・maxDuration 超過で同じ行が10分毎に due になり続ける（費用ゼロ側に倒す）
//   - maxRetries 0・経過 40s で打ち切り: 45s timeout × 再試行 × 直列4件が maxDuration 60s を超えて finishCronLog に届かないのを防ぐ
//   - 丸ごと冷えていた（cache_read 0・cache_write >0）行は retired_at を書いて候補から外し、以降の行も止める（他の行も冷えている可能性が高く、書き込みは次の実リクエストに任せる方が安い）

export const maxDuration = 60;

/** 1回の cron で読み直す最大件数（費用の上限 ≈ 4 × $0.03）。selectWarmTargets の maxPerRun と同じ物 */
const MAX_WARM_PER_RUN = KEEP_WARM_DEFAULTS.maxPerRun;
/** DB から候補を引く件数（selectWarmTargets が 40分ルール・件数で絞る） */
const CANDIDATE_LIMIT = 20;
/** 読み直しの返事は「.」だけでよい（max_tokens はキャッシュの鍵に入らない） */
const WARM_MAX_TOKENS = 4;
/** ループの経過時間の上限（maxDuration 60s の内側で finishCronLog を確実に呼ぶ） */
const RUN_BUDGET_MS = 40_000;
/** これ以上の cache_write は「丸ごと冷えていた」（system 36k＋human 25k の全書き込み ≈115k。human 側だけの部分書き込みは ≈25k） */
const COLD_WRITE_TOKENS = 50_000;

type WarmRow = WarmPrefixRow & { model: string; system_blocks: WarmBlock[]; human_blocks: WarmBlock[]; chars: number | null; warm_count: number | null };

/** 応答の usage（LangChain は API の usage を response_metadata.usage にそのまま残す。無ければ usage_metadata.input_token_details） */
function readUsage(res: unknown): { cache_read: number; cache_write: number; input: number } {
  const r = res as { response_metadata?: { usage?: Record<string, unknown> }; usage_metadata?: { input_tokens?: number; input_token_details?: { cache_read?: number; cache_creation?: number } } } | null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const meta = r?.response_metadata?.usage;
  if (meta) return { cache_read: n(meta.cache_read_input_tokens), cache_write: n(meta.cache_creation_input_tokens), input: n(meta.input_tokens) };
  const d = r?.usage_metadata?.input_token_details;
  return { cache_read: n(d?.cache_read), cache_write: n(d?.cache_creation), input: n(r?.usage_metadata?.input_tokens) };
}

/**
 * 読み直す前に last_warmed_at / warm_count を進める（claim）。前回の last_warmed_at と一致した行だけ更新するので、
 * 重なった cron が同じ行を2回読まない。1行も更新できなければ false（読まない）
 */
async function claimWarm(row: WarmRow, nowIso: string): Promise<boolean> {
  let q = supabase.from("llm_warm_prefixes")
    .update({ last_warmed_at: nowIso, warm_count: (row.warm_count ?? 0) + 1 })
    .eq("hash", row.hash);
  q = row.last_warmed_at ? q.eq("last_warmed_at", row.last_warmed_at) : q.is("last_warmed_at", null);
  const { data, error } = await q.select("hash");
  if (error) { console.warn("[keep-warm] claim failed:", row.hash, error.message); return false; }
  return Array.isArray(data) && data.length > 0;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.KEEP_WARM === "off") {
    return NextResponse.json({ ok: true, warmed: [], skipped: 0, reason: "disabled(KEEP_WARM=off)" });
  }

  const runLogId = await startCronLog("keep-warm");
  const nowMs = Date.now();
  const hoursJst = process.env.KEEP_WARM_HOURS_JST || KEEP_WARM_DEFAULTS.hoursJst;

  try {
    const recentCutoff = new Date(nowMs - KEEP_WARM_DEFAULTS.recentHours * 3_600_000).toISOString();
    const { data, error } = await supabase
      .from("llm_warm_prefixes")
      .select("hash, model, system_blocks, human_blocks, chars, use_count, last_used_at, last_warmed_at, warm_count, retired_at, sys0_hash")
      // モデルを変えたら古い prefix は鍵が合わない（別のキャッシュを温めるだけ）ので今のモデルの行だけ
      .eq("model", REPLY_GENERATION_MODEL)
      .gte("last_used_at", recentCutoff)
      .gte("use_count", KEEP_WARM_DEFAULTS.minUseCount)
      .order("last_used_at", { ascending: false })
      .limit(CANDIDATE_LIMIT);
    if (error) {
      await finishCronLog(runLogId, false, undefined, error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    const rows = (data ?? []) as WarmRow[];
    // retired（丸ごと冷えていた）・sys0_hash 違い（デプロイで死んだ行）・上位3変種・40〜55分の窓 は selectWarmTargets（純関数）が絞る
    const { targets, reason } = selectWarmTargets(rows, nowMs, { hoursJst, maxPerRun: MAX_WARM_PER_RUN });
    const skipped = rows.length - targets.length;
    if (targets.length === 0) {
      await finishCronLog(runLogId, true, { warmed: 0, skipped, reason });
      return NextResponse.json({ ok: true, warmed: [], skipped, reason });
    }

    // 同じ設定の ChatAnthropic（鍵＝model・thinking・ブロック配列）。max_tokens だけ絞り・再試行なし・印（action=keep-warm）を fetch に付ける
    const model = createGenerationModel({ maxTokens: WARM_MAX_TOKENS, maxRetries: 0, defaultHeaders: { [LLM_ACTION_HEADER]: "keep-warm" } });
    const warmed: Array<{ hash: string; cache_read: number; cache_write: number; error?: string }> = [];
    let stoppedReason: string | null = null;
    // 直列（同じ prefix を同時に書かない・1件 ≈ 5〜10s × 最大4件 < RUN_BUDGET_MS 40s < maxDuration 60s）
    for (const t of targets) {
      if (Date.now() - nowMs > RUN_BUDGET_MS) { stoppedReason = "time_budget"; break; }
      const row = rows.find((r) => r.hash === t.hash);
      if (!row || !Array.isArray(row.system_blocks) || !Array.isArray(row.human_blocks)) continue;
      // claim できなければ読まない（重なった cron・DB の一時エラー → 費用ゼロ側に倒す）
      if (!(await claimWarm(row, new Date().toISOString()))) { warmed.push({ hash: row.hash, cache_read: 0, cache_write: 0, error: "claim_failed" }); continue; }
      const messages = [
        new SystemMessage({ content: row.system_blocks }),
        new HumanMessage({ content: [...row.human_blocks, { type: "text", text: KEEP_WARM_TAIL_TEXT }] }),
      ];
      try {
        const res = await model.invoke(messages);
        const u = readUsage(res);
        warmed.push({ hash: row.hash, cache_read: u.cache_read, cache_write: u.cache_write });
        if (u.cache_write > 0) {
          // 書き直しになった＝40〜55分の窓が破れている印（cron の遅延で 1h 超・鍵がずれた・プロンプトが変わって死んだ行 等）
          console.warn(JSON.stringify({ tag: "keep-warm:cache-write", hash: row.hash, cache_write: u.cache_write, cache_read: u.cache_read, last_used_at: row.last_used_at, last_warmed_at: row.last_warmed_at }));
        }
        if ((u.cache_read === 0 && u.cache_write > 0) || u.cache_write > COLD_WRITE_TOKENS) {
          // 丸ごと冷えていた → 実リクエストが来る（last_used_at > retired_at）まで候補から外し、以降の行も止める
          const { error: rtErr } = await supabase.from("llm_warm_prefixes").update({ retired_at: new Date().toISOString() }).eq("hash", row.hash);
          if (rtErr) console.warn("[keep-warm] retire failed:", row.hash, rtErr.message);
          stoppedReason = "cold_prefix";
          break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[keep-warm] invoke failed:", row.hash, msg);
        warmed.push({ hash: row.hash, cache_read: 0, cache_write: 0, error: msg.slice(0, 200) });
      }
    }

    console.log(JSON.stringify({ tag: "keep-warm:done", warmed: warmed.length, skipped, stopped: stoppedReason, cache_read: warmed.reduce((n, w) => n + w.cache_read, 0), cache_write: warmed.reduce((n, w) => n + w.cache_write, 0) }));
    const result = { warmed, skipped, reason: stoppedReason };
    await finishCronLog(runLogId, true, { warmed: warmed.length, skipped, stopped: stoppedReason, errors: warmed.filter((w) => w.error).length, cache_write_total: warmed.reduce((n, w) => n + w.cache_write, 0) });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(runLogId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
