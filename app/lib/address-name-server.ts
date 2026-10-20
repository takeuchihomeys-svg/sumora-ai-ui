// 2026-09-12 竹内方針C: 呼び名の決定をサーバー側で1つにする（generate-reply と check-reply が同じ関数を呼ぶ）。
//   旧: generate-reply は DB名＋スタッフ送信100件の取り直し＋resolveAddressName、check-reply は窓内の表示名だけで決めていて、
//   窓（25件）にスタッフの呼びかけが無い会話では送信時チェックが別の名前を基準にしうる。
//   履歴は顧客の発言も取る（名乗り・申込フォーマット・本人確認書類＝「元の名前の固定」の判定に使う）。is_aix_generated で人間の呼び名を優先する。
import { supabase } from "@/app/lib/supabase";
import { resolveAddressName, type AddrMsg, type AddressNameVerdict } from "@/app/lib/validate-reply";
import { mergeHistoryForAddress, type AddressWindowMsg, type AddressDbMsg } from "@/app/lib/address-history";
import { isGroupConversationName } from "@/app/lib/line-target";
import { staffCalledName } from "@/app/lib/aix-staff-called-name";
import { lockedCallName } from "@/app/lib/call-name-guard";
import { hasNameLetter, lockableCallNameSource } from "@/app/lib/call-name-pick";

const HISTORY_LIMIT = 150;

// ─── 顧客名をDBから解決（generate-reply から移設）────
// conversations.customer_name は line-webhook が LINEプロフィールの displayName で上書きするため表示名そのもの。
// property_customers.customer_name はスタッフが顧客管理画面で実名に修正できるので、そちらを先に見る。
export async function fetchDbCustomerNames(conversationId: string): Promise<{ pcName: string; convName: string; callName?: string }> {
  try {
    // 2026-10-06 ⑫ 竹内「お客さん毎に名前決まったら固定」: 固定の呼び名（conversations.call_name）も読む（列がまだ無い時は読まない）
    let convRes = await supabase.from("conversations").select("customer_name, property_customer_id, call_name").eq("id", conversationId).maybeSingle();
    if (convRes.error) convRes = await supabase.from("conversations").select("customer_name, property_customer_id").eq("id", conversationId).maybeSingle();
    const conv = convRes.data;
    const convRow = conv as { customer_name?: string | null; property_customer_id?: string | null; call_name?: string | null } | null;
    if (!convRow) return { pcName: "", convName: "" };
    const convName = (convRow.customer_name ?? "").trim();
    const callName = (convRow.call_name ?? "").trim();
    const pcId = convRow.property_customer_id;
    if (!pcId) return { pcName: "", convName, callName };
    const { data: pc } = await supabase
      .from("property_customers")
      .select("customer_name")
      .eq("id", pcId)
      .maybeSingle();
    const pcName = ((pc as { customer_name?: string | null } | null)?.customer_name ?? "").trim();
    return { pcName, convName, callName };
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
    const d = isGroupConversationName(displayName) ? "" : (displayName ?? "");
    return { ...resolveAddressName({ messages: recentMessages, displayName: d }), pcName: "", convName: "" };
  }
  const [names, hist] = await Promise.all([
    fetchDbCustomerNames(conversationId),
    supabase.from("messages").select("sender, text, created_at, is_aix_generated")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false }).limit(HISTORY_LIMIT)
      .then((r) => r, (e: unknown) => ({ data: null, error: e })),
  ]);
  // 2026-09-21 竹内（黒明様お部屋探し）: グループの会話の表示名は「【グループ】黒明様お部屋探し」＝人の名前ではない。
  //   これを呼び名の元にすると「黒明様お部屋探しさん」になる。グループでは表示名を使わず、
  //   スタッフが実際に呼んだ名前（履歴）と顧客管理の実名だけで決める
  const isGroup = isGroupConversationName(names.convName) || isGroupConversationName(displayName);
  const disp = isGroup ? "" : ((displayName ?? "").trim() || names.convName);
  let messages: AddrMsg[] = recentMessages.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.createdAt ?? null, isAix: m.isAix ?? null }));
  const rows = (hist as { data: DbMsg[] | null }).data;
  if (rows && rows.length) messages = mergeHistoryForAddress(recentMessages, rows);
  else if ((hist as { error?: unknown }).error) console.warn("[address-name] 呼び名の履歴取得に失敗（窓内の結果で続行）");
  const verdict = resolveAddressName({ messages, displayName: disp, pcName: names.pcName });
  // 2026-10-06 ⑫ 竹内「名前間違えているの絶対にいれない…お客さん毎に名前決まったら固定していたらこんなミス起きない」（あ・「森本様」）:
  //   resolveAddressName は名前の形（ひらがな2字以上 等）で本物かを決め、1文字の「あ」を採らず「呼び名なし」→ LLM が名前を作った。
  //   固定の呼び名（call_name）→ スタッフ（人）が冒頭で2回以上呼んだ名前（形を問わない）→ 今までの結果 の順に決める（call-name-guard.lockedCallName）。
  //   スタッフが2回以上呼んだ名前が決まって、まだ固定が無ければ固定する（以後は形・揺れに関わらずこの名前）
  const staffCalled = staffCalledName(messages.filter((m) => m.sender === "staff" && !(m.isAix ?? m.is_aix_generated)).map((m) => ({ sender: "staff", text: m.text ?? "" })));
  // 2026-10-20 竹内さん（P1 979a4c55・ayaka→🎀）「最初呼んでいた名前で連絡する」: 絵文字・記号・数字だけの名前は呼び名にしない（固定もしない）。
  //   固定はスタッフが2回以上呼んだ名前に加えて、会話で確定した名前（行頭の呼びかけ・元の名前・お客様の名乗り＝call-name-pick.lockableCallNameSource）でも行う。
  //   表示名・登録名からの名前は固定しない（表示名が変わったら変わる物を固定しない）。戻す: CALL_NAME_LOCK_FROM_CONVERSATION=off
  const storedOk = hasNameLetter(names.callName) ? names.callName : "";
  const staffCalledOk = hasNameLetter(staffCalled) ? staffCalled : "";
  const locked = lockedCallName({ stored: storedOk, staffCalled: staffCalledOk, resolved: verdict.name });
  const lockFromConv = (process.env.CALL_NAME_LOCK_FROM_CONVERSATION ?? "").trim().toLowerCase() !== "off";
  const toLock = !names.callName && locked.name && (locked.source === "staff_called" || (lockFromConv && locked.source === "resolved" && lockableCallNameSource(verdict.source, locked.name)))
    ? locked.name : "";
  if (toLock) {
    void supabase.from("conversations").update({ call_name: toLock }).eq("id", conversationId).is("call_name", null)
      .then(({ error }) => { if (error && !/call_name/.test(error.message)) console.warn("[address-name] 呼び名の固定に失敗:", error.message); });
  }
  const finalVerdict: AddressNameVerdict = locked.name && locked.name !== verdict.name
    ? { ...verdict, name: locked.name, source: verdict.source, evidence: `${locked.source}:${locked.name}`, aliases: [...new Set([...verdict.aliases, locked.name])] }
    : verdict;
  return { ...finalVerdict, pcName: names.pcName, convName: names.convName };
}

/**
 * 2026-10-20 竹内さん（P1 979a4c55）: AIX・テンプレートの名前の差し込みも返信の下書きと同じ呼び名にする（固定の呼び名 → 会話で確定した名前 → 名前なし）。
 *   会話が分からない・読めない時は渡された名前（絵文字・記号・数字だけなら ""）。表示名の変更（ayaka→🎀）で変わらない
 */
export async function callNameForConversation(conversationId: string | null | undefined, fallbackName?: string | null): Promise<string> {
  const { pickCallName } = await import("@/app/lib/call-name-pick");
  if (!conversationId) return pickCallName({ conversational: fallbackName ?? "" });
  try {
    const r = await resolveAddressNameForConversation(conversationId, [], null);
    return pickCallName({ conversational: r.name }) || "";
  } catch {
    return pickCallName({ conversational: fallbackName ?? "" });
  }
}
