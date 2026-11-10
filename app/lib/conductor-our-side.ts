// app/lib/conductor-our-side.ts — 入口の統括に渡す「こちら側の状態」の短い1塊（純関数・DB/LLM なし）
//
// 2026-11-11 作業員4（弱い所 565「AIX の種類・順番の読み違い」13番・568「スタッフだけが結果を持つ番を返信にする」13番・統括役の指示）:
//   根は、統括が約束の帳面（確認の約束 → 結果 → 見積書の順・確認中 → スタッフの手元に結果あり）とピッカーの意味を持っていない事。
//   竹内さんの決定（11/11・KB P1 bfb1d47d）「こちら側の細かい所（何を送ったか・何を約束したか・AIX で何を送ったか）にも注目して読む」と同じ向き。
//   竹内さんの番 1,123（conductor_turn_vectors v2）を、こちら側の状態ごとに数えた（11/11）:
//     見積書の約束が開いている → AIX【見積書送る】13/19／直前に内覧の案内の AIX（了承の一言）→ AIX【待ち合わせ場所】9/12／
//     確認の約束が開いている＋お客様の一言 → 返信 23/30／約束なし＋空きの問い → AIX【物件確認した】4/11・返信 4/11
//   ＝同じお客様の一言でも、こちら側の状態で竹内さんの一手が変わる。状態をそのまま渡し、読むのは統括（決めるのはブレイン・P0 9eb6aa9c）。
//   切替: CONDUCTOR_OUR_SIDE=on（既定 off）。テスト: app/lib/__tests__/conductor-our-side.test.ts

type Env = Record<string, string | undefined>;
export const conductorOurSideOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_OUR_SIDE ?? "").trim().toLowerCase() === "on";

export type OurSideMsg = { sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null };
export type OurSideAix = { aix_type: string; check_pattern?: string | null; created_at: string; sent_at?: string | null; property_names?: string[] | null; estimate_sent?: boolean | null };

const AIX_JA: Record<string, string> = {
  property_send: "物件送付（束）", property_recommendation: "物件オススメ（1件）", property_check_result: "物件確認した（物件そのもの＝空き・募集）",
  acknowledge_check: "確認した（設備・条件＝管理会社に確認）", estimate_sheet: "見積書送る", viewing_invite: "内覧調整（候補日）", meeting_place: "待ち合わせ場所（内覧の確定）",
  application_push: "申込へ", phone_call: "電話", guarantor_info: "保証会社", condition_hearing: "条件ヒアリング", zenryoku_support: "全力サポート", cost_explain: "初期費用を説明",
};
const PICK_JA: Record<string, string> = {
  available: "募集中", unavailable: "募集終了", vacating: "退去予定", move_out_planned: "退去予定", alternative: "代わりの部屋が募集中", taken: "申込あり", second_position: "2番手", exclusive: "専任",
};
const pickJa = (p: string | null | undefined) => (!p ? "" : PICK_JA[p] ?? (p.startsWith("mgmt_") ? `管理会社に確認した（${p.slice(5)}）` : p));

/** 約束の種類（決まった計算の網・こちらの文の言い方で分ける） */
export function promiseKindOf(t: string): "見積" | "確認" | "探す" | "内覧" | "他" {
  if (/見積/.test(t)) return "見積";
  if (/内覧|ご案内|日程|候補/.test(t)) return "内覧";
  if (/ピックアップ|お探し|探させ|新着|お送りさせて頂きます/.test(t) && !/募集状況|空き状況/.test(t)) return "探す";
  if (/募集状況|空き|空室|状況|確認(させて|致し|いたし)|確認出来次第|確認でき次第|管理会社/.test(t)) return "確認";
  return "他";
}
const PROMISE_RE = /(?:確認|お送り|ピックアップ|ご連絡|交渉|調整|作成|手配|お調べ|探させ|お探し).{0,20}(?:させて頂きます|させていただきます|致します|いたします)|次第/;
const FULFIL = new Set(["property_send", "property_recommendation", "property_check_result", "acknowledge_check", "estimate_sheet", "meeting_place", "viewing_invite"]);

const ago = (nowMs: number, iso: string) => {
  const m = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m}分前` : m < 48 * 60 ? `${Math.round(m / 60)}時間前` : `${Math.round(m / 1440)}日前`;
};

/**
 * こちら側の状態の1塊（無ければ ""）。msgs は今の番より前の通（順は問わない）、aix は AIX の記録（順は問わない）。
 *   ① 開いている約束（こちらの最後の約束の文の後に、果たす AIX がまだ無い）: 種類・その文の要点・いつ
 *   ② 直前の AIX（種類の意味・ピッカーの値・物件名2件まで・見積書の同封・いつ）
 *   ③ 送った物件（束／1件の回数・最後はいつ）
 */
export function ourSideBlock(o: { msgs: ReadonlyArray<OurSideMsg>; aix: ReadonlyArray<OurSideAix>; nowMs: number }): string {
  const msgs = [...o.msgs].filter((m) => Date.parse(m.created_at) <= o.nowMs).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const aix = [...o.aix].filter((a) => Date.parse(a.sent_at ?? a.created_at) <= o.nowMs).sort((a, b) => (a.sent_at ?? a.created_at).localeCompare(b.sent_at ?? b.created_at));
  const lines: string[] = [];
  // ① 開いている約束
  let promise: { text: string; at: string } | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.sender === "customer" || m.is_aix_generated) continue;
    const s = (m.text ?? "").split(/\n+|(?<=[！!。])/u).find((x) => PROMISE_RE.test(x));
    if (s) { promise = { text: s.replace(/\s+/g, " ").trim().slice(0, 50), at: m.created_at }; break; }
  }
  if (promise && aix.some((a) => FULFIL.has(a.aix_type) && (a.sent_at ?? a.created_at) > promise!.at)) promise = null; // 後で AIX で果たした
  lines.push(promise ? `・開いている約束: ${promiseKindOf(promise.text)}の約束「${promise.text}」（${ago(o.nowMs, promise.at)}・結果はまだ送っていない）` : "・開いている約束: なし");
  // ② 直前の AIX
  const last = aix[aix.length - 1];
  if (last) {
    const names = (last.property_names ?? []).filter(Boolean).slice(0, 2).join("・");
    const pk = pickJa(last.check_pattern);
    lines.push(`・直前の AIX: ${AIX_JA[last.aix_type] ?? last.aix_type}${pk ? `＝${pk}` : ""}${names ? `（${names}）` : ""}${last.estimate_sent ? "・御見積書を同封" : ""}（${ago(o.nowMs, last.sent_at ?? last.created_at)}）`);
  } else lines.push("・直前の AIX: なし");
  // ③ 送った物件
  const sends = aix.filter((a) => a.aix_type === "property_send"), recs = aix.filter((a) => a.aix_type === "property_recommendation");
  const lastSend = [...sends, ...recs].sort((a, b) => (a.sent_at ?? a.created_at).localeCompare(b.sent_at ?? b.created_at)).pop();
  lines.push(sends.length || recs.length ? `・送った物件: 束 ${sends.length}回・1件のオススメ ${recs.length}回（最後 ${ago(o.nowMs, lastSend!.sent_at ?? lastSend!.created_at)}）` : "・送った物件: まだ無い");
  return [
    "【こちら側の状態（11/11・読むのは統括）】",
    ...lines,
    "（読み方: 物件確認した＝物件そのものの空き・募集の結果、確認した＝設備・条件を管理会社に確かめた結果、見積書＝費用。約束が開いている番は、その約束の続き（確認→結果→見積の順）か、新しい依頼かを先に分ける。スタッフが自分で確かめて結果を送れる事（空き・日時・費用）は、約束の返信を挟まず AIX で結果を送る番もある＝お客様の言葉だけでなく、この状態と合わせて読む）",
  ].join("\n");
}
