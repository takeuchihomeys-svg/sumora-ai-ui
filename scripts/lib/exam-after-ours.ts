// scripts/lib/exam-after-ours.ts — 試験の作りで「こちらの通の後」の番（お客様の返事が無い番）を扱う（台帳 #861・純関数・試験の台本だけ・本番のコードは触らない）
// 2026-11-28 作業員L（統括役の頼み・作業員A の調べ: #805 の SILENT_SINCE_OURS_LINE の番を今の試験の作りでは問題にできない）:
//   spec に afterOurs: true（「こちらの通の後」の印）がある時だけ、最後のお客様の通より後のこちらの通（〜at）も場面に残し、
//   ブレインは今の発言の無い番として流す（今＝at・本番の2層の「今回の発言の層」は無いので1層で）。判定の文は「今の発言は無い」と書く。
//   印の無い問題は1字も変えない（scripts/lib/__tests__/exam-after-ours.test.ts が全部の問題で前後を比べる）。
export type SliceMsg = { sender: string };
export type SceneSlice<T> = { ctx: T[]; cust: T[]; tail: T[] };
/** 場面の切り出し。印が無い時は今までと同じ（最後のお客様の通のまとまり＋その前の29通）。印がある時は、その後のこちらの通（tail）も返す */
export function sceneSliceOf<T extends SliceMsg>(msgs: readonly T[], afterOurs = false): SceneSlice<T> | string {
  let end = msgs.length - 1; while (end >= 0 && msgs[end].sender !== "customer") end--;
  if (end < 0) return "お客様の通が無い";
  let start = end; while (start - 1 >= 0 && msgs[start - 1].sender === "customer") start--;
  const ctx = msgs.slice(Math.max(0, start - 29), start);
  const cust = msgs.slice(start, end + 1);
  if (!afterOurs) return { ctx, cust, tail: [] };
  const tail = msgs.slice(end + 1);
  if (!tail.length) return "こちらの通の後の番ではない（最後の通がお客様）";
  return { ctx, cust, tail: tail.slice(-10) };
}

export type CtxMsg = { s: string; t: string; aix?: boolean; ago?: number };
/** 判定役に渡す「今の発言」と「直前のこちらの送信」（brain-exam.ts の contextText と同じ・印の無い問題は1字も同じ） */
export function examContextText(p: { customer: string; context: readonly CtxMsg[]; afterOurs?: boolean }): string {
  const lastStaff = [...p.context].reverse().filter((m) => m.s === "staff").slice(0, 2).reverse().map((m) => `${m.aix ? "【AIX】" : ""}${m.t}`.slice(0, 300));
  if (p.afterOurs) {
    const last = [...p.context].reverse().find((m) => m.s === "staff");
    const h = last && typeof last.ago === "number" ? Math.round(last.ago / 60) : null;
    return `【お客様の今の発言（連投）】\n（無い＝こちらの通の後にお客様の返事が無い番・今はこちらの最後の通から${h != null ? `約${h}時間` : "しばらく"}後）\n\n【直前のこちらの送信】\n${lastStaff.join("\n―\n") || "（なし＝初回）"}`;
  }
  return `【お客様の今の発言（連投）】\n${p.customer}\n\n【直前のこちらの送信】\n${lastStaff.join("\n―\n") || "（なし＝初回）"}`;
}
/** 本番と同じ2層で流すか（印のある番は今回の発言が無い＝1層で流す）。印の無い問題は今までと同じ条件 */
export function examProdLayerOk(p: { context: readonly CtxMsg[]; afterOurs?: boolean }, layer: string, burst: number): boolean {
  if (p.afterOurs) return false;
  return layer === "prod" && burst > 0 && p.context.slice(0, burst).some((m) => m.s === "customer");
}
