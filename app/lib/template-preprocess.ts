// ─── テンプレート前処理の共有ヘルパー ─────────────────────────────────────────
// /api/templates/adapt（旧: Haiku単発最適化）と
// /api/generate-reply（テンプレート最適化モード）で共用する。
// adapt/route.ts のインライン実装をそのまま移設したもの。挙動を変えないこと。

export type VacatingDate = { month: number; day: number } | null | undefined;

// 丸文字クラス: ◯(U+25EF)・○(U+25CB)・〇(U+3007) の3種を統一して扱う（DBは◯多用）
const C = "[◯○〇]";

function lastDayOf(m: number): number {
  return new Date(new Date().getFullYear(), m, 0).getDate();
}

/**
 * 退去予定日・内覧可能日を「◯月◯日」プレースホルダーに埋め込む。
 * 内覧可能日 = 退去日 + 1日（月末の繰り越し・12月→1月も対応）。
 * vacatingDate が無い場合はプレースホルダーを汎用文言に置換する。
 */
export function applyVacatingDateToTemplate(templateText: string, vacatingDate: VacatingDate): string {
  let processed = templateText;

  // 退去日・内覧可能日を計算
  let vacStr: string | null = null;
  let viewStr: string | null = null;
  if (vacatingDate) {
    const last = lastDayOf(vacatingDate.month);
    const vacDay = Math.min(vacatingDate.day, last);
    vacStr = `${vacatingDate.month}月${vacDay}日`;
    // 内覧可能日 = 退去日 + 1日（月をまたぐ場合も対応）
    let vm = vacatingDate.month;
    let vd = vacDay + 1;
    if (vd > lastDayOf(vm)) { vd = 1; vm = vm === 12 ? 1 : vm + 1; }
    viewStr = `${vm}月${vd}日`;
  }

  // パターン優先順: 複合パターン（両日付）を先に処理してから単体パターンへ
  // 1) 〇月〇日退去の為〇月〇日以降ご内覧可能
  processed = processed.replace(
    new RegExp(`${C}+月${C}+日退去の為${C}+月${C}+日以降ご内覧可能`, "g"),
    vacStr && viewStr ? `${vacStr}退去の為${viewStr}以降ご内覧可能` : "退去の為内覧可能日以降ご内覧可能"
  );
  // 2) 〇月〇退去予定の為〇月〇日以降ご内覧可能（「日」なしバリアント）
  processed = processed.replace(
    new RegExp(`${C}+月${C}+退去予定の為${C}+月${C}+日以降ご内覧可能`, "g"),
    vacStr && viewStr ? `${vacStr}退去予定の為${viewStr}以降ご内覧可能` : "退去予定の為内覧可能日以降ご内覧可能"
  );
  // 3) 〇月〇日以降ご内覧可能（単体・上のパターン未処理の残り）
  processed = processed.replace(
    new RegExp(`${C}+月${C}+日以降ご内覧可能`, "g"),
    viewStr ? `${viewStr}以降ご内覧可能` : "内覧可能日以降ご内覧可能"
  );
  // 4) 〇月〇日退去予定（単体）
  processed = processed.replace(
    new RegExp(`${C}+月${C}+日退去予定`, "g"),
    vacStr ? `${vacStr}退去予定` : "退去予定"
  );

  return processed;
}

/**
 * 挨拶ルール: 本日スタッフ送信済みなら「お待たせ致しました」（21時以降は「夜分遅くに失礼致します」）、
 * 未送信なら「お世話になっております」。
 */
export function selectGreeting(staffMessagedToday: boolean, jstHour: number): string {
  return staffMessagedToday
    ? (jstHour >= 21 ? "夜分遅くに失礼致します！！" : "お待たせ致しました！！")
    : "お世話になっております！！";
}

/**
 * テンプレート内の挨拶文をルールに従って正しい挨拶に差し替える。
 */
export function applyGreetingSwap(templateText: string, staffMessagedToday: boolean): string {
  const GREETING_RE = /お世話になっております！！?|お待たせ致しました！！?|夜分遅くに失礼致します！！?/g;
  const jstHour = (new Date().getUTCHours() + 9) % 24;
  return templateText.replace(GREETING_RE, selectGreeting(staffMessagedToday, jstHour));
}

/**
 * 号室の先頭ゼロを除去（日本の号室は0始まりにならない: 0906号室→906号室）。
 * 生成後の出力テキストに適用する。
 */
export function stripRoomLeadingZeros(text: string): string {
  return text.replace(/(?<!\d)0+(\d+)号室/g, "$1号室");
}
