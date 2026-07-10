import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 30;

// POST /api/cron/auto-reply-readiness
// 週次（月曜早朝）に各aix_typeの「自動返信化準備スコア」を計算してai_promptsに保存
//
// 判定基準:
//   - acceptance_rate >= 0.65（提案採択率65%以上）
//   - edit_rate < 0.30（編集率30%未満 = 7割以上そのまま送っている）
//   - 両方満たす → ready: true
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const reportDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

    // 1. action_pattern_logs から直近30日の採択率をaix_type別に集計
    //    accepted: suggestion_accepted + prediction_match
    //    dismissed: suggestion_dismissed + prediction_mismatch + suggestion_bypassed
    const { data: patternLogs } = await supabase
      .from("action_pattern_logs")
      .select("action_type, source")
      .in("source", [
        "suggestion_accepted",
        "suggestion_dismissed",
        "prediction_match",
        "prediction_mismatch",
        "suggestion_bypassed",
      ])
      .gte("created_at", since30d)
      .limit(5000);

    const acceptanceStats: Record<string, { accepted: number; total: number }> = {};
    for (const log of (patternLogs ?? []) as Array<{ action_type: string; source: string }>) {
      const at = log.action_type;
      if (!at) continue;
      acceptanceStats[at] ??= { accepted: 0, total: 0 };
      acceptanceStats[at].total += 1;
      if (log.source === "suggestion_accepted" || log.source === "prediction_match") {
        acceptanceStats[at].accepted += 1;
      }
    }

    // 2. aix_usage_logs から直近30日の編集率をaix_type別に集計（was_editedがNULLのものは除外）
    const { data: usageLogs } = await supabase
      .from("aix_usage_logs")
      .select("aix_type, was_edited")
      .gte("created_at", since30d)
      .not("was_edited", "is", null)
      .limit(5000);

    const editStats: Record<string, { edited: number; total: number }> = {};
    for (const log of (usageLogs ?? []) as Array<{ aix_type: string; was_edited: boolean | null }>) {
      const at = log.aix_type;
      if (!at || log.was_edited === null) continue;
      editStats[at] ??= { edited: 0, total: 0 };
      editStats[at].total += 1;
      if (log.was_edited) editStats[at].edited += 1;
    }

    // 3. 全aix_typeを列挙してスコアを計算
    //    MIN_SAMPLES=3 未満はデータ不足として null（判定不可）
    const MIN_SAMPLES = 3;
    const allTypes = new Set([
      ...Object.keys(acceptanceStats),
      ...Object.keys(editStats),
    ]);

    const scores = Array.from(allTypes).map((aix_type) => {
      const acc = acceptanceStats[aix_type];
      const edit = editStats[aix_type];

      const acceptance_rate =
        acc && acc.total >= MIN_SAMPLES ? Math.round((acc.accepted / acc.total) * 1000) / 1000 : null;
      const edit_rate =
        edit && edit.total >= MIN_SAMPLES ? Math.round((edit.edited / edit.total) * 1000) / 1000 : null;

      const ready =
        acceptance_rate !== null &&
        edit_rate !== null &&
        acceptance_rate >= 0.65 &&
        edit_rate < 0.30;

      let reason: string;
      if (acceptance_rate === null && edit_rate === null) {
        reason = "データ不足（採択率・編集率ともサンプル数が3件未満）";
      } else if (acceptance_rate === null) {
        reason = `採択率データ不足・編集率${Math.round((edit_rate ?? 0) * 100)}%`;
      } else if (edit_rate === null) {
        reason = `採択率${Math.round(acceptance_rate * 100)}%・編集率データ不足`;
      } else if (ready) {
        reason = `採択率${Math.round(acceptance_rate * 100)}%・編集率${Math.round(edit_rate * 100)}% → 自動返信化OK`;
      } else {
        const issues: string[] = [];
        if (acceptance_rate < 0.65) issues.push(`採択率${Math.round(acceptance_rate * 100)}%（65%未満）`);
        if (edit_rate >= 0.30) issues.push(`編集率${Math.round(edit_rate * 100)}%（30%以上）`);
        reason = issues.join("・") + " → まだ学習が必要";
      }

      return { aix_type, acceptance_rate, edit_rate, ready, reason };
    }).sort((a, b) => {
      // ready=true を先頭に、次に acceptance_rate の降順
      if (a.ready && !b.ready) return -1;
      if (!a.ready && b.ready) return 1;
      return (b.acceptance_rate ?? 0) - (a.acceptance_rate ?? 0);
    });

    const content = JSON.stringify({ report_date: reportDate, scores }, null, 2);

    const { error } = await supabase.from("ai_prompts").upsert(
      {
        key: "auto_reply_readiness",
        label: "自動返信化準備スコア",
        content,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    const readyTypes = scores.filter((s) => s.ready).map((s) => s.aix_type);
    return NextResponse.json({ ok: true, report_date: reportDate, total: scores.length, ready: readyTypes });
  } catch (e) {
    console.error("[auto-reply-readiness]", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}

// GET: Vercel CronはGETでリクエストするため、認証チェック後POSTへ委譲
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
