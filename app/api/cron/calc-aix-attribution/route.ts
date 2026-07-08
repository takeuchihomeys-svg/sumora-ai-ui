import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// P5: 成果アトリビューション週次集計
// 過去7日間の aix_usage_logs を (aix_type, template_id) でグルーピングし、
// 各会話が「AIX使用後に」内覧(viewing)・申込(applying)・成約(closed_won)へ
// 到達したかを集計して aix_action_attribution に保存する。
//
// 到達判定:
//   - conversations.status（現在値）が該当マイルストーン以上のランクに達している
//   - かつ AIX使用時点のステータス（aix_usage_logs.conversation_status）が
//     マイルストーン未満だった（＝AIXアクションがマイルストーン到達より前）
//   これにより「すでに内覧後だった会話への使用」を内覧到達の手柄にカウントしない。
//
// 冪等性: UNIQUE制約が式インデックス（COALESCE(template_id::text,'none')）のため
// supabase-js の upsert onConflict が使えない。同一 period_start の行を
// delete → insert で置き換える方式（再実行しても重複しない）。
//
// 毎週日曜 JST 04:00（vercel.json cron: 0 19 * * 0）

export const maxDuration = 60;

// 会話ステータスのファネル順ランク（conversations.status の実在12値）
const STATUS_RANK: Record<string, number> = {
  first_reply: 0,
  hearing: 1,
  condition_hearing: 1,
  property_search: 2,
  property_recommendation: 2,
  proposing: 2,
  availability_check: 3,
  viewing: 4,
  estimate_request: 5,
  applying: 6,
  screening: 7,
  closed_won: 8,
};

const VIEWING_RANK = STATUS_RANK.viewing; // 4
const APPLICATION_RANK = STATUS_RANK.applying; // 6
const WON_RANK = STATUS_RANK.closed_won; // 8

function rankOf(status: string | null | undefined): number {
  if (!status) return -1; // 不明は「最初期」扱い（到達の手柄は認める）
  return STATUS_RANK[status] ?? -1;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false; // 未設定時は全拒否（fail-closed）
  const authHeader = req.headers.get("authorization");
  const xSecret = req.headers.get("x-cron-secret");
  return authHeader === `Bearer ${cronSecret}` || xSecret === cronSecret;
}

type UsageLog = {
  conversation_id: string;
  aix_type: string;
  template_id: string | null;
  template_name: string | null;
  conversation_status: string | null;
  created_at: string;
};

async function run() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const periodStart = sevenDaysAgo.toISOString().slice(0, 10);
  const periodEnd = now.toISOString().slice(0, 10);

  // 1. 過去7日間のAIX使用ログ
  const { data: logs, error: logsErr } = await supabase
    .from("aix_usage_logs")
    .select("conversation_id, aix_type, template_id, template_name, conversation_status, created_at")
    .gte("created_at", sevenDaysAgo.toISOString())
    .limit(10000);

  if (logsErr) {
    console.error("[calc-aix-attribution] logs fetch error:", logsErr.message);
    return NextResponse.json({ ok: false, error: logsErr.message }, { status: 500 });
  }

  const usageLogs = (logs ?? []) as UsageLog[];
  if (usageLogs.length === 0) {
    console.log("[calc-aix-attribution] no usage logs in period, skip");
    return NextResponse.json({
      ok: true,
      period: { periodStart, periodEnd },
      groups: 0,
      logs: 0,
    });
  }

  // 2. 対象会話の現在ステータスを取得（.in() は200件ずつチャンク）
  const convIds = Array.from(new Set(usageLogs.map((l) => l.conversation_id).filter(Boolean)));
  const currentStatus = new Map<string, string>();
  for (let i = 0; i < convIds.length; i += 200) {
    const chunk = convIds.slice(i, i + 200);
    const { data: convs, error: convErr } = await supabase
      .from("conversations")
      .select("id, status")
      .in("id", chunk);
    if (convErr) {
      console.error("[calc-aix-attribution] conv fetch error:", convErr.message);
      return NextResponse.json({ ok: false, error: convErr.message }, { status: 500 });
    }
    for (const c of convs ?? []) {
      if (c.id && c.status) currentStatus.set(c.id as string, c.status as string);
    }
  }

  // 3. (aix_type, template_id) でグルーピングして到達件数を集計
  type Group = {
    action_type: string;
    template_id: string | null;
    template_label: string | null;
    usage_count: number;
    // 会話ごとの「AIX使用時点の最小ランク」（複数回使用時は最も早い段階を採用）
    convMinPriorRank: Map<string, number>;
  };
  const groups = new Map<string, Group>();

  for (const log of usageLogs) {
    if (!log.conversation_id || !log.aix_type) continue;
    const key = `${log.aix_type}|${log.template_id ?? "none"}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        action_type: log.aix_type,
        template_id: log.template_id ?? null,
        template_label: log.template_name ?? null,
        usage_count: 0,
        convMinPriorRank: new Map(),
      };
      groups.set(key, g);
    }
    g.usage_count++;
    if (!g.template_label && log.template_name) g.template_label = log.template_name;
    const prior = rankOf(log.conversation_status);
    const existing = g.convMinPriorRank.get(log.conversation_id);
    if (existing === undefined || prior < existing) {
      g.convMinPriorRank.set(log.conversation_id, prior);
    }
  }

  const rows = Array.from(groups.values()).map((g) => {
    let viewingReached = 0;
    let applicationReached = 0;
    let closedWon = 0;
    const uniqueConvs = g.convMinPriorRank.size;

    for (const [convId, priorRank] of g.convMinPriorRank) {
      const cur = rankOf(currentStatus.get(convId));
      // 「AIX使用後に到達」= 現在ランクがマイルストーン以上 かつ 使用時点では未到達
      if (cur >= VIEWING_RANK && priorRank < VIEWING_RANK) viewingReached++;
      if (cur >= APPLICATION_RANK && priorRank < APPLICATION_RANK) applicationReached++;
      if (cur >= WON_RANK && priorRank < WON_RANK) closedWon++;
    }

    return {
      action_type: g.action_type,
      template_id: g.template_id,
      template_label: g.template_label,
      period_start: periodStart,
      period_end: periodEnd,
      usage_count: g.usage_count,
      unique_conversations: uniqueConvs,
      viewing_reached: viewingReached,
      application_reached: applicationReached,
      closed_won: closedWon,
      // 率は「重複除外した会話数」を分母にする（同一会話への複数回使用で率が薄まるのを防ぐ）
      viewing_rate: uniqueConvs > 0 ? round3(viewingReached / uniqueConvs) : 0,
      application_rate: uniqueConvs > 0 ? round3(applicationReached / uniqueConvs) : 0,
      win_rate: uniqueConvs > 0 ? round3(closedWon / uniqueConvs) : 0,
      calculated_at: now.toISOString(),
    };
  });

  // 4. 同一 period_start の既存行を削除してから insert（再実行しても冪等）
  const { error: delErr } = await supabase
    .from("aix_action_attribution")
    .delete()
    .eq("period_start", periodStart);
  if (delErr) {
    console.error("[calc-aix-attribution] delete error:", delErr.message);
    return NextResponse.json({ ok: false, error: delErr.message }, { status: 500 });
  }

  if (rows.length > 0) {
    const { error: insErr } = await supabase.from("aix_action_attribution").insert(rows);
    if (insErr) {
      console.error("[calc-aix-attribution] insert error:", insErr.message);
      return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 });
    }
  }

  // 5. templates.win_rate を全期間の実績から再計算して同期
  //    ソース①: aix_action_attribution（AIX文案生成経由・template_id付き）
  //    ソース②: template_selection_logs（B5バナー経由一般テンプレ選択・phase=sent）
  //    両ソースを合算して win_rate = closed_won / unique_conversations を設定する
  let winRateSynced = 0;

  // ソース①: aix_action_attribution から集計
  const { data: attrRows, error: attrErr } = await supabase
    .from("aix_action_attribution")
    .select("template_id, closed_won, unique_conversations")
    .not("template_id", "is", null)
    .limit(10000);

  // ソース②: template_selection_logs から集計（過去全期間・B5バナー経由テンプレのsent記録）
  const { data: tslRows, error: tslErr } = await supabase
    .from("template_selection_logs")
    .select("template_id, conversation_id, conversation_status, created_at")
    .eq("phase", "sent")
    .not("template_id", "is", null)
    .limit(20000);

  if (attrErr) console.error("[calc-aix-attribution] attribution fetch error:", attrErr.message);
  if (tslErr) console.error("[calc-aix-attribution] tsl fetch error:", tslErr.message);

  const byTemplate = new Map<string, { won: number; convs: number }>();

  // ソース①を投入
  for (const r of attrRows ?? []) {
    const tid = r.template_id as string | null;
    if (!tid) continue;
    const cur = byTemplate.get(tid) ?? { won: 0, convs: 0 };
    cur.won += (r.closed_won as number) ?? 0;
    cur.convs += (r.unique_conversations as number) ?? 0;
    byTemplate.set(tid, cur);
  }

  // ソース②を投入（template_selection_logs: 会話ごとに到達判定して合算）
  if ((tslRows ?? []).length > 0) {
    const tslConvIds = Array.from(new Set((tslRows ?? []).map(r => r.conversation_id as string).filter(Boolean)));
    const tslCurrentStatus = new Map<string, string>();
    for (let i = 0; i < tslConvIds.length; i += 200) {
      const chunk = tslConvIds.slice(i, i + 200);
      const { data: tslConvs } = await supabase
        .from("conversations").select("id, status").in("id", chunk);
      for (const c of tslConvs ?? []) {
        if (c.id && c.status) tslCurrentStatus.set(c.id as string, c.status as string);
      }
    }
    // テンプレ別に会話×到達判定（重複除外）
    const tslByTemplate = new Map<string, { convs: Set<string>; wonConvs: Set<string> }>();
    for (const r of tslRows ?? []) {
      const tid = r.template_id as string | null;
      const cid = r.conversation_id as string | null;
      if (!tid || !cid) continue;
      const entry = tslByTemplate.get(tid) ?? { convs: new Set(), wonConvs: new Set() };
      entry.convs.add(cid);
      if (rankOf(tslCurrentStatus.get(cid)) >= WON_RANK && rankOf(r.conversation_status as string) < WON_RANK) {
        entry.wonConvs.add(cid);
      }
      tslByTemplate.set(tid, entry);
    }
    for (const [tid, v] of tslByTemplate) {
      const cur = byTemplate.get(tid) ?? { won: 0, convs: 0 };
      cur.won += v.wonConvs.size;
      cur.convs += v.convs.size;
      byTemplate.set(tid, cur);
    }
  }

  for (const [templateId, v] of byTemplate) {
    const winRate = v.convs > 0 ? round3(v.won / v.convs) : 0;
    const { error: updErr } = await supabase
      .from("templates")
      .update({ win_rate: winRate })
      .eq("id", templateId);
    if (updErr) {
      console.error(`[calc-aix-attribution] win_rate update error (template ${templateId}):`, updErr.message);
    } else {
      winRateSynced++;
    }
  }

  const summary = {
    logs: usageLogs.length,
    conversations: convIds.length,
    groups: rows.length,
    win_rate_synced: winRateSynced,
    viewing_reached: rows.reduce((s, r) => s + r.viewing_reached, 0),
    application_reached: rows.reduce((s, r) => s + r.application_reached, 0),
    closed_won: rows.reduce((s, r) => s + r.closed_won, 0),
  };
  console.log(
    `[calc-aix-attribution] done: period=${periodStart}..${periodEnd} groups=${summary.groups} logs=${summary.logs} viewing=${summary.viewing_reached} apply=${summary.application_reached} won=${summary.closed_won}`
  );
  return NextResponse.json({ ok: true, period: { periodStart, periodEnd }, ...summary });
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return run();
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return run();
}
