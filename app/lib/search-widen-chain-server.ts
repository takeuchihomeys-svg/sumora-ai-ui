// app/lib/search-widen-chain-server.ts（サーバー専用・DB。画面側から import しない）
// 「まずピンポイント → 足りなければ広げて（1回だけ）」の決まり（search-widen-chain.ts の decideWiden）を DB の値で回し、
//   広げる時は web_brain のコマンド（is_wide:true・payload.chain）を1つ積む。ブレインの PC が拾って広げて検索する（拡張の変更なし）。
// 呼ぶ所（どれも同じ関数・同じお客様×サイトで冪等＝2つ目は already_chained／queued で止まる）:
//   ① まとめ（pickup-complete-server.finishCompleteGroup の最後）… 物件が届いた回。判定・画像の読み取りの後の「通す」で数える
//   ② 検索の点検の finished（/api/search-audits）… 送れる物件が0件の回（物件が届かない＝まとめが来ない）
//   ③ Cron（/api/cron/pickup-auto-complete・2分おき）… ②の取りこぼし（全部送付済みで行が作られなかった回・点検が遅れて閉じた回）
// 止める: 環境変数 SEARCH_WIDEN_CHAIN=off（決めるだけで積まない＝ログに残る）
// 2026-09-27 竹内「まずピンポイント検索して、なければ広げて検索する形（おススメの物件や新着物件がなければ）」
import { supabase } from "@/app/lib/supabase";
import {
  decideWiden, commandSiteOf, pickupSiteOf, LOOKBACK_MS, ROWS_WAIT_MS,
  type AuditLite, type PickupLite, type ChainCommandLite, type WidenDecision,
} from "@/app/lib/search-widen-chain";
import { WEB_BRAIN_SOURCE } from "@/app/lib/web-brain-search";

export type ChainTrigger = "complete" | "audit" | "sweep";
export type ChainResult = { site: string; decision: WidenDecision; commandId: string | null; error: string | null; dry: boolean };

const AUDIT_COLS = "run_id, created_at, finished_at, status, site, mode, trigger, is_wide, pass, command_id, result, customer_snapshot, intended, ext_version";

export function widenChainEnabled(): boolean {
  return process.env.SEARCH_WIDEN_CHAIN !== "off";
}

/** web_brain のコマンドのうち、そのお客様の物（直近 LOOKBACK＋6時間） */
async function loadCommands(pcid: string, nowMs: number): Promise<ChainCommandLite[]> {
  const since = new Date(nowMs - LOOKBACK_MS - 6 * 3600_000).toISOString();
  const { data, error } = await supabase.from("automation_commands")
    .select("id, created_at, status, sites, customer_ids, payload")
    .contains("customer_ids", [pcid]).eq("payload->>source", WEB_BRAIN_SOURCE).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(50);
  if (error) throw new Error(`コマンドを読めない: ${error.message}`);
  return (data ?? []) as ChainCommandLite[];
}

/**
 * そのお客様×サイトで、ピンポイントの回が足りなければ広げてを積む。失敗しても投げない。
 * site は売上サポ・検索の点検の呼び名（realpro / itandi）でもコマンドの呼び名（realnetpro）でもよい
 */
export async function maybeChainWiden(input: { propertyCustomerId: string; site: string; trigger: ChainTrigger; nowMs?: number }): Promise<ChainResult> {
  const nowMs = input.nowMs ?? Date.now();
  const site = pickupSiteOf(input.site) ?? String(input.site);
  const dry = !widenChainEnabled();
  const out: ChainResult = { site, decision: { action: "skip", reason: "init" }, commandId: null, error: null, dry };
  try {
    if (!commandSiteOf(site)) { out.decision = { action: "skip", reason: "site" }; return out; }
    const since = new Date(nowMs - LOOKBACK_MS).toISOString();
    const [au, pk, cmds] = await Promise.all([
      supabase.from("search_audits").select(AUDIT_COLS).eq("property_customer_id", input.propertyCustomerId).gte("created_at", since).order("created_at", { ascending: false }).limit(40),
      supabase.from("property_pickups").select("id, created_at, site, verdict, search_mode, complete_group_id").eq("property_customer_id", input.propertyCustomerId).gte("created_at", since).limit(500),
      loadCommands(input.propertyCustomerId, nowMs),
    ]);
    if (au.error) throw new Error(`検索の点検を読めない: ${au.error.message}`);
    if (pk.error) throw new Error(`売上サポを読めない: ${pk.error.message}`);
    const audits = (au.data ?? []) as AuditLite[];
    // 写し（customer_snapshot）が無い回の予備: その回より前の送付の記録の件数
    let sentBefore: number | null = null;
    const first = audits.filter((a) => pickupSiteOf(a.site) === site).slice(-1)[0];
    if (first && !first.customer_snapshot) {
      const { count } = await supabase.from("sent_properties").select("id", { count: "exact", head: true })
        .eq("property_customer_id", input.propertyCustomerId).lt("sent_at", first.created_at);
      sentBefore = count ?? null;
    }
    const decision = decideWiden({
      site, audits, rows: (pk.data ?? []) as PickupLite[], commands: cmds, nowMs,
      sentBeforeSession: sentBefore, fromAuditFinish: input.trigger === "audit",
    });
    out.decision = decision;
    if (decision.action !== "widen" || dry) return out;
    // 積む（AIXツールの一括検索と同じ形）。更新日はピンポイントの回と同じ値（decision.chain.rp_update_days・sessionRpUpdateDays）
    const rp = decision.chain.rp_update_days;
    const row = {
      command_type: "batch_property_search",
      customer_ids: [input.propertyCustomerId],
      sites: [commandSiteOf(site)],
      payload: { source: WEB_BRAIN_SOURCE, is_wide: true, rp_update_days: rp, chain: decision.chain },
      status: "pending",
    };
    const { data: ins, error } = await supabase.from("automation_commands").insert(row).select("id").single();
    if (error) throw new Error(`コマンドを積めない: ${error.message}`);
    out.commandId = (ins as { id: string } | null)?.id ?? null;
    return out;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  } finally {
    // 見回り（sweep）の「足りている」は2分おきに何度も出るので書かない
    if (out.decision.action === "widen" || (out.decision.action === "enough" && input.trigger !== "sweep") || out.error) {
      console.log(JSON.stringify({ tag: "search-widen-chain", trigger: input.trigger, customer: input.propertyCustomerId.slice(0, 8), site, action: out.decision.action, reason: out.decision.reason, command: out.commandId, dry, error: out.error,
        ...(out.decision.action === "widen" ? { kind: out.decision.chain.kind, pass: out.decision.chain.pass_count, threshold: out.decision.chain.threshold } : out.decision.action === "enough" ? { kind: out.decision.kind, pass: out.decision.passCount } : {}) }));
    }
  }
}

/** まとめの行のサイトごとに決める（finishCompleteGroup の最後） */
export async function chainAfterComplete(propertyCustomerId: string, sites: ReadonlyArray<string | null>): Promise<ChainResult[]> {
  const uniq = [...new Set(sites.map((s) => pickupSiteOf(s)).filter((s): s is "realpro" | "itandi" => s === "realpro" || s === "itandi"))];
  const out: ChainResult[] = [];
  for (const s of uniq) out.push(await maybeChainWiden({ propertyCustomerId, site: s, trigger: "complete" }));
  return out;
}

/**
 * Cron: 終わったピンポイントの回（ブレイン・スタッフ以外・リアプロ／itandi）で、まだ決まっていないお客様×サイトを拾う。
 *   物件が届いた回はまとめ（①）が決めるので、ここでは「行が届かない回」の取りこぼしを拾うだけ（decideWiden が not_complete で待つ）
 */
export async function sweepWidenChains(opts: { nowMs?: number; limit?: number } = {}): Promise<{ checked: number; widened: number; errors: number }> {
  const nowMs = opts.nowMs ?? Date.now();
  const res = { checked: 0, widened: 0, errors: 0 };
  try {
    const { data, error } = await supabase.from("search_audits")
      .select("property_customer_id, site, created_at")
      .eq("status", "finished").eq("is_wide", false).neq("mode", "brain_staff").in("site", ["realpro", "itandi"])
      // 行が届くのを待つ長さ（ROWS_WAIT_MS＝8分）を過ぎた回だけ・その後 8分の間（2分おきに4回）見る＝同じ回を何度も読まない
      .gte("finished_at", new Date(nowMs - ROWS_WAIT_MS - 8 * 60_000).toISOString()).lte("finished_at", new Date(nowMs - ROWS_WAIT_MS).toISOString())
      .order("finished_at", { ascending: false }).limit(60);
    if (error) { console.warn("[search-widen-chain] Cron の読み取りに失敗:", error.message); res.errors++; return res; }
    const keys = new Map<string, { pcid: string; site: string }>();
    for (const r of (data ?? []) as Array<{ property_customer_id: string | null; site: string | null }>) {
      if (!r.property_customer_id || !r.site) continue;
      keys.set(`${r.property_customer_id}::${r.site}`, { pcid: r.property_customer_id, site: r.site });
    }
    for (const k of [...keys.values()].slice(0, opts.limit ?? 10)) {
      const r = await maybeChainWiden({ propertyCustomerId: k.pcid, site: k.site, trigger: "sweep", nowMs });
      res.checked++;
      if (r.commandId) res.widened++;
      if (r.error) res.errors++;
    }
  } catch (e) {
    console.warn("[search-widen-chain] Cron の例外:", e instanceof Error ? e.message : String(e));
    res.errors++;
  }
  return res;
}
