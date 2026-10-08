// app/lib/aix-takeuchi-form.ts — AIX の文を竹内さんの送信の形に寄せる（11巡目）の切り替え（純関数）
//
// 2026-10-08 竹内「AIX テンプレートの文の質も竹内が送っている形で。スタッフの方は質があんまりなので、AIX テンプレート竹内の方に寄せるように改善する」
//   正解は竹内さんが送った AIX の通（messages.staff_writer='takeuchi'）。従業員の送信は正にしない。
//   数え方: scripts/audit-r11-aix-takeuchi-form.ts（種類×ピッカーの竹内さんの多数派の形と生成との差）・audit-r11-second-greeting.ts（2通目の挨拶）
//   前後: scripts/yuma-r11-aix-text.ts → scripts/audit-r11-aix-score.ts
// 戻すのは AIX_TAKEUCHI_FORM=off（呼ぶ時に読む＝同じプロセスで前後を作り直せる）
export function aixTakeuchiFormOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AIX_TAKEUCHI_FORM ?? "on").trim() !== "off";
}

/**
 * AIX【確認した→入居日について（mgmt_move_in）】の申込誘導の文。
 *   竹内さんの送信（2通）: 「〇〇さん良ければ先にお申込みでお部屋を抑えてからご内覧もできます😊！！／よろしければお申し込みしお部屋抑えるのは如何でしょうか！！」
 *   「〇〇さん良ければ先にお申込みでお部屋を抑えてから内覧もできます！！／お申込みはいかがでしょうか😌！！」
 *   旧の1行（「…内覧もできます！！😊良ければお申込みはいかがでしょうか！！」＝絵文字が！！の後・1行に2文）は 4通とも竹内さんが直した
 */
export function moveInApplyInviteLine(nameWithSan: string): string {
  return aixTakeuchiFormOn()
    ? `${nameWithSan}良ければ先にお申込みでお部屋を抑えてからご内覧もできます😊！！\nお申込みはいかがでしょうか！！`
    : `${nameWithSan}良ければ先にお申込みでお部屋を抑えてから内覧もできます！！😊良ければお申込みはいかがでしょうか！！`;
}

/**
 * AIX【確認した→設備（mgmt_equipment）】の締めの既定（スタッフが誘導を選んでいない時）。
 *   竹内さんの送信 6通で「ご不明な点がございましたらお気軽にご連絡ください😊！！」を残したのは 1通（絵文字なし）・4通は結果で終える／次の一手を自分で書く → 既定は締めなし
 */
export function equipmentDefaultClose(): string | null {
  return aixTakeuchiFormOn() ? null : "ご不明な点がございましたらお気軽にご連絡ください😊！！";
}
