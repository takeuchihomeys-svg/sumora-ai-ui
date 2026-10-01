// トーク一覧の行に出す札（チップ）の見た目を1か所に置く。
// 2026-10-01 竹内「要対応や毎日物件出しや🔥の絵文字を外に表示せずバックグラウンドにまわす。
//   AIXや新着の物件や未確認等の重要な部分だけをのこす。LINEトークの色等はこのまま連携された状態で、デザインを洗練させる」
// ・行に出すのは「押せば仕事が進む印」だけ（AIX・新着の未確認・未読・必ず・物件確認の待ち）。
//   運用の状態（要対応・毎日／物件出し・🔥・出し中・内覧済・管理ツール）は絞り込み・長押しメニュー・売上サポ・会話の中に残す。
// ・大きさは全部同じ（高さ18px・文字10px・角丸いっぱい・太さ semibold）。色は意味ごとに1つだけ。
//   強い色（塗り）は今すぐ動く印だけ、それ以外は淡い面の色にして、行の背景色（要対応の橙・申込後の青）とぶつけない。

/** 札の共通の形（大きさ・角丸・太さ）。色は LIST_CHIP_TONE から足す */
export const LIST_CHIP =
  "inline-flex h-[18px] shrink-0 items-center whitespace-nowrap rounded-full px-1.5 text-[10px] font-semibold leading-none";

/** 札の色（意味ごとに1つ）。accent＝塗り（今すぐ動く）・soft＝淡い面・muted＝補足 */
export const LIST_CHIP_TONE = {
  /** ブレインが AIX を判断している（押す先がある） */
  aix: "bg-[#7C3AED] text-white",
  /** 未読の数（LINE と同じ緑） */
  unread: "bg-[#06C755] text-white",
  /** お客様への約束・未履行（【必ず】） */
  promise: "bg-[#d32f2f] text-white",
  // 淡い札は「白地＋細い縁」か「半透明の黒」にする。行の背景（要対応の橙・開いている灰・申込後の青）の上でも消えない
  //   （淡い橙の面だけだと要対応の橙の行に溶け、#f0f2f5 の面だけだと開いている行の灰に溶けた。2026-10-01 静的描画で確認）
  /** AIXツールで採点した新着物件・未確認 */
  newArrival: "bg-white text-[#e65100] ring-1 ring-inset ring-[#ffb74d]",
  /** 物件確認の待ち（日数で強くなる） */
  checkFresh: "bg-black/[0.05] text-[#54656f]",
  checkLate: "bg-white text-[#e65100] ring-1 ring-inset ring-[#ffb74d]",
  checkOverdue: "bg-white text-[#c62828] ring-1 ring-inset ring-[#ef9a9a]",
  /** 補足（アカウント・担当・今日返信済み） */
  muted: "bg-black/[0.05] text-[#667781]",
} as const;

/** 物件確認の待ちの日数 → 色（0〜2日＝補足・3〜6日＝橙・7日〜＝赤。旧の 紫／橙／赤 の段と同じ区切り） */
export function propertyCheckTone(days: number): string {
  if (days >= 7) return LIST_CHIP_TONE.checkOverdue;
  if (days >= 3) return LIST_CHIP_TONE.checkLate;
  return LIST_CHIP_TONE.checkFresh;
}
