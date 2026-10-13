// app/lib/meeting-place-form.ts — AIX【待ち合わせ場所】の2行目（「〇〇ご案内させて頂きます！！」）を竹内さんの送り方に（純関数）
//
// 2026-10-13 竹内「AIX テンプレートで文が生成される所の文の質が今悪い…実際に竹内が送っているのと比べてずれている部分を改善」:
//   待ち合わせ場所は固定の雛形（時間あり＝画面で組み立て・時間なし＝aix/action の雛形）で、竹内さんは 60日 33押下中 27回（82%）を直して送っていた
//   （scripts/audit-aix-text-vs-takeuchi.ts の was_edited）。直した所はほぼ2行目だけ:
//     内覧が今日・明日の番 9回 → 「本日15:00〜ご案内」「明日14:00〜ご案内」「明日11:00ご案内」「明日15:00お部屋ご案内」「明日12:00〜ご案内」「本日14:30〜ご案内」「明日ご案内」（7回が本日/明日＋時間・2回は2行目を消した）
//     それより先の日 → 雛形の「9/26（土）ご案内させて頂きます！！」のまま（直さず送った2回）／1回だけ「10/13（火）11:00よりご案内」
//   3行目（「10/12 11:00に〇〇」）は日付のまま 8回・本日/明日に直した 5回＝割れているので変えない。
//   → 今日・明日の時だけ2行目を「本日{時間}〜ご案内させて頂きます！！」「明日{時間}〜ご案内させて頂きます！！」（時間が分からない時は「明日ご案内…」）。
//   日付の計算（今日・明日）は判断ではなく暦（日本時間）＝決定論でよい（P0 9eb6aa9c の安全の線・暦の計算）。
// 戻す: 画面 NEXT_PUBLIC_MEETING_DAY_WORD=off ／ サーバー MEETING_DAY_WORD=off
// テスト: app/lib/__tests__/meeting-place-form.test.ts

const DAY_MS = 86_400_000;
const jstDay = (ms: number) => Math.floor((ms + 9 * 3600_000) / DAY_MS);

/** "10/12（月）"・"10月12日" 等の内覧日が、今（nowMs）から見て日本時間の何日後か（読めない・年をまたいで遠い時は null） */
export function meetingDayOffset(meetingDate: string | null | undefined, nowMs: number = Date.now()): number | null {
  const m = String(meetingDate ?? "").normalize("NFKC").match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (!m) return null;
  const mo = Number(m[1]), d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const nowJst = new Date(nowMs + 9 * 3600_000);
  const today = jstDay(nowMs);
  let best: number | null = null;
  for (const y of [nowJst.getUTCFullYear() - 1, nowJst.getUTCFullYear(), nowJst.getUTCFullYear() + 1]) {
    const t = Date.UTC(y, mo - 1, d);
    if (new Date(t).getUTCDate() !== d) continue;
    const off = Math.floor(t / DAY_MS) - today;
    if (best === null || Math.abs(off) < Math.abs(best)) best = off;
  }
  return best;
}

export function meetingDayWordOn(env: Record<string, string | undefined>, key: "NEXT_PUBLIC_MEETING_DAY_WORD" | "MEETING_DAY_WORD"): boolean {
  return (env[key] ?? "on").trim().toLowerCase() !== "off";
}

/**
 * 2行目。今日・明日なら「本日{時間}〜」「明日{時間}〜」、それ以外は従来どおり「{日付（曜）}」。
 * @param dateLabel 従来の2行目に入れていた日付（曜日の付いた形）
 * @param time "15:00" 等（無ければ時間なし）
 */
export function meetingSecondLine(dateLabel: string, time: string | null | undefined, nowMs: number = Date.now(), on = true): string {
  const off = on ? meetingDayOffset(dateLabel, nowMs) : null;
  const tm = String(time ?? "").trim().normalize("NFKC").match(/^(\d{1,2}:\d{2})/)?.[1] ?? "";
  if (off === 0 || off === 1) return `${off === 0 ? "本日" : "明日"}${tm ? `${tm}〜` : ""}ご案内させて頂きます！！`;
  return `${dateLabel}ご案内させて頂きます！！`;
}
