// app/lib/takeuchi-wording-r11.ts — 11巡目（2026-10-08・r12 の調査⑦）: 竹内さんが書かない言い回しを出口で竹内さんの形に（純関数）
//   約束の文末の「ね」（「確認させて頂きますね😊」「お伝えさせて頂きますね」「ピックアップさせて頂きますね」）→ 取る
//   線（scripts/audit-r11-wording-exits.ts・10/08）: 竹内さんの手打ち 1,859通（180日）で文末の「ね」は3通（「少なくなりますね😊」「大変でしたね😌」＝約束の文ではない）
//     → 約束の「（させて）頂きますね／致しますね」だけに絞ると竹内さんの文は 0通変わる（誤削除0）。本番の下書き 330通（60日）で 4通変わる。
//   入れなかった物（同じ監査で止めた）:
//     ・「夜遅くに／夜分遅くに失礼致します」: 竹内さんの手打ちで 32通（夜に物件・見積を送る報告の頭＝返信ではない）・本番の下書きは 0通（banned-phrasing が既に落とす）＝足す意味が無い
//     ・「くらい／ぐらい→程」「らへん→周辺」: 本番の下書き 0通・竹内さんの手打ち 1通（誤削除0にならない）
//   「」の中（お客様の言葉の引用）は触らない。戻す: TAKEUCHI_WORDING_R11=off
export function takeuchiWordingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.TAKEUCHI_WORDING_R11 ?? "").toLowerCase() !== "off";
}

/** 「」の外だけに置き換えを当てる */
function outsideQuotes(text: string, f: (s: string) => string): string {
  return text.split(/(「[^「」\n]*」)/).map((seg) => (seg.startsWith("「") && seg.endsWith("」") ? seg : f(seg))).join("");
}
const PROMISE_NE_RE = /((?:頂|いただ)きます|(?:致|いた)します)ね(?=[！!。、😊😌🌟✨\s]|$)/g;

export function fixTakeuchiWording(text: string, enabled = takeuchiWordingEnabled()): { text: string; changes: string[] } {
  if (!enabled || !text) return { text, changes: [] };
  const changes: string[] = [];
  const s = outsideQuotes(text, (seg) => seg.replace(PROMISE_NE_RE, (m, a: string) => { changes.push(`約束の文末の「ね」: ${m}`); return a; }));
  return { text: s, changes };
}
