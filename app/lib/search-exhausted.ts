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
/** 御見積書を送った（「こちら初期費用の御見積書となります」「御見積書お送りさせて頂きます」は約束なので当てない） */
const ESTIMATE_SENT_RE = /御見積書(?:と|に)なります|お見積書(?:と|に)なります|初期費用の御見積書をお送りさせて(?:頂|いただ)きました/;
const NEW_ARRIVAL_PROMISE_RE = /新着[^。\n！!]{0,30}(?:出次第|出ましたら|出た際|出てき次第)[^。\n！!]{0,12}(?:お送り|ご連絡|ご紹介)/;
/** お客様の条件の変更（エリア・家賃・間取り・設備・緩和）。brain の condition_change_type が無い過去の番の予備 */
// 10/09 試験の分解⑥（q061「選択肢増えるかな」）: 選択肢を増やす言い方も広げる側
const CUSTOMER_CONDITION_CHANGE_RE = /選択肢(?:が|も)?増え|(?:エリア|地域|駅)[^。\n]{0,10}(?:広げ|追加|も(?:大丈夫|OK|可|探し))|(?:家賃|予算)[^。\n]{0,10}(?:上げ|あげ|上が|あが|まで(?:大丈夫|OK|可)|万(?:まで|以内)でも)|(?:[0-9０-９]+\s*(?:LDK|DK|K)|間取り)[^。\n]{0,10}(?:でも|も)(?:大丈夫|OK|可|探し)|(?:徒歩|築年数|築)[^。\n]{0,10}(?:でも|も)(?:大丈夫|OK|可)|条件(?:を)?(?:変え|緩め|広げ)/;

export function searchExhaustedEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SEARCH_EXHAUSTED_ZENRYOKU ?? "").trim().toLowerCase() !== "off";
}

export function isExhaustMarker(m: ExMsg): boolean {
  return markerStrength(m) !== null;
}

/**
 * 2026-10-13 ブレイン基準（棚卸し B-1）: 印の強さ。
 *   strong＝今の条件を出し切ったと**言った**印（「全て…ピックアップさせて頂きました」・新着待ちの約束・AIX【全力サポート】）
 *   weak  ＝物件を1回送った・送付を報告しただけ（AIX の物件の送付・「ピックアップさせて頂きました」「募集に出ました」）
 *   10/09 に weak も印にした（試験の出し切り7問）ら、物件を送った事のある会話はほぼ全部「出し切り」になり、
 *   4日 43番でブレインの一手と方向を【全力サポート】に書き換え、その後スタッフが物件の AIX を送ったのは 21/42・全力サポートは 2/42。
 */
export function markerStrength(m: ExMsg): "strong" | "weak" | null {
  if (m.sender !== "staff") return null;
  if (m.aixType === "zenryoku_support") return "strong";
  if (m.aixType === "property_send" || m.aixType === "property_recommendation") return "weak";
  const t = (m.text ?? "").normalize("NFKC");
  if (ALL_PICKED_RE.test(t) || NEW_ARRIVAL_PROMISE_RE.test(t)) return "strong";
  if (DELIVERED_RE.test(t)) return "weak";
  return null;
}

/**
 * 2026-10-27 苦手な問題②（q008・q062・q170 と q006・q007）: 送付だけの印（weak）と出し切ったと言った印（strong）の見分けを正しくする（既定 off）。
 *   旧: 「ご条件から離れますが」（条件の外の物件を送る＝今の条件の物件はもう無い）・「〜探させて頂きましたが、現在募集に出ておらず、エリア広げ」は
 *   weak と数えられ、weak の番にも強い言い切りの行（「出し切った印がある＝返信で締める」）を渡していた（EXHAUSTED_WEAK_TURN_LINE を off にした理由＝q006 q007）。
 *   そのため最初の束を送っただけの番（q008 神崎川・q170 お風呂・q062 京橋）にも「出し切った」と渡り、ブレインが足した条件で探す約束をしなかった（材料の誤り＝原因①）。
 *   新: weak の番でも会話でこう言っていれば（staffSaidExhausted）今の番の行と規則は strong と同じに扱い、言っていない weak の番だけ「出し切りとは限らない」行を渡し、ブレインが選んだ探す約束を規則で書き換えない（ack-exhausted-reply）。印の強さ（左右の材料）は変えない。
 *   線（実送信 120日）: 「条件から離れ」2通・「探…ましたが…募集に出ておらず」1通＝全部が今の条件の物件が無いと言った番。
 *   見本（weakq-after1）で q003（新着を1件ずつ送る段）が weak の行で探す約束に倒れた（3回中2回）→「1件新着で」も言った文に足した。
 *     「募集に出ておらず」だけ（6通）は持ち込みの1件の空きの答え（「〇〇は募集に出ておらず」）＝出し切りではないので入れない。
 *   入れる: EXHAUSTED_WEAK_ACCURATE=on
 */
export function exhaustedWeakAccurateEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.EXHAUSTED_WEAK_ACCURATE ?? "").trim().toLowerCase() === "on";
}
// 「1件新着で〜募集に出ました」＝束を出し切った後の新着を1件ずつ送る段（竹内さんの決定 10/14・q003「新着を1件ずつ送っている段階（出し切り後）」）。実送信 60日の12通は全部この段
// 2026-10-27 試験 weakq-after2（q007）: この文を印の強さ（strong）に足すと、左右の材料（splitMaterialLine の strong＝「物件を求める番は全力サポートが主」）まで変わり、
//   出し切りの後の条件の絞り込み（返信で締める番）で物件の AIX に倒れた（main 2/3 → 0/3）。印の強さは変えず、weak の番で「今の番」の行と規則の扱いを選ぶ時だけ使う（staffSaidExhausted）
const LEFT_CONDITION_RE = /条件から(?:は)?(?:少し)?離れ(?:ます|て|ており)|(?:新着で|新着の)[^。\n]{0,6}(?:1|一)件|(?:1|一)件新着|(?:探|お探し)[^。\n]{0,24}(?:ましたが|ましたところ)[^。\n]{0,12}募集に(?:出|で)ておら?ず/;

/** weak の番で、こちらが会話で今の条件の物件はもう無いと言っているか（直近のスタッフの文 12通・EXHAUSTED_WEAK_ACCURATE=on の時だけ・off は false） */
export function staffSaidExhausted(msgs: ReadonlyArray<{ sender: string; text?: string | null }>, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  if (!exhaustedWeakAccurateEnabled(env)) return false;
  return msgs.filter((m) => m.sender !== "customer").slice(-12).some((m) => LEFT_CONDITION_RE.test(String(m.text ?? "").normalize("NFKC")));
}
/** 今の番の行・規則で使う強さ: weak でも会話で出し切ったと言っていれば strong と同じに扱う */
export function effectiveExhaustStrength(strength: "strong" | "weak" | null | undefined, msgs: ReadonlyArray<{ sender: string; text?: string | null }>, env?: Record<string, string | undefined>): "strong" | "weak" | null {
  if (strength === "weak" && staffSaidExhausted(msgs, env)) return "strong";
  return strength ?? null;
}

/** 弱い印だけの出し切りはブレインの材料に下げる（上書きしない）か。**既定 off（旧のまま）**・BRAIN_DEMOTE_SEARCH_EXHAUSTED=on で下げる。
 *  10/13 試験（出し切り7問・DeepSeek）: 下げると道 7/7→5/7・合格 1→0（q003 が悪化・q002 q006 は2段の約束に）＝試験の正解（竹内さんの実送信）は送付だけの印の後でも全力サポート。
 *  本番4日の 43番ではスタッフが物件の AIX を送った番が多い（21/42）＝食い違う。材料を強くしてから on にする（入れない判断・報告に書いた） */
export function weakExhaustDemoted(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_DEMOTE_SEARCH_EXHAUSTED ?? "").trim().toLowerCase() === "on";
}

/** ブレインに渡す材料の1行（LLM の前）。印が無ければ空 */
export function exhaustedMaterialLine(r: { exhausted: boolean; markerAt: string | null; strength?: "strong" | "weak" | null; markerText?: string | null }): string {
  if (!r.markerAt) return "";
  const q = Array.from(String(r.markerText ?? "").replace(/\s+/g, " ")).slice(0, 40).join("");
  const when = r.markerAt.slice(0, 16).replace("T", " ");
  if (r.exhausted && r.strength === "strong") {
    return `【出し切りの材料】${when}（UTC）にこちらが今の条件の物件を出し切った印${q ? `（「${q}」）` : "（AIX【全力サポート】）"}を送り、その後お客様は条件を広げていない＝物件を求める番は AIX【全力サポート】が主（新着が見つかっていれば物件の AIX は2つ目）`;
  }
  return `【出し切りの材料】${when}（UTC）に物件を送った・送付を報告した${q ? `（「${q}」）` : "（AIX の物件の送付）"}。これは1回送っただけで、今の条件を出し切ったと言った印（「全てピックアップさせて頂きました」・新着待ちの約束・AIX【全力サポート】）は無い＝出し切りとは限らない。お客様が物件を求めた時は、出し切ったかどうかを会話から読んで決める（まだ探せるなら物件の AIX かピックアップの約束・本当に出し切ったなら【全力サポート】）`;
}

export type ExhaustResult = { exhausted: boolean; markerAt: string | null; reason: string; strength?: "strong" | "weak" | null; markerText?: string | null };

/**
 * 出し切りの判定（旧と同じ答え）に、強さ（strong＝出し切ったと言った印から判定しても出し切り／weak＝送付の印だけで出し切り）を付ける。
 * 強さの判定は「強い印だけ」で同じ判定をやり直した結果（強い印の後に条件が変わった・見積に進んだなら強くない）。
 */
export function searchExhausted(msgs: ReadonlyArray<ExMsg>, o: { conditionChangedThisTurn: boolean; pickupReady: boolean | null | undefined; zenryokuSentAt?: ReadonlyArray<string>; deliveredAixAt?: ReadonlyArray<string>; placeMentioned?: boolean }): ExhaustResult {
  const all = searchExhaustedCore(msgs, o, null);
  if (!all.exhausted) return { ...all, strength: null };
  const strong = searchExhaustedCore(msgs, o, "strong");
  return { ...all, strength: strong.exhausted ? "strong" : "weak" };
}

function searchExhaustedCore(msgs: ReadonlyArray<ExMsg>, o: { conditionChangedThisTurn: boolean; pickupReady: boolean | null | undefined; zenryokuSentAt?: ReadonlyArray<string>; deliveredAixAt?: ReadonlyArray<string>; placeMentioned?: boolean }, only: "strong" | null): ExhaustResult {
  const isMarker = (m: ExMsg) => (only ? markerStrength(m) === only : isExhaustMarker(m));
  // 10/09 試験（q008 神崎川・q011 大国町・q032 大国町・q062 京橋）: この番で地名（駅・区・市）を言った＝新しい条件で探す番（出し切っていない）
  if (o.placeMentioned) return { exhausted: false, markerAt: null, reason: "この番で地名を言った（新しい条件）" };
  // AIX の物件の送付（property_send・property_recommendation を送った時刻）も印
  if (o.deliveredAixAt?.length) msgs = [...msgs, ...o.deliveredAixAt.map((at) => ({ sender: "staff", text: "", createdAt: at, aixType: "property_send" }))].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // AIX【全力サポート】を送った時刻（行動台帳の AIX の行）も印にする
  if (o.zenryokuSentAt?.length) msgs = [...msgs, ...o.zenryokuSentAt.map((at) => ({ sender: "staff", text: "", createdAt: at, aixType: "zenryoku_support" }))].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (o.pickupReady === true) return { exhausted: false, markerAt: null, reason: "売上サポに送れる新しい候補がある" };
  if (o.conditionChangedThisTurn) return { exhausted: false, markerAt: null, reason: "この番で条件が変わった（2択のまま）" };
  let idx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (isMarker(msgs[i])) { idx = i; break; }
  if (idx < 0) return { exhausted: false, markerAt: null, reason: "出し切った印が無い" };
  const after = msgs.slice(idx + 1).filter((m) => m.sender === "customer");
  // 広げた条件・条件のフォームの出し直しだけ取り消す（「ガスコンロ」「中央大通りより北側で」等の絞り込みは出し切ったまま＝竹内さん Q4「広がった時は除く」・試験 q006 q007）
  //   新しい地名・駅名で「〜はありませんか」と聞いた（試験 q011「大国町、本町、堺筋本町、などはあまりありませんか？」＝竹内さんは新しいエリアでピックアップの約束）も取り消す
  if (after.some((m) => { const x = (m.text ?? "").normalize("NFKC"); return CUSTOMER_CONDITION_CHANGE_RE.test(x) || CONDITION_FORM_RE.test(x) || NEW_AREA_ASK_RE.test(x); })) return { exhausted: false, markerAt: msgs[idx].createdAt, reason: "印の後に条件が変わった" };
  // 10/09 試験 q038（見積書の後の「礼金がなかったらここで決めてました」）: 印の後に1件の御見積書まで進んだ＝話は物件1件の比べに移った。
  //   竹内さんは礼金0の別の物件を推した（AIX【物件オススメ】・答え: オススメが第一＋ピックアップの約束も正解）＝新着待ちではない。戻す SEARCH_EXHAUSTED_ESTIMATE_CANCEL=off
  if ((typeof process === "undefined" || (process.env?.SEARCH_EXHAUSTED_ESTIMATE_CANCEL ?? "").toLowerCase() !== "off")
    && msgs.slice(idx + 1).some((m) => m.sender === "staff" && (m.aixType === "estimate_sheet" || ESTIMATE_SENT_RE.test((m.text ?? "").normalize("NFKC"))))) {
    return { exhausted: false, markerAt: msgs[idx].createdAt, reason: "印の後に御見積書を送った（物件1件の話）" };
  }
  return { exhausted: true, markerAt: msgs[idx].createdAt, reason: "今の条件の物件は出し切った（新着待ち）", markerText: msgs[idx].text ?? null };
}

/** brain-core の最後の AIX に当てる: 物件の AIX で出し切っていれば主を【全力サポート】に（物件の AIX は2つ目） */
export function applySearchExhausted(o: { finalAix: string | null; altActions: string[] | undefined; exhausted: boolean; postApply: boolean; env?: Record<string, string | undefined> }): { finalAix: string | null; altActions: string[] | undefined; changed: boolean } {
  const keep = { finalAix: o.finalAix, altActions: o.altActions, changed: false };
  if (!searchExhaustedEnabled(o.env) || o.postApply || !o.exhausted) return keep;
  if (!o.finalAix || !["property_send", "property_recommendation", "property_search"].includes(o.finalAix)) return keep;
  const alts = [o.finalAix, ...(o.altActions ?? []).filter((a) => a !== o.finalAix && a !== "zenryoku_support")];
  return { finalAix: "zenryoku_support", altActions: alts, changed: true };
}
