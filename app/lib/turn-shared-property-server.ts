// app/lib/turn-shared-property-server.ts（サーバー専用・DB を読むだけ・画面側から import しない）
// 今の番にお客様が送ってきた物件（URL・画像）の物件名・号室を決める材料を読む。決まりは純関数 turn-shared-property.ts に1つ。
//   読む物: この会話の新しい方の発言 40通（今の番を切り出す）・こちらが送った部屋（sent_image_properties 60行の物件名・号室・facts）・
//           共有文に名前の無い SUUMO の URL だけ 1件ページを読む（portal-page-read・1時間覚える・2.5秒まで）。新しい LLM 呼び出しは無い。
//   既定 off（TURN_SHARED_PROPERTY_TARGET=on）。失敗・時間切れは null（今まで通り）。
import { supabase } from "@/app/lib/supabase-server";
import { customerTurnOf, knownRoomOf, sharedPropertyOfTurn, turnSharedPropertyTargetOn, type KnownRoom, type SharedTarget, type TsMsg } from "@/app/lib/turn-shared-property";
import { customerSharedPropertyNames } from "@/app/lib/customer-property-names";
import { portalUrlsIn, readPortalPage, type PortalPage } from "@/app/lib/portal-page-read";

export async function loadTurnSharedProperty(conversationId: string): Promise<{ target: SharedTarget | null; reason: string; found: number }> {
  const { data: msgs, error } = await supabase.from("messages").select("sender, text, image_type, created_at")
    .eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(40);
  if (error) throw new Error(error.message);
  const turn = customerTurnOf(((msgs ?? []) as TsMsg[]).reverse());
  if (!turn.some((m) => /^\s*\[画像\]/.test(String(m.text ?? "")) || /https?:\/\//.test(String(m.text ?? "")))) return { target: null, reason: "none", found: 0 };
  const { data: sent } = await supabase.from("sent_image_properties").select("property_name, room_no, facts")
    .eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(60);
  const known = ((sent ?? []) as Array<{ property_name: string | null; room_no: string | null; facts: unknown }>).map(knownRoomOf).filter((k): k is KnownRoom => !!k);
  const pages = new Map<string, PortalPage>();
  // 共有文に名前の無い URL だけ（名前がある物は共有文で決まる）・1件だけ開く
  const nameless = turn.filter((m) => !customerSharedPropertyNames([{ sender: "customer", text: m.text ?? "", createdAt: m.created_at }], { limit: 1 }).length)
    .flatMap((m) => portalUrlsIn(m.text));
  if (nameless[0]) pages.set(nameless[0], await readPortalPage(nameless[0], { timeoutMs: 2_500 }));
  return sharedPropertyOfTurn({ turn, pages, known });
}

/** 時間の枠つき（ブレインは待ちすぎない）。off・失敗・枠切れは null */
export async function loadTurnSharedPropertyWithin(ms: number, conversationId: string | null | undefined): Promise<SharedTarget | null> {
  if (!turnSharedPropertyTargetOn() || !conversationId) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const r = await Promise.race([
      loadTurnSharedProperty(conversationId),
      new Promise<null>((res) => { timer = setTimeout(() => res(null), ms); }),
    ]);
    if (r) console.log(JSON.stringify({ tag: "brain:turn-shared-property", conversationId, reason: r.reason, found: r.found, by: r.target?.by ?? null, target: r.target ? `${r.target.name}${r.target.roomNo ? ` ${r.target.roomNo}` : ""}` : null }));
    return r?.target ?? null;
  } catch (e) {
    console.warn("[turn-shared-property] 失敗:", conversationId, e instanceof Error ? e.message : e);
    return null;
  } finally { if (timer) clearTimeout(timer); }
}
