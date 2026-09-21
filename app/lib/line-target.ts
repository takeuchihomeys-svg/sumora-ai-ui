// app/lib/line-target.ts
// LINE の宛先が「個人」か「グループ」か「トークルーム」かを1か所で決める（純関数・DB 依存なし）。
//
// 2026-09-21 竹内「これLINEのグループやから、LINEのグループでも送れるように対応する。
//   ちゃんと個人とLINEのグループ分けて認識できるようにもする。
//   LINEのグループにおくるはずが個人のLINEにおくらないように。グループに送るときはグループに送る」
//   「グループなら分かりやすくグループと入れる」
//
// 【起きていた事故（2026-09-21 黒明様お部屋探し）】
//   line-webhook は event.source.userId（**発言者**）しか見ておらず、source.groupId を捨てていた。
//     20:23 グループで「お手間おかけします。よろしくお願いいたします」
//     → 発言者（黒明さん個人 U…）の会話として作成（名前は取れず「名称未設定」）
//     → 20:44 スタッフがその会話から画像4枚＋募集状況の報告を送信
//     → 宛先は**黒明さん個人**。グループには届いていない
//   会話335件は全て個人（U…）で、グループ（C…）は0件だった。
//
// 【決め方】LINE の ID は先頭の1文字で種類が決まっている（U＝個人／C＝グループ／R＝トークルーム）。
//   会話の宛先（conversations.line_user_id）にグループなら**グループID**を入れれば、
//   送信（push の to）はそのままグループに届く。1つの会話＝1つの宛先なので取り違えが起きない。

export type LineTargetKind = "user" | "group" | "room";

/** LINE の ID の種類（先頭の1文字で決まる）。形が違えば null */
export function lineTargetKind(id: string | null | undefined): LineTargetKind | null {
  const s = (id ?? "").trim();
  if (!/^[UCR][0-9a-f]{32}$/.test(s)) return null;
  return s[0] === "U" ? "user" : s[0] === "C" ? "group" : "room";
}

/** グループ・トークルーム（複数人の宛先）か */
export function isMultiPersonTarget(id: string | null | undefined): boolean {
  const k = lineTargetKind(id);
  return k === "group" || k === "room";
}

export type EventSource = { type?: string; userId?: string; groupId?: string; roomId?: string };

/**
 * webhook のイベントの「宛先（会話のキー）」と「発言者」を分ける。
 *   個人    → 宛先 = userId            ／ 発言者 = userId
 *   グループ → 宛先 = groupId（C…）     ／ 発言者 = userId（居ない事もある）
 *   ルーム   → 宛先 = roomId（R…）      ／ 発言者 = userId
 * ⚠ 宛先に**発言者の userId を使わない**のがこの関数の目的（使うと返信が個人に飛ぶ）。
 */
export function resolveEventTarget(source: EventSource | null | undefined): { targetId: string; kind: LineTargetKind; speakerUserId: string | null } | null {
  if (!source) return null;
  const speaker = (source.userId ?? "").trim() || null;
  if (source.type === "group") {
    const g = (source.groupId ?? "").trim();
    return g ? { targetId: g, kind: "group", speakerUserId: speaker } : null;
  }
  if (source.type === "room") {
    const r = (source.roomId ?? "").trim();
    return r ? { targetId: r, kind: "room", speakerUserId: speaker } : null;
  }
  // type が無い・"user" は個人（従来どおり）
  return speaker ? { targetId: speaker, kind: "user", speakerUserId: speaker } : null;
}

/** 一覧・画面で分かるように付ける印（竹内「グループなら分かりやすくグループと入れる」） */
export const GROUP_NAME_PREFIX = "【グループ】";

/**
 * グループ名 → 会話の表示名。名前が取れない時も「グループ」だと分かるようにする。
 * 2026-09-21 竹内「グループ名もLINE側と同じにできるか」: LINE の表示と同じく、名前の後ろに人数を付ける
 *   （LINE 画面の「黒明様お部屋探し(4)」の (4) はグループ名ではなく人数。members/count で取る）
 */
export function groupConversationName(groupName: string | null | undefined, kind: LineTargetKind = "group", memberCount?: number | null): string {
  const n = (groupName ?? "").trim();
  const count = typeof memberCount === "number" && memberCount > 0 ? `(${memberCount})` : "";
  if (kind === "room") return `${GROUP_NAME_PREFIX}トークルーム${n ? ` ${n}` : ""}${count}`;
  return `${GROUP_NAME_PREFIX}${n ? `${n}${count}` : "グループ名取得中"}`;
}

/** 表示名がグループの印付きか（呼び名に使わない判定の入口） */
export function isGroupConversationName(name: string | null | undefined): boolean {
  return (name ?? "").trim().startsWith(GROUP_NAME_PREFIX);
}

export type SendTargetCheck = { ok: true } | { ok: false; reason: string; message: string };

/**
 * 送る直前の関門（送信経路はすべてこれを通す）。
 *   ① 宛先の ID の形が LINE の形でない → 送らない
 *   ② 会話の宛先と、送ろうとしている宛先が違う → 送らない（個人とグループの取り違え）
 *   ③ 会話に送信停止の印がある（グループから誤って個人の会話として作られた等） → 送らない
 * 会話が分からない呼び出し（conversation が null）は ① だけ見る（従来の動きを変えない）。
 */
export function checkSendTarget(
  to: string | null | undefined,
  conversation: { line_user_id?: string | null; send_blocked_reason?: string | null } | null,
): SendTargetCheck {
  const kind = lineTargetKind(to);
  if (!kind) return { ok: false, reason: "invalid_target", message: "送信先の LINE ID の形が正しくありません" };
  if (!conversation) return { ok: true };
  const convTarget = (conversation.line_user_id ?? "").trim();
  if (convTarget && convTarget !== (to ?? "").trim()) {
    const convKind = lineTargetKind(convTarget);
    const label = (k: LineTargetKind | null) => (k === "group" ? "グループ" : k === "room" ? "トークルーム" : "個人");
    return {
      ok: false, reason: "target_mismatch",
      message: `この会話の宛先は${label(convKind)}ですが、${label(kind)}に送ろうとしました。送信を止めました`,
    };
  }
  const blocked = (conversation.send_blocked_reason ?? "").trim();
  if (blocked) {
    return { ok: false, reason: "send_blocked", message: sendBlockedMessage(blocked) };
  }
  return { ok: true };
}

/** 送信停止の理由 → 画面に出す文 */
export function sendBlockedMessage(reason: string): string {
  if (reason === "created_from_group") {
    return "この会話は LINE グループのメッセージから誤って個人として作られたため、送信を止めています。グループの会話（【グループ】…）から送ってください";
  }
  if (reason === "merged_to_group") {
    return "この会話の履歴はグループの会話（【グループ】…）へ引き継ぎました。グループの会話から送ってください";
  }
  return `この会話は送信を止めています（${reason}）`;
}
