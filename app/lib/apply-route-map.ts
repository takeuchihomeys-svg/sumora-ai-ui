// app/lib/apply-route-map.ts — 問い合わせから申込までの地図（本線＋分かれ道）と、今どこにいるかを決める純関数（DB も fetch も LLM も持たない）
//
// 2026-10-20 竹内さん（設計知見 55bf37b6「申込までの地図」・9d41ce71「場面の狙い」・98bca000/e07a8b73「つなぎのブレイン」）:
//   「ブレインは問い合わせからゴールまで基本の流れとかは分かっていて、基本プラス応用で別ルートに行っても申込までのルートをちゃんと分かるようになっているのかな？」
//   今あるのは段階（customer-state の12段階・brain-stage の5段階）だけ。地図（本線・分かれ道の意味・次の一手・本線への戻り方）が無い。
//   ここはその地図をデータで持ち、既に計算済みの合図（customer-state・行動台帳・発言の型・場面の証拠・お客様の事情）から
//   「今どこ・申込へ向けた次の一手・開いている分かれ道」を決める（段1・決定論）。LINE のブレイン・AIX・つなぎのブレインが同じ物を読む芯。
//
// ── 線（P0 9eb6aa9c「判断はすべてブレイン基準」）──
//   位置は「候補の網」。どう返すか・AIX をどれにするかはブレインが決める（材料の文にもそう書く）。
//   合図は作り直さない: 段階＝customer-state.resolveCustomerState・約束＝action-ledger の facts・発言の型＝brain-route-type.routeTypeOf・
//   場面＝aix-scene-evidence・すぐ来られない＝customer-circumstances.holdFirstReason・他社で内覧＝other-agent-viewing・番手＝parallel-second.latestRankMention（申込んだ／案内を分ける）と2番手で申込中の1つの判定（post-apply.judgeParallelSecond）。
//   この表に無い分かれ道（相見積もり・入居時期が先）だけ、ここで小さな語の網を持つ（COMPETING_ESTIMATE_RE・MOVE_IN_LATER_RE）。
//
// ── ブレインへの渡し方 ──
//   applyRouteMapEnabled()（APPLY_ROUTE_MAP=on の時だけ・既定 off）。置き場所は brain-core の毎回変わる並び（キャッシュの印の無い user の最後のブロック）。
//   off の時は空文字＝プロンプトは1バイトも変わらない（app/lib/__tests__/apply-route-map.test.ts）。
import type { CustomerStage, SearchingMark } from "./customer-state";
import type { LedgerFacts } from "./action-ledger";
import type { RouteType } from "./brain-route-type";
import type { SceneId } from "./aix-scene-evidence";
import { isOtherAgentViewingApplyQuestion, isOtherAgentViewingPlan } from "./other-agent-viewing";
import { latestRankMention } from "./parallel-second";

const N = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");

// ═════════════════════════════════════════════════════════════════════════════
// 地図（データ）
// ═════════════════════════════════════════════════════════════════════════════

/** 本線の駅（申込へ向かう順） */
export type RouteNodeId =
  | "inquiry" | "hearing" | "pickup" | "proposing" | "interested" | "estimate"
  | "viewing_arrange" | "viewing_scheduled" | "viewed" | "apply_prep" | "applying" | "won";

/** 場面の狙い（9d41ce71 の一覧の言葉） */
export type SceneAim = "信用を頂く" | "条件を聞き出す" | "比べて選んでもらう" | "申込へ誘う" | "不安を解く" | "関係をつなぐ" | "断りを受け止める";

export type RouteStep = {
  /** 申込へ向けた次の一手（日本語・短く） */
  label: string;
  /** その一手に合う AIX（aix_type/ピッカー）。空＝返信・約束の返信で進める */
  aix: string[];
};

export type RouteNode = {
  id: RouteNodeId;
  name: string;
  aim: SceneAim[];
  /** この駅にいると分かるお客様・こちらの合図（説明用） */
  signals: string;
  next: RouteStep;
  /** 本線で次の駅 */
  nextNode: RouteNodeId | null;
};

export const ROUTE_NODES: Record<RouteNodeId, RouteNode> = {
  inquiry: { id: "inquiry", name: "問い合わせ", aim: ["信用を頂く", "条件を聞き出す"], signals: "初めての連絡・こちらはまだ何も送っていない",
    next: { label: "ご挨拶と希望条件のヒアリング", aix: ["condition_hearing"] }, nextNode: "hearing" },
  hearing: { id: "hearing", name: "条件ヒアリング", aim: ["条件を聞き出す", "信用を頂く"], signals: "条件のやり取り中・物件はまだ送っていない・探す約束もまだ",
    next: { label: "条件がそろったらピックアップしてお送りする（約束の返信→物件ピックアップした）", aix: ["property_send"] }, nextNode: "pickup" },
  pickup: { id: "pickup", name: "物件ピックアップ", aim: ["信用を頂く"], signals: "ピックアップしてお送りすると約束した（まだ送っていない）",
    next: { label: "約束どおり物件をピックアップしてお送りする", aix: ["property_send"] }, nextNode: "proposing" },
  proposing: { id: "proposing", name: "物件の提案（反応待ち）", aim: ["比べて選んでもらう"], signals: "物件を送った・お客様の反応待ち",
    next: { label: "気になるお部屋を伺い、募集状況の確認・見積へ", aix: ["property_check_result", "property_recommendation"] }, nextNode: "interested" },
  interested: { id: "interested", name: "気に入った物件あり", aim: ["申込へ誘う", "比べて選んでもらう"], signals: "確認の結果を報告した・送った物件への言及・お客様の共有",
    next: { label: "最大限割引の御見積書をお送りする", aix: ["estimate_sheet"] }, nextNode: "estimate" },
  estimate: { id: "estimate", name: "見積", aim: ["申込へ誘う"], signals: "御見積書を送った",
    next: { label: "ご内覧のご案内（候補日）", aix: ["viewing_invite"] }, nextNode: "viewing_arrange" },
  viewing_arrange: { id: "viewing_arrange", name: "内覧調整", aim: ["申込へ誘う"], signals: "内覧を打診した・お客様が内覧を希望・日時はまだ",
    next: { label: "日時を決めて待ち合わせ場所をお送りする", aix: ["viewing_invite", "meeting_place"] }, nextNode: "viewing_scheduled" },
  viewing_scheduled: { id: "viewing_scheduled", name: "内覧予定", aim: ["信用を頂く"], signals: "内覧の日時が決まっている",
    next: { label: "当日のご挨拶で確実にご来場頂く", aix: ["greeting_viewing"] }, nextNode: "viewed" },
  viewed: { id: "viewed", name: "内覧後", aim: ["申込へ誘う"], signals: "内覧が済んだ（内覧後のお礼）",
    next: { label: "気に入ったお部屋はお申込みでお部屋を抑える", aix: ["application_push"] }, nextNode: "apply_prep" },
  apply_prep: { id: "apply_prep", name: "申込準備", aim: ["申込へ誘う", "不安を解く"], signals: "申込のフォーマットを送った／フォームが届いた",
    next: { label: "フォーマットと本人確認書類（裏表）を揃えて頂き申込", aix: ["application_push"] }, nextNode: "applying" },
  applying: { id: "applying", name: "申込・審査", aim: ["不安を解く", "関係をつなぐ"], signals: "状態が申込以降（審査中）",
    next: { label: "（ゴール到達）審査の進み具合をお伝えする", aix: [] }, nextNode: "won" },
  won: { id: "won", name: "成約", aim: ["関係をつなぐ"], signals: "成約", next: { label: "（ゴールの先）", aix: [] }, nextNode: null },
};

export const MAIN_ROUTE: readonly RouteNodeId[] = ["inquiry", "hearing", "pickup", "proposing", "interested", "estimate", "viewing_arrange", "viewing_scheduled", "viewed", "apply_prep", "applying"];

/** 分かれ道 */
export type RouteBranchId =
  | "brought_property" | "other_agent_viewing" | "competing_estimate" | "screening_concern" | "condition_change"
  | "negotiation" | "cannot_come_soon" | "move_in_later" | "rank_waiting" | "rank_offered" | "considering" | "new_arrival_wait"
  | "silent" | "postponed" | "declined";

export type RouteBranch = {
  id: RouteBranchId;
  name: string;
  /** その分かれ道の意味 */
  meaning: string;
  aim: SceneAim[];
  next: RouteStep;
  /** 本線への戻り方（どの駅へ・何をすれば戻るか） */
  wayBack: { to: RouteNodeId | null; how: string };
};

export const ROUTE_BRANCHES: Record<RouteBranchId, RouteBranch> = {
  brought_property: { id: "brought_property", name: "他社物件の持ち込み", meaning: "お客様が自分で見つけた物件（URL・画像）を送ってきた", aim: ["信用を頂く"],
    next: { label: "募集状況の確認の約束→結果を物件確認したで", aix: ["property_check_result"] },
    wayBack: { to: "interested", how: "募集中なら最大限割引の御見積書へ（気に入った物件ありに戻る）" } },
  other_agent_viewing: { id: "other_agent_viewing", name: "他社で内覧", meaning: "他社で内覧する／した物件の話（内覧はどこでもでき、申込は決めた会社でする）", aim: ["信用を頂く"],
    next: { label: "スモラで申込できると即答し、弊社でもご内覧できる旨を伝える", aix: [] },
    wayBack: { to: "viewing_arrange", how: "弊社での内覧の調整、または気に入ればそのまま弊社で申込（申込準備へ）" } },
  competing_estimate: { id: "competing_estimate", name: "相見積もり", meaning: "他社の見積と比べている", aim: ["比べて選んでもらう"],
    // 10/20 竹内さんの決定（87ff68e1）: 物件確認した ではなく、他社より抑えた見積の約束と申込への背中押し
    next: { label: "他社より抑えた見積の約束と申込への背中押し（見積ができたら御見積書）", aix: ["estimate_sheet"] },
    wayBack: { to: "estimate", how: "抑えた見積で決めて頂き、内覧へ" } },
  screening_concern: { id: "screening_concern", name: "審査の相談", meaning: "審査・保証会社・保証人の不安や問い", aim: ["不安を解く"],
    // 10/20 竹内さんの決定（a0c5ecf0・84519320）: 物件の審査の見込み→AIX【保証会社について】／名義・職業・保証人等の相談→確認の約束の後 AIX【管理会社に確認した→審査について（ご相談）】
    next: { label: "保証会社の説明と、通るまでサポートする旨（物件の審査の見込み→保証会社について／名義・職業などの相談→確認の後 審査について（ご相談））", aix: ["guarantor_info", "property_check_result"] },
    wayBack: { to: "apply_prep", how: "気に入ったお部屋ならまず審査をかけてみる（申込へ）" } },
  condition_change: { id: "condition_change", name: "条件変更", meaning: "条件の言い直し・物件への感想・別の物件の依頼", aim: ["条件を聞き出す"],
    next: { label: "新しい条件でピックアップしてお送りする（約束の返信→物件ピックアップした）", aix: ["property_send"] },
    wayBack: { to: "pickup", how: "新しい条件で物件を送り、提案に戻る" } },
  negotiation: { id: "negotiation", name: "交渉", meaning: "礼金・家賃などの交渉の依頼", aim: ["申込へ誘う"],
    next: { label: "交渉の約束→結果を確認した（交渉）で", aix: ["property_check_result"] },
    wayBack: { to: "apply_prep", how: "交渉の結果でお申込みへ" } },
  cannot_come_soon: { id: "cannot_come_soon", name: "すぐ来られない", meaning: "遠方・内覧に来られるのが先・予定が詰まっている", aim: ["申込へ誘う"],
    next: { label: "お申込みでお部屋を抑えた状態でのご内覧を提案（オンライン内見・撮影も）", aix: ["application_push"] },
    wayBack: { to: "apply_prep", how: "申込で抑えてから内覧" } },
  move_in_later: { id: "move_in_later", name: "入居時期が先", meaning: "入居・引越しの時期がまだ先", aim: ["関係をつなぐ"],
    next: { label: "申込の時期を逆算して伝え、再開の時期を約束する", aix: [] },
    wayBack: { to: "pickup", how: "約束した時期に条件の確認とピックアップを再開" } },
  // 2026-10-21 番手を2つに分けた（旧 rank_waiting は案内「2番手でのお申込可能」「お気に召されましたら2番手で…」にも当たり、申込んだ後に「番手での申込」を勧めていた）
  rank_offered: { id: "rank_offered", name: "申込が入っていた・番手のご案内", meaning: "先に申込が入っている物件で、番手（2番手以降）での申込をご案内した（まだ申込んでいない）", aim: ["申込へ誘う", "関係をつなぐ"],
    next: { label: "番手で申込んでお部屋を抑え並行して探すか、代わりの好条件のお部屋をお送りする", aix: ["application_push", "property_recommendation"] },
    wayBack: { to: "apply_prep", how: "番手で申込（申込準備へ）、または代わりの物件で提案に戻る" } },
  rank_waiting: { id: "rank_waiting", name: "番手で申込中", meaning: "2番手以降で申込んで繰り上がりを待っている（並行して探す）", aim: ["関係をつなぐ"],
    next: { label: "繰り上がりの結果は分かり次第お伝えし、並行して代わりの好条件のお部屋をお送りする", aix: ["property_recommendation"] },
    wayBack: { to: "applying", how: "繰り上がれば申込・審査へ、取れなければ代わりの物件で提案に戻る" } },
  considering: { id: "considering", name: "検討・保留", meaning: "検討します・家族と相談・確認してみます", aim: ["関係をつなぐ"],
    next: { label: "受け止めて締める（必要なら柔らかい次の一手を1文）", aix: [] },
    wayBack: { to: null, how: "お客様の反応で、見積・内覧・申込のいずれかへ" } },
  new_arrival_wait: { id: "new_arrival_wait", name: "新着待ち", meaning: "条件に合う物件を出し切り、新着が出次第お送りする約束", aim: ["関係をつなぐ"],
    next: { label: "新着が出たら物件オススメで1件お送りする", aix: ["property_recommendation"] },
    wayBack: { to: "proposing", how: "新着を送って提案に戻る" } },
  silent: { id: "silent", name: "音信不通", meaning: "こちらが送った後、お客様の返事が7日以上無い", aim: ["関係をつなぐ"],
    next: { label: "追客（新着・状況の確認）で会話を起こす", aix: ["followup_revive", "property_recommendation"] },
    wayBack: { to: null, how: "反応があった時の段階へ戻る" } },
  postponed: { id: "postponed", name: "延期・取りやめ", meaning: "内覧・お部屋探しの延期・体調不良・一旦なし", aim: ["断りを受け止める", "関係をつなぐ"],
    next: { label: "受け止めて待つ（再開の時期を伺えれば約束に）", aix: [] },
    wayBack: { to: "hearing", how: "再開の連絡で条件の確認から" } },
  declined: { id: "declined", name: "見送り・他社決定", meaning: "他で決まった・もう大丈夫", aim: ["断りを受け止める"],
    next: { label: "受け止めて関係をつなぐ（押さない）", aix: [] },
    wayBack: { to: "hearing", how: "また探す時に条件の確認から" } },
};

// ═════════════════════════════════════════════════════════════════════════════
// 合図（既存の計算の値を受け取る）
// ═════════════════════════════════════════════════════════════════════════════

/** 他社の見積と比べている（既存の網に無いのでここで持つ） */
export const COMPETING_ESTIMATE_RE = /相見積|あいみつ|(?:他社|他の不動産|別の不動産|他の(?:会社|業者|お店))(?:さん)?[^\n。]{0,16}(?:見積|初期費用)|(?:見積|初期費用)[^\n。]{0,12}(?:比べ|比較)/;
/** 入居・引越しの時期がまだ先（既存の網に無いのでここで持つ）。「〇月」は今月から MOVE_IN_LATER_MONTHS か月以上先の時だけ（moveInLaterOf） */
export const MOVE_IN_LATER_RE = /(?:入居|引っ?越し?)[^\n。]{0,10}(?:来年|年明け|春頃)|(?:来年|年明け)[^\n。]{0,10}(?:入居|引っ?越)|まだ(?:先|時間がある)[^\n。]{0,8}(?:入居|引っ?越)/;
const MOVE_IN_MONTH_RE = /(?:入居|引っ?越し?)[^\n。]{0,12}?([0-9]{1,2})\s*月/;
export const MOVE_IN_LATER_MONTHS = 2;
/** 入居時期が先か（語・または「〇月」が今月から2か月以上先。月は日本時間で数える） */
export function moveInLaterOf(text: string, nowMs: number): boolean {
  const t = N(text);
  if (MOVE_IN_LATER_RE.test(t)) return true;
  const m = t.match(MOVE_IN_MONTH_RE);
  if (!m) return false;
  const mon = Number(m[1]);
  if (!(mon >= 1 && mon <= 12)) return false;
  const cur = new Date(nowMs + 9 * 3600_000).getUTCMonth() + 1;
  return ((mon - cur + 12) % 12) >= MOVE_IN_LATER_MONTHS;
}
/** 審査の不安（問いの形でない申告: 「クレカブラックなので」「夜職で明細が出せない」）。brain-route-type の screening_question は問いの形だけ拾う */
/** 条件のフォームの雛形（項目名に「審査」等の語が入る・お客様の申告ではない） */
export const CONDITION_FORM_RE = /[①②③]【|ご希望のお部屋探し|記入欄】/;
export const SCREENING_WORRY_RE = /ブラック|夜職|水商売|滞納|自己破産|債務整理|無職|(?:審査|保証会社)[^\n。]{0,8}(?:不安|心配|通(?:る|ら|り)|落ち)/;
/** 音信不通の線（こちらが送った後お客様の返事が無い日数） */
export const SILENT_DAYS = 7;

export type ApplyRouteSignals = {
  /** customer-state の段階（読めなかった時は null＝位置は unknown） */
  stage: CustomerStage | null;
  searching?: Pick<SearchingMark, "active" | "reason"> | null;
  /** 行動台帳の事実（brain-core の brainLedger.facts） */
  ledger?: Pick<LedgerFacts, "propertiesSentCount" | "pickupPromisedUnfulfilled" | "estimateSent" | "conditionAsked"> | null;
  /** 今のお客様の発言の型（brain-route-type.routeTypeOf） */
  routeType?: RouteType | null;
  /** 場面の証拠（aix-scene-evidence） */
  sceneId?: SceneId | null;
  /** まだ応えていないお客様の連投（無ければ空） */
  customerTurnText?: string | null;
  /** 直近のこちらの本文（72時間以内・新しい順） */
  recentStaffTexts?: ReadonlyArray<string>;
  /** 2番手で申込中（並行で探す）の1つの判定（post-apply.judgeParallelSecond）。分からなければ省く */
  parallelSecond?: boolean | null;
  /** customer-circumstances.holdFirstReason（すぐ来られない事情の文・無ければ null） */
  holdReason?: string | null;
  /** contact-promise.farMoveInTurn の結果（brain-core の farMoveInEarly が在るか）。渡された時はこちらを使い、語の網（moveInLaterOf）は使わない
   *  ＝「入居時期が先」は決まった線（連絡の日＝1ヶ月半前が7日以上先・竹内さんの決定 22c7e985/900059a6）と同じ所で開く。未指定（監査・試験）だけ語の網 */
  farMoveIn?: boolean | null;
  /** 最後の発言がこちら（スタッフ・AIX）の時、その時刻（お客様が最後なら null） */
  lastStaffAtIfStaffLast?: string | null;
  nowMs?: number;
};

export type ApplyRouteLocation = {
  node: RouteNodeId | null;
  branch: RouteBranchId | null;
  /** 申込へ向けた次の一手（分かれ道があればその一手） */
  next: RouteStep | null;
  /** 分かれ道から本線への戻り方 */
  wayBack: RouteBranch["wayBack"] | null;
  aim: SceneAim[];
  /** 位置の根拠（ログ・監査用・短く） */
  evidence: string[];
};

const STAGE_TO_NODE: Record<CustomerStage, RouteNodeId | null> = {
  first: "inquiry", searching: "hearing", proposing: "proposing", interested: "interested", estimate_sent: "estimate",
  viewing_arranging: "viewing_arrange", viewing_scheduled: "viewing_scheduled", viewed: "viewed", apply_prep: "apply_prep",
  applying: "applying", won: "won", dropped: null,
};

/** 本線の駅（customer-state の段階をそのまま写し、物件検索中だけ台帳で 条件ヒアリング／ピックアップ に分ける） */
export function resolveRouteNode(s: Pick<ApplyRouteSignals, "stage" | "searching" | "ledger" | "routeType">): { node: RouteNodeId | null; why: string | null } {
  if (!s.stage) return { node: null, why: null };
  // 初回の連絡で条件（条件のフォーム・希望）を出した＝ヒアリングの答えが来た（次はピックアップ）。分かれ道の「条件変更」ではない
  if (s.stage === "first" && s.routeType === "condition_feedback") return { node: "hearing", why: "初回・条件の答え" };
  if (s.stage === "searching") {
    const promised = !!s.ledger?.pickupPromisedUnfulfilled || s.searching?.reason === "pickup_promised" || s.searching?.reason === "watch_promised";
    if (s.searching?.reason === "sent_after_focus") return { node: "proposing", why: "物件検索中（送付を続けている）" };
    if (promised) return { node: "pickup", why: `物件検索中・探す約束あり（${s.searching?.reason ?? "pickup_promised"}）` };
    if ((s.ledger?.propertiesSentCount ?? 0) > 0) return { node: "pickup", why: "物件検索中・送付歴あり（次の物件を探す番）" };
    return { node: "hearing", why: "物件検索中・まだ送付も約束も無い" };
  }
  return { node: STAGE_TO_NODE[s.stage], why: `段階:${s.stage}` };
}

/** 開いている分かれ道（強い順に1つ） */
export function resolveRouteBranch(s: ApplyRouteSignals): { branch: RouteBranchId | null; why: string | null } {
  const turn = N(s.customerTurnText);
  const rt = s.routeType ?? null;
  const post = s.stage === "applying" || s.stage === "won";
  if (s.stage === "dropped" || rt === "decided_elsewhere") return { branch: "declined", why: s.stage === "dropped" ? "段階:dropped" : "型:decided_elsewhere" };
  if (rt === "postpone_cancel") return { branch: "postponed", why: "型:postpone_cancel" };
  if (turn && (isOtherAgentViewingApplyQuestion(turn) || isOtherAgentViewingPlan(turn))) return { branch: "other_agent_viewing", why: "他社で内覧の話" };
  // 番手（2026-10-21）: 2番手で申込中は申込の段階でも開く（並行で探すのが次の一手）。文は一番新しい番手の話で、申込んだ／案内を分ける
  if (s.parallelSecond === true && s.stage !== "won") return { branch: "rank_waiting", why: "2番手で申込中（並行で探す）" };
  const rank = post ? null : latestRankMention(s.recentStaffTexts ?? []);
  if (rank === "applied") return { branch: "rank_waiting", why: "こちらが番手で申込んだ・繰り上がり待ちを伝えた後" };
  if (rank === "offered") return { branch: "rank_offered", why: "こちらが番手のご案内をした後" };
  if (turn && COMPETING_ESTIMATE_RE.test(turn)) return { branch: "competing_estimate", why: "相見積もりの語" };
  if (rt === "screening_question" || s.sceneId === "S3_screening" || (!post && SCREENING_WORRY_RE.test(turn) && !CONDITION_FORM_RE.test(turn))) return { branch: "screening_concern", why: rt === "screening_question" ? "型:screening_question" : s.sceneId === "S3_screening" ? "場面:S3_screening" : "審査の不安の語" };
  if (rt === "negotiation") return { branch: "negotiation", why: "型:negotiation" };
  if (rt === "brought_property") return { branch: "brought_property", why: "型:brought_property" };
  // 条件変更は物件を送った後だけ（送る前の条件のやり取りは本線のヒアリング）
  const sentBefore = (s.ledger?.propertiesSentCount ?? 0) > 0;
  //   場面の S7（「〜でも大丈夫」等の語）は時刻の相談にも当たるので使わず、発言の型だけで見る
  if (!post && sentBefore && (rt === "condition_feedback" || rt === "other_property")) return { branch: "condition_change", why: `型:${rt}` };
  if (!post && s.holdReason) return { branch: "cannot_come_soon", why: s.holdReason };
  const fmi = typeof s.farMoveIn === "boolean";
  if (!post && (fmi ? s.farMoveIn : !!turn && moveInLaterOf(turn, s.nowMs ?? Date.now()))) return { branch: "move_in_later", why: fmi ? "入居時期が先（farMoveInTurn）" : "入居時期の語" };
  if (rt === "considering") return { branch: "considering", why: "型:considering" };
  if (!post && s.searching?.reason === "watch_promised") return { branch: "new_arrival_wait", why: "新着が出次第の約束" };
  if (!post && s.lastStaffAtIfStaffLast) {
    const now = s.nowMs ?? Date.now();
    const t = Date.parse(s.lastStaffAtIfStaffLast);
    if (Number.isFinite(t) && now - t >= SILENT_DAYS * 86_400_000) return { branch: "silent", why: `こちらの送信から${Math.floor((now - t) / 86_400_000)}日返事なし` };
  }
  return { branch: null, why: null };
}

/** 今どこ・次の一手・開いている分かれ道（純関数） */
export function locateApplyRoute(s: ApplyRouteSignals): ApplyRouteLocation {
  const n = resolveRouteNode(s);
  const b = resolveRouteBranch(s);
  const node = n.node ? ROUTE_NODES[n.node] : null;
  const br = b.branch ? ROUTE_BRANCHES[b.branch] : null;
  return {
    node: n.node,
    branch: b.branch,
    next: br ? br.next : node ? node.next : null,
    wayBack: br ? br.wayBack : null,
    aim: br ? br.aim : node ? node.aim : [],
    evidence: [n.why, b.why].filter((x): x is string => !!x),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ブレインへの材料（毎回変わる並び・既定 off）
// ═════════════════════════════════════════════════════════════════════════════

export function applyRouteMapEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.APPLY_ROUTE_MAP ?? "").trim().toLowerCase() === "on";
}

export const APPLY_ROUTE_TEXT_MAX = 600;

const nodeName = (id: RouteNodeId | null) => (id ? ROUTE_NODES[id].name : "—");

/** 材料の文（位置が分からない時は空文字）。上限 APPLY_ROUTE_TEXT_MAX 字 */
export function buildApplyRouteBrainText(loc: ApplyRouteLocation): string {
  if (!loc.node && !loc.branch) return "";
  const line = MAIN_ROUTE.map((id) => (id === loc.node ? `［${ROUTE_NODES[id].name}］` : ROUTE_NODES[id].name)).join("→");
  const parts: string[] = [
    `\n【申込までの地図（決定論の位置・材料）】本線: ${line}`,
    `今どこ: ${nodeName(loc.node)}${loc.aim.length ? `／この場面の狙い: ${loc.aim.join("・")}` : ""}`,
  ];
  if (loc.branch) {
    const br = ROUTE_BRANCHES[loc.branch];
    parts.push(`分かれ道: ${br.name}（${br.meaning}）／本線への戻り方: ${br.wayBack.how}${br.wayBack.to ? `（→${nodeName(br.wayBack.to)}）` : ""}`);
  }
  if (loc.next) parts.push(`申込へ向けた次の一手の候補: ${loc.next.label}${loc.next.aix.length ? `（合う AIX: ${loc.next.aix.join("・")}）` : ""}`);
  parts.push("※位置は網。どう返すか・AIX にするかはあなたが会話を読んで決める。");
  let text = parts.join("\n");
  if (text.length > APPLY_ROUTE_TEXT_MAX) text = text.slice(0, APPLY_ROUTE_TEXT_MAX - 1) + "…";
  return text;
}

/** brain-core から呼ぶ入口。off の時は必ず空文字（プロンプトを変えない） */
export function applyRouteBrainTextIfEnabled(s: ApplyRouteSignals, env?: Record<string, string | undefined>): { text: string; loc: ApplyRouteLocation | null } {
  if (!applyRouteMapEnabled(env)) return { text: "", loc: null };
  const loc = locateApplyRoute(s);
  return { text: buildApplyRouteBrainText(loc), loc };
}
