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
