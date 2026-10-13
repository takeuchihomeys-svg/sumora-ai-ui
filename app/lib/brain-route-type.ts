// app/lib/brain-route-type.ts — 返信か・2段（約束の返信→後で AIX）か・AIX か の「竹内さんの使い分け」をブレインの材料にする（純関数・DB も fetch も LLM も持たない）
//
// 2026-10-14 竹内さん（10/13）「実際の竹内の LINE の判断ができるようにブレインの判断基準の部分も強化する」「ちゃんと AIX か返信か分別できる必要がある」。
//   答えを書く規則ではなく、竹内さんの使い分けの材料（型ごとの実際の数・見分け方）と判断の手本（竹内さんの実送信）を渡して、ブレインに決めさせる（P0 9eb6aa9c）。
//   ・型（routeTypeOf）は語で拾う「候補の網」。決めるのはブレイン（材料の言い方も「この型なら〇〇」ではなく「竹内さんは〇〇が多い・見分けは〇〇」）。
//   ・物差しは竹内さんの実送信（3b508208・22802738）＝数と手本は staff_writer=takeuchi の番だけ（scripts/brain-route-type-build.ts → brain-route-type-data.ts）。
//   ・見分けの軸は P0 ca55d42b・4b744a33: スタッフだけが知る事（確認の結果・空き・金額・内覧の日程の確定）は AIX、まだ手元に無ければ約束の返信（2段）、
//     会話・資料・会社の事実で答えられる事・お礼・了承・時刻の変更・遅刻・延期は返信。決まっている事を答えるのは返信（c646f0d4）。
//   測った事（30日 839番・scripts/audit-split-reply-aix.ts）: ブレインの AIX 62%・AIX の番で人が文で済ませた 126・文の後で同じ AIX 132。
//     型ごとの竹内さんの並びは brain-route-type-data.ts の ROUTE_TYPE_STATS（作る時の数）。
//   置き場所: ブレインの材料の「毎回変わる並び」（judgeExamplesText の隣・キャッシュの印の無い所）＝system と会話専用ブロックのキャッシュは変えない。
// 既定 off（試験で下がる側・routeTypeMaterialEnabled の注記）。入れる: BRAIN_ROUTE_TYPE_MATERIAL=on／手本だけ外す BRAIN_ROUTE_TYPE_EXAMPLES=off
import { contentSim, textFingerprint, textSim } from "./brain-judge-examples";

export type RouteType =
  | "arrived" | "late" | "postpone_cancel" | "phone_arrange" | "time_change" | "considering" | "decided_elsewhere"
  | "apply_intent" | "negotiation" | "brought_property" | "vacancy_question" | "screening_question" | "cost_question"
  | "equipment_question" | "estimate_request" | "other_property" | "condition_feedback" | "viewing_wish"
  | "ack_after_promise" | "ack_after_viewing_setup" | "ack_other" | "other_question";

export const ROUTE_TYPE_JA: Record<RouteType, string> = {
  arrived: "当日・着いた", late: "遅刻の連絡", postpone_cancel: "延期・取りやめ", phone_arrange: "電話の段取り", time_change: "時刻の変更",
  considering: "検討中", decided_elsewhere: "決まった報告", apply_intent: "申込の意思", negotiation: "交渉の依頼", brought_property: "物件の持ち込み",
  vacancy_question: "空き・内覧可否の問い", screening_question: "審査・保証の問い", cost_question: "費用の問い", equipment_question: "設備・入居の問い",
  estimate_request: "見積の依頼", other_property: "他の物件・探す依頼", condition_feedback: "条件・物件への感想", viewing_wish: "内覧の希望・日程",
  ack_after_promise: "受けだけ（約束の後）", ack_after_viewing_setup: "受けだけ（内覧の段取りの後）", ack_other: "受けだけ（その他）", other_question: "その他の問い",
};

/** 見分け方（P0 ca55d42b・4b744a33・c646f0d4 と竹内さんの実送信を読んで書いた・答えではなく材料） */
export const ROUTE_TYPE_GUIDE: Record<RouteType, string> = {
  arrived: "現地・当日の連絡。返信で受ける。内覧の後のお礼（AIX【挨拶→内覧後】）は内覧が終わってからスタッフが出す物で、この発言への答えではない",
  late: "遅れる・向かっているの連絡。返信で受ける（「かしこまりました！！お気をつけてお越しください😌！！」）。AIX にしない",
  postpone_cancel: "内覧・お部屋探しの延期・取りやめ・体調不良。返信で受けて待つ。お客様が別日・他の物件を頼んでいない時は内覧調整・物件の AIX・探す約束にしない",
  phone_arrange: "電話の時間の段取り。返信で受ける（「〇時頃のお電話お待ちしております」）。スタッフの電話できる時間を出す時だけその時間を書く",
  time_change: "もう決まっている内覧・待ち合わせの時刻を変えたい。新しい時刻を受ける・その時刻で行けるかの一言は返信。スタッフの空きから新しい候補日を出し直す時だけ AIX【内覧調整】",
  considering: "検討します・確認してみます。返信で閉じる（ごゆっくりご検討…）。次の物件の AIX・申込へにしない",
  decided_elsewhere: "他で決まった・もう大丈夫。返信で閉じる",
  apply_intent: "申込の意思。申込の手続きは AIX【申込へ】。竹内さんは先に「お申込させて頂きます」と返信し、何号室か等を聞いてから申込へを押す番も多い（申込の前の質問・迷いだけなら返信）",
  negotiation: "礼金・家賃などの交渉の依頼。交渉の結果はスタッフだけが知る事＝まだ交渉の約束をしていなければ約束の返信（2段）、結果が出たら AIX【確認した→交渉】",
  brought_property: "お客様が物件（URL・画像）を送ってきた。募集状況・最大限割引の金額はスタッフだけが知る事＝まだ確認の約束をしていなければ約束の返信（2段）、結果が出たら AIX【物件確認した】",
  vacancy_question: "空き・内覧できるかの問い。確認しないと分からない事はまだ約束していなければ確認の約束（2段）→結果は AIX。会話・資料で分かる事（退去前で室内は見られない 等）は返信で答える",
  screening_question: "審査・保証会社の問い。一般的な事・会話や資料で分かる事は返信で答える。その物件の保証会社をスタッフが確かめる事だけ確認の約束（2段）",
  cost_question: "費用の問い。送った御見積書・資料・会社の事実で答えられる事（合計に駐車場代が別か・2,980円の仕組み 等）は返信で答える。まだ無い金額を出す時は御見積書の約束（2段）→ AIX【見積書送る】",
  equipment_question: "設備・入居日の問い。資料・会話にある事は返信で答える。無い事だけ確認の約束（2段）",
  estimate_request: "見積の依頼。御見積書を作る前は約束の返信（2段）、作れたら AIX【見積書送る】",
  other_property: "他の物件・もっと探しての依頼。竹内さんはまず（新しい条件で）ピックアップしてお送りする約束（2段）。物件の AIX はピックアップした後",
  condition_feedback: "条件の言い直し・物件への感想（狭い・高い・〇〇が欲しい）。竹内さんはまず新しい条件でピックアップしてお送りする約束（2段）。物件の AIX はピックアップした後",
  viewing_wish: "内覧の希望・日程。今見られる部屋の候補日を出すのは AIX【内覧調整】、候補を選んだら AIX【待ち合わせ場所】。お客様が出された時間の枠で時刻を決めただけ・行き先が未定なら返信で受ける",
  ack_after_promise: "こちらが約束（確認・探す・見積）した直後のお礼・了承だけ。竹内さんの多くは返信せず、後で約束を果たす AIX（物件・見積書・確認の結果）で応える。約束の言い直しの返信は書かない",
  ack_after_viewing_setup: "内覧の日時・待ち合わせを送った後のお礼・了承だけ。短い返信で受ける（「本日何卒よろしくお願い致します」）か何もしない。内覧の挨拶の AIX は当日の朝・内覧の後にスタッフが時刻で出す物で、この発言への答えではない",
  ack_other: "お礼・了承だけ。答える中身が無い＝短い返信で閉じるか、次の一手（物件の AIX 等）がもう決まっている時だけ AIX",
  other_question: "会話・資料・会社の事実で答えられる問いは返信で答える。スタッフが確かめないと分からない事だけ確認の約束（2段）",
};

const N = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");
const Q = /[?？]|ますか|ですか|でしょうか|って感じ|いくら|ますかね|ですかね/;
const PROPERTY_SHARE = /https?:\/\/|by SUUMO|^\s*\[画像\]/m;

/**
 * 今のお客様の発言の型（候補の網・語で拾う）。決めるのはブレイン。拾えない番は null（材料を出さない）
 *   ackOnly はブレインの isAckOnlyTurn（お礼・了承だけ）を渡す
 */
export function routeTypeOf(i: { customerText: string | null | undefined; prevStaffText?: string | null; ackOnly?: boolean }): RouteType | null {
  const c = N(i.customerText).trim();
  if (!c) return null;
  const prev = N(i.prevStaffText);
  if (/着きました|到着しました|今(?:向かって|から向かい)|もうすぐ着|着きます/.test(c)) return "arrived";
  if (/遅れ(?:ます|そう|て)|遅刻|少し遅く|分ほど遅|ギリギリ/.test(c)) return "late";
  // 物件の画面・URL は先に（画面の文字「条件を変更する」「内見予約」「初期費用」で他の型に入れない）
  if (PROPERTY_SHARE.test(c)) return "brought_property";
  if (/延期|別日|キャンセル|取りやめ|取り止め|見送|インフル|体調(?:崩|不良|が悪)|一旦なし|また(?:年明け|落ち着いたら)/.test(c)) return "postpone_cancel";
  if (/電話/.test(c)) return "phone_arrange";
  if (/(?:変更|ずら|遅らせ|早め)/.test(c) && /(?:\d{1,2}\s*[:：時]|午前|午後|夕方|明日|\d{1,2}日)/.test(c)) return "time_change";
  if (/他で決ま|決まりました|決まったので|もう大丈夫です/.test(c)) return "decided_elsewhere";
  if (/検討(?:して|させ|します)|考えさせ|考えます|悩んで(?:い|ます)|相談して(?:み|から)|確認してみます|確認いたします|確認します/.test(c) && !Q.test(c)) return "considering";
  // 申込の時期・流れの質問（いつ頃申し込めば・何日前から）は申込の意思でなく問い
  if (/申込(?:み)?(?:たい|します|お願い|進め|させて)|申し込(?:みたい|みます|んで(?:も|ください|ほし)|みをお願い|みさせて)|審査(?:を)?(?:出して|かけて|お願い)|(?:抑え|押さえ)(?:たい|てほし|て欲し|てください)|ここにします|で決めよう|で決めます/.test(c)
    && !/いつ(?:頃|ごろ|まで|から)?|何日前|までに|どのくらい/.test(c)) return "apply_intent";
  if (/交渉|値下|下げ(?:て|られ|る)|安く(?:なり|でき|して)|フリーレント/.test(c)) return "negotiation";
  if (Q.test(c) && /募集(?:して|中)|空いて|空き|まだ(?:あり|ある|残)|埋ま|内[覧見](?:でき|出来|可能|は)/.test(c)) return "vacancy_question";
  if (Q.test(c) && /保証会社|保証人|審査|通り(?:ます|そう)|年収|勤続|学生|未成年|ブラック|夜職|滞納/.test(c)) return "screening_question";
  if (Q.test(c) && /円|費用|初期|家賃|管理費|共益費|敷金|礼金|保証料|仲介|手数料|駐車場/.test(c)) return "cost_question";
  if (Q.test(c) && /ペット|設備|駐車|バイク|ネット|オートロック|エアコン|帖|日当|騒音|入居(?:日|可能|時期)|退去/.test(c)) return "equipment_question";
  if (/見積/.test(c)) return "estimate_request";
  if (/他の(?:物件|お部屋|部屋)|ほかの|違う物件|別の(?:物件|部屋)|もう少し(?:探|他)|探して(?:頂|いただ|ほし|欲し)|紹介して|ありませんか|ないでしょうか|ないですか/.test(c)) return "other_property";
  if (i.ackOnly) {
    if (/確認(?:させ|し)|お送り(?:させ|し)|ピックアップ|探させ|出次第|出来次第|でき次第|交渉/.test(prev)) return "ack_after_promise";
    if (/ご案内|待ち合わせ|お待ち合わせ|内覧|現地|お気をつけ/.test(prev)) return "ack_after_viewing_setup";
    return "ack_other";
  }
  if (/条件|エリア|間取り|予算|駅|徒歩|㎡|帖|1K|1LDK|1DK|2LDK|ペット|希望|欲しい|がいい|が良い|狭い|広い|高い|安い/.test(c)) return "condition_feedback";
  if (/内[覧見]|見学|案内|日程|何時|何日|土曜|日曜|平日|\d{1,2}\s*時/.test(c)) return "viewing_wish";
  if (Q.test(c)) return "other_question";
  return null;
}

/** 型ごとの竹内さんの実際の数（作る時に数えた物） */
export type RouteTypeStat = { n: number; reply: number; promise: number; aix: number };
/** 竹内さんの実送信の手本（伏せた） */
export type RouteExample = {
  conv: string; at: string; type: RouteType;
  /** お客様の発言（伏せた・最大120字） */
  customer: string;
  /** 直前のこちらの文の終わり（伏せた・最大60字） */
  prev: string;
  /** 竹内さんの一手（返信／返信→後で AIX【…】／約束の返信（確認・探す・見積・撮影）／AIX【…】） */
  actual: string;
  /** 竹内さんの文の頭（伏せた・最大70字・AIX だけの番は空） */
  staff: string;
  /** 元の会話の指紋（番より前のお客様の発言の最初の4通＋直前の20通） */
  fp?: string[];
};

/**
 * 2026-10-14 既定 off（入れる: BRAIN_ROUTE_TYPE_MATERIAL=on）。試験（DeepSeek・関係する6型 54答案・1回ずつ）で道の合格が
 *   材料なし 39・39（2回）→ 材料あり 35（手本・近さの下限なし）・37（手本・近さ 0.15）・36（手本なし）＝どれも揺れの幅の中で下がる側。
 *   AIX の言い過ぎ（返信の問題で AIX）も 6・7 → 9・9・7。直った番（q011 q014 q050 q057）より崩れた番（q022 q055 q056 q141 等）が多く、
 *   型の網が粗い（内覧の希望で「時刻だけ決めた・行き先未定」と「日時を選んだ」が同じ型）・手本が別の道を見せる、が原因の見込み。最後の Claude の確かめは dept_line_reply.md 10/14
 */
export function routeTypeMaterialEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_ROUTE_TYPE_MATERIAL ?? "").trim().toLowerCase() === "on";
}
export function routeTypeExamplesEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return routeTypeMaterialEnabled(env) && (env.BRAIN_ROUTE_TYPE_EXAMPLES ?? "").trim().toLowerCase() !== "off";
}

/** 手本の近さの下限（中身の2文字の組の Jaccard）。戻す・変える: BRAIN_ROUTE_EXAMPLES_MIN_SIM */
export const ROUTE_EXAMPLE_MIN_SIM = Number((typeof process !== "undefined" ? process.env.BRAIN_ROUTE_EXAMPLES_MIN_SIM : "") || 0.15);

const routeOfActual = (a: string) => (a.startsWith("返信→") ? "返信→AIX" : a.startsWith("返信") ? "返信" : a.startsWith("約束") ? "約束" : "AIX");

/**
 * 今の番に入れる手本（同じ型・最大 max 件）。同じ会話・この会話に既に出ている発言の番は外す（試験の写しで答えが漏れない）。
 *   並べ方: 中身の近さ＋新しさ。同じ道（返信・約束・AIX）は2件まで＝竹内さんの使い分けの対比が見える
 */
export function pickRouteExamples(all: ReadonlyArray<RouteExample>, ctx: {
  type: RouteType; customerText: string; conversationId?: string | null; historyCustomerTexts?: ReadonlyArray<string>; max?: number; excludeConversationIds?: ReadonlyArray<string>;
  /** 直前のこちらの文（お礼・了承だけの型は、発言でなく直前のこちらの文の近さで選ぶ） */ prevStaffText?: string | null; minSim?: number;
}): RouteExample[] {
  const text = String(ctx.customerText ?? "").trim();
  if (!text) return [];
  const hist = ctx.historyCustomerTexts ?? [];
  const histFp = new Set(hist.map(textFingerprint).filter((x): x is string => !!x));
  const envEx = new Set((typeof process !== "undefined" ? process.env.BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV ?? "" : "").split(",").map((x) => x.trim()).filter(Boolean));
  const ex = new Set([...(ctx.excludeConversationIds ?? []), ...envEx]);
  const seen = (e: RouteExample) => (e.fp?.some((f) => histFp.has(f)) ?? false)
    || (N(e.customer).length >= 6 && hist.some((h) => N(h).length >= 6 && textSim(e.customer, h) >= 0.6));
  const pool = all.filter((e) => e.type === ctx.type && e.conv !== ctx.conversationId && !ex.has(e.conv) && !seen(e));
  if (!pool.length) return [];
  const newest = Math.max(...pool.map((e) => Date.parse(e.at) || 0));
  // 10/14 試験（route1014-after-a）: 近さの無い手本（0.00〜0.05）も入り、別の道の手本が判断をずらした（q062 q141）→ 近い手本だけ。
  //   お礼・了承だけの型は発言がどれも同じ（近さ 1.0）＝直前のこちらの文の近さで選ぶ
  const ackType = /^ack_/.test(ctx.type);
  const minSim = ctx.minSim ?? ROUTE_EXAMPLE_MIN_SIM;
  const simOf = (e: RouteExample) => (ackType ? contentSim(String(ctx.prevStaffText ?? ""), e.prev) : contentSim(text, e.customer));
  const scored = pool.map((e) => ({ e, sim: simOf(e) })).filter((x) => x.sim >= minSim)
    .map(({ e, sim }) => ({ e, s: sim + Math.max(0, 0.03 - Math.max(0, (newest - (Date.parse(e.at) || 0)) / 86_400_000) * 0.001) }))
    .sort((a, b) => b.s - a.s || Date.parse(b.e.at) - Date.parse(a.e.at));
  const max = ctx.max ?? 3;
  const out: RouteExample[] = [];
  const perRoute = new Map<string, number>();
  for (const { e } of scored) {
    const r = routeOfActual(e.actual);
    if ((perRoute.get(r) ?? 0) >= 2) continue;
    perRoute.set(r, (perRoute.get(r) ?? 0) + 1);
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

/** 数の1行（無い・少ない時は空）。少ない型（5番未満）は数を出さない＝見分け方だけ */
export function routeStatLine(st: RouteTypeStat | undefined): string {
  if (!st || st.n < 5) return "";
  return `竹内さんの実際（竹内さんが送った ${st.n}番・最初の一手）: 返信 ${st.reply}・約束の返信（2段）${st.promise}・AIX ${st.aix}`;
}

/** ブレインの材料の文（型が無ければ空） */
export function routeTypeBrainText(type: RouteType | null, o: { stats?: Partial<Record<RouteType, RouteTypeStat>>; examples?: ReadonlyArray<RouteExample> } = {}): string {
  if (!type) return "";
  const stat = routeStatLine(o.stats?.[type]);
  const ex = o.examples ?? [];
  const exLines = ex.map((e, i) => `${i + 1}. こちら「…${e.prev || "-"}」→ お客様「${e.customer}」\n   竹内さん: ${e.actual}${e.staff ? `「${e.staff}」` : ""}`);
  return `\n\n【返信か AIX かの材料（今の発言の型の候補: ${ROUTE_TYPE_JA[type]}・語で拾った候補＝型が違えば使わない）】
見分け: ${ROUTE_TYPE_GUIDE[type]}${stat ? `\n${stat}` : ""}${exLines.length ? `\n竹内さんの実送信（同じ型）:\n${exLines.join("\n")}` : ""}
※ 決めるのはこの会話の事実（台帳・送った物・約束の有無・段階）。スタッフだけが知る事を送る番だけ AIX、まだ手元に無ければ約束の返信、会話・資料・会社の事実で足りる番・お礼や連絡を受けるだけの番は返信。`;
}
