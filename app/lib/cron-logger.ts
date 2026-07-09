import { supabase } from "@/app/lib/supabase";

/**
 * cron_run_logs テーブルへの実行記録ユーティリティ。
 * 各cronの先頭で startCronLog() を呼び、完了時に finish() する。
 * DB書き込み失敗は握りつぶして本来のcron処理を止めない。
 */
export async function startCronLog(cronName: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("cron_run_logs")
      .insert({ cron_name: cronName })
      .select("id")
      .single();
    return (data?.id as string) ?? null;
  } catch {
    return null;
  }
}

export async function finishCronLog(
  runId: string | null,
  ok: boolean,
  resultJson?: Record<string, unknown>,
  errorMessage?: string,
): Promise<void> {
  if (!runId) return;
  try {
    await supabase.from("cron_run_logs").update({
      finished_at: new Date().toISOString(),
      ok,
      ...(resultJson ? { result_json: resultJson } : {}),
      ...(errorMessage ? { error_message: errorMessage.slice(0, 500) } : {}),
    }).eq("id", runId);
  } catch { /* ignore */ }
}
