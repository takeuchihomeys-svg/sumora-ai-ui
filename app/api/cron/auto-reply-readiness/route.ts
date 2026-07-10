import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 30;

// POST /api/cron/auto-reply-readiness
// 週次（月曜早朝）に各aix_typeの「自動返信化準備スコア」を計算してai_promptsに保存
//
// 判定基準（HIGH-04: サンプル3件でready:trueになるのを防止＋成約率を条件に追加）:
//   - acceptance_rate >= 0.65（提案採択率65%以上）
//   - edit_rate < 0.30（編集率30%未満 = 7割以上そのまま送っている）
//   - サンプル数 >= 15（採択率・編集率とも。rate表示自体は3件から）
//   - win_rate データがある場合は 全aix_type平均の半分以上
//   - 全て満たす → ready: true
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
    //    中3: 同一AIX送信で suggestion_accepted（バナークリック）と prediction_match（送信完了）の
    //    2行が入り採択率が上振れするため、prediction_match のみを accepted の正とする
    //    accepted: prediction_match のみ
    //    total: suggestion_accepted + suggestion_dismissed + prediction_match + prediction_mismatch + suggestion_bypassed
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
      // 中3: suggestion_accepted は total のみ（prediction_match が accepted を代表する）
      if (log.source === "prediction_match") {
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

    // 2.5. aix_action_attribution から直近30日の aix_type 別 win_rate 平均を取得
    //      （HIGH-04: 成約率が低いaix_typeを ready:true にしないための条件）
    const since30dDate = since30d.slice(0, 10);
    const { data: attrRows } = await supabase
      .from("aix_action_attribution")
      .select("action_type, win_rate")
      .gte("period_start", since30dDate)
      .not("win_rate", "is", null)
      .limit(5000);

    const winRateAgg: Record<string, { sum: number; n: number }> = {};
    for (const row of (attrRows ?? []) as Array<{ action_type: string; win_rate: number | null }>) {
      if (!row.action_type || row.win_rate === null) continue;
      winRateAgg[row.action_type] ??= { sum: 0, n: 0 };
      winRateAgg[row.action_type].sum += Number(row.win_rate);
      winRateAgg[row.action_type].n += 1;
    }
    const winRateData: Record<string, number> = {};
    for (const [at, agg] of Object.entries(winRateAgg)) {
      winRateData[at] = Math.round((agg.sum / agg.n) * 1000) / 1000;
    }
    const winRateValues = Object.values(winRateData);
    const avgWinRate = winRateValues.length > 0
      ? winRateValues.reduce((a, b) => a + b, 0) / winRateValues.length
      : 0;

    // 3. 全aix_typeを列挙してスコアを計算
    //    MIN_SAMPLES=3 未満はデータ不足として null（判定不可・rate計算の下限）
    //    ready判定はサンプル15件以上を要求（HIGH-04: 3件でready:trueは根拠が弱すぎる）
    const MIN_SAMPLES = 3;
    const MIN_SAMPLES_FOR_READY = 15;
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

      // win_rateデータがない場合は条件をスキップ（データありなら全aix_type平均の半分以上を要求）
      const win_rate = winRateData[aix_type] ?? null;
      const winRateOk = win_rate === null || win_rate >= avgWinRate * 0.5;

      const enoughSamples =
        (acc?.total ?? 0) >= MIN_SAMPLES_FOR_READY &&
        (edit?.total ?? 0) >= MIN_SAMPLES_FOR_READY;

      const ready =
        acceptance_rate !== null &&
        edit_rate !== null &&
        acceptance_rate >= 0.65 &&
        edit_rate < 0.30 &&
        winRateOk &&
        enoughSamples;

      const winRateInfo = win_rate !== null
        ? `成約率${Math.round(win_rate * 100)}%（全体平均${Math.round(avgWinRate * 100)}%）`
        : "成約率データなし";

      let reason: string;
      if (acceptance_rate === null && edit_rate === null) {
        reason = `データ不足（採択率・編集率ともサンプル数が3件未満）・${winRateInfo}`;
      } else if (acceptance_rate === null) {
        reason = `採択率データ不足・編集率${Math.round((edit_rate ?? 0) * 100)}%・${winRateInfo}`;
      } else if (edit_rate === null) {
        reason = `採択率${Math.round(acceptance_rate * 100)}%・編集率データ不足・${winRateInfo}`;
      } else if (ready) {
        reason = `採択率${Math.round(acceptance_rate * 100)}%・編集率${Math.round(edit_rate * 100)}%・${winRateInfo} → 自動返信化OK`;
      } else {
        const issues: string[] = [];
        if (acceptance_rate < 0.65) issues.push(`採択率${Math.round(acceptance_rate * 100)}%（65%未満）`);
        if (edit_rate >= 0.30) issues.push(`編集率${Math.round(edit_rate * 100)}%（30%以上）`);
        if (!winRateOk) issues.push(`${winRateInfo}（平均の半分未満）`);
        if (!enoughSamples) issues.push(`サンプル数不足（採択${acc?.total ?? 0}件・編集${edit?.total ?? 0}件 / ${MIN_SAMPLES_FOR_READY}件以上必要）`);
        reason = issues.join("・") + `${winRateOk ? `・${winRateInfo}` : ""} → まだ学習が必要`;
      }

      return { aix_type, acceptance_rate, edit_rate, win_rate, ready, reason };
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

    // 時系列スナップショットに追記（upsertで日付×aix_type単位の重複防止）
    const snapshots = scores.map((s) => ({
      report_date: reportDate,
      aix_type: s.aix_type,
      acceptance_rate: s.acceptance_rate,
      edit_rate: s.edit_rate,
      ready: s.ready,
      reason: s.reason,
    }));
    await supabase.from("aix_readiness_snapshots").upsert(snapshots, { onConflict: "report_date,aix_type" });

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
