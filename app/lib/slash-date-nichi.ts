// app/lib/slash-date-nichi.ts — 「11/2日」「10/24日12:00」のようなスラッシュの日付＋「日」を直す（DATE_SLASH_NO_NICHI・既定 off）
//
// 2026-10-28 竹内さんの指摘 #16（かずき 8:07「11/2日は何卒よろしくお願い致します」）: 「/ で日付したら、その後に日を入れるのはおかしい」。
//   出所は2つ: ①done-state.viewingAckLine が「M/D日は」を足していた（7巡目・人の手打ちの多数に合わせた）②手本（スタッフの実送信「10/24日12:00」）。
//   直し: 「M/D日」の「日」を外す（後ろに数字が続く時は半角の空白を入れる＝「10/24 12:00」）。「日」が語の頭（日割・日間・日分・日程・日付・日数・日曜）の時だけ触らない
//   （「10/13日以降」「9/17日までに」「10/31日ごろ」「10/17日当日」の「日」は日付の日＝外す）。スタッフの送信 365日で 430通中 直す 272通・触らない 1通（7/1日曜日）（前後を目で読んだ）
//   normalizeBannedPhrasing（手本の入口と返信・AIX の出口の共通）で掛ける。
export function slashDateNichiOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.DATE_SLASH_NO_NICHI ?? "").trim().toLowerCase() === "on";
}

// 「日」の後ろがこれらで始まる時は語の一部（日割・日間 等）なので触らない
const NICHI_WORD_TAIL = /^(?:割|間|分|程|付|目|数|曜|常|々)/;

export function fixSlashDateNichi(text: string): { text: string; fixed: string[] } {
  const fixed: string[] = [];
  const out = text.replace(/(?<![0-9０-９/／])([0-9]{1,2})\/([0-9]{1,2})日(?=(.?))/g, (all, mo: string, d: string, _n: string, offset: number, whole: string) => {
    const m = Number(mo), dd = Number(d);
    if (!(m >= 1 && m <= 12 && dd >= 1 && dd <= 31)) return all;
    const rest = whole.slice(offset + all.length);
    if (NICHI_WORD_TAIL.test(rest)) return all;
    fixed.push(all);
    return `${mo}/${d}${/^[0-9]/.test(rest) ? " " : ""}`;
  });
  return { text: out, fixed };
}
