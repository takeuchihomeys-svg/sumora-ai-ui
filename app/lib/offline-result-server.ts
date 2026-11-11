// app/lib/offline-result-server.ts（サーバー専用・DB を読むだけ）
// 電話の後・内覧の後のお礼の1通（スタッフの手打ち）から決まった事を取り、ブレインの材料の1行にする。決まりは純関数 offline-result.ts。
//   読む物: この会話のスタッフの文の新しい方 30通（14日以内）・その日の内覧の記録の部屋（viewing_history 3行）。新しい LLM 呼び出しは無い。
//   既定 off（OFFLINE_RESULT_MATERIAL=on）。失敗・時間切れは空（今まで通り）。
import { supabase } from "@/app/lib/supabase-server";
import { extractOfflineFacts, hasOfflineFacts, offlineResultMaterialLine, offlineResultMaterialOn } from "@/app/lib/offline-result";
import { jstMD } from "@/app/lib/jst-date";

const WINDOW_DAYS = 14;

export async function loadOfflineResultLine(conversationId: string): Promise<string> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase.from("messages").select("text, created_at")
    .eq("conversation_id", conversationId).eq("sender", "staff").gte("created_at", since)
    .order("created_at", { ascending: false }).limit(30);
  if (error) throw new Error(error.message);
  for (const m of (data ?? []) as Array<{ text: string | null; created_at: string }>) {
    const f = extractOfflineFacts(m.text);
    if (!f) continue;
    if (!hasOfflineFacts(f)) return ""; // 一番新しいお礼の1通に中身が無ければ出さない（古い1通に戻らない）
    let viewedRoom: string | null = null;
    if (f.kind === "viewing") {
      const day = new Date(Date.parse(m.created_at) + 9 * 3600_000).toISOString().slice(0, 10);
      const { data: v } = await supabase.from("viewing_history").select("property_name, scheduled_date")
        .eq("conversation_id", conversationId).eq("scheduled_date", day).limit(3);
      const names = [...new Set(((v ?? []) as Array<{ property_name: string | null }>).map((r) => r.property_name).filter((x): x is string => !!x))];
      viewedRoom = names.length === 1 ? names[0] : null;
    }
    return offlineResultMaterialLine(f, jstMD(m.created_at), { viewedRoom });
  }
  return "";
}

/** 時間の枠つき。off・失敗・枠切れは空 */
export async function loadOfflineResultLineWithin(ms: number, conversationId: string | null | undefined): Promise<string> {
  if (!offlineResultMaterialOn() || !conversationId) return "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const line = await Promise.race([loadOfflineResultLine(conversationId), new Promise<string>((res) => { timer = setTimeout(() => res(""), ms); })]);
    if (line) console.log(JSON.stringify({ tag: "brain:offline-result", conversationId, chars: line.length }));
    return line;
  } catch (e) {
    console.warn("[offline-result] 失敗:", conversationId, e instanceof Error ? e.message : e);
    return "";
  } finally { if (timer) clearTimeout(timer); }
}
