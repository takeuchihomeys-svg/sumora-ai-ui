// scripts/lib/exam-scene-times.ts — 試験の場面の通の時刻（2026-11-05 作業員1・番 8959・q212）
//
// 旧: 通の時刻は全部 90秒おき（h.sceneTimes）。本番で 18分空いていた AIX の物件送付と手打ちのピックアップの約束が、試験では3分の中に並び、
//   台帳の「最後のこちらの行い」（action-ledger の pickLastStaffEntry・3分の窓）が物件の送付になって、約束の直後のお礼（スタンプ）が読めなかった。
// 新（EXAM_REAL_GAPS・11/05 統括役「試験が本番を写す方が大事」で既定 on・=off で旧の90秒おき）: 元の間隔（ago の差）を使う。短すぎる間は 90秒（今まで通り）・長い間は 5分で頭打ち
//   （3分の窓の内か外かは保つ・場面の長さは通の数×5分まで＝線（floor）が昔の残りに届きにくい）。
export const GAP_MIN_SEC = 90;
export const GAP_MAX_SEC = 300;
export function examRealGapsOn(env: Record<string, string | undefined> = process.env): boolean { return (env.EXAM_REAL_GAPS ?? "").trim().toLowerCase() !== "off"; }
/** agoMin: 各通が番の何分前か（古い順）。end: 最後の通の時刻（ms） */
export function gapSceneTimes(agoMin: ReadonlyArray<number>, endMs: number): string[] {
  const n = agoMin.length;
  const out = new Array<number>(n);
  if (!n) return [];
  out[n - 1] = endMs;
  for (let i = n - 2; i >= 0; i--) {
    const realSec = Math.max(0, (Number(agoMin[i]) - Number(agoMin[i + 1])) * 60);
    const step = Math.min(GAP_MAX_SEC, Math.max(GAP_MIN_SEC, realSec));
    out[i] = out[i + 1] - step * 1000;
  }
  return out.map((t) => new Date(t).toISOString());
}

/**
 * 2026-11-06 作業員1（弱い所 353・作業員7の見つけ）: 通の時刻を、元の番の「日の区切り」に合わせて作る。
 *   旧（gapSceneTimes）は今の時刻から間を詰めて逆に並べるだけ＝0時 JST 前後に流すと通が2日に分かれ、【気持ちの流れ】に
 *   「2日に分けて送った後の返事」の偽の材料が入った（入った回 8/8・04時以降 0/14・q055）。逆に元が数日に分かれていた通は1日に詰まっていた。
 * 新: 元の通の JST の日（番の日から何日前か）を保つ。番の日の通は end の日に、前の日の通はその日数だけ前の日の 23:58 から逆に並べる。
 *   同じ日の中の間は今まで通り 90秒〜5分。番の日の通が end の日の 0時を越える時は、間を縮めて（最小 10秒）その日の中に収める。
 */
const DAY_MS = 86_400_000, JST_MS = 9 * 3_600_000;
export const jstDayOf = (ms: number): number => Math.floor((ms + JST_MS) / DAY_MS);
const jstDayStart = (day: number): number => day * DAY_MS - JST_MS;
export function gapSceneTimesByDay(agoMin: ReadonlyArray<number>, atMs: number, endMs: number): string[] {
  const n = agoMin.length;
  if (!n) return [];
  const atDay = jstDayOf(atMs);
  const offs = agoMin.map((a) => atDay - jstDayOf(atMs - Number(a) * 60_000)); // 番の日から何日前か（0＝同じ日）
  const endDay = jstDayOf(endMs);
  const out = new Array<number>(n);
  // 古い順に並んでいる前提。後ろから日ごとのまとまりを作る
  let i = n - 1;
  while (i >= 0) {
    const d = offs[i];
    let j = i; while (j - 1 >= 0 && offs[j - 1] === d) j--;
    const sceneDay = endDay - d;
    const dayStart = jstDayStart(sceneDay);
    const last = d === 0 ? endMs : Math.min(jstDayStart(sceneDay + 1) - 2 * 60_000, endMs);
    // まとまりの中の間（今まで通り 90秒〜5分）
    const steps: number[] = [];
    for (let k = i - 1; k >= j; k--) steps.push(Math.min(GAP_MAX_SEC, Math.max(GAP_MIN_SEC, Math.max(0, (Number(agoMin[k]) - Number(agoMin[k + 1])) * 60))) * 1000);
    const need = steps.reduce((a, b) => a + b, 0);
    const room = Math.max(0, last - dayStart - 60_000);
    const scale = need > room && need > 0 ? Math.max(room / need, 0) : 1;
    out[i] = last;
    for (let k = i - 1, s = 0; k >= j; k--, s++) out[k] = out[k + 1] - Math.max(10_000, Math.round(steps[s] * scale));
    i = j - 1;
  }
  return out.map((t) => new Date(t).toISOString());
}
