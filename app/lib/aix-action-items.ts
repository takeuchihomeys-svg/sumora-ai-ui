// app/lib/aix-action-items.ts
// 売上番長グループの「AIX要対応」（2026-09-12 竹内方針）
//   「AIXの要対応がスタッフが特に行う部分。売上番長のグループに送られるのはAIX要対応の指示だけ。
//    お客さん名と【AIX】ボタンの種類の指示がLINEで届く。物件出しのように一覧をつくって完了したら✅」
//
// 1会話につき未完了（pending）は1件。判断者はブレインだけ（[[feedback-brain-owns-aix]]）:
//   登録・1件通知  … brain-core runBrainAndNotify（ブレインが今回の顧客発言を見て AIX 必要と判断した時。発言が48時間より古ければしない）
//   不要になった   … 同じく runBrainAndNotify（ブレインが AIX なしと判断し直した時 → dismissed。通知しない）
//                    2026-09-27: お客様が止まった・断ったとブレインが読んだ時も（brainPausedCustomer → dismissed_reason=brain_customer_paused）
//   完了（✅）     … log-aix-usage（その会話でスタッフが AIX を送った時・done_by=aix）
//                    2026-09-27: 通常の返信の本文で AIX の仕事を済ませた時（send-line-message → completeAixActionItemByStaffText・done_by=staff_text）
//   ※ 片付けの判定は app/lib/aix-item-cleanup.ts（純関数）・監査 scripts/audit-aix-item-cleanup.ts
//   定時一覧       … cron/announce-aix-actions（10:30〜20:30 の2時間ごと）
import { supabase } from "@/app/lib/supabase";
import { buildAixActionNotice, isFreshAixTurn } from "@/app/lib/aix-action-text";
import { AIX_BUTTON_LABELS } from "@/app/lib/aix-taxonomy";
import { isSimulatedCustomerTurn } from "@/app/lib/customer-sim-guard";
import { staffTextFulfillsAixItem, brainPausedCustomer } from "@/app/lib/aix-item-cleanup";
export { aixButtonText, buildAixActionNotice, buildAixActionList, isFreshAixTurn, AIX_NOTICE_FRESH_MS, type AixActionItemRow } from "@/app/lib/aix-action-text";

/** 売上番長グループへ push（宛先・トークンの決め方は notify-group と同じ: env → hanbancyo_settings.group_id） */
export async function pushToHanbancyoGroup(text: string): Promise<boolean> {
  let targetId = process.env.LINE_STAFF_GROUP_ID || null;
  if (!targetId) {
    const { data } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
    targetId = (data?.value as string | undefined) ?? null;
  }
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!targetId || !token) return false;
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: targetId, messages: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) console.warn("[aix-action-items] push failed:", res.status, await res.text().catch(() => ""));
  return res.ok;
}

/**
 * ブレインの最新判断（今回の顧客発言を見た判断のみ）を AIX要対応に反映する。
 *   AIX あり → 未完了が無ければ登録して1件通知／違う AIX に変わったら更新して1件通知／同じなら何もしない
 *   AIX なし → 未完了があれば dismissed（ブレインが不要と判断し直した。通知しない）
 */
export async function syncAixActionItem(input: {
  conversationId: string;
  customerName: string;
  meta: {
    action?: string | null; check_pattern?: string | null; reply_mode?: string | null; source?: string | null; analyzed_msg_ts?: string | null;
    condition_change_type?: string | null; first_contact_pickup?: string | null;
    /** 2026-09-23 竹内（あっぴ事例）: 台帳に未履行の物件ピックアップ宣言が残っている（brain-core が pending-pickup で判定して渡す） */
    pending_pickup?: boolean | null;
    /** 2026-09-27 取り下げの判定（brainPausedCustomer）が読む: 判断の出どころ・保留の型・意図 */
    decision_source?: string | null; hesitancy_pattern?: string | null; customer_intent?: string | null;
  } | null;
}): Promise<void> {
  const { conversationId, customerName, meta } = input;
  // cached は今回の顧客発言を見ていない判断なので使わない
  if (!meta || meta.source === "cached") return;
  // 2026-09-27 お客様役（テスト・YUMA）の番: 要対応の登録・売上番長グループへの通知・物件の自動検索をしない
  //   （判断は suggested_aix_meta に残るので、お客様役の実行は そこを読む）。本物の発言（竹内さんの手動テスト）は今まで通り
  if (await isSimulatedCustomerTurn(conversationId)) {
    console.log(JSON.stringify({ tag: "aix-action-items:customer-sim-skip", conversationId, action: meta.action ?? null }));
    return;
  }
  // 初回（スタッフ未返信）でお客様が条件を送ってきた: action は出さない（挨拶下書き優先）が、ブレインが残した「物件ピックアップが必要」を使う
  const action = meta.action || meta.first_contact_pickup || null;
  // 実在の AIX ボタンだけ。reply_mode=aix（ブレインが AIX 必要と判断）か、初回の条件受領（first_contact_pickup）
  const wantsAix = !!action && !!AIX_BUTTON_LABELS[action] && (meta.reply_mode === "aix" || !!meta.first_contact_pickup);
  // 2026-09-27 竹内「お客様が止まった・断った時はブレインが取り下げる」: ブレインの分析自身は AIX を選ばず（決定論の補い signal:* が入れた AIX）、
  //   ブレインがお客様を保留（検討します・また連絡します・少し待って）／否定と読んだ判断は「AIX なし」と同じ扱い（前の要対応を取り下げ・新しく登録しない）。
  //   本番 9/13〜: この型の番 8 で次の発言までに同じ AIX を押した 0（scripts/audit-aix-item-cleanup.ts ②）。
  //   画面の判断（suggested_aix_meta）はそのまま＝カード・帯はブレインの判断どおり出る。変えるのは売上番長グループの要対応だけ
  const pause = wantsAix ? brainPausedCustomer(meta) : { paused: false as const };
  const needsAix = wantsAix && !pause.paused;
  const checkPattern = meta.check_pattern ?? null;

  const { data: open } = await supabase
    .from("aix_action_items")
    .select("id, action, check_pattern")
    .eq("conversation_id", conversationId)
    .eq("status", "pending")
    .maybeSingle();
  const now = new Date().toISOString();

  if (!needsAix) {
    // 2026-09-23 竹内（あっぴ事例）「こんな同じようなことなんかいもいれない成約率のためにも」:
    //   「今回の発言に AIX は要らない」と「残っている仕事が無くなった」を同じ扱いにしない。
    //   台帳に未履行の物件ピックアップ宣言が残っている間は、物件を送る要対応を取り下げずに pending のまま残す。
    //   実測（brain_no_aix で取り下げた property_send 11件・YUMAテスト6件除く）:
    //     14日以内にスタッフが実際に物件を送った 6/11（55%）＝取り下げが過半数で間違い。
    //     送らなかった5件はいずれも取り下げ直後に会話が停止＝失注そのもの。逆方向の誤り（取り下げないと困る例）は0件。
    //   再通知はしない（下の「同じ指示は再通知しない」早期 return と同じく、ここでは push しない）ので売上番長グループは荒れない。
    if (open && meta.pending_pickup === true && (open.action === "property_send" || open.action === "property_recommendation")) {
      console.log("[aix-action-items] keep pending (未履行のピックアップ宣言あり):", conversationId, open.action);
      return;
    }
    if (open) {
      await supabase.from("aix_action_items")
        .update(pause.paused
          ? { status: "dismissed", dismissed_reason: "brain_customer_paused", resolution_note: `${pause.reason}（判断 ${action}）`.slice(0, 200), updated_at: now }
          : { status: "dismissed", dismissed_reason: "brain_no_aix", updated_at: now })
        .eq("id", open.id).eq("status", "pending");
    }
    if (pause.paused) console.log(JSON.stringify({ tag: "aix-action-items:customer-paused", conversationId, action, reason: pause.reason, dismissed: open?.action ?? null }));
    return;
  }

  // 古いお客様の発言（48時間超）を見た判断は、今の要対応として登録・通知しない（isFreshAixTurn の根拠参照）
  if (!isFreshAixTurn(meta.analyzed_msg_ts)) {
    console.log("[aix-action-items] stale customer turn — not registering:", conversationId, meta.analyzed_msg_ts);
    return;
  }

  // 2026-09-27 竹内「返信の本文で AIX の仕事を済ませた時は自動で済み」: スタッフが判断より先に通常の返信で済ませていた番
  //   （判断の保存まで中央27秒・スタッフが先に返した番 41.5%）は登録・通知しない。前の要対応があれば、ブレインの今の依頼は済んだので済み（返信で済み）にする
  const earlyDone = await findStaffTextFulfillment(conversationId, { action: action!, check_pattern: checkPattern }, meta.analyzed_msg_ts ?? null);
  if (earlyDone) {
    if (open) {
      await supabase.from("aix_action_items")
        .update({ status: "done", done_at: now, done_aix_type: null, done_matched: null, done_by: "staff_text", resolution_note: `${action}: ${earlyDone}`.slice(0, 200), updated_at: now })
        .eq("id", open.id).eq("status", "pending");
    }
    console.log(JSON.stringify({ tag: "aix-action-items:fulfilled-before-register", conversationId, action, evidence: earlyDone }));
    return;
  }

  if (open) {
    if (open.action === action && (open.check_pattern ?? null) === checkPattern) {
      // 同じ指示は再通知しない。ただし物件ピックアップ待ちのままお客様が条件を変えた時は、新しい条件で検索し直す
      if (AIX_AUTO_SEARCH_ACTIONS.has(action!) && meta.condition_change_type) {
        await enqueueAixPropertySearch(conversationId, action!).catch((e) =>
          console.warn("[aix-action-items] re-enqueue on condition change failed:", conversationId, e instanceof Error ? e.message : e));
      }
      return;
    }
    await supabase.from("aix_action_items")
      .update({ action, check_pattern: checkPattern, customer_name: customerName || null, brain_analyzed_msg_ts: meta.analyzed_msg_ts ?? null, notified_at: now, updated_at: now })
      .eq("id", open.id).eq("status", "pending");
  } else {
    const { error } = await supabase.from("aix_action_items").insert({
      conversation_id: conversationId, customer_name: customerName || null, action, check_pattern: checkPattern,
      status: "pending", brain_analyzed_msg_ts: meta.analyzed_msg_ts ?? null, notified_at: now,
    });
    // 同時実行で一意制約（1会話1件の pending）に当たった＝もう一方が登録・通知済み
    if (error) { if (!/duplicate|unique/i.test(error.message)) console.warn("[aix-action-items] insert failed:", error.message); return; }
  }
  await pushToHanbancyoGroup(buildAixActionNotice(customerName, action!, checkPattern));
  if (AIX_AUTO_SEARCH_ACTIONS.has(action!)) {
    await enqueueAixPropertySearch(conversationId, action!).catch((e) =>
      console.warn("[aix-action-items] enqueue auto search failed:", conversationId, e instanceof Error ? e.message : e));
  }
}

/** AIX モード（拡張の AIX ボタン ON の PC）で自動の物件検索→売上番長グループ送信を行う AIX 指示 */
const AIX_AUTO_SEARCH_ACTIONS = new Set(["property_send", "property_recommendation", "property_search"]);
/** AIX 連動の自動検索で使う検索サイト（Web画面の「リアプロで検索」と同じキー） */
const AIX_AUTO_SEARCH_SITES = ["realnetpro"];

/**
 * AIX で物件ピックアップ・物件オススメの指示が出たお客さんの自動検索コマンドを積む（2026-09-12 竹内方針「AIXモード」）。
 * payload.source="aix" のコマンドは AIX モードの PC だけが claim する（/api/automation/pending ?aix=1）。
 * 物件出し顧客（property_customers）に紐付いていない会話は条件が無いので積まない。同じ顧客の未実行・実行中があれば積まない。
 */
async function enqueueAixPropertySearch(conversationId: string, action: string): Promise<void> {
  const { data: conv } = await supabase
    .from("conversations").select("property_customer_id, line_user_id").eq("id", conversationId).maybeSingle();
  let customerId = (conv?.property_customer_id as string | null | undefined) ?? null;
  // 紐付け漏れ（同じ LINE ID の物件顧客がいるのに conversations.property_customer_id が空）を補う。
  //   同じ LINE ID の物件顧客がちょうど1人の時だけ紐付ける（2人以上は誰か決められないので積まない）
  if (!customerId && conv?.line_user_id) {
    const { data: pcs } = await supabase
      .from("property_customers").select("id").eq("line_user_id", conv.line_user_id as string).limit(2);
    if (pcs && pcs.length === 1) {
      customerId = pcs[0].id as string;
      await supabase.from("conversations").update({ property_customer_id: customerId }).eq("id", conversationId).is("property_customer_id", null);
    }
  }
  if (!customerId) return;
  const { data: existing } = await supabase
    .from("automation_commands")
    .select("id")
    .in("status", ["pending", "running"])
    .contains("customer_ids", [customerId])
    .limit(1);
  if (existing && existing.length > 0) return;
  const { error } = await supabase.from("automation_commands").insert({
    command_type: "batch_property_search",
    customer_ids: [customerId],
    sites: AIX_AUTO_SEARCH_SITES,
    payload: { source: "aix", aix_action: action, conversation_id: conversationId, is_wide: false },
    status: "pending",
  });
  if (error) console.warn("[aix-action-items] automation insert failed:", error.message);
}

/** 判断の番（analyzed_msg_ts）より後のスタッフの通常の返信で、その AIX の仕事を済ませた物があれば根拠（無ければ null） */
async function findStaffTextFulfillment(conversationId: string, item: { action: string; check_pattern: string | null }, afterTs: string | null): Promise<string | null> {
  if (!afterTs) return null;
  const { data } = await supabase
    .from("messages").select("text, is_aix_generated")
    .eq("conversation_id", conversationId).eq("sender", "staff").gt("created_at", afterTs)
    .order("created_at", { ascending: true }).limit(10);
  for (const m of (data ?? []) as Array<{ text: string | null; is_aix_generated: boolean | null }>) {
    if (m.is_aix_generated) continue;
    const r = staffTextFulfillsAixItem(item, m.text);
    if (r.done) return `${r.basis}「${r.evidence}」`;
  }
  return null;
}

/**
 * 2026-09-27 竹内「返信の本文で AIX の仕事を済ませた時は自動で済み」: スタッフが通常の返信（手打ち・AI 下書き）を送った直後に、
 * その本文が pending の AIX要対応の仕事を済ませていれば完了（✅・done_by=staff_text）にする。
 * 判定は staffTextFulfillsAixItem（AIX の種類ごとの線・押した番に当てて誤り 0）。判断の番より前の送信は見ない。
 * 画面のカード（aix-button-view の pendingItemMeta）とグループの一覧は同じ pending を読むので、両方から同時に消える（一覧は今日の ✅ に「返信で済み」で出る）
 */
export async function completeAixActionItemByStaffText(conversationId: string, text: string, sentAtIso: string): Promise<boolean> {
  const { data: open } = await supabase
    .from("aix_action_items")
    .select("id, action, check_pattern, brain_analyzed_msg_ts")
    .eq("conversation_id", conversationId)
    .eq("status", "pending")
    .maybeSingle();
  if (!open) return false;
  if (open.brain_analyzed_msg_ts && new Date(sentAtIso).getTime() <= new Date(open.brain_analyzed_msg_ts as string).getTime()) return false;
  const r = staffTextFulfillsAixItem({ action: open.action as string, check_pattern: (open.check_pattern as string | null) ?? null }, text);
  if (!r.done) return false;
  const now = new Date().toISOString();
  const { error } = await supabase.from("aix_action_items")
    .update({ status: "done", done_at: now, done_aix_type: null, done_matched: null, done_by: "staff_text", resolution_note: `${r.basis}「${r.evidence}」`.slice(0, 200), updated_at: now })
    .eq("id", open.id).eq("status", "pending");
  if (error) { console.warn("[aix-action-items] complete by staff text failed:", conversationId, error.message); return false; }
  console.log(JSON.stringify({ tag: "aix-action-items:done-by-staff-text", conversationId, action: open.action, basis: r.basis, evidence: r.evidence }));
  return true;
}

/** スタッフがその会話で AIX を送った → 未完了を完了（✅）にする。押した AIX がブレインの指示と同じかも残す */
export async function completeAixActionItem(conversationId: string, aixType: string): Promise<void> {
  const { data: open } = await supabase
    .from("aix_action_items")
    .select("id, action")
    .eq("conversation_id", conversationId)
    .eq("status", "pending")
    .maybeSingle();
  if (!open) return;
  const norm = (x: string) => (x === "property_check" ? "property_check_result" : x);
  const now = new Date().toISOString();
  await supabase.from("aix_action_items")
    .update({ status: "done", done_at: now, done_aix_type: aixType, done_matched: norm(open.action) === norm(aixType), done_by: "aix", updated_at: now })
    .eq("id", open.id).eq("status", "pending");
}
