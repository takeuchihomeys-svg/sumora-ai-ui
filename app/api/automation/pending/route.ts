import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import {
  AIX_ONLY_SOURCES, BRAIN_ONLY_SOURCES, WAIT_FOR_PICKER_MS, AIX_EXPIRE_MESSAGE, BRAIN_EXPIRE_MESSAGE, pendingSourceOrFilter,
  pickClaimable, isPickerWaitExpired, pickerActiveAt, deferForRealproNotReady,
} from "@/app/lib/automation-sources";
import { claimExtVersion, claimInstallId, isMissingColumnError } from "@/app/lib/extension-snapshots";

export async function GET(req: NextRequest) {
  // 修正10: 共有シークレット認証（AUTOMATION_API_KEY 設定時のみ強制。未設定なら従来通り許可）
  const apiKey = process.env.AUTOMATION_API_KEY;
  if (apiKey && req.headers.get("x-automation-key") !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 障害修正: SUPABASE_SERVICE_ROLE_KEY 未設定でも空500クラッシュせず、
  // anon キーへフォールバック（automation_commands は RLS 無効のため機能同等）。
  // 両方欠落時は明示的な JSON エラーを返して障害を可視化する。
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      { error: "server misconfigured: SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY missing" },
      { status: 500 }
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  // 修正2: サーバー側ウォッチドッグ — running のまま30分以上放置されたコマンドを pending に戻す
  // （拡張SWクラッシュ等でコマンドが永久に running のまま止まるのを防ぐ）
  // 2026-09-30 picked_up_at は拡張の心拍（/api/automation/update の heartbeat・お客様ごとの進み）で新しくなる＝動いている長い命令は戻さない
  const staleBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { error: staleErr } = await supabase
    .from("automation_commands")
    .update({ status: "pending", picked_up_at: null })
    .eq("status", "running")
    .lt("picked_up_at", staleBefore);
  if (staleErr) {
    console.warn("[automation/pending] stale-running reset error:", staleErr.message);
  }

  // 2026-09-12 竹内方針「AIXモード」: AIX 由来（payload.source="aix"）の自動検索コマンドは、
  //   拡張の AIX ボタンを ON にしている PC（?aix=1）だけに渡す。OFF の PC には渡さない（pending のまま残る）。
  //   どの PC も AIX モードにしないまま 3時間経ったものは error で閉じる（古い指示で後から検索しない）。
  //   2026-09-19 竹内「拡張ツールAIXモードにしている場合、毎日11:00に…17:00に…」:
  //   時刻起動の自動検索（payload.source="auto_schedule"・/api/cron/auto-property-search が積む）も同じ扱いにする。
  //   AIX モードの PC だけが実行し、誰も AIX モードでなければ3時間で閉じる（古い指示で後から検索しない）。
  //   2026-09-25 竹内「チェックした物の一括検索。拡張ツールでブレインモードに選択していたら連動して検索。ブレインモードのみで連動」:
  //   ウェブの AIXツールの一括検索（payload.source="web_brain"）は、拡張のブレインが ON の PC（?brain=1・🧠×スタッフは付けない）だけに渡す。
  //   どの PC もブレインでないまま 3時間経ったものは error で閉じる。拾い手の決まりは app/lib/automation-sources.ts の1か所
  const aixMode = req.nextUrl.searchParams.get("aix") === "1";
  const brainMode = req.nextUrl.searchParams.get("brain") === "1";
  // v2.5.48: リアプロのタブが検索の画面でない PC（?rp=0）には、リアプロを含む手の命令を少しの間渡さない（deferForRealproNotReady）
  const rpReady = req.nextUrl.searchParams.get("rp") !== "0";
  const nowMs = Date.now();
  const expireBefore = new Date(nowMs - WAIT_FOR_PICKER_MS).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  // 2026-09-27 竹内「開始時間を毎日ランダムに」: 3時間は payload.not_before（あれば）から数える（isPickerWaitExpired）。
  //   not_before は積んだ時刻より後なので、積んだ時刻が3時間より前の物だけを候補に取り、JS で決める
  // 2026-09-30 自動便は60人×1人1命令を1台が順に拾う（1人 約7〜9分）: 拾い手が動いている間は「前の人が終わってから」3時間を数える
  //   （同じ出どころの命令の最後の picked_up_at・completed_at。isPickerWaitExpired）。拾い手がいない時は今まで通り not_before から3時間で閉じる
  const activeAtFor = async (sources: readonly string[]): Promise<number | null> => {
    const { data, error } = await supabase
      .from("automation_commands")
      .select("picked_up_at, completed_at")
      .in("payload->>source", [...sources])
      .not("picked_up_at", "is", null)
      .gte("picked_up_at", expireBefore)
      .order("picked_up_at", { ascending: false })
      .limit(20);
    if (error) { console.warn("[automation/pending] picker activity select error:", error.message); return null; }
    return pickerActiveAt((data ?? []) as Array<{ picked_up_at: string | null; completed_at: string | null }>);
  };
  const closeExpired = async (sources: readonly string[], message: string) => {
    const activeAt = await activeAtFor(sources);
    const { data: cand, error: candErr } = await supabase
      .from("automation_commands")
      .select("id, created_at, payload")
      .eq("status", "pending")
      .in("payload->>source", [...sources])
      .lt("created_at", expireBefore)
      .limit(200);
    if (candErr) { console.warn("[automation/pending] expire select error:", candErr.message); return; }
    const ids = (cand ?? []).filter((r) => isPickerWaitExpired(r, nowMs, activeAt)).map((r) => r.id);
    if (ids.length === 0) return;
    const { error: expErr } = await supabase
      .from("automation_commands")
      .update({ status: "error", error_message: message, completed_at: nowIso })
      .eq("status", "pending")
      .in("id", ids);
    if (expErr) console.warn("[automation/pending] expire error:", expErr.message);
  };
  await closeExpired(AIX_ONLY_SOURCES, AIX_EXPIRE_MESSAGE);
  await closeExpired(BRAIN_ONLY_SOURCES, BRAIN_EXPIRE_MESSAGE);

  let pendingQuery = supabase
    .from("automation_commands")
    .select("*")
    .eq("status", "pending");
  const sourceFilter = pendingSourceOrFilter({ aix: aixMode, brain: brainMode });
  if (sourceFilter) pendingQuery = pendingQuery.or(sourceFilter);
  // 2026-09-27: not_before（自動便の開始時刻）より前の物は渡さない。古い順に見て、今渡してよい最初の1件
  //   （自動便は1回に最大60件×午前と午後・時刻待ちの物の後ろに積まれた手動の検索が埋もれないよう多めに取る）
  const { data: commands, error: selErr } = await pendingQuery
    .order("created_at", { ascending: true })
    .limit(200);

  if (selErr) {
    return NextResponse.json({ error: selErr.message }, { status: 500 });
  }
  // 2026-09-30 今渡してよい物の中で自動便でない物（手の検索・AIX・広げての続き）を先に（自動便60人の後ろで何時間も待たせない・pickClaimable）
  const cmd = pickClaimable((commands ?? []).filter((c) => !deferForRealproNotReady(c, { rpReady }, nowMs)), nowMs);
  if (!cmd) {
    return NextResponse.json({ command: null });
  }

  // 修正3: 条件付きUPDATE + .select() で claim 成功を確認する。
  // 複数PCが同時にポーリングした場合、先に claim した方だけが実行権を得る。
  // 0行更新（= 他のPCが先に claim 済み）なら command: null を返して二重実行を防ぐ。
  // 2026-09-29 拾った拡張の版と PC（x-ext-version / x-ext-install・v2.5.40 から）を行に残す。
  //   9/29 16:32 の午後の便の見送りは v2.5.38 より前の拡張だったが、版の記録が search_audits にしか無く後から推すしかなかった。
  //   列（picked_ext_version / picked_install_id）がまだ無い DB でも claim を止めない（列が無いと言われたら版なしで claim し直す）
  const extVersion = claimExtVersion(req.headers.get("x-ext-version"));
  const extInstall = claimInstallId(req.headers.get("x-ext-install"));
  const claimUpdate: Record<string, unknown> = { status: "running", picked_up_at: new Date().toISOString() };
  if (extVersion) claimUpdate.picked_ext_version = extVersion;
  if (extInstall) claimUpdate.picked_install_id = extInstall;
  let { data: claimed, error: updErr } = await supabase
    .from("automation_commands")
    .update(claimUpdate)
    .eq("id", cmd.id)
    .eq("status", "pending")
    .select();
  if (updErr && (extVersion || extInstall) && isMissingColumnError(updErr)) {
    console.warn("[automation/pending] picked_ext_version の列が無い → 版なしで claim（migrate-schema を流すと残る）:", updErr.message);
    ({ data: claimed, error: updErr } = await supabase
      .from("automation_commands")
      .update({ status: "running", picked_up_at: claimUpdate.picked_up_at })
      .eq("id", cmd.id)
      .eq("status", "pending")
      .select());
  }

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ command: null });
  }

  return NextResponse.json({ command: { ...cmd, status: "running" } });
}
