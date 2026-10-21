// app/lib/brain-route-fix-1020.ts（純関数・DB/LLM なし）
// 2026-10-20 試験の道の外れ（見積・約束の後・不満→次の探し）の根の直し。10/21 から一部既定 on（下の「戻す」）。
//
// 道の外れと根（scripts/exam-brain.ts の q170・q177・q179・q182・q183・q184・録音の再生で同じ答えを見て確かめた）:
//   見積 estimate
//     ① 持ち込みの番の「何を聞いたか」（two-stage broughtPropertyAsk）を、物件の画像の読み取り（[画像] の行・SUUMO の画面のボタン
//        「最新の空室状況を知りたい」・資料の「空室／即入」）まで含めて読んでいた → 見積だけ頼んだ番も「空き＋費用（both）」になり、2段が確認（check）に（q183・q184）。
//        → お客様が打った文だけで読む（brought_text）。
//     ② 持ち込みで費用・見積だけを頼んだ番も2段は確認（brought_both＝kind check・後で AIX【物件確認した】）だった。竹内さんの実送信（q183・q184）は
//        「2件とも最大限割引した御見積書を作成しお送り」→ AIX【見積書送る】。→ 費用だけの番は見積の2段（brought_estimate）。空きも聞いた・言葉なしは今まで通り両方。
//     ③ ブレインが最後の aix を空にしたまま turn_contract の依頼を route=aix（見積書送る等）と書いた番は、AIX も2段も立たず、後の reconcile が依頼を約束に直す
//        ＝ただの返信になっていた（q184）。→ 2段の判定に渡す AIX をその依頼（先に答える依頼 lead_with を優先）から作る（contract_aix）。
//     ④ 主のお部屋への見積の依頼の信号（focused_estimate_request・本番 52件で次の AIX 見積書送る 47）は 10/13 から信号の家族ごと下げられ、ブレインの
//        物件確認した（空き状況の約束の直後の「初期費用等も出して」）が残って AIX 直接になっていた（q182）。→ この信号は下げない（focused_estimate）。
//   約束の後 promise
//     ⑤ 約束の依頼（route=promise）の答えが「確認させて頂きます」だけ（about=設備など）だと、promiseAixFromContract が確認と読まず2段が立たなかった（q177）
//        → 約束の答えに「確認」がある・about が物件の事実（設備・条件・空き）なら確認の約束（promise_check）。
//     ⑤b 確認の結果を返した直後（6時間以内）の追いの質問をブレインが確認の約束にした番は、答えがスタッフにしか分からない＝AIX【物件確認した】を直接（q177・P0「AIX と返信の分け方」・check_after_result）。
//     ⑥ 「内覧可否と募集状況を確認」の約束を果たす AIX を、内覧可否の語だけで【内覧調整】に替えていた（q179・結果は「募集に出ていない」）。
//        → 同じ約束に募集状況・空きの確認がある時は【物件確認した】のまま（viewing_check_vacancy）。
//   不満→次の探し concern
//     ⑦ 送った物件への不満（お風呂が狭い）にブレインのルール⑨（懸念→条件に変えた再ピックアップの宣言）があるのに、LLM が「浴室を確認してお伝え」の返信にした
//        （q170・avoid_topics に「新規物件ピックアップ」まで入れた）。→ customer_concern が物件の作り（広さ・設備・階・築年・駅・日当たり・騒音）で、
//        問いでなく、こちらが物件を送った後で、依頼が返信だけの時は、その依頼を探す約束（route=promise・about=search_condition）に直す（concern_repickup）。
//
// 2026-10-21 竹内さん B1「入れて良い」・B3「よい」・B5「よい」（設計知見 e2558968）: 既定で入る部分 = ROUTE_FIX_1020_DEFAULT_ON
//   （brought_text・brought_estimate・focused_estimate・promise_check・viewing_check_vacancy・concern_repickup）。
//   check_after_result は B4「質問内容による」で既定 off のまま・contract_aix は決定に無いので既定 off のまま。
// 戻す: BRAIN_ROUTE_FIX_1020=off で全部止める。一部だけ: BRAIN_ROUTE_FIX_1020=brought_text,brought_estimate,... ／ on で全部・
//   BRAIN_ROUTE_FIX_1020_<名前>=off で1つ止める（既定でも効く）

type Env = Record<string, string | undefined>;

export const ROUTE_FIX_1020_PARTS = [
  "brought_text", "brought_estimate", "contract_aix", "focused_estimate",
  "promise_check", "check_after_result", "viewing_check_vacancy", "concern_repickup",
] as const;
export type RouteFix1020Part = (typeof ROUTE_FIX_1020_PARTS)[number];
/** 10/21 竹内さんの決定で既定 on の部分（BRAIN_ROUTE_FIX_1020 を付けない時） */
export const ROUTE_FIX_1020_DEFAULT_ON: readonly RouteFix1020Part[] = [
  "brought_text", "brought_estimate", "focused_estimate", "promise_check", "viewing_check_vacancy", "concern_repickup",
];

export function routeFix1020(part: RouteFix1020Part, env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  const v = (env.BRAIN_ROUTE_FIX_1020 ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return false;
  if ((env[`BRAIN_ROUTE_FIX_1020_${part.toUpperCase()}`] ?? "").trim().toLowerCase() === "off") return false;
  if (!v || v === "default") return ROUTE_FIX_1020_DEFAULT_ON.includes(part);
  if (v === "on" || v === "all" || v === "1" || v === "true") return true;
  return v.split(",").map((s) => s.trim()).includes(part);
}

// ① 持ち込みの番の「お客様が打った文」（物件の画像の読み取り・URL だけの行を除く）
export function broughtTypedText(turnMsgs: readonly string[]): string {
  return turnMsgs
    .filter((t) => !/^\s*\[(?:画像|動画|ファイル|スタンプ)\]/.test(t))
    .map((t) => t.replace(/https?:\/\/\S+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

// ③ 最後の aix が空で、turn_contract の依頼が route=aix の時の AIX（lead_with を優先・無ければ AIX の依頼が1種類の時だけ）
export function contractAixWhenTopEmpty(tc: unknown, normalize: (k: unknown) => string | null): string | null {
  if (!tc || typeof tc !== "object") return null;
  const c = tc as { asks?: Array<{ route?: unknown; aix?: unknown }>; lead_with?: unknown; close_only?: unknown };
  if (c.close_only === true || c.close_only === "true") return null;
  const asks = Array.isArray(c.asks) ? c.asks : [];
  const keyOf = (a: { route?: unknown; aix?: unknown } | undefined) => (a?.route === "aix" ? normalize(String(a.aix ?? "").split("/")[0]) : null);
  const lw = c.lead_with;
  const lead = typeof lw === "number" ? asks[lw] : typeof lw === "string" && /^\d+$/.test(lw) ? asks[Number(lw)] : undefined;
  const leadKey = keyOf(lead);
  if (leadKey) return leadKey;
  const keys = [...new Set(asks.map(keyOf).filter((k): k is string => !!k))];
  return keys.length === 1 ? keys[0] : null;
}

// ⑤ 約束の依頼の答え「確認させて頂きます」・about が物件の事実 → 確認の約束
const CHECK_ABOUT = new Set(["property_equipment", "vacancy", "property_condition", "contract_terms", "move_in", "pet", "parking"]);
export function contractPromiseIsCheck(tc: unknown): boolean {
  if (!tc || typeof tc !== "object") return false;
  const c = tc as { asks?: Array<{ route?: unknown; answer?: unknown; about?: unknown }>; close_only?: unknown };
  if (c.close_only === true || c.close_only === "true") return false;
  return (Array.isArray(c.asks) ? c.asks : []).some((a) => a?.route === "promise"
    && !/ピックアップ|探し|探す|見積/.test(String(a?.answer ?? ""))
    && (/確認/.test(String(a?.answer ?? "")) || CHECK_ABOUT.has(String(a?.about ?? ""))));
}

// ⑥ 内覧可否の確認の約束に募集状況・空きの確認も入っている
export function viewingCheckAlsoVacancy(lastStaffText: string): boolean {
  return /募集状況|空き状況|空室状況|空室|空き(?:の)?確認|募集(?:中|して)/.test(lastStaffText);
}

// ⑦ 送った物件への不満（物件の作りの懸念・問いでない）→ 探す約束
const CONCERN_TOPICS = new Set(["広さ", "設備", "階数", "築年数", "駅距離", "日当たり", "騒音治安"]);
export type ConcernRepickupInput = {
  concern: { topic?: unknown; object?: unknown } | null | undefined;
  customerText: string;
  ackOnly: boolean;
  /** こちらが物件を送った（送付済み物件が1件以上） */
  propertiesSent: boolean;
  finalAix: string | null;
  decisionSource: string | null;
  postApply: boolean;
  tc: unknown;
};
export function concernRepickupTarget(i: ConcernRepickupInput): number | null {
  if (i.finalAix || i.decisionSource || i.postApply || i.ackOnly || !i.propertiesSent) return null;
  const topic = String(i.concern?.topic ?? "");
  if (!CONCERN_TOPICS.has(topic)) return null;
  if (/[?？]|ですか|ますか|でしょうか/.test(i.customerText)) return null;
  const tc = i.tc as { asks?: Array<{ route?: unknown; kind?: unknown }>; close_only?: unknown } | null;
  if (!tc || typeof tc !== "object" || tc.close_only === true || tc.close_only === "true") return null;
  const asks = Array.isArray(tc.asks) ? tc.asks : [];
  if (!asks.length || asks.some((a) => a?.route === "promise" || a?.route === "aix")) return null;
  const idx = asks.findIndex((a) => a?.kind === "concern" || a?.kind === "feeling" || a?.kind === "wish");
  return idx >= 0 ? idx : null;
}
/** 懸念の語から探す約束の答えの文（例: お風呂が狭い → お風呂広めのお部屋をピックアップしてお送り） */
export function concernRepickupAnswer(object: unknown): string {
  const o = String(object ?? "").trim();
  const m = o.match(/^(.{1,12}?)(?:が|は)?(狭い|狭く|小さい|古い|遠い|暗い|うるさい|高い|少ない|無い|ない)/);
  const flip: Record<string, string> = { 狭い: "広め", 狭く: "広め", 小さい: "広め", 古い: "築浅", 遠い: "駅近", 暗い: "日当たりの良い", うるさい: "静かな", 高い: "低め", 少ない: "多め", 無い: "付き", ない: "付き" };
  const cond = m ? `${m[1]}${flip[m[2]] ?? ""}` : o ? `${o}を解消できる` : "ご要望に合う";
  return `${cond}のお部屋を中心にご条件に合ったお部屋をピックアップしてお送りする`;
}

// ⑤b 確認の結果を返した直後の追いの質問（q177・P0「AIX と返信の分け方」）: 管理会社に確かめる事の答えはスタッフにしか分からない＝約束の返信でなく AIX【物件確認した】。
//   こちらの最後の文が確認の結果（「確認させて頂きました」「確認しましたところ」・「〜とのことでした」だけはお客様の話の引用もあるので数えない）で、その後 RESULT_FOLLOWUP_HOURS 時間以内の番だけ（スタッフが確認の窓口を開いている）
export const RESULT_FOLLOWUP_HOURS = 6;
const RESULT_REPORTED_RE = /確認(?:致し|いたし|させて(?:頂|いただ)き)?ましたところ|確認(?:が)?取れました|(?:確認|交渉|確認・交渉)させて(?:頂|いただ)きました|(?:募集中|空室|募集終了|募集が終了)(?:です|でした|となって)/;
export function lastStaffReportedResult(lastStaff: { text: string | null; at: string | null } | null, turnAt: string | null): boolean {
  if (!lastStaff?.text || !lastStaff.at || !turnAt) return false;
  const gap = Date.parse(turnAt) - Date.parse(lastStaff.at);
  if (!Number.isFinite(gap) || gap < 0 || gap > RESULT_FOLLOWUP_HOURS * 3600_000) return false;
  return RESULT_REPORTED_RE.test(lastStaff.text.normalize("NFKC"));
}
// ⑤b の除外（10/20 査読・本番 30日の当たり候補の目視）: 新しい物件の持ち込み（URL・画像）・別のお部屋の空き／募集の問いは、
//   スタッフも「確認させて頂きます」の約束の返信→後で AIX にしていた（96c140e4・fecda03f・1191b1eb・f9ec0b0d）＝結果の追いの質問ではない
export function checkAfterResultTurnOk(turnText: string, hasImage: boolean): boolean {
  if (hasImage) return false;
  const t = String(turnText ?? "").normalize("NFKC");
  if (/https?:\/\//.test(t) || /^\s*\[(?:画像|ファイル)\]/m.test(t)) return false;
  // お部屋の空きだけ外す（q177「駐車場の空きは軽専用…」は結果の追いの質問のまま）
  return !/空室|募集|退去予定|(?:部屋|号室|階|物件|ここ|こちら)[^。\n？?]{0,8}(?:空いて|空き)/.test(t);
}
