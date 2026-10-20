// app/lib/brain-gap-finder.ts — ブレインの穴を自分で見つける見張りの決まり（純関数・DB も fetch も LLM も持たない）
//
// 2026-10-15 竹内さん「ブレインを強化するのが質を上げるために最重要。足りていない部分を見つけられるようにする。隙のない精度の高い考えができるために」
//   （設計知見【最優先】97ea82f3）。スクショが届くのを待たず、本番の番から「ブレインが足りていなかった番」を集めて原因の型に分け、
//   型ごとの数・前の週との差・代表の番・どこを直すとよさそうかを出す。DB を読むのは brain-gap-finder-server.ts。
//
//   集める番（kind）:
//     edited        … 下書きを直して送った（line_watch_turns の文の判定 partial/different・下書きあり）
//     hand_typed    … 下書きが無いまま手で打った（AIX 誘導の印だけ・下書きなし）
//     final_miss    … 最終チェックの取りこぼし系（MISSED_QUESTION・CONCERN_UNADDRESSED・STAFF_REQUEST_OMITTED）が最後まで残った
//     brain_mismatch… ブレインの判断（返信か AIX か・AIX の種類）とスタッフの実送信が食い違った
//     ledger_open   … お客様の確認事項が未対応のまま長く残った（既定 48 時間）
//     ledger_reopen … 完了と判定した確認事項を、お客様がその後に同じ種類でもう一度聞いた（＝完了の判定が覆った）
//     brought_no_estimate … 初回の物件の持ち込みで、AI の下書きに「最大限割引した初期費用の御見積書」の一言が無い（竹内さんの決定 10/07）
//
//   原因の型（cause・決定論の手がかりだけ。確かでない物は unknown＝要確認）:
//     axis          … 軸の読み違い（何について about・誰の whose・いつの when・どの物件 property）
//     situation     … 状況の把握の不足（2番手・承諾済み・募集なしの後・申込の段 等）
//     knowledge     … 知識の不足（会社の事実・業界の知識に無い話題で約束に倒れた／スタッフが手で答えた）
//     material      … 材料が届いていない（送った束・資料の読み・会社の事実があるのに約束に倒れた）
//     rule_override … 決まりがブレインを上書き（decision_source の rule:/correction:・LLM の AIX と最終の AIX が違う・demoted_overrides・出口の削り）
//     unknown       … 要確認（返信か AIX かの食い違いだけ・手がかりなし）
//
//   今日（10/15）竹内さんが画面で見つけた型は名前つきの印（tag）で数える: 駐車場・洗面台・確認済みの判定・申込の帯・予算オーバー・
//   ペット・繁忙期・募集なしの後の誘い・2番手の申込。
//   新しい turn_contract の about/property/when/whose（ブランチ brain-merge-1015）が本番に入った後は、その値と実送信を照らす（axisOf）。
//   入る前は語と前後の流れの手がかり。戻す: BRAIN_GAP_FINDER=off（週の見張りで回さない）

export type GapKind = "edited" | "hand_typed" | "final_miss" | "brain_mismatch" | "ledger_open" | "ledger_reopen" | "brought_no_estimate";
export type GapCause = "axis" | "situation" | "knowledge" | "material" | "rule_override" | "unknown";
export type TodayTag = "parking" | "washstand" | "confirmed_judgement" | "apply_band" | "budget_over" | "pet" | "busy_season" | "invite_after_unavailable" | "second_applicant";

export const KIND_JA: Record<GapKind, string> = {
  edited: "下書きを直して送った", hand_typed: "下書きなしで手で打った", final_miss: "最終チェックの取りこぼしが残った",
  brain_mismatch: "ブレインの判断と実送信が食い違った", ledger_open: "確認事項が未対応のまま長く残った",
  ledger_reopen: "完了の判定が後で覆った（同じ種類をもう一度聞かれた）", brought_no_estimate: "初回の持ち込みで最大限割引の御見積書の一言が抜けた",
};
export const CAUSE_JA: Record<GapCause, string> = {
  axis: "軸の読み違い（何について・誰の・いつの・どの物件）", situation: "状況の把握の不足", knowledge: "知識の不足",
  material: "材料が届いていない", rule_override: "決まりがブレインを上書き", unknown: "要確認",
};
export const TAG_JA: Record<TodayTag, string> = {
  parking: "駐車場", washstand: "洗面台（設備）", confirmed_judgement: "確認済みの判定", apply_band: "申込の帯", budget_over: "予算オーバー",
  pet: "ペット", busy_season: "繁忙期", invite_after_unavailable: "募集なしの後の誘い", second_applicant: "2番手の申込",
};
/** 原因の型ごとに「どこを直すとよさそうか」（ファイル・仕組みの名前） */
export const CAUSE_FIX: Record<GapCause, string> = {
  axis: "app/lib/turn-contract.ts（asks の about/property/when/whose）・brain-core のブレインの説明（軸の例）",
  situation: "turn_contract.situation・app/lib/action-ledger.ts（我々の行動台帳）・brain-core の状況の材料",
  knowledge: "app/lib/company-facts.ts（会社の事実の追加）・設計知見の業界の知識",
  material: "送った束（sent-bundles）・brain-deep-check（追加で引く材料）・material-answer・generate-reply の材料の欄",
  rule_override: "app/lib/override-demote.ts（規則の下げ）・brain-core の decision_source の規則・app/lib/exit-edits.ts の出口",
  unknown: "1件ずつ読む（設計知見 a09c202a の6種類 G1〜G6 に当てる）",
};
export const TAG_FIX: Record<TodayTag, string> = {
  parking: "about=viewing_day・when=viewing_day／company-facts car_visit（近くのパーキング）",
  washstand: "about=property_equipment・property=送った束／sent-bundles・material-answer",
  confirmed_judgement: "request-ledger の完了の判定（request_status）・ブレインの request_status",
  apply_band: "申込の段（status）・turn_contract.situation・申込フォーマットの AIX",
  budget_over: "about=reaction_to_sent（探す条件を変えない）",
  pet: "about=search_condition・polarity=relax",
  busy_season: "company-facts 繁忙期（COMPANY_FACT_BUSY_SEASON）",
  invite_after_unavailable: "aixDone.checkAllUnavailable（UNAVAILABLE_ACK_AXIS）・situation「募集に出ていない」",
  second_applicant: "whose=other_applicant・situation「2番手で申込＋並行して探す」",
};

/** 1つの番（line_watch_turns の行＋前後の流れ）。文は呼ぶ側で読んだ物をそのまま渡す（ここでは外に出さない） */
export type GapTurn = {
  id: number | string;
  conversationId: string;
  turnAt: string;
  status: string | null;
  customerText: string;
  /** 番の前のこちらの最後の送信（文・AIX の生成文） */
  prevStaffText: string;
  /** 番の前のこちらの AIX の物件確認の結果の型（available/unavailable…）。無ければ null */
  prevCheckPattern: string | null;
  staffTexts: string[];
  staffWriter: string | null;
  staffAix: string[];
  draft: string | null;
  sentinel: string | null;
  brainAction: string | null;
  brainReplyMode: string | null;
  verdict: string | null;
  detail: Record<string, unknown> | null;
  finalCodes: string[];
  /** ブレインの判断ログの要点（brain_decision_logs.digest の la/aix/ds） */
  digest: { la?: string | null; aix?: string | null; ds?: string | null } | null;
  /** 番の前にこちらが資料（画像・URL・物件確認の結果）を送っていたか */
  materialBefore: boolean;
  /** この会話で初めての物件の持ち込みの番か */
  firstBrought: boolean;
  /** 会社の事実に当たる話題か（matchCompanyFacts が1つ以上） */
  companyFactHit: boolean;
  /** 新しい turn_contract の軸（本番に入った後・この番の判断の時だけ） */
  axis: Array<{ about?: string | null; property?: string | null; when?: string | null; whose?: string | null; route?: string | null }> | null;
  situation: string | null;
  /** 今の meta の記録（この番が会話の最新の判断の時だけ）: 下げた上書きの数・出口の削りの数 */
  demotedOverrides: number;
  exitEdits: number;
};

export type GapFinding = {
  kind: GapKind;
  cause: GapCause;
  /** 原因の細かい印（axis:when 等・決め手の言葉） */
  sub: string;
  tags: TodayTag[];
  conversationId: string;
  turnId: string;
  at: string;
  /** お客様の発言の要旨（30字まで・名前を伏せた物） */
  customer: string;
  /** スタッフの実送信の要旨（30字まで・名前を伏せた物） */
  staff: string;
};

// ── 語の網（決定論）
export const PROMISE_RE = /確認(?:させて|致し|いたし|して|出来次第|でき次第)|お調べ|お問い?合わせ(?:させて|致し|いたし)|確認後|確認の上/;
const QUESTION_RE = /[?？]|ですか|ますか|でしょうか|かな|教えて|知りたい|どう(?:です|なり|でしょう)|いくら|何時|何日|いつ/;
export const FINAL_MISS_CODES: ReadonlySet<string> = new Set(["MISSED_QUESTION", "CONCERN_UNADDRESSED", "STAFF_REQUEST_OMITTED"]);
/** ブレインの判断と実送信が食い違った理由（line-watch-judge の reason） */
export const MISMATCH_REASONS: ReadonlySet<string> = new Set(["aix_other", "aix_but_text", "text_but_aix", "text_plus_aix", "text_but_staff_fact", "no_reply_needed_but_sent"]);
export const MAX_ESTIMATE_RE = /最大限[^\n。]{0,24}割引[^\n。]{0,40}見積|見積[^\n。]{0,16}最大限/;
export const BROUGHT_RE = /https?:\/\/(?:www\.)?(?:suumo|homes|chintai|realestate\.yahoo|athome|able|minimini|apamanshop|e-heya|shamaison|daito|ieagent|canary|mansion-review)/;
const BROUGHT_IMAGE_CUE_RE = /(?:この|こちらの|こんな)(?:物件|お部屋|部屋)|気になる(?:物件|お部屋|部屋)/;

const PARKING_RE = /駐車場|パーキング|車で(?:行|伺|向|来)|車停め|車を停め/;
const VIEWING_SCHEDULED_RE = /(?:内覧|内見|ご案内)[^\n。]{0,30}(?:日|時|当日|お待ち|楽しみ)|当日|待ち合わせ/;
const EQUIPMENT_RE = /洗面|独立洗面|トイレ|風呂|浴室|バス(?!停)|追い焚|追焚|キッチン|コンロ|収納|クローゼット|エアコン|洗濯機|室内干し|ベランダ|インターネット|wi-?fi|オートロック|宅配ボックス/i;
const BUDGET_OVER_RE = /予算(?:オーバー|を?超え|外|より高|的に厳し)|ちょっと高い|高いです|高めです/;
const PET_RE = /ペット|犬|猫|わんちゃん|ねこ/;
const RELAX_RE = /じゃなくても|でなくても|なくても(?:いい|良い|大丈夫)|無しで|なしで|不要|こだわらない|どちらでも/;
const BUSY_SEASON_RE = /繁忙期|閑散期|(?:時期|季節|月)[^\n。]{0,12}(?:安|高|変わ)|今の方が[^\n。]{0,10}(?:安|高)/;
const UNAVAILABLE_RE = /募集(?:が)?終了|満室|申込(?:が|み)?入|埋まって|ご紹介(?:が)?(?:出来|でき)(?:ない|ません)|募集(?:に)?出て(?:い)?ない|空きが(?:無|な)/;
const INVITE_RE = /ご案内|ご内覧|内覧|内見|お申込|お申し込み|お部屋抑え/;
const SECOND_RE = /[2２二]番手|[1１一]番手|キャンセル待ち/;
const SECOND_PARALLEL_RE = /申し?込[^\n。]{0,30}並行して|並行して[^\n。]{0,20}申し?込/;
// 2026-10-15 review: 前のこちらの送信の「2番手」は、お客様が今2番手で申込んでいる状態の時だけ数える（別の物件の募集状況の「2番手以降でのお申込となります」・
//   2番手のキャンセル・スライドの案内は外す）。スタッフの文の「2番手」はブレインが申込へ進めた時だけ（物件確認の結果の中継は状況の穴ではない）
const SECOND_STATE_RE = /[2２二]番手(?:で|にて)?(?:の)?お?申し?込み?(?:が|は)?(?:完了|済|中|しており|して(?:おり|い)|させて(?:頂|いただ)き(?:ました|まし))/;
const SECOND_CANCEL_RE = /キャンセル|取り下げ|スライド/;
const APPLY_RE = /申し?込(?:み|ませ|みた|みま|もう)|申込(?:書|フォーマット)|(?:ここ|こちら|この部屋|このお部屋)にし(?:ます|たい)|契約したい/;
const STAFF_APPLY_AIX = /apply|application|form/;
const REASK_CUE_RE = /まだ|どうなり|その後|先ほど|さっき|改めて|再度|もう一度|返事|ご連絡(?:は|まだ)/;

/** 名前を伏せて30字に縮める（呼び方の「〇〇さん」と既知の名前・電話・メールを伏せる） */
export function brief(text: string | null | undefined, mask: (s: string) => string = (s) => s, n = 30): string {
  // 2026-10-15 review: maskPII の「漢字1字＋様」は人の呼び方でない語（お子様・お父様・緊急連絡先様・管理会社様）まで「お客様」にするので先に避け、
  //   英字・ひらがなの呼び方（〇〇さんの英字・ひらがなの名前）は maskPII が伏せないのでここで伏せる
  const keep: string[] = [];
  const pre = String(text ?? "").replace(BRIEF_KEEP_RE, (m) => { keep.push(m); return `\u0000${keep.length - 1}\u0000`; });
  const s = mask(pre)
    .replace(/^[^\n！!。、\s\u0000]{1,12}?(?:さん|様)/u, "〇〇さん")
    .replace(/(^|[^A-Za-zＡ-Ｚａ-ｚぁ-ん〇])(?:[A-Za-zＡ-Ｚａ-ｚ]{1,12}|[ぁ-ん]{1,6})(?:さん|くん|ちゃん)/gu, "$1〇〇さん")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => keep[Number(i)] ?? "")
    .replace(/https?:\/\/\S+/g, "[URL]")
    .replace(/\s+/g, " ").trim();
  return s ? [...s].slice(0, n).join("") : "（画像・資料・様式だけ）";
}

const BRIEF_KEEP_RE = /お子様|お父様|お母様|ご両親様|ご家族様|ご主人様|ご友人様|緊急連絡先様|連帯保証人様|保証人様|契約者様|入居者様|管理会社様|保証会社様|貸主様|担当者様/g;

/**
 * 下書きもブレインの判断も画面に届いていない番が続いた区間（障害・記録の止まり）。番を時刻順に並べ、届いていない番が minRun 以上続いた区間の番の id を返す。
 *   2026-10-15 review: 10/13 01時〜10/14 18時（JST）の 69 番は控えに下書き・判断が1つも入っておらず、「手で打った」「ブレインが走っていない」
 *   「text_but_aix」に混ざってブレインの穴の数を倍にしていた。障害の区間は穴に数えず別に数える（普段の届いていない番は1日2〜4・続いても数番）
 *   ⚠ 2026-10-20 訂正: 当時「DeepSeek の障害の頃」と書いたが誤り。ブレインも下書きも実際は動いていた（ai_reply_examples に下書き 45件・brain_decision_logs も平常）。
 *     止まっていたのは見張りの控え（トリガー capture_line_watch_turn が失敗を EXCEPTION WHEN OTHERS → RAISE WARNING で飲んでいた）で、
 *     10/12 12:34Z〜10/15 00:01Z の約60時間、番の行はできたが下書き・判断の欄が入らなかった。今は line-watch-scope.findCaptureStalls が見張る
 */
export function outageTurnIds(turns: ReadonlyArray<{ id: number | string; at: string; missing: boolean }>, minRun = 8): Set<string> {
  const out = new Set<string>();
  const sorted = [...turns].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let run: string[] = [];
  const flush = () => { if (run.length >= minRun) for (const id of run) out.add(id); run = []; };
  for (const t of sorted) { if (t.missing) run.push(String(t.id)); else flush(); }
  flush();
  return out;
}

/** 今日の型の印（customer・前後の流れの語で決める。印は原因の型の手がかりにもなる） */
export function todayTagsOf(t: GapTurn): TodayTag[] {
  const c = t.customerText, prev = t.prevStaffText, staff = t.staffTexts.join("\n"), draft = t.draft ?? "";
  const out: TodayTag[] = [];
  if (PARKING_RE.test(c)) out.push("parking");
  if (EQUIPMENT_RE.test(c) && QUESTION_RE.test(c)) out.push("washstand");
  if (BUDGET_OVER_RE.test(c) && t.materialBefore) out.push("budget_over");
  if (PET_RE.test(c)) out.push("pet");
  if (BUSY_SEASON_RE.test(c)) out.push("busy_season");
  const afterUnavailable = t.prevCheckPattern === "unavailable" || t.prevCheckPattern === "exclusive" || UNAVAILABLE_RE.test(prev);
  const brainInvites = /viewing_invite|application_push|greeting_viewing/.test(t.brainAction ?? "");
  if (afterUnavailable && ((INVITE_RE.test(draft) && !INVITE_RE.test(staff)) || (brainInvites && !t.staffAix.includes(t.brainAction ?? "")))) out.push("invite_after_unavailable");
  const brainApply = [t.brainAction, t.digest?.la, t.digest?.aix].some((x) => STAFF_APPLY_AIX.test(x ?? ""));
  const prevSecondState = prev.split(/[。\n]/).some((x) => SECOND_STATE_RE.test(x) && !SECOND_CANCEL_RE.test(x));
  if (SECOND_RE.test(c) || (SECOND_RE.test(staff) && brainApply) || prevSecondState || SECOND_PARALLEL_RE.test(staff)) out.push("second_applicant");
  if (APPLY_RE.test(c) && (t.staffAix.some((a) => STAFF_APPLY_AIX.test(a)) || /申込|お申し込み/.test(staff)) && !/申込|お申し込み/.test(draft) && !STAFF_APPLY_AIX.test(t.brainAction ?? "")) out.push("apply_band");
  return out;
}

const PROPERTY_TOPIC_RE = new RegExp(`${EQUIPMENT_RE.source}|初期費用|家賃|賃料|管理費|共益費|敷金|礼金|間取り|広さ|築|階|駅|徒歩|日当たり|角部屋|入居(?:可能|日)|退去`, "i");
const GENERAL_KNOWLEDGE_RE = new RegExp(`${BUSY_SEASON_RE.source}|審査|保証会社|保証人|火災保険|鍵交換|更新料|解約|違約金|仲介手数料|フリーレント|分割|カード|引越し|住民票|在籍確認|内覧(?:の)?(?:時間|所要|持ち物)|駐車場|パーキング`);

/** 1つの番の原因の型（決定論の手がかり。強い物から順に・当たらなければ unknown） */
export function classifyCause(t: GapTurn, kind: GapKind, tags: ReadonlyArray<TodayTag>): { cause: GapCause; sub: string } {
  const staff = t.staffTexts.join("\n"), draft = t.draft ?? "";
  const staffPromised = PROMISE_RE.test(staff), draftPromised = PROMISE_RE.test(draft);
  const d = (t.detail ?? {}) as { facts?: { conflict?: string[]; draftOnly?: string[]; staffOnly?: string[] }; reason?: string; brain_aix?: string | null };

  // 1. 新しい軸（本番に入った後）: ブレインの about と今日の型が食い違う
  if (t.axis?.length) {
    const ab = t.axis.map((a) => a.about ?? "");
    if (tags.includes("parking") && !t.axis.some((a) => a.when === "viewing_day" || a.about === "viewing_day")) return { cause: "axis", sub: "when:内覧当日を物件の事と読んだ（about=" + ab.join("/") + "）" };
    if (tags.includes("budget_over") && !ab.includes("reaction_to_sent")) return { cause: "axis", sub: "about:送った物件への反応を条件と読んだ" };
    if (tags.includes("second_applicant") && !t.axis.some((a) => a.whose === "other_applicant") && /[1１一]番手|否決/.test(t.prevStaffText + staff)) return { cause: "axis", sub: "whose:他の申込者の事をお客様の事と読んだ" };
  }
  // 2. 決まりがブレインを上書き
  const dg = t.digest;
  const ruleSrc = !!dg?.ds && /^(?:rule|correction)[:_]/.test(dg.ds);
  // 2026-10-15 review: スタッフも規則の出した AIX を押した時は規則が当たっている（上書きの穴に数えない）
  if (ruleSrc && (dg?.la ?? null) !== (dg?.aix ?? null) && !(dg?.aix && t.staffAix.includes(dg.aix))) {
    const staffFollowedLlm = !!dg?.la && t.staffAix.includes(dg.la);
    const staffTextWhenLlmNone = !dg?.la && t.staffAix.length === 0 && t.staffTexts.length > 0;
    if (staffFollowedLlm || staffTextWhenLlmNone || kind === "brain_mismatch") return { cause: "rule_override", sub: `${dg?.ds}: ${dg?.la ?? "なし"}→${dg?.aix ?? "なし"}` };
  }
  if (t.demotedOverrides > 0 && kind === "brain_mismatch") return { cause: "rule_override", sub: `下げた上書き ${t.demotedOverrides}件（規則は当たった）` };
  if (t.exitEdits > 0 && (kind === "edited" || kind === "final_miss")) return { cause: "rule_override", sub: `出口の削り ${t.exitEdits}件` };
  // 下書きの文はスタッフと同じだった（食い違いは返信か AIX か・スタッフだけの事実だけ）→ 文の中身の型（軸・知識・材料）には数えない
  const textSame = (t.detail as { text_verdict?: string } | null)?.text_verdict === "same" || (t.detail as { text_verdict?: string } | null)?.text_verdict === "same_meaning";
  if (textSame) return { cause: "unknown", sub: `文は同じ・返信かAIXか: ${d.reason ?? ""}` };
  // 2026-10-15 review: ブレインが走っていない番・初回のあいさつの番は、文の中身の型（軸・状況・材料・知識）に数えない（ブレインの読みの穴ではない）。話題の手がかりは sub に残す
  const firstGreeting = /はじめまして|この度ご連絡頂き/.test(staff);
  if (d.reason === "no_brain" || firstGreeting) {
    const topic = GENERAL_KNOWLEDGE_RE.exec(t.customerText)?.[0];
    const head = d.reason === "no_brain" ? (firstGreeting ? "ブレインが走っていない番・初回のあいさつ" : "ブレインが走っていない番") : "初回のあいさつの番";
    return { cause: "unknown", sub: `${head}（${d.reason ?? ""}${topic ? `・話題:${topic}` : ""}）` };
  }
  // 3. 今日の型の印から
  if (tags.includes("parking") && (VIEWING_SCHEDULED_RE.test(t.prevStaffText) || /コインパーキング|近くのパーキング/.test(staff))) return { cause: "axis", sub: "when:内覧当日の来方（物件の駐車場ではない）" };
  if (tags.includes("budget_over")) return { cause: "axis", sub: "about:送った物件への反応（探す条件の変化ではない）" };
  if (tags.includes("pet") && RELAX_RE.test(t.customerText)) return { cause: "axis", sub: "polarity:ペット可を外す（NG にしない）" };
  if (tags.includes("invite_after_unavailable")) return { cause: "situation", sub: "募集に出ていない結果の後に内覧・申込へ誘った" };
  if (tags.includes("second_applicant")) return { cause: "situation", sub: "2番手の申込・並行して探す" };
  if (tags.includes("apply_band")) return { cause: "situation", sub: "申込の段（お客様が申込を言った）" };
  if (tags.includes("busy_season") && !t.companyFactHit) return { cause: "knowledge", sub: "繁忙期（会社の事実に無い）" };
  // 4. 物件の取り違え
  if (d.facts?.conflict?.includes("property") || (d.facts?.draftOnly?.includes("property") && d.facts?.staffOnly?.includes("property"))) return { cause: "axis", sub: "property:別の物件の事として書いた" };
  // 5. 約束に倒れた／手で答えた: 材料か知識か
  const askedQ = QUESTION_RE.test(t.customerText);
  const aiFellToPromise = (draftPromised && !staffPromised && staff.trim().length > 0) || (kind === "hand_typed" && askedQ && !staffPromised);
  if (aiFellToPromise || kind === "final_miss") {
    const propTopic = PROPERTY_TOPIC_RE.test(t.customerText);
    if (propTopic && t.materialBefore) return { cause: "material", sub: tags.includes("washstand") ? "送った資料に設備の答えがある" : "送った資料・物件の記録で答えられる" };
    if (t.companyFactHit) return { cause: "material", sub: "会社の事実に当たるのに使っていない" };
    if (GENERAL_KNOWLEDGE_RE.test(t.customerText)) return { cause: "knowledge", sub: (GENERAL_KNOWLEDGE_RE.exec(t.customerText)?.[0] ?? "") + "（会社の事実・業界の知識に無い）" };
    if (tags.includes("washstand")) return { cause: "material", sub: "設備の質問・送った資料なし" };
  }
  // 6. 返信か AIX か（食い違いだけ・手がかりなし）
  if (kind === "brain_mismatch") return { cause: "unknown", sub: `返信かAIXか: ${d.reason ?? ""}（ブレイン ${d.brain_aix ?? t.brainAction ?? "返信"}／実送信 ${t.staffAix.join("+") || "文"}）` };
  if (d.reason === "no_draft" || d.reason === "sentinel_only") return { cause: "unknown", sub: `下書きが無い（${d.reason}）` };
  return { cause: "unknown", sub: (d.reason as string | undefined) ?? "" };
}

/** 1つの番から集める番を全部出す（1つの番が複数の kind に入ることがある） */
export function findingsOfTurn(t: GapTurn, mask: (s: string) => string = (s) => s): GapFinding[] {
  const d = (t.detail ?? {}) as { reason?: string; text_verdict?: string };
  const kinds: GapKind[] = [];
  const hasStaffText = t.staffTexts.some((x) => x.trim());
  const reason = d.reason ?? "";
  if (t.draft && hasStaffText && (d.text_verdict === "partial" || d.text_verdict === "different")) kinds.push("edited");
  if (!t.draft && hasStaffText && (reason === "no_draft" || reason === "sentinel_only" || (t.verdict === "na" && !t.sentinel))) kinds.push("hand_typed");
  if (t.finalCodes.some((c) => FINAL_MISS_CODES.has(c.split(":")[0]))) kinds.push("final_miss");
  if (MISMATCH_REASONS.has(reason)) kinds.push("brain_mismatch");
  if (t.firstBrought && t.draft && !MAX_ESTIMATE_RE.test(t.draft)) kinds.push("brought_no_estimate");
  if (!kinds.length) return [];
  const tags = todayTagsOf(t);
  const customer = brief(t.customerText, mask), staff = brief(t.staffTexts.join(" ") || (t.staffAix.length ? `[AIX ${t.staffAix.join("+")}]` : ""), mask);
  return kinds.map((kind) => {
    const c = kind === "brought_no_estimate"
      ? { cause: (MAX_ESTIMATE_RE.test(t.staffTexts.join("\n")) ? "knowledge" : "unknown") as GapCause, sub: MAX_ESTIMATE_RE.test(t.staffTexts.join("\n")) ? "竹内さんの決定（持ち込みは募集状況＋最大限割引の見積）がブレインに無い" : "スタッフも書いていない（要確認）" }
      : classifyCause(t, kind, tags);
    return { kind, cause: c.cause, sub: c.sub, tags, conversationId: t.conversationId, turnId: String(t.id), at: t.turnAt, customer, staff };
  });
}

export function isBroughtBundle(text: string): boolean {
  return BROUGHT_RE.test(text) || (/^\s*\[画像\]/m.test(text) && BROUGHT_IMAGE_CUE_RE.test(text));
}

// ── 確認事項（request ledger）の見張り
export type LedgerLike = { quote: string; topic: string; status: "open" | "promised" | "done"; saidAt: string; doneAt?: string | null; deferred?: boolean; kind?: string };
export type LedgerMsgLike = { sender: string; text: string | null | undefined; createdAt: string };

/** 未対応のまま openHours 以上残った物（取り下げ・先の相談は外す。お客様がその後に話していない会話も含む） */
export function longOpenItems(items: ReadonlyArray<LedgerLike>, nowMs: number, openHours = 48): LedgerLike[] {
  return items.filter((x) => x.status === "open" && !x.deferred && x.kind !== "concern" && nowMs - Date.parse(x.saidAt) >= openHours * 3600_000);
}

/**
 * 完了と判定した後に、お客様が同じ種類（topic）をもう一度聞いた物（＝完了の判定が覆った）。
 *   条件: 完了の後 72 時間以内のお客様の発言が同じ種類の質問で、問い直しの語（まだ・どうなり・先ほど…）か同じ言葉の繰り返しがある
 */
export function reopenedItems(items: ReadonlyArray<LedgerLike>, msgs: ReadonlyArray<LedgerMsgLike>, topicOf: (text: string) => string[], withinHours = 72): Array<{ item: LedgerLike; again: string; at: string }> {
  const out: Array<{ item: LedgerLike; again: string; at: string }> = [];
  for (const it of items) {
    if (it.status !== "done" || !it.doneAt) continue;
    const from = Date.parse(it.doneAt), to = from + withinHours * 3600_000;
    const hit = msgs.find((m) => m.sender === "customer" && Date.parse(m.createdAt) > from && Date.parse(m.createdAt) <= to
      && topicOf(String(m.text ?? "")).includes(it.topic) && QUESTION_RE.test(String(m.text ?? ""))
      && (REASK_CUE_RE.test(String(m.text ?? "")) || sharesWords(String(m.text ?? ""), it.quote)));
    if (hit && !out.some((o) => o.at === hit.createdAt && o.item.topic === it.topic)) out.push({ item: it, again: String(hit.text ?? ""), at: hit.createdAt });
  }
  return out;
}
function sharesWords(a: string, b: string): boolean {
  const grams = (s: string) => { const t = s.replace(/[\s！!？?。、😊😌]/gu, ""); const g = new Set<string>(); for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3)); return g; };
  const ga = grams(a), gb = grams(b); let n = 0; for (const x of ga) if (gb.has(x)) n++;
  return n >= 3;
}

// ── まとめ
export type CauseCount = { cause: GapCause; n: number; prev: number; diff: number; fix: string; subs: Array<{ sub: string; n: number }>; examples: GapFinding[] };
export type GapSummary = {
  turns: number;
  findings: number;
  byKind: Record<GapKind, number>;
  byKindPrev: Record<GapKind, number>;
  byCause: CauseCount[];
  byTag: Array<{ tag: TodayTag; n: number; causes: Record<string, number>; fix: string; examples: GapFinding[] }>;
};
const emptyKinds = (): Record<GapKind, number> => ({ edited: 0, hand_typed: 0, final_miss: 0, brain_mismatch: 0, ledger_open: 0, ledger_reopen: 0, brought_no_estimate: 0 });

export function summarizeGaps(cur: ReadonlyArray<GapFinding>, prev: ReadonlyArray<GapFinding>, turns: number, o: { examples?: number } = {}): GapSummary {
  const ex = o.examples ?? 3;
  const byKind = emptyKinds(), byKindPrev = emptyKinds();
  for (const f of cur) byKind[f.kind]++;
  for (const f of prev) byKindPrev[f.kind]++;
  // 型の数は「番」で数える（同じ番の複数の kind を重ねない・同じ原因なら1つ）
  const uniq = (list: ReadonlyArray<GapFinding>) => { const m = new Map<string, GapFinding>(); for (const f of list) { const k = `${f.turnId}|${f.cause}`; if (!m.has(k)) m.set(k, f); } return [...m.values()]; };
  const u = uniq(cur), up = uniq(prev);
  const causes: GapCause[] = ["axis", "situation", "knowledge", "material", "rule_override", "unknown"];
  const byCause = causes.map((cause) => {
    const list = u.filter((f) => f.cause === cause);
    const subs = new Map<string, number>();
    for (const f of list) { const k = f.sub.replace(/（[^）]*）$/, "").slice(0, 40); subs.set(k, (subs.get(k) ?? 0) + 1); }
    const n = list.length, p = up.filter((f) => f.cause === cause).length;
    return { cause, n, prev: p, diff: n - p, fix: CAUSE_FIX[cause], subs: [...subs].map(([sub, n2]) => ({ sub, n: n2 })).sort((a, b) => b.n - a.n).slice(0, 5), examples: pickExamples(list, ex) };
  }).sort((a, b) => (a.cause === "unknown" ? 1 : 0) - (b.cause === "unknown" ? 1 : 0) || b.n - a.n);
  const tags = Object.keys(TAG_JA) as TodayTag[];
  const byTag = tags.map((tag) => {
    const list = u.filter((f) => f.tags.includes(tag));
    const cs: Record<string, number> = {};
    for (const f of list) cs[f.cause] = (cs[f.cause] ?? 0) + 1;
    return { tag, n: list.length, causes: cs, fix: TAG_FIX[tag], examples: pickExamples(list, 2) };
  });
  return { turns, findings: u.length, byKind, byKindPrev, byCause, byTag };
}
function pickExamples(list: ReadonlyArray<GapFinding>, n: number): GapFinding[] {
  // 会話を散らす（同じ会話から2つ取らない）・新しい順
  const seen = new Set<string>(); const out: GapFinding[] = [];
  for (const f of [...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) { if (seen.has(f.conversationId)) continue; seen.add(f.conversationId); out.push(f); if (out.length >= n) break; }
  return out;
}

/** 人が読む一覧の行（スクリプト・報告用。会話は id の先頭8字だけ） */
export function gapSummaryLines(s: GapSummary, days: number): string[] {
  const L: string[] = [];
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  L.push(`■ ブレインの穴（直近${days}日・番 ${s.turns}・穴のある番 ${s.findings}）`);
  L.push("● 集める番（今週／前の週）");
  for (const k of Object.keys(KIND_JA) as GapKind[]) L.push(`  ${KIND_JA[k]}: ${s.byKind[k]}（前 ${s.byKindPrev[k]}・${sign(s.byKind[k] - s.byKindPrev[k])}）`);
  L.push("● 原因の型（番の数・前の週との差）");
  for (const c of s.byCause) {
    if (!c.n && !c.prev) continue;
    L.push(`  ${CAUSE_JA[c.cause]}: ${c.n}（前 ${c.prev}・${sign(c.diff)}）→ 直す所: ${c.fix}`);
    for (const x of c.subs.slice(0, 3)) L.push(`      ・${x.sub} ×${x.n}`);
    for (const e of c.examples) L.push(`      例 ${e.conversationId.slice(0, 8)} ${e.at.slice(5, 16)}［${KIND_JA[e.kind]}］客「${e.customer}」→ 実「${e.staff}」`);
  }
  L.push("● 今日の型（10/15 竹内さんが画面で見つけた物）");
  for (const t of s.byTag) L.push(`  ${TAG_JA[t.tag]}: ${t.n}${t.n ? `（${Object.entries(t.causes).map(([k, v]) => `${CAUSE_JA[k as GapCause].replace(/（.*$/, "")} ${v}`).join("・")}）` : ""}${t.examples[0] ? ` 例 ${t.examples[0].conversationId.slice(0, 8)}「${t.examples[0].customer}」` : ""}`);
  return L;
}

export function brainGapFinderEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.BRAIN_GAP_FINDER ?? "").trim().toLowerCase() !== "off";
}
