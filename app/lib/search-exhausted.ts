// app/lib/search-exhausted.ts — 今の条件の物件を出し切ったか（純関数）
//
// 2026-10-08 竹内さん（Q4）「これは全力サポートの所。出し切るまで全力サポートと物件ピックアップ・物件オススメで行う
//   （＝送れる物件があるか分からない時は2択）。出し切ったら全力サポート。文も実際の会話のように合わせる」
//   不一致の実物: #178 #194 #197 #200 #214 #215 #216（前に「現在募集…全てピックアップ」を送った後の「もう少し探して」「条件の言葉」に
//   AI は「改めて／新たにピックアップしてお送り」・人は「新着状況随時確認…募集に出次第お送り」）。
// 決め方（決定論・LLM なし）:
//   出し切った印 = こちらの送信（AIX・手打ち）で「全て／すべて／全部 ピックアップ（お送り）させて頂きました」か、
//                 新着待ちの約束（「新着…出次第／出ましたら お送り」）か、AIX【全力サポート】を送った。
//   取り消し     = 印の後にお客様が条件を変えた（エリア・家賃・間取り・設備・緩和）＝新しい条件ではまだ探していない。
//                 この番で条件を変えた時も取り消し（search-result-choice の2択のまま）。
//   売上サポに今送れる新しい候補がある（pickupReady=true）時は出し切っていない（物件を送る）。
// ⚠ 「現在募集に出ておらず」は物件1件の募集終了にも使う（120日で AIX 44・手打ち 31）ので印にしない。
// 使い方（brain-core の search-result-choice の直前）: 物件の AIX を選んだ番で exhausted なら主を AIX【全力サポート】に、
//   物件の AIX は2つ目に残す（スタッフが新着を見つけた時のため。竹内さんに Q-A で確認）。
// 戻す: SEARCH_EXHAUSTED_ZENRYOKU=off（今の2択のまま）

export type ExMsg = { sender: string; text: string | null | undefined; createdAt: string; isAix?: boolean | null; aixType?: string | null };

const ALL_PICKED_RE = /(?:全て|すべて|全部)(?:の)?(?:お部屋)?(?:ピックアップ|お送り)(?:させて|して)(?:頂|いただ)きました|(?:全て|すべて|全部)確認させて(?:頂|いただ)きましたところ/;
// 10/09 ブレインの試験（出し切り7問）: 実物の印は「全て」の無い送付の報告（「天王寺周辺全域から…ピックアップさせて頂きました」「新着で…募集に出ました」）と AIX の物件の送付。
//   今の条件の物件を送り終えた報告は全部印にする（これから送る約束「ピックアップしてお送りさせて頂きます」は過去形でないので当たらない）
const DELIVERED_RE = /ピックアップ(?:させて|して)(?:頂|いただ)きました|募集に(?:出|で)ました/;
/** 新しい地名・駅名でのお部屋の有無の問い（「〇〇町、〇〇などはありませんか？」）。「中央大通りより北側で」等の絞り込みの言い方（問いでない）は当てない */
const NEW_AREA_ASK_RE = /[一-龥ァ-ヶ]{1,6}(?:駅|区|市|町|線)[^。\n]{0,24}(?:あり|無い|ない|どう)[^。\n]{0,8}(?:か|？|\?)/;
/** お客様が条件を出し直した（条件のフォーム）＝新しい条件ではまだ探していない */
const CONDITION_FORM_RE = /お部屋探しご条件|お部屋お探し中|【ご入居の時期】/;
// ⚠ 「全てピックアップしてお送りさせて頂きます」（これから送る約束）は印にしない（60日の実送信を読んで確かめた）
const NEW_ARRIVAL_PROMISE_RE = /新着[^。\n！!]{0,30}(?:出次第|出ましたら|出た際|出てき次第)[^。\n！!]{0,12}(?:お送り|ご連絡|ご紹介)/;
/** お客様の条件の変更（エリア・家賃・間取り・設備・緩和）。brain の condition_change_type が無い過去の番の予備 */
// 10/09 試験の分解⑥（q061「選択肢増えるかな」）: 選択肢を増やす言い方も広げる側
const CUSTOMER_CONDITION_CHANGE_RE = /選択肢(?:が|も)?増え|(?:エリア|地域|駅)[^。\n]{0,10}(?:広げ|追加|も(?:大丈夫|OK|可|探し))|(?:家賃|予算)[^。\n]{0,10}(?:上げ|あげ|上が|あが|まで(?:大丈夫|OK|可)|万(?:まで|以内)でも)|(?:[0-9０-９]+\s*(?:LDK|DK|K)|間取り)[^。\n]{0,10}(?:でも|も)(?:大丈夫|OK|可|探し)|(?:徒歩|築年数|築)[^。\n]{0,10}(?:でも|も)(?:大丈夫|OK|可)|条件(?:を)?(?:変え|緩め|広げ)/;

export function searchExhaustedEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SEARCH_EXHAUSTED_ZENRYOKU ?? "").trim().toLowerCase() !== "off";
}

export function isExhaustMarker(m: ExMsg): boolean {
  if (m.sender !== "staff") return false;
  if (m.aixType === "zenryoku_support" || m.aixType === "property_send" || m.aixType === "property_recommendation") return true;
  const t = (m.text ?? "").normalize("NFKC");
  return ALL_PICKED_RE.test(t) || DELIVERED_RE.test(t) || NEW_ARRIVAL_PROMISE_RE.test(t);
}

export function searchExhausted(msgs: ReadonlyArray<ExMsg>, o: { conditionChangedThisTurn: boolean; pickupReady: boolean | null | undefined; zenryokuSentAt?: ReadonlyArray<string>; deliveredAixAt?: ReadonlyArray<string>; placeMentioned?: boolean }): { exhausted: boolean; markerAt: string | null; reason: string } {
  // 10/09 試験（q008 神崎川・q011 大国町・q032 大国町・q062 京橋）: この番で地名（駅・区・市）を言った＝新しい条件で探す番（出し切っていない）
  if (o.placeMentioned) return { exhausted: false, markerAt: null, reason: "この番で地名を言った（新しい条件）" };
  // AIX の物件の送付（property_send・property_recommendation を送った時刻）も印
  if (o.deliveredAixAt?.length) msgs = [...msgs, ...o.deliveredAixAt.map((at) => ({ sender: "staff", text: "", createdAt: at, aixType: "property_send" }))].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // AIX【全力サポート】を送った時刻（行動台帳の AIX の行）も印にする
  if (o.zenryokuSentAt?.length) msgs = [...msgs, ...o.zenryokuSentAt.map((at) => ({ sender: "staff", text: "", createdAt: at, aixType: "zenryoku_support" }))].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (o.pickupReady === true) return { exhausted: false, markerAt: null, reason: "売上サポに送れる新しい候補がある" };
  if (o.conditionChangedThisTurn) return { exhausted: false, markerAt: null, reason: "この番で条件が変わった（2択のまま）" };
  let idx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (isExhaustMarker(msgs[i])) { idx = i; break; }
  if (idx < 0) return { exhausted: false, markerAt: null, reason: "出し切った印が無い" };
  const after = msgs.slice(idx + 1).filter((m) => m.sender === "customer");
  // 広げた条件・条件のフォームの出し直しだけ取り消す（「ガスコンロ」「中央大通りより北側で」等の絞り込みは出し切ったまま＝竹内さん Q4「広がった時は除く」・試験 q006 q007）
  //   新しい地名・駅名で「〜はありませんか」と聞いた（試験 q011「大国町、本町、堺筋本町、などはあまりありませんか？」＝竹内さんは新しいエリアでピックアップの約束）も取り消す
  if (after.some((m) => { const x = (m.text ?? "").normalize("NFKC"); return CUSTOMER_CONDITION_CHANGE_RE.test(x) || CONDITION_FORM_RE.test(x) || NEW_AREA_ASK_RE.test(x); })) return { exhausted: false, markerAt: msgs[idx].createdAt, reason: "印の後に条件が変わった" };
  return { exhausted: true, markerAt: msgs[idx].createdAt, reason: "今の条件の物件は出し切った（新着待ち）" };
}

/** brain-core の最後の AIX に当てる: 物件の AIX で出し切っていれば主を【全力サポート】に（物件の AIX は2つ目） */
export function applySearchExhausted(o: { finalAix: string | null; altActions: string[] | undefined; exhausted: boolean; postApply: boolean; env?: Record<string, string | undefined> }): { finalAix: string | null; altActions: string[] | undefined; changed: boolean } {
  const keep = { finalAix: o.finalAix, altActions: o.altActions, changed: false };
  if (!searchExhaustedEnabled(o.env) || o.postApply || !o.exhausted) return keep;
  if (!o.finalAix || !["property_send", "property_recommendation", "property_search"].includes(o.finalAix)) return keep;
  const alts = [o.finalAix, ...(o.altActions ?? []).filter((a) => a !== o.finalAix && a !== "zenryoku_support")];
  return { finalAix: "zenryoku_support", altActions: alts, changed: true };
}
