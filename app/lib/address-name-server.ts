// 2026-09-12 竹内方針C: 呼び名の決定をサーバー側で1つにする（generate-reply と check-reply が同じ関数を呼ぶ）。
//   旧: generate-reply は DB名＋スタッフ送信100件の取り直し＋resolveAddressName、check-reply は窓内の表示名だけで決めていて、
//   窓（25件）にスタッフの呼びかけが無い会話では送信時チェックが別の名前を基準にしうる。
//   履歴は顧客の発言も取る（名乗り・申込フォーマット・本人確認書類＝「元の名前の固定」の判定に使う）。is_aix_generated で人間の呼び名を優先する。
import { supabase } from "@/app/lib/supabase";
import { resolveAddressName, type AddrMsg, type AddressNameVerdict } from "@/app/lib/validate-reply";
import { mergeHistoryForAddress, type AddressWindowMsg, type AddressDbMsg } from "@/app/lib/address-history";

const HISTORY_LIMIT = 150;

// ─── 顧客名をDBから解決（generate-reply から移設）────
// conversations.customer_name は line-webhook が LINEプロフィールの displayName で上書きするため表示名そのもの。
// property_customers.customer_name はスタッフが顧客管理画面で実名に修正できるので、そちらを先に見る。
export async function fetchDbCustomerNames(conversationId: string): Promise<{ pcName: string; convName: string }> {
  try {
    const { data: conv } = await supabase
      .from("conversations")
      .select("customer_name, property_customer_id")
      .eq("id", conversationId)
      .maybeSingle();
    const convRow = conv as { customer_name?: string | null; property_customer_id?: string | null } | null;
    if (!convRow) return { pcName: "", convName: "" };
    const convName = (convRow.customer_name ?? "").trim();
    const pcId = convRow.property_customer_id;
    if (!pcId) return { pcName: "", convName };
    const { data: pc } = await supabase
      .from("property_customers")
      .select("customer_name")
      .eq("id", pcId)
      .maybeSingle();
    const pcName = ((pc as { customer_name?: string | null } | null)?.customer_name ?? "").trim();
    return { pcName, convName };
  } catch (err) {
    console.warn("[address-name] 顧客名のDB取得失敗 — 名前なしで続行:", err);
    return { pcName: "", convName: "" };
  }
}

type WindowMsg = AddressWindowMsg;
type DbMsg = AddressDbMsg;

/** 会話の呼び名を決める（DB名・履歴150件・窓をつないで resolveAddressName を1回）。fail-open（DB 取得に失敗したら窓だけで決める） */
export async function resolveAddressNameForConversation(
  conversationId: string | null | undefined,
  recentMessages: WindowMsg[],
  displayName?: string | null,
): Promise<AddressNameVerdict & { pcName: string; convName: string }> {
  if (!conversationId) {
    return { ...resolveAddressName({ messages: recentMessages, displayName: displayName ?? "" }), pcName: "", convName: "" };
  }
  const [names, hist] = await Promise.all([
    fetchDbCustomerNames(conversationId),
    supabase.from("messages").select("sender, text, created_at, is_aix_generated")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false }).limit(HISTORY_LIMIT)
      .then((r) => r, (e: unknown) => ({ data: null, error: e })),
  ]);
  const disp = (displayName ?? "").trim() || names.convName;
  let messages: AddrMsg[] = recentMessages.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.createdAt ?? null, isAix: m.isAix ?? null }));
  const rows = (hist as { data: DbMsg[] | null }).data;
  if (rows && rows.length) messages = mergeHistoryForAddress(recentMessages, rows);
  else if ((hist as { error?: unknown }).error) console.warn("[address-name] 呼び名の履歴取得に失敗（窓内の結果で続行）");
  return { ...resolveAddressName({ messages, displayName: disp, pcName: names.pcName }), pcName: names.pcName, convName: names.convName };
}
