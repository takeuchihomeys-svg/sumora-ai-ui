// app/lib/pickup-line-1121.ts — AIX【物件ピックアップした】の文で、竹内さんの型（PICKUP_SEND_FORM_1028）が負けている2か所の指示の差し替え（純関数・既定 off）
//
// 2026-11-21 作業員K2（台帳 #469・統括役の頼み）: 竹内さんは物件ピックアップした の文を 36番のうち 35番直して送っていた
//   （scripts/audit-aix-edit-diff.ts・AI の元の文は ai_template_candidates.original_text）。大きい直しは2つ:
//   ① 内覧の誘いの1行を足した 17/36（「〇〇さんお気に召されたお部屋ご都合よろしいお日にちにご案内させて頂きます！！」・日時は書かない）。
//      従業員は 72番のうち1番しか足していない＝竹内さんの形。
//      負けている所: aix/action の skipViewingInviteNote（画面の内覧の切り替えが on でない時は「【最重要・内覧提案の省略】…内覧誘導文は一切含めない」）が、
//      竹内さんの型の材料（pickupSendFormNote の「→ ご案内 → ご査収」の順）より強い（system の最後に置かれ「最重要」）。
//   ② ピックアップの1行の条件を減らした 16/36（AI は エリア＋家賃＋間取り＋築年 を並べ、竹内さんはエリアだけかエリア＋1つ）。
//      負けている所: 【条件ルール】の後ろの「※【今回実際に検索した条件】がある時は、②のエリア・家賃・間取りはそちらに合わせる」が、
//      家賃・間取りを書く指示として読まれる（条件の数の決まりは PICKUP_COND_COUNT で「決め打ちしない」になり、上限の言葉が無い）。
// 直し（PICKUP_LINE_1121=on の時だけ・既定 off＝今と1文字も変わらない）:
//   ① 画面の切り替えが on でない時も、日時を書かない誘いの1行（竹内さんの言葉）だけは入れる。内覧の予定がもう決まっている・申込の後・お客様が内覧できないと言っている時は入れない
//   ② 検索した条件は②の言葉の出所（言い方を合わせる）で、数を増やす指示ではない。②の条件はエリアのほか、特に気にしていた物を1つまで
// テスト: app/lib/__tests__/pickup-line-1121.test.ts
type Env = Record<string, string | undefined>;
export function pickupLine1121On(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.PICKUP_LINE_1121 ?? "").trim().toLowerCase() === "on";
}

/** 竹内さんのピックアップの誘いの1行（36番の竹内さんの直しの言葉） */
export const TAKEUCHI_PICKUP_INVITE = "[お客様名]お気に召されたお部屋ご都合よろしいお日にちにご案内させて頂きます！！";

/** skipViewingInviteNote の代わり（画面の内覧の切り替えが on でない時） */
export function pickupInviteNote1121(): string {
  return `\n\n【内覧の誘いの1行（竹内さんの形）】内覧の日時（候補日・カレンダー）は書かない（日時は AIX【内覧日調整】で送る）。` +
    `最終行のご査収の直前に「${TAKEUCHI_PICKUP_INVITE}」を1文だけ入れる（竹内さんは物件ピックアップした の約半分の通でこの1文を足している）。` +
    `内覧の予定がもう決まっている・申込の後・お客様が内覧に行けないと言っている時は入れない。JSON 出力の場合は "invite" にこの1文、"calendar" は空文字にする。`;
}

/** 会話を合わせる経路の④の指示の代わり（name はお客様名） */
export function pickupInviteRule1121(name: string): string {
  return `【内覧誘導】④の後に「${TAKEUCHI_PICKUP_INVITE.replace("[お客様名]", name)}」を1文だけ（内覧の日時・候補日は書かない＝AIX【内覧日調整】で送る）。内覧の予定がもう決まっている・申込の後・お客様が内覧に行けないと言っている時は入れない`;
}

/** 出口: 日時・候補の入った誘いの行だけ落とす（日時の無い誘いの1行は残す） */
const DATED_INVITE_RE = /(?:ご案内|ご内覧|内覧).*(?:\d{1,2}\s*[\/月]\s*\d{1,2}|\d{1,2}\s*[:：時]|直近|明日|明後日|本日|今週|来週|土日|[月火水木金土日]曜)|直近(?:ですと|ですが|の日程)|ご案内可能です/;
export function stripDatedInviteLines(text: string): { text: string; removed: number } {
  let removed = 0;
  const kept = text.split("\n").filter((l) => { if (DATED_INVITE_RE.test(l)) { removed++; return false; } return true; });
  return { text: removed ? kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() : text, removed };
}

/** 【条件ルール】の後ろの検索した条件の注意の代わり */
export function searchedConditionsAddendum1121(): string {
  return "\n※【今回実際に検索した条件】は②の言葉の出所（エリア・条件の言い方を合わせる）で、②に書く条件を増やす指示ではない。②はエリアのほか、お客様が特に気にしていた条件を1つまで（エリアだけでもよい・家賃・間取り・築年を並べない）";
}
