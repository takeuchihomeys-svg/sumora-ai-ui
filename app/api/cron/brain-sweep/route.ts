import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import {
  runBrainAndNotify, BRAIN_SKIP_STATUSES, BRAIN_MODEL,
  loadBrainSystemInputs, buildBrainSystemBlocks, brainSysKeyFull, sendBrainWarm,
} from "@/app/lib/brain-core";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { AIX_NOTICE_FRESH_MS } from "@/app/lib/aix-action-text";
import { decideBrainWarm, classifyBrainWarmUsage, BRAIN_WARM_DEFAULTS, type BrainWarmUsageKind } from "@/app/lib/brain-warm";
import { decideNightDeferNow, isOffSwitch } from "@/app/lib/brain-night-defer";
import { willRouteAlt } from "@/app/lib/llm-alt-provider";
import { jstDayStartMs } from "@/app/lib/jst-date";
import { MSG_SEP } from "@/app/lib/reply-context";
import { pendingApplySummaryConversations, ensureApplyPeriodSummary } from "@/app/lib/apply-period-summary-server";

// ── brain-sweep: 脳分析バックストップ（5分毎）─────────────────────────────
// FIX(Fable5 #2): 分析の主経路は line-webhook のイベント駆動（顧客メッセージ受信 =
// suggested_aix_meta を消すのと同じ場所で再分析）。本 cron は webhook の分析が
// 失敗/中断した会話（meta が null のまま残った行）だけを拾う保険。
// 通常運転ではほぼ毎回 0 件（純粋な DB read のみ）で終わる。
// 旧 brain-weekly（週100件のHaiku分析 → webhookのwipeで全破棄される金銭浪費）は廃止した。

export const maxDuration = 120;

// 1回の sweep で分析する最大会話数（コスト・レイテンシガード）
// claude-sonnet-5 extended thinking: 1件最大60s × 並列3 = 1ラウンド最大60s → maxDuration=120s 内に収まるよう3件に制限
const MAX_SWEEP_PER_RUN = 3;

// webhook の after() 分析が進行中の可能性がある直近の会話はスキップ（二重分析防止）
// M4(Fable5): 2分→3分 — 旧値は webhook の maxDuration=120秒とちょうど同値で、境界上の after() 分析と
// 二重分析になり得た。maxDuration を超える猶予にして境界レースを解消
const IN_FLIGHT_GRACE_MS = 3 * 60 * 1000; // 3 minutes

// H3(Fable5): 失敗バックオフ — analyzeAndSaveBrainMeta は失敗時も brain_analyzed_at を書くため、
// 直近30分以内に試行済みの行は再試行しない（決定的に失敗する会話の永久リトライ・sweep飢餓を防ぐ）
const RETRY_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes
const EMBEDDING_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // embedding_cache は30日で消す

// ── ブレインの前置きの温め（brain-warm・営業時間 JST 9〜22 だけ）──────────────────────────
// 2026-09-24 竹内「実装する」（前置きの温め）＋「22時〜9時のお客さんは分析せずに9時から」:
//   ブレインの前置き（system 2ブロック ≈38〜39k・1h キャッシュ）は1時間空くと次の1回が全書き直し（$0.24）。温め1回は読むだけ ≈$0.012。
//   新しい cron は増やさず、この sweep（5分毎）の**対象0件の分岐**で1回だけ温める（分析が1件でも走ればその呼び出し自体が温め）。
//   本物と1文字も違わない system は brain-core の同じ関数（loadBrainSystemInputs → buildBrainSystemBlocks → sendBrainWarm）で作る。
//   keep-warm の教訓の型: claim 先行（llm_warm_prefixes の行・重なった sweep の二重送信を防ぐ）・冷えていたら温めない（書き込みは次の本物に払わせる）・
//   時間帯・1日の上限・効いたかは llm_usage_logs（action='brain-warm' の cache_read≈39k・cache_write_1h 0）で見張る。
//   止める: BRAIN_WARM=off。時間帯: BRAIN_WARM_HOURS_JST（既定 "9-22"・start<end のみ。壊れた値は parseHoursJst の fallback 7-24）。
//   「最後のブレイン呼び出し」は llm_usage_logs を sys_key_full 一致で読む（conversations.brain_analyzed_at は skip/cached/失敗でも打刻され LLM を呼んだ印ではない）。
//   env で絞らない: キャッシュは Anthropic アカウント×内容の鍵なので、local でも同じ鍵なら本番のキャッシュを温めている（実測 09-23 21:28 local と 22:45 production が同じ 1ed13988）。
const BRAIN_WARM_ACTION = "brain-warm";
const BRAIN_REAL_ACTIONS = ["brain_fresh", "brain_full", "brain_fresh_claude"];
const BRAIN_WARM_HASH_PREFIX = "brain:";

type BrainWarmResult = {
  warmed: boolean;
  reason: string;
  key?: string;
  gapMinutes?: number | null;
  cache_read?: number;
  cache_write_1h?: number;
  cache_write_5m?: number;
  kind?: BrainWarmUsageKind;
  request_id?: string | null;
};

/**
 * 温め1回（失敗しても sweep を壊さない: 呼び出し側で catch）。
 * 順序: env（disabled / 時間帯外は DB を読まずに即 return）→ DeepSeek 振り分け → system ブロック（本物と同じ関数）→ 3つ並列で読む → 判定 → claim → 送信 → 分類・記録
 */
async function tryBrainWarm(nowMs: number): Promise<BrainWarmResult> {
  const enabled = !isOffSwitch(process.env.BRAIN_WARM);
  const hoursJst = process.env.BRAIN_WARM_HOURS_JST || BRAIN_WARM_DEFAULTS.hoursJst;
  // disabled / 時間帯外は DB を読まない（null を渡して先に判定させる。判定順は decideBrainWarm: disabled → alt_routed → outside_hours_jst → …）
  const altRouted = enabled ? willRouteAlt("brain_fresh") : false;
  const pre = decideBrainWarm({ nowMs, lastRealCallMs: null, lastWarmedMs: null, retiredMs: null, warmedTodayCount: 0, hoursJst, enabled, altRouted });
  if (!pre.warm && pre.reason !== "no_prior_call") return { warmed: false, reason: pre.reason };

  const sys = buildBrainSystemBlocks(await loadBrainSystemInputs());
  const key = brainSysKeyFull(sys);
  const hash = BRAIN_WARM_HASH_PREFIX + key;
  const dayStartIso = new Date(jstDayStartMs(nowMs)).toISOString();
  const [lastReal, warmedToday, claimRow] = await Promise.all([
    // 2026-09-24 反証: created_at は応答を読み終えた後の insert 時刻（DEFAULT NOW()）で、Anthropic が TTL を延ばす「リクエスト時刻」より
    //   duration_ms（brain_full は最大 60s）だけ遅い。リクエスト開始時刻 = created_at − duration_ms を「最後の本物」にする（枠の端で TTL を跨がない）
    supabase.from("llm_usage_logs").select("created_at, duration_ms").in("action", BRAIN_REAL_ACTIONS).lt("status", 400).eq("sys_key_full", key)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("llm_usage_logs").select("*", { count: "exact", head: true }).eq("action", BRAIN_WARM_ACTION).gte("created_at", dayStartIso),
    supabase.from("llm_warm_prefixes").select("last_warmed_at, retired_at, warm_count").eq("hash", hash).maybeSingle(),
  ]);
  if (lastReal.error) console.warn("[brain-warm] llm_usage_logs read failed:", lastReal.error.message);
  if (claimRow.error) console.warn("[brain-warm] llm_warm_prefixes read failed:", claimRow.error.message);
  const ms = (iso: unknown): number | null => { const t = typeof iso === "string" ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
  const row = (claimRow.data ?? null) as { last_warmed_at: string | null; retired_at: string | null; warm_count: number | null } | null;
  const lastRealInsertedMs = ms(lastReal.data?.created_at);
  const lastRealDurationMs = Math.max(0, Number(lastReal.data?.duration_ms) || 0);
  const decision = decideBrainWarm({
    nowMs,
    lastRealCallMs: lastRealInsertedMs === null ? null : lastRealInsertedMs - lastRealDurationMs,
    lastWarmedMs: ms(row?.last_warmed_at),
    retiredMs: ms(row?.retired_at),
    warmedTodayCount: warmedToday.count ?? 0,
    hoursJst, enabled, altRouted,
  });
  if (!decision.warm) return { warmed: false, reason: decision.reason, key, gapMinutes: decision.gapMinutes };

  // claim 先行（keep-warm と同じ形）: 行が無ければ insert（unique エラー＝別の sweep が先に取った）、あれば last_warmed_at が前の値と一致した時だけ update。取れなければ読まない
  const nowIso = new Date(nowMs).toISOString();
  if (!row) {
    const { error: insErr } = await supabase.from("llm_warm_prefixes").insert({
      hash, model: BRAIN_MODEL, system_blocks: [], human_blocks: [], chars: 0, use_count: 0, sys0_hash: "brain",
      first_used_at: nowIso, last_used_at: nowIso, last_warmed_at: nowIso, warm_count: 1,
    });
    if (insErr) return { warmed: false, reason: "claim_failed", key, gapMinutes: decision.gapMinutes };
  } else {
    let q = supabase.from("llm_warm_prefixes").update({ last_warmed_at: nowIso, warm_count: (row.warm_count ?? 0) + 1 }).eq("hash", hash);
    q = row.last_warmed_at ? q.eq("last_warmed_at", row.last_warmed_at) : q.is("last_warmed_at", null);
    const { data: claimed, error: upErr } = await q.select("hash");
    if (upErr || !Array.isArray(claimed) || claimed.length === 0) return { warmed: false, reason: "claim_failed", key, gapMinutes: decision.gapMinutes };
  }

  // 2026-09-24 反証: 送信が失敗（529・60s タイムアウト・maxRetries 0）した時に claim を残すと、以降50分は too_soon で温めず、その間に本物の TTL が切れて
  //   次の温めが cold（$0.24 を温めが払う）→ 6h retire になる。失敗したら claim を元に戻す（insert したばかりなら delete・update なら前の値へ）
  let u: Awaited<ReturnType<typeof sendBrainWarm>>;
  try {
    u = await sendBrainWarm(sys);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    const { error: undoErr } = row
      ? await supabase.from("llm_warm_prefixes").update({ last_warmed_at: row.last_warmed_at, warm_count: row.warm_count ?? 0 }).eq("hash", hash).eq("last_warmed_at", nowIso)
      : await supabase.from("llm_warm_prefixes").delete().eq("hash", hash).eq("last_warmed_at", nowIso);
    console.warn(JSON.stringify({ tag: "brain-warm:send-failed", key, gapMinutes: decision.gapMinutes, error: msg, claimUndone: !undoErr, undoError: undoErr?.message ?? null }));
    return { warmed: false, reason: "send_failed:" + msg, key, gapMinutes: decision.gapMinutes };
  }
  const kind = classifyBrainWarmUsage(u);
  const line = { tag: "brain-warm:done", key, kind, cache_read: u.cache_read, cache_write_1h: u.cache_write_1h, cache_write_5m: u.cache_write_5m, request_id: u.request_id, gapMinutes: decision.gapMinutes };
  if (kind === "hit") {
    console.log(JSON.stringify(line));
  } else if (kind === "dynamic_rewrite") {
    // static は当たり・DB 由来ブロック（system[1]）だけ書いた＝ai_prompt_rules 等の更新（11:24/15:24/19:24 の analyze-diffs 等）。次の本物が払う分の前払いで損ではない。
    // 2026-09-24 反証: ただし**同じ鍵で2回続けて** system[1] を書くのは異常（前払いは1回で済むはず＝鍵の揺れか cache の消失）。
    //   keep-warm で起きた「毎回読めているつもりで毎回書いている」（50分ごとに $0.07）を繰り返さないため、2回目は retire＋warn
    const prev = await supabase.from("llm_usage_logs").select("cache_read, cache_write_1h").eq("action", BRAIN_WARM_ACTION).eq("sys_key_full", key)
      .lt("status", 400).lt("created_at", nowIso).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const prevKind = prev.data ? classifyBrainWarmUsage({ cache_read: Number(prev.data.cache_read) || 0, cache_write_1h: Number(prev.data.cache_write_1h) || 0 }) : null;
    if (prevKind === "dynamic_rewrite") {
      console.warn(JSON.stringify({ ...line, tag: "brain-warm:dynamic-rewrite-repeat", note: "同じ鍵で2回続けて system[1] を書いた＝鍵の揺れ（並びの非決定性）か cache の消失 → 6h retire" }));
      const { error: rtErr } = await supabase.from("llm_warm_prefixes").update({ retired_at: new Date().toISOString() }).eq("hash", hash);
      if (rtErr) console.warn("[brain-warm] retire failed:", hash, rtErr.message);
    } else {
      console.log(JSON.stringify({ ...line, note: "理由: DB 由来ブロック（system[1]）が変わった＝次の本物が払う分の前払い" }));
    }
  } else {
    // cold: 時間切れ or デプロイ or 鍵ずれ／no_cache: キャッシュ指定が効いていない（brainRequestBase の cache_control を疑う）。
    // どちらも retire: 以降 coldRetireHours（6h）は本物の呼び出しが来るまで温めない（書き込みは本物に払わせる。連続で cold＝鍵ずれなら実質の停止になる）
    console.warn(JSON.stringify({ ...line, tag: kind === "cold" ? "brain-warm:cold" : "brain-warm:no-cache", note: kind === "cold" ? "時間切れ・デプロイ・鍵ずれのどれか → 6h retire" : "キャッシュ指定が効いていない → brainRequestBase の cache_control を疑う → 6h retire" }));
    const { error: rtErr } = await supabase.from("llm_warm_prefixes").update({ retired_at: new Date().toISOString() }).eq("hash", hash);
    if (rtErr) console.warn("[brain-warm] retire failed:", hash, rtErr.message);
  }
  return { warmed: true, reason: "warm", key, gapMinutes: decision.gapMinutes, cache_read: u.cache_read, cache_write_1h: u.cache_write_1h, cache_write_5m: u.cache_write_5m, kind, request_id: u.request_id };
}

/**
 * 未返信のお客様の通を MSG_SEP でつないで返す（cron generate-pending-drafts と同じ形・画像/動画/スタンプだけの通は除く）。
 * 2026-09-24 反証: 旧 sweep は msgText を渡さず、runBrainAndNotify の条件ブレイン（runConditionBrain・msgText が無いと動かない）が sweep 経路では走らなかった。
 *   昼は webhook→bg-async が msgText 付きで先に走るので隠れていたが、22〜9時の見送り後の 9:00 は sweep（updated_at desc・3件）が cron より先に分析する事があり、
 *   その会話は cron 側で「ブレインは新鮮」と見て再実行しない → 夜の発言の条件変更（家賃・エリア）が property_customers に反映されない。読めなければ undefined（従来どおり）
 */
async function loadUnrepliedCustomerText(conversationId: string): Promise<string | undefined> {
  const { data, error } = await supabase.from("messages").select("sender, text, image_url, created_at").eq("conversation_id", conversationId)
    .order("created_at", { ascending: false }).limit(20);
  if (error || !data) return undefined;
  const list = (data as Array<{ sender: string; text: string | null; image_url: string | null }>).reverse();
  const lastStaffIdx = list.map((m, i) => (m.sender === "staff" ? i : -1)).filter((i) => i >= 0).at(-1);
  const afterStaff = lastStaffIdx !== undefined ? list.slice(lastStaffIdx + 1) : list;
  const texts = afterStaff
    .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]" && m.text !== "[スタンプ]")
    .slice(-5)
    .map((m) => (m.text as string).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�"));
  const joined = texts.join(MSG_SEP);
  return joined.trim() ? joined : undefined;
}

async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const runLogId = await startCronLog("brain-sweep");

  // 2026-09-13 RAG 監査: embedding_cache（検索の問いの平文＋埋め込み）に期限が無く、7日で約3,700行ずつ増え続けていた。
  //   キャッシュなので30日より古い行は消す（5分毎の sweep のうち毎時0〜4分の1回だけ）
  if (new Date().getUTCMinutes() < 5) {
    const { error: purgeErr } = await supabase.from("embedding_cache").delete()
      .lt("created_at", new Date(Date.now() - EMBEDDING_CACHE_TTL_MS).toISOString());
    if (purgeErr) console.warn("[brain-sweep] embedding_cache purge failed:", purgeErr.message);
  }

  // 2026-09-27 竹内「申込中の部分はクロードに切り替えて要約して（審査否決等になって申込から物件提案中にステータスを切り替えた時に
  //   連動してクロードが申込期間の部分を要約して DeepSeek に渡す仕組み）」: 線（deepseek_cutoff_at）は DB のトリガーが書くので LLM を呼べない。
  //   ここ（5分毎）で「線があるのに、その線のまとめが無い会話」を1回に2件まで作る（月に数件・1件 約$0.01）。夜も止めない（お客様への通知は無い）。
  //   失敗しても sweep は止めない（ensureApplyPeriodSummary は例外を外に出さない・失敗は30分後にもう一度）
  const applySummaries = await pendingApplySummaryConversations(2)
    .then((ids) => Promise.all(ids.map((id) => ensureApplyPeriodSummary(id))))
    .catch((e) => { console.warn("[brain-sweep] 申込期間のまとめ: 対象を読めない:", e instanceof Error ? e.message : e); return []; });
  if (applySummaries.length) console.log(JSON.stringify({ tag: "brain-sweep:apply-summary", results: applySummaries.map((r) => ({ id: r.conversationId.slice(0, 8), status: r.status, reasons: r.reasons ?? [] })) }));

  // 2026-09-24 竹内「22時〜9時のお客さんは分析せずに9時から分析する」: 夜は先頭で止める（最重要）。
  //   webhook が meta を消すので、ここを止めないと夜の会話を 3〜5 分後に sweep が分析して見送りが無効になる。温めもしない（9〜22 の窓の外）。
  //   打刻しないので同じ会話を選び続ける DB 読みは起きない（先頭で return するため）。reason を cron_run_logs に残す
  const nightDefer = decideNightDeferNow("sweep");
  if (nightDefer.defer) {
    const until = new Date(nightDefer.until!).toISOString();
    await finishCronLog(runLogId, true, { processed: 0, reason: "night_defer", until });
    return NextResponse.json({ ok: true, processed: 0, reason: "night_defer", until });
  }

  try {
    const cutoff = new Date(Date.now() - IN_FLIGHT_GRACE_MS).toISOString();
    const backoffCutoff = new Date(Date.now() - RETRY_BACKOFF_MS).toISOString();
    const freshCutoff = new Date(Date.now() - AIX_NOTICE_FRESH_MS).toISOString();
    const { data: conversations, error } = await supabase
      .from("conversations")
      .select("id")
      .is("suggested_aix_meta", null)
      // FIX(post-Fable5): sweep の存在意義は「webhook brain が失敗した会話の補填」。
      // webhook は顧客メッセージ受信時のみ brain を起動するため、失敗行は必ず last_sender="customer"。
      // staff が返信済みの行（last_sender="staff"）は次の顧客メッセージで webhook brain が必ず走るため sweep 不要。
      // このフィルタにより: (a) staff 返信30分後の sweep によるバナー復活を根絶、
      // (b) staff 返信ごとの無駄 Sonnet 呼び出しを削減。副作用なし（本来対象は全て条件を満たす）。
      .eq("last_sender", "customer")
      // B7(Fable5): 旧 .not("status","in",...) は SQL の NOT IN で NULL 行を除外してしまう
      // （writer 側の analyzeAndSaveBrainMeta は null status を許容 → 永久に分析されない盲点だった）
      .or(`status.is.null,status.not.in.(${BRAIN_SKIP_STATUSES.join(",")})`)
      // 2026-09-10 Fable5 Sさん事例（原因D）: writer 側（analyzeAndSaveBrainMeta）が分析対象外にする行を
      //   クエリ側でも除外する（NULL 行を落とさない .or 形式）。
      // 2026-09-12 竹内（名無しの権兵衛事例）: writer が is_post_apply（申込中）を分析対象にしたので、ここでも除外しない
      .or("line_status.is.null,line_status.not.in.(blocked,unfollowed)")
      // H3(Fable5): 30分バックオフ（未試行 or 前回試行から30分経過した行のみ）
      .or(`brain_analyzed_at.is.null,brain_analyzed_at.lt.${backoffCutoff}`)
      .lt("updated_at", cutoff)
      // 2026-09-12 竹内（Sky・AKANE 事例）: sweep は「webhook 分析の失敗の補填」＝今のお客様発言だけが対象。
      //   何日も前に止まった会話（申込中の積み残し等）を今分析すると、今の要対応ではない会話に AIX 通知が飛んだ。
      //   AIX要対応と同じ 48時間（AIX_NOTICE_FRESH_MS）より古い会話は拾わない（次のお客様発言で webhook が分析する）
      .gt("updated_at", freshCutoff)
      // FIX: SQL の neq は NULL 行を除外する（NULL比較は常にFALSE）。brain失敗行は
      // ai_draft が NULL のことが多く、まさに sweep が拾うべき行が漏れていた
      .or("ai_draft.is.null,ai_draft.neq.__SHOWN__")
      .order("updated_at", { ascending: false })
      .limit(MAX_SWEEP_PER_RUN);

    if (error) {
      await finishCronLog(runLogId, false, undefined, error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const rows = (conversations ?? []) as Array<{ id: string }>;
    if (rows.length === 0) {
      console.log("[brain-sweep] 対象なし（0件）— suggested_aix_meta=null の会話はありません");
      // 2026-09-24: 分析が0件の時だけ前置きを温める（分析が走った回はそれ自体が温め。llm_usage_logs の非同期遅れで直後に二重に温めるのも防ぐ）。
      //   失敗しても sweep を壊さない。too_soon は5分毎に出るので console ではなく cron_run_logs の result だけに残す
      const warm = await tryBrainWarm(Date.now()).catch((e): BrainWarmResult => ({ warmed: false, reason: "error:" + (e instanceof Error ? e.message : String(e)).slice(0, 200) }));
      if (!warm.warmed && warm.reason !== "too_soon" && !warm.reason.startsWith("outside_hours_jst") && warm.reason !== "disabled") {
        console.log(JSON.stringify({ tag: "brain-warm:skip", reason: warm.reason, gapMinutes: warm.gapMinutes ?? null, key: warm.key ?? null }));
      }
      await finishCronLog(runLogId, true, { processed: 0, warm });
      return NextResponse.json({ ok: true, processed: 0, warm });
    }

    let processed = 0;
    let failed = 0;
    await withConcurrency(rows, 3, async (conv) => {
      // 2026-09-24: origin: sweep（夜は上の先頭で止まるが、brain-core の保険にも名札を渡す）。
      //   msgText（未返信のお客様の通）も渡す＝条件ブレインが cron / bg-async と同じく動く（loadUnrepliedCustomerText のコメント）
      const msgText = await loadUnrepliedCustomerText(conv.id).catch(() => undefined);
      const saved = await runBrainAndNotify(conv.id, msgText, { origin: "sweep" }).catch((e) => {
        // B10(Fable5): 旧実装は throw されたエラーメッセージも握り潰していた
        const msg = e instanceof Error ? e.message : String(e);
        const kind = msg.includes("timed out") || msg.includes("timeout") ? "timeout" : "error";
        console.error(`[brain-sweep] analyze failed [${kind}]:`, conv.id, msg);
        return false;
      });
      if (saved) processed++;
      else failed++;
    });

    console.log(`[brain-sweep] 完了: 対象${rows.length}件 / 成功${processed}件 / 失敗${failed}件`);

    const result = { processed, failed, total: rows.length };
    await finishCronLog(runLogId, true, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(runLogId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
