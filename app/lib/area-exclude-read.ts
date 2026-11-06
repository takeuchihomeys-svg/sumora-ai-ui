// app/lib/area-exclude-read.ts — 物件を送った後の「〇〇は住んでいたが不便だった」を、そのエリアを外す条件の言い直しと読む手本（純関数・LLM なし）
//
// 2026-11-06 作業員1（弱い所 359・q008）: 「神崎川はすんでましたが 不便だったので汗」（送った束の🌟が RIFF阪急神崎川）を、ブレインが
//   条件の言い直しと読めず、4回中3回「返信」にした。「避けたい・除いて」と言わず、前に住んだ・行った経験の悪さで外したいと伝える言い方。
//   竹内さん本人の実送信（200日・物件を送った後にエリアを外す言い直し 3番）: そのエリアを除いてピックアップする約束 3・返信だけ 0
//     （9/19 721ff307 神崎川・9/19 ac34b364 ミナミ方面は避けたい・9/09 f5e92bc6 京都・尼崎はNG）。従業員も 8/10 生野区付近は避けたい → 同じ。
//   ＝判断の手本（竹内さんの一手）としてブレインの材料に足す。答えを決める規則ではない（P0「判断はすべてブレイン基準」）。
//   内覧・申込・日程の言葉がある番は出さない。既定 on（11/06 試験 area-read-on2-1106: q008 main 2/4 → 4/4・本質 2段:pickup 3/4・q010 1/1・q011 3/3・確かな悪化0）。止める BRAIN_AREA_EXCLUDE_READ=off
//   監査（scripts/audit-area-exclude-read.ts・200日・物件を送った後・候補 208通）: 当たる 5番＝全部エリアを外す言い直しで、5番ともピックアップの約束で返した（竹内さん 3/3）。誤って当たる番 0（目で読んだ）

import { normalizeCustomerText } from "./reply-context";

export function areaExcludeReadOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_AREA_EXCLUDE_READ ?? "").trim().toLowerCase() !== "off";
}

/** 前に住んだ・行った・通った経験 */
export const PAST_STAY_RE = /住んで(?:い|た|ま)|すんで(?:い|た|ま)|前に住|以前住|昔住|行った(?:事|こと)|通って(?:い|た)|実家が/;
/** 経験の悪さ（外したい理由） */
export const BAD_EXPERIENCE_RE = /不便|微妙|治安|うるさ|騒がし|苦手|嫌|いや(?:で|だ)|良くな|よくな|遠(?:い|かっ)|暗(?:い|かっ)|物騒|合わな|ちょっと/;
/** この番に当たらない言葉（内覧・申込・日程・申込の書類） */
export const NOT_AREA_TURN_RE = /内[覧見]|見学|申込|申し込|日程|何時|お申込者様記入欄|生年月日|住居年数/;

// 2026-11-06 統括役「網は型の広さに（住んでいた・避けたい・NG）」: エリアの語と外す言い方が同じ文にある／地名＋はNG も当てる。
//   200日の監査で目で読んで外した物: 物件の作り・設備（和室・木造・告知事項）・ブランド（レオパレス）・会社（スモラさん以外で契約）・
//   広げる言い方（〜以外でも・市内なら）・条件の入力の型（①【…】）・内覧／申込の番
/** エリアの語（区・駅・線・方面 等）が外す言い方（避けたい・以外・除いて・NG）と同じ文にある */
export const AREA_AVOID_RE = /(?:エリア|区|市|駅|周辺|付近|辺り|あたり|方面|沿線|線|側)[^。\n！!？?]{0,15}?(?:避け|以外(?:で|の(?:エリア|地域|場所))|除い|外し|外して|NG|ＮＧ|は無し|はなし|は嫌|は無理|はちょっと|苦手)/;
/** 地名＋はNG（「京都・尼崎はNG」）。物件の作り・設備の語は地名ではない */
export const PLACE_NG_RE = /([一-龯ァ-ヶー]{2,6})(?:は|も)(?:NG|ＮＧ)/;
const NOT_PLACE_RE = /ペット|喫煙|タバコ|楽器|木造|和室|ユニット|三点|ロフト|一階|半地下|角部屋|鉄骨|告知|事故|保証人|連帯|審査|分割|カード|現金|仲介|礼金|敷金|家具|家電/;
/** 広げる言い方・会社や作りの「以外」（外す言い直しではない） */
export const NOT_AREA_AVOID_RE = /以外でも|ならオッケー|ならOK|なら大丈夫|さん以外|契約|①【|【ご希望|和室|木造|鉄骨|告知事項|レオパレス|物件以外/;

/** この番が「物件を送った後・エリアを外す言い直し（住んでいたが不便・避けたい・NG）」か */
export function readAreaExclude(i: { customerText: string | null | undefined; sentPropertyCount: number }): boolean {
  const c = normalizeCustomerText(i.customerText);
  if (!c.trim() || c.length > 250 || i.sentPropertyCount <= 0) return false;
  if (NOT_AREA_TURN_RE.test(c) || NOT_AREA_AVOID_RE.test(c)) return false;
  if (PAST_STAY_RE.test(c) && BAD_EXPERIENCE_RE.test(c)) return true;
  if (AREA_AVOID_RE.test(c)) return true;
  const m = c.match(PLACE_NG_RE);
  return !!m && !NOT_PLACE_RE.test(m[1]);
}

export type AreaExcludeExample = { conv: string; at: string; customer: string; staff: string; writer: "takeuchi" | "employee" };
export const AREA_EXCLUDE_EXAMPLES: ReadonlyArray<AreaExcludeExample> = [
  { conv: "721ff307-5ced-46bb-b33c-f5e9cc6bbe04", at: "2026-09-19", writer: "takeuchi",
    customer: "神崎川はすんでましたが 不便だったので汗",
    staff: "かしこまりました！！神崎川エリアを除いた地域から、〇〇さん達にオススメできる家賃9万円以内・ペット可・お2人でご入居可能なお部屋を新たにピックアップしてお送りさせて頂きます！！" },
  { conv: "ac34b364-e0f9-42e5-b071-d33333919a82", at: "2026-09-19", writer: "takeuchi",
    customer: "出来れば中央大通りより北側でお願いしたいです。ミナミ方面は、避けたいです。",
    staff: "かしこまりました！！中央大通りより北側で、ミナミ方面は除いたエリアで、〇〇さんにオススメ出来るお部屋引き続きお探しさせて頂きます😌！！" },
  { conv: "f5e92bc6", at: "2026-09-09", writer: "takeuchi",
    customer: "できれば大阪の市内付近でお願いいたします（京都・尼崎はNGで、、、)",
    staff: "かしこまりました😊！！大阪市内に絞らせて頂き、〇〇でオススメできるお部屋をピックアップさせて頂きます！！" },
];

/** 手本の選び（同じ会話・試験の元の会話は外す＝答えが漏れない） */
export function pickAreaExcludeExamples(conversationId: string | null | undefined, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): AreaExcludeExample[] {
  const ex = [String(conversationId ?? ""), ...String(env.BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV ?? "").split(",")].map((x) => x.trim()).filter(Boolean);
  return AREA_EXCLUDE_EXAMPLES.filter((e) => !ex.some((x) => e.conv === x || x.startsWith(e.conv) || e.conv.startsWith(x)));
}

/** ブレインの材料の文（当たらなければ空） */
export function areaExcludeBrainText(hit: boolean, examples: ReadonlyArray<AreaExcludeExample>): string {
  if (!hit) return "";
  const lines = examples.map((e, i) => `${i + 1}. お客様「${e.customer}」→ 竹内さん: ピックアップの約束（2段:pickup）「${e.staff}」`);
  // 2026-11-06 試験 area-read-on-1106: 読み方だけでは q008 が main と同じ 1/4（返信 3/4）。(a) と同じく一手（ピックアップの約束）を1組で渡す
  return `\n\n【読み方と一手の手本（物件を送った後の「〇〇は住んでいたが不便・〇〇は避けたい・〇〇はNG」）】
- 読み方: お客様はそのエリアを外したいと伝えている（「住んでいたが不便だった」のように避けたいと言わない言い方も同じ）＝条件の言い直し（そのエリアを除く）。感想・事情への相づちではない。
- 一手: 竹内さんは「〇〇エリアを除いた地域から…新たにピックアップしてお送りさせて頂きます」の約束を返す（物件の AIX【物件ピックアップした】の番で、送れる物件がまだ無い＝先に約束の返信・2段:pickup。turn_contract のこの依頼の道は約束 route=promise）。相づちだけの返信で終わらせない。
竹内さんの実送信（物件を送った後にエリアを外す言い直し 3番）: そのエリアを除いてピックアップする約束 3・相づちだけの返信 0。${lines.length ? `\n${lines.join("\n")}` : ""}
※ 決めるのはこの会話の事実（どのエリアか・送った物件のエリア）。`;
}
