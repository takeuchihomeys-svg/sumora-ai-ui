import { NextRequest, NextResponse, after } from "next/server";
import { PRE_APPLY_STATUSES } from "@/app/lib/application-form-detect";
import { shouldSetApplyingImageFlag } from "@/app/lib/applying-promotion";
import { runBrainAndNotify } from "@/app/lib/brain-core";
import { imageTextForSave, imageTypeForSave } from "@/app/lib/id-document-guard";
import { fileMessageText } from "@/app/lib/received-document";
// 2026-09-21 竹内「LINEのグループでも送れるように。個人とLINEのグループ分けて認識」: 宛先と発言者を分ける
import { resolveEventTarget, groupConversationName, displayMemberCount, parseStaffUserIds, type LineTargetKind } from "@/app/lib/line-target";
// 2026-09-27: お客様の文字の発言の処理は app/lib/line-webhook-text.ts へ移した（お客様役のテスト入口と同じ関数を通すため・中身は同じ）
import { type AccountConfig, ACCOUNTS, fetchLineProfile, getDb, ensureConversation, updateProfileAsync, handleTextMessage, tryPromoteToApplying } from "@/app/lib/line-webhook-text";

// Vercel Functions のタイムアウト上限（秒）— after()内のAnthropicコール（30s）と画像処理に余裕を持たせる
// 2026-09-13: 画像は読み取り（最大 IMAGE_READ_WAIT_MS）→ ブレイン（最大約90s・実行中に読み取りが終わった分の再分析1回）を直列にしたので 300 に
export const maxDuration = 300;

// 画像の読み取り（LINE から取得 10s ＋ Vision 12s）を待つ上限。これを過ぎたらブレインは読み取りを待たずに動く
const IMAGE_READ_WAIT_MS = 25_000;


// ── P1: AIXアクション日本語ラベルは brain-core.ts の AIX_LABEL_JP へ移設（2026-08 brain直列化）──
// required通知本体も runBrainAndNotify（brain-core）に移設済み

// ── bg-async / after() B と同期させる draft 生成スキップステータス集合 ─────────
// 定義は conversation-status.ts（BG_ASYNC_SKIP_STATUSES）に集約。
// bg-async・cron 側も同じ定数を import しているため、変更は conversation-status.ts のみで行う。

// ── LINE 署名検証 ──────────────────────────────────────────────────────
async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(signed)));
  return expected === signature;
}


// ── LINE グループ・トークルームの名前と発言者（2026-09-21 竹内・黒明様お部屋探し）──────────
// 個人のプロフィール API（/v2/bot/profile）はグループのメンバーには使えない（友だちでなければ 404）。
// グループ名は /group/{id}/summary、発言者の名前は /group/{id}/member/{userId}（友だちでなくても取れる）。
async function fetchGroupSummary(groupId: string, token: string): Promise<{ groupName?: string; pictureUrl?: string } | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { groupName?: string; pictureUrl?: string };
  } catch { return null; }
}
async function fetchMemberProfile(kind: LineTargetKind, targetId: string, userId: string, token: string): Promise<{ displayName?: string } | null> {
  try {
    const path = kind === "room" ? `room/${targetId}/member/${userId}` : `group/${targetId}/member/${userId}`;
    const res = await fetch(`https://api.line.me/v2/bot/${path}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { displayName?: string };
  } catch { return null; }
}

async function fetchMemberCount(kind: LineTargetKind, targetId: string, token: string): Promise<number | null> {
  try {
    const path = kind === "room" ? `room/${targetId}/members/count` : `group/${targetId}/members/count`;
    const res = await fetch(`https://api.line.me/v2/bot/${path}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { count?: number };
    return typeof j.count === "number" ? j.count : null;
  } catch { return null; }
}

/**
 * グループの発言者に「グループから誤って作られた個人の会話」があれば、その履歴をグループの会話へ引き継ぐ。
 * 2026-09-21 竹内「ここからグループ判明出来ないか」: 公式LINEの管理画面から送った分は webhook に届かないので
 *   グループID は分からない。**次にグループで発言があった瞬間**に、黒明さん個人の会話（名称未設定・送信停止中）の
 *   履歴（お客様の発言・アプリから送った画像と報告）をグループの会話へ移し、話の続きとして読めるようにする。
 *   移すのは会話IDで紐づく記録（messages・送った物件・画像の読み取り）。古い会話は送信停止のまま「引継ぎ済み」にする。
 */
async function mergeMisroutedPersonalConversation(
  db: ReturnType<typeof getDb>,
  targetId: string,
  speakerUserId: string,
  account: AccountConfig,
): Promise<void> {
  const [{ data: grp }, { data: old }] = await Promise.all([
    db.from("conversations").select("id, status, property_customer_id").eq("line_user_id", targetId).eq("account", account.key).limit(1),
    db.from("conversations").select("id, status, property_customer_id").eq("line_user_id", speakerUserId).eq("account", account.key)
      .eq("send_blocked_reason", "created_from_group").limit(1),
  ]);
  const g = (grp ?? [])[0] as { id: string; status: string | null; property_customer_id: string | null } | undefined;
  const o = (old ?? [])[0] as { id: string; status: string | null; property_customer_id: string | null } | undefined;
  if (!g || !o || g.id === o.id) return;
  const moved: Record<string, string> = {};
  for (const table of ["messages", "sent_properties", "sent_image_properties", "image_details"] as const) {
    const { error } = await db.from(table).update({ conversation_id: g.id }).eq("conversation_id", o.id);
    moved[table] = error ? `error:${error.message}` : "ok";
  }
  // 段階・顧客の紐付けも引き継ぐ（グループの会話は作られたばかりで hearing・未紐付けのため）
  const patch: Record<string, string> = {};
  if (o.status && (!g.status || g.status === "hearing")) patch.status = o.status;
  if (o.property_customer_id && !g.property_customer_id) patch.property_customer_id = o.property_customer_id;
  if (Object.keys(patch).length) await db.from("conversations").update(patch).eq("id", g.id);
  await db.from("conversations").update({
    send_blocked_reason: "merged_to_group",
    customer_name: "（【グループ】へ引継ぎ済み）",
    last_message: "履歴はグループの会話へ引き継ぎました",
  }).eq("id", o.id);
  console.log(JSON.stringify({ tag: "line-webhook:group-merge", account: account.key, from: o.id, to: g.id, moved }));
}

/**
 * グループ・トークルームの会話に、グループ名（【グループ】付き）と発言者を入れる。
 * ・会話名: 【グループ】黒明様お部屋探し（竹内「グループなら分かりやすくグループと入れる」）
 * ・line_contacts にも宛先として登録（送信時のアカウント解決が引けるように）
 * ・メッセージに発言者（誰が言ったか）を残す。グループは複数人が話すため
 */
async function updateGroupInfo(
  db: ReturnType<typeof getDb>,
  targetId: string,
  kind: LineTargetKind,
  account: AccountConfig,
  speakerUserId: string | null,
  lineMessageId: string | null,
  now: string,
  isStaffSpeaker = false,
): Promise<void> {
  if (kind === "user" || !account.token) return;
  try {
    const [summary, member, memberCount] = await Promise.all([
      kind === "group" ? fetchGroupSummary(targetId, account.token) : Promise.resolve(null),
      speakerUserId ? fetchMemberProfile(kind, targetId, speakerUserId, account.token) : Promise.resolve(null),
      fetchMemberCount(kind, targetId, account.token),
    ]);
    // 竹内「グループ名もLINE側と同じにできるか」: LINE の表示「黒明様お部屋探し(4)」と同じく人数も付ける
    const name = groupConversationName(summary?.groupName ?? null, kind, displayMemberCount(memberCount));
    const patch: Record<string, string> = { line_source_type: kind };
    // 名前が取れた時だけ上書きする（取れなかった時に「グループ名取得中」へ戻さない）
    if (summary?.groupName || kind === "room") patch.customer_name = name;
    if (summary?.pictureUrl) patch.profile_image_url = summary.pictureUrl;
    await db.from("conversations").update(patch).eq("line_user_id", targetId).eq("account", account.key);
    if (summary?.groupName || kind === "room") {
      await db.from("line_contacts").upsert(
        { line_user_id: targetId, line_name: name, line_profile_image: summary?.pictureUrl ?? "", account: account.name, last_message_at: now },
        { onConflict: "line_user_id,account" },
      );
    }
    if (lineMessageId && speakerUserId) {
      await db.from("messages")
        .update({
          speaker_user_id: speakerUserId,
          ...(member?.displayName ? { speaker_name: member.displayName } : {}),
          // スタッフが個人の LINE から送った画像・ファイルも「こちらの送信」に揃える（文字はもう staff で保存済み）
          ...(isStaffSpeaker ? { sender: "staff" } : {}),
        })
        .eq("line_message_id", lineMessageId);
    }
    // 2026-09-21: 引き継ぎは「発言者」ではなく「グループのメンバーか」で決める。
    //   最初の実物では竹内さん（YUMA）が発言し、誤って作られたのは黒明さんの会話だったので、発言者で探すと見つからなかった。
    //   送信停止中の会話の個人 ID がこのグループのメンバーなら（member API が 200）引き継ぐ
    const { data: blocked } = await db.from("conversations").select("line_user_id")
      .eq("account", account.key).eq("send_blocked_reason", "created_from_group").limit(20);
    for (const b of (blocked ?? []) as Array<{ line_user_id: string }>) {
      const isMember = b.line_user_id === speakerUserId || !!(await fetchMemberProfile(kind, targetId, b.line_user_id, account.token));
      if (isMember) await mergeMisroutedPersonalConversation(db, targetId, b.line_user_id, account);
    }
    console.log(JSON.stringify({
      tag: "line-webhook:group", kind, account: account.key, groupNameFound: !!summary?.groupName,
      speakerFound: !!member?.displayName,
    }));
  } catch (e) {
    console.warn("[line-webhook] グループ情報の取得失敗:", e instanceof Error ? e.message : e);
  }
}

/** こちらのスタッフの LINE 個人 ID（hanbancyo_settings の staff_line_user_ids ＋ 鈴木） */
async function getStaffLineUserIds(db: ReturnType<typeof getDb>): Promise<Set<string>> {
  const { data } = await db.from("hanbancyo_settings").select("key, value").in("key", ["staff_line_user_ids", "suzuki_line_user_id"]);
  return parseStaffUserIds(...((data ?? []) as Array<{ value: string | null }>).map((r) => r.value));
}

/** グループでスタッフが個人の LINE から話した発言を「こちらの送信」として残す（下書き・ブレインは動かさない） */
async function saveGroupStaffMessage(
  db: ReturnType<typeof getDb>,
  targetId: string,
  account: AccountConfig,
  text: string,
  lineMessageId: string | null,
  now: string,
): Promise<boolean> {
  const convId = await ensureConversation(db, targetId, account, now);
  if (!convId) return false;
  if (lineMessageId) {
    const { data: dup } = await db.from("messages").select("id").eq("line_message_id", lineMessageId).maybeSingle();
    if (dup) return true;
  }
  const { error } = await db.from("messages").insert({
    conversation_id: convId, sender: "staff", text,
    ...(lineMessageId ? { line_message_id: lineMessageId } : {}),
    created_at: now,
  });
  if (error && error.code !== "23505") { console.error("[line-webhook] スタッフ発言の保存失敗:", error.message); return false; }
  await db.from("conversations").update({ last_message: text, last_sender: "staff", updated_at: now }).eq("id", convId);
  return true;
}

/** 社内の LINE グループ（売上番長・物件ピックアップ）なら true。お客様の会話にしない安全網 */
async function isInternalStaffGroup(db: ReturnType<typeof getDb>, groupId: string): Promise<boolean> {
  if (groupId === process.env.LINE_STAFF_GROUP_ID) return true;
  const { data } = await db.from("hanbancyo_settings").select("value").in("key", ["group_id", "pickup_group_id"]);
  return ((data ?? []) as Array<{ value: string | null }>).some((r) => r.value === groupId);
}


// ── 画像メッセージ即時保存（LINEへの応答前に完了させる軽量処理）────────────
// 重複防止のため line_message_id で存在確認してから insert
async function handleImageMessageSave(
  userId: string,
  lineMessageId: string,
  account: AccountConfig,
): Promise<{ convId: string; msgId: string } | "duplicate" | null> {
  const db = getDb();
  const now = new Date().toISOString();

  const convId = await ensureConversation(db, userId, account, now);
  if (!convId) return null; // 失敗（LINEにリトライさせる）

  // 重複チェック（LINEのリトライで同じ lineMessageId が来ることがある）
  const { data: existing } = await db
    .from("messages")
    .select("id")
    .eq("line_message_id", lineMessageId)
    .maybeSingle();
  if (existing) {
    return "duplicate"; // 既に保存済み = 正常（リトライ不要）
  }

  // image_expires_at = 30日後（デフォルト保存期限）
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // image_url は後から埋める。まず line_message_id だけ保存して即座に会話に表示
  const { data: msgData, error: msgErr } = await db.from("messages").insert({
    conversation_id: convId,
    sender: "customer",
    text: "[画像]",
    image_url: null,
    line_message_id: lineMessageId,
    image_expires_at: expiresAt,
    created_at: now,
  }).select("id").maybeSingle();

  if (msgErr || !msgData) {
    console.error("[line-webhook] image message保存失敗:", msgErr?.message);
    return null;
  }

  await db
    .from("conversations")
    .update({ last_message: "[画像]", last_sender: "customer", updated_at: now, is_flagged: true, suggested_aix_meta: null })
    .eq("id", convId);

  // FIX: stale __SHOWN__ 残留対策（テキスト経路と同一。画像経路には after() B の ai_draft リセットが
  // 存在しないため、ここでクリアしないと brain-sweep が永久に補填しない）
  await db
    .from("conversations")
    .update({ ai_draft: null })
    .eq("id", convId)
    .eq("ai_draft", "__SHOWN__");

  // 顧客返信（画像）→ pending property_check タスクを自動キャンセル（テキスト経路と同一理由）
  await db
    .from("line_tasks")
    .update({ status: "cancelled" })
    .eq("conversation_id", convId)
    .eq("task_type", "property_check")
    .eq("status", "pending");

  // 「〇〇さんから画像きた」通知は 2026-09-12 廃止（竹内方針: 売上番長グループへの返信・AIX 系の通知は「AIX要対応」だけ。
  //   画像への対応が AIX ならブレインの判断 → AIX要対応で届く）

  // 画像受信のブレイン分析は、画像の読み取り（Vision）が終わった後に会話ごとに1回だけ動かす（POST 末尾の画像後処理）。
  //   旧: ここで1枚ごとに after(runBrainAndNotify) → 7枚の連投で同じ分析が7本・どれも読み取り前の「[画像]」だけを見て判断していた
  //   （2026-09-12 Sさん: 間取り図8枚＋確認依頼に、1本が画像の種類を知らず「見積書送る」に決め打ち）

  // スタッフが申込書の記入を依頼した直後の顧客画像 → 記入済み申込書の可能性大 → applying自動昇格
  // （画像フォームはテキスト検知できないためヒューリスティックで補完）
  await autoPromoteApplyingOnFormImage(db, convId, now);

  // 会話内の画像が100枚を超えたら古い画像の保存期限を即時終了
  void expireOldImagesIfOverLimit(db, convId).catch((e) => console.warn("[line-webhook] expireOldImagesIfOverLimit:", e));

  updateProfileAsync(db, userId, convId, account, "[画像]", now);
  return { convId, msgId: String(msgData.id) };
}

// ── LINE の file メッセージ（PDF 等）を保存（2026-09-17 竹内・友哉事例）──────────────
//   画像経路（handleImageMessageSave）と同じ形。違いはテキストが "[ファイル] <ファイル名>" で、
//   本体は file_url に入れる（image_url は画面が <img> で描くので PDF を入れてはいけない）
async function handleFileMessageSave(
  userId: string,
  lineMessageId: string,
  fileName: string | null,
  account: AccountConfig,
): Promise<{ convId: string; msgId: string } | "duplicate" | null> {
  const db = getDb();
  const now = new Date().toISOString();

  const convId = await ensureConversation(db, userId, account, now);
  if (!convId) return null; // 失敗（LINEにリトライさせる）

  const { data: existing } = await db
    .from("messages")
    .select("id")
    .eq("line_message_id", lineMessageId)
    .maybeSingle();
  if (existing) return "duplicate";

  const text = fileMessageText(fileName);
  // 保存期限は画像と同じ30日（LINE の Content API 自体が期限つき）
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: msgData, error: msgErr } = await db.from("messages").insert({
    conversation_id: convId,
    sender: "customer",
    text,
    file_name: fileName,
    file_url: null,
    line_message_id: lineMessageId,
    image_expires_at: expiresAt,
    created_at: now,
  }).select("id").maybeSingle();

  if (msgErr || !msgData) {
    console.error("[line-webhook] file message保存失敗:", msgErr?.message);
    return null;
  }

  await db
    .from("conversations")
    .update({ last_message: text, last_sender: "customer", updated_at: now, is_flagged: true, suggested_aix_meta: null })
    .eq("id", convId);
  // stale __SHOWN__ 残留対策（画像経路と同一理由）
  await db
    .from("conversations")
    .update({ ai_draft: null })
    .eq("id", convId)
    .eq("ai_draft", "__SHOWN__");
  // 顧客返信 → pending property_check タスクを自動キャンセル（テキスト・画像経路と同一）
  await db
    .from("line_tasks")
    .update({ status: "cancelled" })
    .eq("conversation_id", convId)
    .eq("task_type", "property_check")
    .eq("status", "pending");

  // 申込書類が PDF で届く場合があるので、画像と同じ applying 昇格の材料にする
  await autoPromoteApplyingOnFormImage(db, convId, now);

  updateProfileAsync(db, userId, convId, account, text, now);
  return { convId, msgId: String(msgData.id) };
}

// ── LINE Content API からファイル本体を取得して Storage に保存（after()で非同期実行）──
//   専用バケット line-files に置く。line-images は allowed_mime_types が画像のみ・5MB 上限で
//   PDF を弾く（本番検証で "mime type application/pdf is not supported" が出た）
const LINE_FILE_BUCKET = "line-files";
async function fetchAndUploadLineFile(
  lineMessageId: string,
  msgId: string,
  fileName: string | null,
  account: AccountConfig,
): Promise<void> {
  if (!account.token) return;
  const db = getDb();
  try {
    const contentRes = await fetch(
      `https://api-data.line.me/v2/bot/message/${lineMessageId}/content`,
      { headers: { Authorization: `Bearer ${account.token}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (!contentRes.ok) {
      console.warn(`[line-webhook] Content API失敗(file) status=${contentRes.status} msgId=${lineMessageId}`);
      return;
    }
    const contentType = contentRes.headers.get("content-type") || "application/octet-stream";
    // 拡張子はファイル名を正とする（LINE の content-type は application/octet-stream のことがある）
    const extFromName = (fileName ?? "").match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase();
    const ext = extFromName || (contentType.includes("pdf") ? "pdf" : "bin");
    const arrayBuf = await contentRes.arrayBuffer();
    const storagePath = `${lineMessageId}.${ext}`;
    const uploadType = ext === "pdf" ? "application/pdf" : contentType;

    const { error: upErr } = await db.storage
      .from(LINE_FILE_BUCKET)
      .upload(storagePath, new Blob([arrayBuf], { type: uploadType }), { contentType: uploadType, upsert: true });
    if (upErr) {
      console.error("[line-webhook] Storage upload失敗(file):", upErr.message, "msgId:", lineMessageId, "type:", uploadType);
      return;
    }
    const { data: urlData } = db.storage.from(LINE_FILE_BUCKET).getPublicUrl(storagePath);
    const { error: updateErr } = await db
      .from("messages")
      .update({ file_url: urlData.publicUrl })
      .eq("id", msgId);
    if (updateErr) console.error("[line-webhook] file_url更新失敗:", updateErr.message);
  } catch (e) {
    console.error("[line-webhook] ファイル処理エラー:", e);
  }
}


// ── 顧客の画像・ファイル → applying_image_received=true に更新 ──────────
// 判定は app/lib/applying-promotion.ts shouldSetApplyingImageFlag（純関数）:
//   ① image_type が本人確認書類（id_document）— Vision の分類が終わった後（fetchAndUploadLineImage）から呼ぶ
//   ② 従来: 直近72h以内のスタッフ発言に申込書依頼の語 — 保存時（handleImageMessageSave / handleFileMessageSave）から呼ぶ
// applying_text_received も true なら tryPromoteToApplying で applying に昇格する。
async function autoPromoteApplyingOnFormImage(
  db: ReturnType<typeof getDb>,
  convId: string,
  now: string,
  imageType: string | null = null,
): Promise<void> {
  try {
    const { data: conv } = await db
      .from("conversations")
      .select("status")
      .eq("id", convId)
      .maybeSingle();
    const status = (conv?.status as string) ?? "";
    if (!PRE_APPLY_STATUSES.includes(status)) return;

    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const { data: staffMsgs } = await db
      .from("messages")
      .select("text")
      .eq("conversation_id", convId)
      .eq("sender", "staff")
      .gt("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1);
    const lastStaffText = (staffMsgs?.[0]?.text as string) ?? "";
    const flag = shouldSetApplyingImageFlag({ imageType, lastStaffTextWithin72h: lastStaffText });
    if (!flag.set) return;

    const { data: updated, error } = await db
      .from("conversations")
      .update({ applying_image_received: true, updated_at: now })
      .eq("id", convId)
      .in("status", PRE_APPLY_STATUSES)
      .select("id");
    if (error) {
      console.error(`[line-webhook] applying_image_received更新失敗: conv=${convId}`, error.message);
    } else if ((updated ?? []).length > 0) {
      console.log(`[line-webhook] 画像受信 → applying_image_received=true: conv=${convId} reason=${flag.reason}`);
      await tryPromoteToApplying(db, convId, now, `image:${flag.reason}`);
    }
  } catch (e) {
    console.warn("[line-webhook] autoPromoteApplyingOnFormImage:", e);
  }
}

// ── Claude Vision で画像内容を日本語テキスト抽出 + 画像種別分類 ─────────────
// buf: LINE Content API から取得済みの ArrayBuffer（二重ダウンロード不要）
// 既存のVision 1回呼び出しに分類を相乗りさせる（追加APIコストゼロ）
// imageType: 'estimate' | 'floor_plan' | 'property_photo' | 'id_document' | 'income_document' | 'other'
// 2026-09-26 income_document（収入・勤め先・身元の証明書類）を足した。本人確認書類と同じく書き起こしは保存しない（personal-document-guard.ts）
async function extractImageContent(
  buf: ArrayBuffer,
  mimeType: string,
): Promise<{ imageType: string; content: string }> {
  try {
    const base64 = Buffer.from(buf).toString("base64");
    // Claude Vision が受け付ける MIME タイプのみ渡す（非対応は image/jpeg にフォールバック）
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
    type AllowedMime = (typeof allowedTypes)[number];
    const safeType: AllowedMime = (allowedTypes as readonly string[]).includes(mimeType)
      ? (mimeType as AllowedMime)
      : "image/jpeg";

    const visionRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(12_000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: safeType, data: base64 },
              },
              {
                type: "text",
                text: "1行目に必ず「TYPE: estimate|floor_plan|property_photo|id_document|income_document|other」の形式で画像の種類を1つだけ出力してください。\n- estimate=見積書/初期費用明細, floor_plan=間取り図/物件資料, property_photo=室内外の物件写真,\n  id_document=本人確認書類（免許証・保険証・マイナンバー等）,\n  income_document=収入・勤め先・身元の証明書類（源泉徴収票・給与明細・課税証明書・確定申告書・在籍証明書・内定通知書・雇用契約書・労働条件通知書・年金の通知書・通帳・住民票・印鑑登録証明書・記入済みの申込書）※見積書・初期費用の明細・物件資料は含めない,\n  other=それ以外（LINEスクショ含む）\n2行目以降に、この画像に写っているテキスト・会話・情報をすべて書き起こしてください。LINEスクリーンショットの場合は発言者と内容を整理して返してください。画像の説明は不要で、内容だけ返してください。",
              },
            ],
          },
        ],
      }),
    });
    if (!visionRes.ok) {
      console.warn("[line-webhook] Vision API失敗 status=", visionRes.status);
      return { imageType: "", content: "" };
    }
    const visionData = await visionRes.json() as {
      content?: Array<{ type: string; text?: string }>;
    };
    const raw = visionData.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
    const typeMatch = raw.match(/^TYPE:\s*(estimate|floor_plan|property_photo|id_document|income_document|other)/i);
    const imageType = typeMatch ? typeMatch[1].toLowerCase() : (raw ? "other" : "");
    const content = raw.replace(/^TYPE:[^\n]*\n?/, "").trim();
    return { imageType, content };
  } catch (e) {
    console.warn("[line-webhook] Vision抽出エラー:", e);
    return { imageType: "", content: "" };
  }
}

// ── LINE Content API から画像を取得してStorageに保存（after()で非同期実行）──
// Vision抽出（claude-haiku-4-5）と Storage upload を並列実行し、
// 完了後に messages.text（[画像] <内容>）と messages.image_url を同時更新する。
async function fetchAndUploadLineImage(
  lineMessageId: string,
  msgId: string,
  account: AccountConfig,
  convId: string | null = null,
): Promise<void> {
  if (!account.token) return;
  const db = getDb();

  try {
    const contentRes = await fetch(
      `https://api-data.line.me/v2/bot/message/${lineMessageId}/content`,
      { headers: { Authorization: `Bearer ${account.token}` }, signal: AbortSignal.timeout(10_000) },
    );

    if (!contentRes.ok) {
      console.warn(`[line-webhook] Content API失敗 status=${contentRes.status} msgId=${lineMessageId}`);
      return;
    }

    const contentType = contentRes.headers.get("content-type") || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : contentType.includes("gif") ? "gif" : "jpg";
    const arrayBuf = await contentRes.arrayBuffer();
    const storagePath = `${lineMessageId}.${ext}`;

    // Vision抽出 と Storage upload を並列実行（arrayBuf は読み取り専用で両方に渡せる）
    const [visionResult, uploadResult] = await Promise.allSettled([
      extractImageContent(arrayBuf, contentType),
      db.storage
        .from("line-images")
        .upload(storagePath, new Blob([arrayBuf], { type: contentType }), { contentType, upsert: true }),
    ]);

    if (uploadResult.status === "rejected") {
      console.error("[line-webhook] Storage upload失敗:", uploadResult.reason, "msgId:", lineMessageId);
      return;
    }
    if (uploadResult.value.error) {
      console.error("[line-webhook] Storage upload失敗:", uploadResult.value.error.message, "msgId:", lineMessageId);
      return;
    }

    const { data: urlData } = db.storage.from("line-images").getPublicUrl(storagePath);

    // Vision 抽出結果を "[画像] <内容>" 形式でテキストとして保存
    const extracted = visionResult.status === "fulfilled" ? visionResult.value.content : "";
    const extractedType = visionResult.status === "fulfilled" ? visionResult.value.imageType : "";
    // 2026-09-19 竹内「マイナンバーカードや運転免許証の個人情報は本人確認書類とだけ文字にして
    //   情報が文字お越しされないようにする」
    //   → 本人確認書類は書き起こしを保存しない（"[画像] 本人確認書類" だけ）。
    //     会話本文に入ると、返信生成のプロンプト（直近25件）にも学習の事例にも載ってしまうため、
    //     後段でマスクするのではなく**保存する前に捨てる**。
    //     捨てても image_type が残るので「書類が届いた」事実は received-document / ブレインに伝わる。
    // 2026-09-26 竹内「収入証明書なども収入証明書とするだけで、文字おこししないようにする」
    //   → 収入・勤め先・身元の証明書類も同じ関数で "[画像] 収入証明書（給与明細）" のように種類だけにする（image_type=income_document）
    const newText = imageTextForSave(extractedType, extracted);
    const savedType = imageTypeForSave(extractedType, extracted);

    // image_type: Vision失敗時はNULLのまま（"other"を書かない — 後日バックフィル可能に）
    const { error: updateErr } = await db
      .from("messages")
      .update({
        image_url: urlData.publicUrl,
        text: newText,
        ...(savedType ? { image_type: savedType } : {}),
      })
      .eq("id", msgId);

    if (updateErr) {
      console.error("[line-webhook] image_url/text更新失敗:", updateErr.message);
    } else if (savedType === "id_document" && convId) {
      // 2026-09-23 課題②: 本人確認書類が届いた＝申込の画像の旗（applying_image_received）。
      //   保存時の判定（autoPromoteApplyingOnFormImage・スタッフの語）は Vision の前に走るので image_type を見られない。
      //   分類が付いた**後**にここから同じ関数を呼ぶ。ブレイン（runBrainAndNotify）はこの後に動くので、進んだ status を見る
      await autoPromoteApplyingOnFormImage(db, convId, new Date().toISOString(), savedType);
    }
  } catch (e) {
    console.error("[line-webhook] 画像処理エラー:", e);
  }
}

// 会話内の画像が100枚を超えたら、超過分の古い画像を即時期限切れにする
async function expireOldImagesIfOverLimit(
  db: ReturnType<typeof getDb>,
  convId: string,
  limit = 100,
): Promise<void> {
  const { data: imgs } = await db
    .from("messages")
    .select("id, image_expires_at")
    .eq("conversation_id", convId)
    .eq("sender", "customer")
    .like("text", "[画像]%")
    .not("image_expires_at", "is", null)
    .gt("image_expires_at", new Date().toISOString()) // まだ有効なもの
    .order("created_at", { ascending: true });

  if (!imgs || imgs.length <= limit) return;

  // limit超過分の古い画像IDを即時期限切れにする
  const overflowIds = imgs.slice(0, imgs.length - limit).map((m) => m.id as string);
  await db
    .from("messages")
    .update({ image_expires_at: new Date().toISOString() })
    .in("id", overflowIds);
}

// destination → account key のマッピング（各LINE公式アカウントのBot User ID）
const DESTINATION_MAP: Record<string, string> = Object.fromEntries(
  ([
    [process.env.LINE_SUMORA_DESTINATION, "sumora"],
    [process.env.LINE_IEYASU_DESTINATION, "ieyasu"],
    [process.env.LINE_GIGA_DESTINATION, "giga"],
  ] as [string | undefined, string][]).filter(([k]) => !!k)
);

// ── POST ──────────────────────────────────────────────────────────────
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";

  let body: { destination?: string; events?: unknown[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // 1. destination フィールドでアカウントを一発判定
  const destination = body.destination ?? "";
  const accountKey = DESTINATION_MAP[destination];
  const matchedAccount = ACCOUNTS.find((a) => a.key === accountKey);

  if (!matchedAccount) {
    console.warn("[line-webhook] 未知のdestination:", destination);
    return NextResponse.json({ error: "unknown destination" }, { status: 400 });
  }

  // 2. 署名検証（セキュリティ確保）
  // secret未設定のアカウントは検証不能のため処理を拒否（fail-close）
  if (!matchedAccount.secret) {
    console.error("[line-webhook] channel secret未設定のため処理を拒否:", matchedAccount.key);
    return NextResponse.json({ error: "channel secret not configured" }, { status: 500 });
  }
  const valid = await verifySignature(rawBody, signature, matchedAccount.secret);
  if (!valid) {
    console.warn("[line-webhook] 署名検証失敗:", matchedAccount.key);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const events = body.events ?? [];

  // 画像メッセージの後処理用（after()で非同期実行する分）
  const imageJobs: Array<{ lineMessageId: string; msgId: string; convId: string; account: typeof matchedAccount }> = [];
  // ファイル（PDF 等）の後処理用（2026-09-17 友哉事例）
  const fileJobs: Array<{ lineMessageId: string; msgId: string; convId: string; fileName: string | null; account: typeof matchedAccount }> = [];
  let anyFailed = false;

  // 同一POSTバッチ内で同一ユーザーに対してafter() Bが複数登録されるのを防ぐ
  // （LINEが1回のPOSTに複数eventを詰めて送った場合の多重bg-asyncトリガー対策）
  const draftTriggeredUserIds = new Set<string>();

  for (const ev of events) {
    const event = ev as {
      type: string;
      source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
      // fileName / fileSize は LINE の file メッセージ（PDF 等）に付く
      message?: { type: string; id?: string; text?: string; quotedMessageId?: string; fileName?: string; fileSize?: number };
      unsend?: { messageId?: string };
    };

    // フォロー/ブロック/フォロー解除 → line_status を更新
    if (event.type === "follow") {
      const uid = event.source?.userId;
      if (uid) {
        const db = getDb();
        await Promise.all([
          db.from("conversations").update({ line_status: "active" }).eq("line_user_id", uid),
          db.from("line_contacts").update({ line_status: "active" }).eq("line_user_id", uid).eq("account", matchedAccount.key),
        ]).catch(() => {});
      }
      continue;
    }
    if (event.type === "unfollow") {
      const uid = event.source?.userId;
      if (uid) {
        const db = getDb();
        await Promise.all([
          db.from("conversations").update({ line_status: "unfollowed" }).eq("line_user_id", uid),
          db.from("line_contacts").update({ line_status: "unfollowed" }).eq("line_user_id", uid).eq("account", matchedAccount.key),
        ]).catch(() => {});
      }
      continue;
    }

    // 送信取消（unsend）→ 該当メッセージを削除し、学習例の☆を外す（学習データ汚染防止）
    // 取り消されたメッセージを ai_reply_examples の教師データとして残さない
    if (event.type === "unsend") {
      const unsendMessageId = event.unsend?.messageId;
      if (unsendMessageId) {
        const db = getDb();
        const { data: unsentMsg } = await db
          .from("messages")
          .select("id, text")
          .eq("line_message_id", unsendMessageId)
          .maybeSingle();
        if (unsentMsg) {
          const unsentText = (unsentMsg.text as string | null) ?? "";
          // sent_reply が取り消し文と一致する学習例の☆を外す（誤送信文の学習防止）
          // "[画像]" で始まるテキスト（Vision抽出付きも含む）は学習対象外
          if (unsentText.trim() && !unsentText.startsWith("[画像]")) {
            await db
              .from("ai_reply_examples")
              .update({ is_starred: false })
              .eq("sent_reply", unsentText);
          }
          // messages から物理削除（取り消されたメッセージは会話履歴・AI文脈から除外）
          await db.from("messages").delete().eq("id", unsentMsg.id);
        }
      }
      continue;
    }

    // 2026-09-21 竹内（黒明様お部屋探し）: お客様の LINE グループに招待された／外された
    //   招待された時点でグループの会話を作っておく（【グループ】＋グループ名）。外されたら送れないので印を付ける
    if (event.type === "join" || event.type === "leave") {
      const t = resolveEventTarget(event.source);
      if (t && t.kind !== "user") {
        const db = getDb();
        if (t.kind === "group" && await isInternalStaffGroup(db, t.targetId)) continue;
        if (event.type === "join") {
          const now = new Date().toISOString();
          await ensureConversation(db, t.targetId, matchedAccount, now);
          after(() => updateGroupInfo(db, t.targetId, t.kind, matchedAccount, null, null, now));
          console.log(JSON.stringify({ tag: "line-webhook:group-join", kind: t.kind, account: matchedAccount.key }));
        } else {
          await db.from("conversations").update({ line_status: "left" })
            .eq("line_user_id", t.targetId).eq("account", matchedAccount.key);
        }
      }
      continue;
    }

    if (event.type !== "message") continue;
    // 自分自身（bot）からのメッセージはスキップ（返信送信時のエコーバック対策）
    if (event.source?.type === "bot") {
      continue;
    }
    // 2026-09-21 竹内「LINEのグループにおくるはずが個人のLINEにおくらないように」:
    //   会話のキー（＝返信の宛先）は**グループなら groupId**。旧は source.userId（発言者）を使っていたため、
    //   グループの発言が発言者個人の会話になり、返信が個人の LINE に飛んでいた。
    //   以下の userId は「宛先」（個人なら従来どおり userId）。発言者は speakerUserId。
    const target = resolveEventTarget(event.source);
    if (!target) continue;
    const msgType = event.message?.type;
    const userId = target.targetId;
    const speakerUserId = target.speakerUserId;
    if (target.kind !== "user") {
      const db0 = getDb();
      // 社内のグループ（売上番長・物件ピックアップ）をお客様の会話にしない安全網
      if (target.kind === "group" && await isInternalStaffGroup(db0, userId)) continue;
      const nowG = new Date().toISOString();
      const lmidG = event.message?.id ?? null;
      // 2026-09-21: グループではスタッフも個人の LINE で話す（竹内さん＝YUMA が「弊社スタッフと私でサポート」と送った）。
      //   お客様の発言として保存すると AI がスタッフの発言に返信を作る（実物:「お申込み内容を確認させて頂きます」）。
      //   スタッフの発言は「こちらの送信」として残し、下書き・ブレインは動かさない
      const staffIds = await getStaffLineUserIds(db0);
      const isStaffSpeaker = !!speakerUserId && staffIds.has(speakerUserId);
      // メッセージの保存が終わった後に、グループ名と発言者を入れる
      after(() => updateGroupInfo(db0, userId, target.kind, matchedAccount, speakerUserId, lmidG, nowG, isStaffSpeaker));
      if (isStaffSpeaker && (msgType === "text" || msgType === "sticker")) {
        const text = msgType === "text" ? String((event.message as { text?: string })?.text ?? "") : "[スタンプ]";
        if (text) {
          const ok = await saveGroupStaffMessage(db0, userId, matchedAccount, text, lmidG, nowG);
          if (!ok) anyFailed = true;
        }
        console.log(JSON.stringify({ tag: "line-webhook:group-staff-speaker", account: matchedAccount.key, msgType }));
        continue;
      }
    } else {
      // 個人のトークで本人から直接届いた＝本物の個人の会話。グループから誤って作られた印を外す
      const db0 = getDb();
      after(async () => {
        await db0.from("conversations").update({ send_blocked_reason: null })
          .eq("line_user_id", userId).eq("account", matchedAccount.key).eq("send_blocked_reason", "created_from_group");
      });
    }

    // 鈴木のuserIdが未保存なら、プロフィールをチェックして自動保存（発言者の個人 ID で見る）
    if (speakerUserId && target.kind === "user") after(async () => {
      try {
        const db2 = getDb();
        const { data: existing } = await db2.from("hanbancyo_settings").select("value").eq("key", "suzuki_line_user_id").maybeSingle();
        if (!existing?.value && matchedAccount.token) {
          const profile = await fetchLineProfile(userId, matchedAccount.token);
          if (profile?.displayName?.includes("鈴木")) {
            await db2.from("hanbancyo_settings").upsert({ key: "suzuki_line_user_id", value: userId }, { onConflict: "key" });
            console.log("[line-webhook] 鈴木のuserIdを自動保存:", userId, profile.displayName);
          }
        }
      } catch (e) {
        console.warn("[line-webhook] 鈴木userId自動検出エラー:", e);
      }
    });

    if (msgType === "text") {
      const lineMessageId = event.message?.id;
      const text = (event.message as { text?: string })?.text;
      if (!text) continue;
      // LINEリプライ（引用）機能: 引用元メッセージID（LINE API 2023年9月〜）
      const quotedMessageId = event.message?.quotedMessageId;
      // 同一POSTバッチ内で同一ユーザーに対してドラフトトリガーが複数発火するのを防ぐ
      // 1回目は通常通り実行、2回目以降はskipDraftTrigger=trueでafter() Bをスキップ
      const skipDraft = draftTriggeredUserIds.has(userId);
      draftTriggeredUserIds.add(userId);
      // sync-from-screeningより高速な直接経路で保存（line_message_idで重複防止）
      const ok = await handleTextMessage(userId, text, matchedAccount, lineMessageId, quotedMessageId, skipDraft);
      if (!ok) anyFailed = true;
      continue;
    } else if (msgType === "image") {
      const lineMessageId = event.message?.id;
      if (!lineMessageId) continue;
      // 即時保存（重複チェック込み）してから後処理キューに積む
      const saved = await handleImageMessageSave(userId, lineMessageId, matchedAccount);
      if (saved === null) {
        anyFailed = true; // 失敗 → LINEにリトライさせる
      } else if (saved !== "duplicate") {
        imageJobs.push({ lineMessageId, msgId: saved.msgId, convId: saved.convId, account: matchedAccount });
      }
    } else if (msgType === "file") {
      // 2026-09-17 竹内（友哉事例）: PDF（LINE の file メッセージ）は保存されず捨てられていた
      //   → 公式 LINE には出るのにアプリには出ず、ブレインも「書類が届いた」と分からなかった
      //   （実データ365日で messages の "[ファイル]" は0件）。画像と同じ形で保存・取得・ブレインを動かす
      const lineMessageId = event.message?.id;
      if (!lineMessageId) continue;
      const fileName = (event.message?.fileName ?? "").trim() || null;
      const saved = await handleFileMessageSave(userId, lineMessageId, fileName, matchedAccount);
      if (saved === null) {
        anyFailed = true; // 失敗 → LINEにリトライさせる
      } else if (saved !== "duplicate") {
        fileJobs.push({ lineMessageId, msgId: saved.msgId, convId: saved.convId, fileName, account: matchedAccount });
      }
    } else if (msgType === "sticker") {
      // H4: スタンプは保存も通知もされず消えていた → テキスト経路で "[スタンプ]" として保存・通知
      // skipDraftTrigger=true: スタンプでai_draft生成は不要（連打で多重生成が起きるのを防ぐ）
      const lineMessageId = event.message?.id;
      const ok = await handleTextMessage(userId, "[スタンプ]", matchedAccount, lineMessageId, undefined, true);
      if (!ok) anyFailed = true;
      continue;
    } else {
      // 未対応msgType（video/audio等）: ブレイン誘導のみクリア（draft生成は不要）
      const db = getDb();
      const { data: conv } = await db
        .from("conversations")
        .select("id")
        .eq("line_user_id", userId)
        .eq("account", matchedAccount.key)
        .maybeSingle();
      if (conv?.id) {
        await db.from("conversations")
          .update({ suggested_aix_meta: null })
          .eq("id", conv.id as string);
        // FIX: stale __SHOWN__ 残留対策 — この経路は meta をクリアするだけで brain 再分析が走らず、
        // 補填は brain-sweep のみ。__SHOWN__ が残っていると sweep が誤スキップするためクリアする
        await db.from("conversations")
          .update({ ai_draft: null })
          .eq("id", conv.id as string)
          .eq("ai_draft", "__SHOWN__");
      }
    }
    // video / audio / file は現状スキップ
  }

  // LINEへの200レスポンスを先に返し、画像fetch/uploadはレスポンス後に実行
  // after()はNext.js 14.1+の機能。レスポンス送信後もVercel functionを維持する
  if (imageJobs.length > 0) {
    after(async () => {
      // 画像の読み取り（Vision: 書き起こし＋種類）が終わってから、会話ごとにブレインを1回だけ動かす。
      //   ブレインは messages.text（[画像] <書き起こし>）と image_type を読むので、読み取り前に動かすと中身を見ずに判断する。
      //   読み取りが止まってもブレインは必ず動かす（上限 IMAGE_READ_WAIT_MS。読めなかった画像は従来どおり「[画像]」として判断）
      const readStartedAt = Date.now();
      await Promise.race([
        Promise.allSettled(
          imageJobs.map(({ lineMessageId, msgId, account, convId }) => fetchAndUploadLineImage(lineMessageId, msgId, account, convId))
        ),
        new Promise<void>((resolve) => setTimeout(resolve, IMAGE_READ_WAIT_MS)),
      ]);
      const inputUpdatedAt = Date.now();
      const convIds = [...new Set(imageJobs.map((j) => j.convId))];
      console.log(JSON.stringify({ tag: "brain:image-trigger", convIds, images: imageJobs.length, readMs: inputUpdatedAt - readStartedAt }));
      // 2026-09-24: 画像の読み取り（Vision）は夜も行う（本文の書き起こしは朝の分析の材料）。ブレインだけ origin: image_read で夜は見送る（brain-core の保険が止める）
      await Promise.allSettled(convIds.map((cid) =>
        runBrainAndNotify(cid, undefined, { inputUpdatedAt, origin: "image_read" })
          .catch((e) => console.warn("[line-webhook] brain notify (image):", cid, e))
      ));
    });
  }

  // 2026-09-17 竹内（友哉事例）: ファイル（PDF 等）も本体を取ってからブレインを会話ごとに1回動かす。
  //   同じ POST に画像もあった時は画像側が同じ会話を回すので、ここでは画像に無い会話だけ動かす
  if (fileJobs.length > 0) {
    const imageConvIds = new Set(imageJobs.map((j) => j.convId));
    after(async () => {
      await Promise.race([
        Promise.allSettled(
          fileJobs.map(({ lineMessageId, msgId, fileName, account }) => fetchAndUploadLineFile(lineMessageId, msgId, fileName, account))
        ),
        new Promise<void>((resolve) => setTimeout(resolve, IMAGE_READ_WAIT_MS)),
      ]);
      const inputUpdatedAt = Date.now();
      const convIds = [...new Set(fileJobs.map((j) => j.convId))].filter((cid) => !imageConvIds.has(cid));
      console.log(JSON.stringify({ tag: "brain:file-trigger", convIds, files: fileJobs.length, names: fileJobs.map((j) => j.fileName) }));
      await Promise.allSettled(convIds.map((cid) =>
        runBrainAndNotify(cid, undefined, { inputUpdatedAt, origin: "image_read" })
          .catch((e) => console.warn("[line-webhook] brain notify (file):", cid, e))
      ));
    });
  }

  // 保存失敗時は500を返してLINEにリトライさせる（line_message_id UNIQUE制約で重複保存は防止済み）
  if (anyFailed) {
    return NextResponse.json({ error: "message save failed, will retry" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
