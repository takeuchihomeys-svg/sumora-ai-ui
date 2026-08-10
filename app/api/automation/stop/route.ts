import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export async function POST() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      { error: "server misconfigured: SUPABASE keys missing" },
      { status: 500 }
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  // pending / running のコマンドを全件 cancelled に更新
  const { data: cancelled, error } = await supabase
    .from("automation_commands")
    .update({ status: "cancelled" })
    .in("status", ["pending", "running"])
    .select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Supabase Realtime broadcast で Chrome拡張に即時ストップ信号を送る
  // ext-commands チャンネルを購読中の background.js が stop_command を受け取り
  // chrome.storage.local に batchStopRequested: true をセットしてループを中断する
  const ch = supabase.channel("ext-commands");
  try {
    await new Promise<void>((resolve) => {
      ch.subscribe((st) => { if (st === "SUBSCRIBED") resolve(); });
    });
    await ch.send({
      type: "broadcast",
      event: "stop_command",
      payload: { at: new Date().toISOString() },
    });
  } catch (broadcastErr) {
    // Realtime 失敗は致命的ではない（DB 側は既にキャンセル済み）
    console.warn("[automation/stop] Realtime broadcast 失敗:", broadcastErr);
  } finally {
    await supabase.removeChannel(ch).catch(() => {});
  }

  return NextResponse.json({ ok: true, cancelled: (cancelled ?? []).length });
}
