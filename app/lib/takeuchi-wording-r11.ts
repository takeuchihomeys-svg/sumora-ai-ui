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

/**
 * 2026-10-16 竹内悠馬（10/16 の画面の事例 e）「代理契約は『交渉させて頂きます』」:
 *   竹内さんの手打ち（180日）で代理契約のこれからの約束は「交渉させて頂きます」2/2（「確認させて頂きましたところ」は結果の報告＝過去の形）。
 *   同じ文に代理契約があり、これからの約束（確認させて頂きます／確認致します）の時だけ「交渉させて頂きます」に替える。過去の形・「」の中は触らない。
 *   戻す TAKEUCHI_PROXY_NEGOTIATE=off
 */
export function proxyNegotiateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.TAKEUCHI_PROXY_NEGOTIATE ?? "").toLowerCase() !== "off";
}
const PROXY_PROMISE_RE = /([^。！!\n]*代理契約[^。！!\n]*?)確認(?:させて(?:頂|いただ)きます|致します|いたします)/g;
export function fixProxyNegotiate(text: string, enabled = proxyNegotiateEnabled()): { text: string; changes: string[] } {
  if (!enabled || !text || !text.includes("代理契約")) return { text, changes: [] };
  const changes: string[] = [];
  const s = outsideQuotes(text, (seg) => seg.replace(PROXY_PROMISE_RE, (m, head: string) => {
    // 同じ文で募集状況・空きも確認する約束は替えない（「募集状況と代理契約を交渉」にならない）
    if (/募集状況|空き|空室|内覧/.test(head)) return m;
    // 2026-10-16 確かめる人: 交渉は「代理契約が出来るか（可能か）を管理会社に」の時だけ（「代理契約の必要書類につきまして確認」は交渉にしない）
    if (!/可能|可否|出来|できる|管理会社|オーナー|貸主/.test(head)) return m;
    changes.push(`代理契約の約束は交渉: ${m.slice(-24)}`);
    return `${head}交渉させて頂きます`;
  }));
  return { text: s, changes };
}
