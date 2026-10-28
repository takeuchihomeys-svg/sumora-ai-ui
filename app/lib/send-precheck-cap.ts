// app/lib/send-precheck-cap.ts — LINE 送信の前の DB の確かめに短い上限を付ける（SEND_PRECHECK_FAST・既定 off）
//
// 2026-10-28 作業員4（竹内さんの指摘 #19 陽菜 10/26 9:24「送れているのに『送信の返事が来ませんでした』と出る」）:
//   本番のログ（10/26 00:23〜00:24 UTC）: 1回目の要求 nhnnc（00:23:20 開始）は約83秒・確かめの要求 5xlzw（00:23:50 開始・同じ印）は
//   51秒目に「retry-key-accepted」（LINE は届いていた）。画面の待ち（1回目 30秒・確かめ 25秒）を両方超えて「分からない」になった。
//   原因: 送信の前の DB の読み（会話の行＝送り先の確かめ・新しい発言の確かめ・アカウントの補い）が DB の詰まりで1本ずつ REST の上限 25秒まで待つ
//   （読めない時は今も「確かめない」で進む＝fail-open）。上限に達するまで待ってから進むので、確かめの要求も LINE に届く前に時間切れになる。
//   直し: on の時はこの3本の読みを並べて投げ、各 4秒で切る（読めない時の扱いは今と同じ＝止めない側）。送信の後の処理は既に after（応答の後）。
//   二重送り防止（LINE の X-Line-Retry-Key・画面の印）はそのまま。
export const SEND_PRECHECK_CAP_MS = 4_000;

export function sendPrecheckFastOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SEND_PRECHECK_FAST ?? "").trim().toLowerCase() === "on";
}

/** p が ms 以内に終わらなければ fallback を返す（p は止めない・結果は捨てる）。fallback の時は onTimeout を呼ぶ */
export async function withCap<T>(p: PromiseLike<T>, ms: number, fallback: T, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const t = new Promise<{ timedOut: true }>((r) => { timer = setTimeout(() => r({ timedOut: true }), ms); });
  try {
    const out = await Promise.race([Promise.resolve(p).then((v) => ({ v })), t]);
    if ("timedOut" in out) { onTimeout?.(); return fallback; }
    return out.v;
  } finally { if (timer) clearTimeout(timer); }
}
