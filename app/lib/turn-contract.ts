// app/lib/turn-contract.ts — この番の「本質の仕様」（ブレインが決める・返信の最上位の決まり）（純関数・DB/LLM なし）
//
// 2026-10-08 竹内さん「頼まれている事の本質を理解できていない可能性が高い…ブレインが本質判断も一任できているか。そうすれば的外れが起きるはずがない」
//   ＋「もう言った事を言わないは人間の営業マンなら当たり前…他にも AI ならではのギャップがあるのでは」＋「とにかくここの部分も徹底的に強化する。細部までこだわる」
//
// 実測（不一致 194番を1番ずつ読んだ・中身の差 112番・scratchpad r12/r13）: ブレインが読み違えた A≒41／ブレインは正しいのに別の層に負けた B≒34・D≒15／材料が届かない C≒20。
//   それまでの作りでは「何に答える・何を約束する・何を言わない」をブレインが決めていなかった:
//   ①effectiveReplyDirection は早い者勝ちの型でブレインの方向は11番目 ②brain-specific-note は「型とぶつかる時は型を優先」
//   ③確認の約束の可否は語の正規表現（confirmation-context） ④【永久ルール（最上位・絶対厳守）】 ⑤最終チェックの書き直しがブレインの判断を見ない
// → この番の依頼の一覧と、それぞれの答え方（返信／約束／AIX／触れない）・言ってはいけない事・閉じる番か・もう言った事・決まった事を1つにし（これ）、
//   生成・確認の約束の関門・最終チェックの書き直しは全部これに従う（竹内さん Q1「本質を勝たせる・安全の線は上」）。
//   型・学習ルール・手本は「形」（開口語・字数・言い回し・締め）だけを決める。
// ⚠ ブレインが勝たない物（安全の線）: スタッフだけが知る事（空き・金額・内覧の確定・管理会社の回答 等＝aix-content-gate・staff-confirm-facts・AIX_BOUNDARY_*）・NG 物件・個人情報。
// 11巡目との関係（10/08）: reply-style-r11 の「質問は答えから（sceneStyleNote）」「直前2通の約束を繰り返さない（noRepeatNote）」は、本質がある番ではここに1つにまとめる
//   （leadWith・alreadySaid＝repeatCandidates をそのまま使う）。本質が無い番（夜の見送り・古い判断）は11巡目の注記のまま。
// 戻す: TURN_CONTRACT=off（全部）／TURN_CONTRACT_CONFIRM_GATE=off（確認の約束の関門だけ旧の語判定）／TURN_CONTRACT_FINAL_CHECK=off（最終チェックの書き直しの見送りだけ）
// テスト: app/lib/__tests__/turn-contract.test.ts

import type { RequestItem, RequestTopic } from "./request-ledger";

/** 1つの依頼への答え方 */
export type AnswerRoute =
  | "reply"     // 返信の本文で答える（会話・資料・会社の事実・一般的な事で答えられる）
  | "promise"   // 約束の返信（確認・作成・探す・交渉）→ 結果は後で AIX
  | "aix"       // AIX の番（スタッフだけが知る事）。返信は受けの一言だけ
  | "none";     // 触れない（もう答えた・お客様が自分でやる・触れない方がよい）

export type ContractAsk = {
  quote: string;
  topic: RequestTopic;
  kind: "request" | "question" | "concern" | "report" | "feeling";
  route: AnswerRoute;
  /** 答えの要点（reply）・約束の中身（promise）。60字まで */
  answer: string | null;
  basis: "conversation" | "material" | "company_fact" | "general" | "judgement" | null;
  /** route=aix の時の AIX（aix-catalog の鍵: "ボタン" か "ボタン/ピッカー"） */
  aixKey: string | null;
};

export type TurnContract = {
  asks: ContractAsk[];
  leadWith: number | null;
  closeOnly: boolean;
  mustNot: string[];
  /** こちらから添える提案（抑える・オンライン内見・室内の撮影 等）。返信で消さない・最終チェックの段階の指摘で消させない（刺さりの基準の担当からの穴 10/08） */
  proposals: string[];
  alreadySaid: string[];
  settled: string[];
  feeling: { kind: FeelingKind | null; acknowledge: boolean };
  humanChecks: HumanCheckId[];
  /** brain＝今の番を見たブレイン／ledger＝決定論の一覧だけ（予備） */
  source: "brain" | "ledger";
};

export type FeelingKind = "anxious" | "apologetic" | "hurried" | "disappointed" | "positive";

/** 人の営業なら当たり前にする／しない事（194番の不一致の型・件数は scratchpad r13 の集計） */
export type HumanCheckId =
  | "H3_answer_first" | "H4_no_unasked_promise" | "H1_no_repeat" | "H9_feeling" | "H2_no_ignore"
  | "H14_exhausted" | "H5_close" | "H8_received" | "H7_consistent" | "H13_settled"
  | "H14_concern_to_action" | "H14_returning" | "H12_time";

export const HUMAN_CHECK_JA: Record<HumanCheckId, string> = {
  H3_answer_first: "聞かれた事に一番先に答える（前置き・別の話から入らない）",
  H4_no_unasked_promise: "頼まれていない確認・約束・説明を足さない（一般的な事・会社の事実で答えられる事を確認の約束にしない）",
  H1_no_repeat: "こちらがもう言った事を繰り返さない",
  H9_feeling: "気持ち（不安・恐縮・謝罪・落胆）を一言で受ける",
  H2_no_ignore: "お客様が言った事（条件・名前・日程）を落とさない・聞き返さない",
  H14_exhausted: "今の条件の物件は出し切った＝AIX【全力サポート】の番（本文に『改めてピックアップ』も『新着が出次第』も書かない）",
  H5_close: "返事の要らない番は短く閉じる（新しい約束・提案を足さない・『また連絡します』に押さない）",
  H8_received: "送ってくれた物（画像・URL・資料）を受け取った事に触れる",
  H7_consistent: "前にこちらが言った日付・金額・物件と食い違わない",
  H13_settled: "決まった事（内覧の日時・申込）を蒸し返さない",
  H14_concern_to_action: "不安・不満を次の手（交渉・探し方）に変える",
  H14_returning: "前にやり取りのある方を初回（はじめまして）扱いしない",
  H12_time: "時刻・曜日・相手の都合に合わせる（社内で済む事に『明日一番で管理会社』と書かない）",
};

export function turnContractEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}, override?: string | null): boolean {
  if (override === "off") return false;
  if (override === "on") return true;
  return (env.TURN_CONTRACT ?? "").trim().toLowerCase() !== "off";
}
export function turnContractConfirmGateEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TURN_CONTRACT_CONFIRM_GATE ?? "").trim().toLowerCase() !== "off";
}
export function turnContractFinalCheckEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TURN_CONTRACT_FINAL_CHECK ?? "").trim().toLowerCase() !== "off";
}

// ── ブレインへの指示（brain-core の出力の指定に入れる文）───────────────────────
/** ブレインの JSON に足す欄の説明（brain-core の出力の指定・今回の発言の層の出力の指定の両方に入れる） */
export const BRAIN_TURN_CONTRACT_FIELD = `"turn_contract": {"asks": [{"quote": "お客様の今の連投の依頼・質問・懸念を1つずつ（お客様の言葉・40字以内）", "kind": "request|question|concern|report|feeling", "route": "reply|promise|aix|none", "answer": "reply なら答えの要点・promise なら約束の中身（40字以内）・aix/none は null", "basis": "conversation|material|company_fact|general|judgement", "aix": "route=aix の時だけ AIX のキー（上の能力マップ）。他は null"}], "lead_with": "先に答える asks の番号（0始まり）か null", "close_only": "true/false", "must_not": ["この返信で言ってはいけない事（最大4件・各20字）"], "proposals": ["こちらから添える提案（お申込みでお部屋を抑える・オンライン内見・室内の撮影 等。お客様の事情と刺さり具合で・最大2件・各30字。無ければ []）"], "feeling": {"kind": "anxious|apologetic|hurried|disappointed|positive|null", "acknowledge": "true/false"}}`;

/** ブレインの判断の仕方（出力の指定の後ろに置く短い規則・竹内さん 10/08 の答え Q1〜Q10 をそのまま） */
export const BRAIN_TURN_CONTRACT_RULES = `【この番の本質（turn_contract）の決め方 — 返信の中身はここだけで決まる】
- ★基本（P0・竹内さん 10/09）: スタッフしか分からない事・確認する必要がある事（管理会社の確認結果・募集状況・撮った写真・見積の金額・内覧の日程の可否や確定・資料に無い設備の有無・管理会社の回答）は AIX から送る。返信は確認・作成の約束まで（中身・結果を書かない）。中身を知らなくても「AIX の番」と判断する。逆に資料・会社の事実・一般的な事で答えられる事は確認にせず返信で答える。
- asks: 【お客様の依頼の一覧】があればその項目を1つも落とさない（足すのはよい）。無ければ今の連投から自分で数える。前の番の依頼を書き写さない（まだ答えていない前の依頼は【お客様の依頼の一覧】の「まだ答えていない確認事項」から入る）。
- route の決め方: スタッフだけが知る事（管理会社に確認した結果・募集状況・見積の金額・割引額・入居日の確定・内覧の日時の確定・撮影した写真・交渉の結果・審査の結果・探した結果）が答えに要る → "aix"（AIX のキーを付ける）。
  まだ結果が無く、これから確認・作成・探す・交渉する → "promise"。会話・送った物件の資料・会社の事実・一般的な事（虫・換気・二人で住める広さ・内覧の所要時間・手続きの流れ）で答えられる → "reply"（確認の約束にしない）。もう答えた・お客様が自分でやる → "none"。
- 不安・不満は次の手に変える（例: エアコンが無い→管理会社にエアコン設置を交渉／カードの滞納歴・審査が不安→審査の通りやすい保証会社の物件も探す／審査否決の歴→保証会社の切り替えを交渉／お風呂が狭い→その点を条件にして探す）。交渉・探す約束にするかは route=promise で自分で決める（例は決まりではない）。
- close_only=true の番の answer は受けの一言だけ（前にした約束・予定・日付を言い直さない＝もう言った事）。
- close_only=true: 返事の要らない番（お礼・了承・あいさつだけ）／お客様が待ってと言った番（「決まったら連絡します」「また連絡します」「確認してから連絡します」）。待っての番は「お決まりになりましたらご連絡ください」の形で閉じ、物件を送り続ける約束・新しい提案をしない。
- 今の条件の物件を出し切った後（前に「全てピックアップ」・新着待ちの約束・全力サポートを送った後で条件が変わっていない）の「もう少し探して」等は route="aix"・aix="zenryoku_support"。
- 人生の出来事（出産・結婚・別れ・転職・同居 等）を話した時は、決まり文句で受けて終わらず、新しい状態（住む人数・広さ・時期・審査）の変化として読み、それに合わせた確かめ直し・探し方を asks の主にする（条件が変わるなら登録の条件そのものを直す）。出産・家族が増える時はこちらから広さ・間取りを聞き直す（竹内さん 10/09）。
- feeling: 不安・恐縮・謝罪・急ぎ・落胆がある時は kind を付け、受ける一言が要るなら acknowledge=true。
- proposals: お客様がすぐ来られない事情（今週は無理・出張中・予定が詰まって・遠方）があり物件が刺さっている時の「お申込みでお部屋を抑える」「オンライン内見・室内の撮影」の申し出は proposals に入れる（返信で消さない・「ご内覧可否確認」に置き換えない）。内覧したいだけの依頼は aix=viewing_invite（確認の約束にしない）。
- must_not: 聞かれていない事・この場面で言うと外れる事（例「見積書」「申込誘導」「管理会社に確認」）。`;

// ── ブレインの出力を読む ─────────────────────────────────────────────
export type BrainTurnContractRaw = {
  asks?: Array<{ quote?: unknown; topic?: unknown; kind?: unknown; route?: unknown; answer?: unknown; basis?: unknown; aix?: unknown }>;
  lead_with?: unknown;
  close_only?: unknown;
  must_not?: unknown;
  proposals?: unknown;
  feeling?: { kind?: unknown; acknowledge?: unknown } | null;
};

const ROUTES: ReadonlySet<string> = new Set(["reply", "promise", "aix", "none"]);
const KINDS: ReadonlySet<string> = new Set(["request", "question", "concern", "report", "feeling"]);
const BASES: ReadonlySet<string> = new Set(["conversation", "material", "company_fact", "general", "judgement"]);
const FEELINGS: ReadonlySet<string> = new Set(["anxious", "apologetic", "hurried", "disappointed", "positive"]);
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const truthy = (v: unknown) => v === true || v === "true";

/** brain-core が保存する前にブレインの turn_contract を整える（型の外れた値は落とす・最大6件）。無ければ null */
export function normalizeBrainTurnContract(raw: unknown): BrainTurnContractRaw | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as BrainTurnContractRaw;
  const asks = (Array.isArray(r.asks) ? r.asks : []).map((a) => ({
    quote: clip(a?.quote, 40),
    kind: KINDS.has(String(a?.kind)) ? String(a?.kind) : "question",
    route: ROUTES.has(String(a?.route)) ? String(a?.route) : "reply",
    answer: a?.answer == null || a?.answer === "null" ? null : clip(a?.answer, 40) || null,
    basis: BASES.has(String(a?.basis)) ? String(a?.basis) : null,
    aix: typeof a?.aix === "string" && a.aix && a.aix !== "null" ? clip(a.aix, 60) : null,
  })).filter((a) => a.quote).slice(0, 6);
  const lw = typeof r.lead_with === "number" ? r.lead_with : typeof r.lead_with === "string" && /^\d+$/.test(r.lead_with) ? Number(r.lead_with) : null;
  const mustNot = (Array.isArray(r.must_not) ? r.must_not : []).map((s) => clip(s, 20)).filter(Boolean).slice(0, 4);
  const proposals = (Array.isArray(r.proposals) ? r.proposals : []).map((s) => clip(s, 30)).filter(Boolean).slice(0, 2);
  const fk = r.feeling && FEELINGS.has(String(r.feeling.kind)) ? String(r.feeling.kind) : null;
  if (!asks.length && !truthy(r.close_only) && !mustNot.length && !fk && !proposals.length) return null;
  return {
    asks, lead_with: lw != null && lw >= 0 && lw < asks.length ? lw : null, close_only: truthy(r.close_only), must_not: mustNot, proposals,
    feeling: fk ? { kind: fk, acknowledge: truthy(r.feeling?.acknowledge) } : null,
  };
}

export type TurnContractFacts = {
  /** 今の条件の物件を出し切った（search-exhausted） */
  exhausted?: boolean;
  /** 前にやり取りのある方（初回でない） */
  returning?: boolean;
  /** 今の番にお客様が画像・URL・資料を送った */
  sentMedia?: boolean;
  /** ブレインが無い時の予備: 語の場面が短いお礼・了承／一時保留 */
  closeOnlyByForm?: boolean;
  /** 夜（18時以降）・土日で管理会社に今は聞けない */
  nightOutsideHours?: boolean;
};

/**
 * ブレインの判断（今の番を見た物だけ）と決定論の一覧（request-ledger）・もう言った事・決まった事を合わせて、この番の本質の仕様を作る。
 * - 一覧の項目はブレインが落とせない（ブレインに無い項目は一覧の目安の道で残す＝取りこぼし防止）
 * - ブレインが答え方を付けた項目はブレインが勝つ
 * - alreadySaid / settled は決定論の材料だけ（LLM に作らせない）
 */
export function buildTurnContract(input: {
  brain: BrainTurnContractRaw | null | undefined;
  brainFresh: boolean;
  ledgerItems: ReadonlyArray<RequestItem>;
  alreadySaid: ReadonlyArray<string>;
  settled: ReadonlyArray<string>;
  facts?: TurnContractFacts;
}): TurnContract {
  const facts = input.facts ?? {};
  const b = input.brainFresh ? normalizeBrainTurnContract(input.brain) : null;
  const asks: ContractAsk[] = [];
  const keys: string[] = [];
  const keyOf = (q: string) => q.normalize("NFKC").replace(/[\s。、！!？?「」]/g, "").slice(0, 10);
  if (b) {
    for (const a of b.asks ?? []) {
      const quote = String(a.quote);
      asks.push({ quote, topic: "other", kind: a.kind as ContractAsk["kind"], route: a.route as AnswerRoute, answer: (a.answer as string | null) ?? null, basis: (a.basis as ContractAsk["basis"]) ?? null, aixKey: (a.aix as string | null) ?? null });
      keys.push(keyOf(quote));
    }
  }
  for (const it of input.ledgerItems) {
    const k = keyOf(it.quote);
    const hit = keys.findIndex((x) => x && k && (x.includes(k.slice(0, 6)) || k.includes(x.slice(0, 6))));
    if (hit >= 0) { if (asks[hit].topic === "other") asks[hit].topic = it.topic; continue; }
    asks.push({ quote: it.quote.slice(0, 40), topic: it.topic, kind: it.kind, route: it.route, answer: null, basis: null, aixKey: null });
    keys.push(k);
  }
  if (facts.exhausted) {
    for (const a of asks) if (a.topic === "pickup" && a.route !== "none") { a.route = "aix"; a.aixKey = "zenryoku_support"; a.answer = null; }
  }
  const closeOnly = b ? !!b.close_only : !!facts.closeOnlyByForm;
  const fk = (b?.feeling?.kind as FeelingKind | undefined) ?? null;
  const feeling = { kind: fk, acknowledge: !!b?.feeling?.acknowledge };
  const humanChecks: HumanCheckId[] = ["H1_no_repeat", "H4_no_unasked_promise"];
  if (asks.some((a) => a.kind === "question" && a.route === "reply")) humanChecks.push("H3_answer_first");
  if (asks.length) humanChecks.push("H2_no_ignore");
  if (closeOnly) humanChecks.push("H5_close");
  if (feeling.acknowledge) humanChecks.push("H9_feeling");
  if (facts.exhausted) humanChecks.push("H14_exhausted");
  if (facts.returning) humanChecks.push("H14_returning");
  if (facts.sentMedia) humanChecks.push("H8_received");
  if (input.settled.length) humanChecks.push("H13_settled");
  if (facts.nightOutsideHours) humanChecks.push("H12_time");
  if (asks.some((a) => a.kind === "concern")) humanChecks.push("H14_concern_to_action");
  const lwB = b?.lead_with;
  const lw = typeof lwB === "number" ? lwB : asks.findIndex((a) => a.kind === "question" && a.route === "reply");
  return {
    asks, leadWith: lw >= 0 && lw < asks.length ? lw : null, closeOnly,
    mustNot: (b?.must_not as string[] | undefined) ?? [],
    proposals: (b?.proposals as string[] | undefined) ?? [],
    alreadySaid: input.alreadySaid.map((s) => clip(s, 60)).filter(Boolean).slice(0, 6),
    settled: input.settled.map((s) => clip(s, 60)).filter(Boolean).slice(0, 4),
    feeling, humanChecks, source: b ? "brain" : "ledger",
  };
}

// AIX の番（スタッフだけが知る事）は、結果をまだ送っていなければ本文は「確認／作成しお送りさせて頂きます」の約束の一文で受ける（2段・P0 の分け方）（確認・作成の結果を送る AIX だけ＝canConfirm。内覧日調整・待ち合わせ・物件の送付は確認の約束にしない）
//   （10/08 YUMA の再生 m151: ブレインが AIX と付けた見積の依頼に、竹内さんは「御見積しお送りさせて頂きます」と約束していた）
/** 「確認させて頂きます」の約束になってよい項目（約束・確認や作成の結果を送る AIX）。内覧日調整・待ち合わせ・物件の送付の AIX は確認の約束ではない（10/08 刺さりの担当: 内覧したい→「ご内覧可否確認」に置き換わっていた） */
//   ⚠ 10/09 調査の担当（scripts/audit-brain-interference.ts）: 「見積の約束→『初期費用・募集状況確認させて頂きます』に変わる」が邪魔の主な型。
//     見積（作成しお送り）・ピックアップ（探してお送り）の約束は「確認」の約束ではない＝確認の関門を開けない（見積・探す約束の文は別の注記が書く）
const ESTIMATE_OR_PICKUP_RE = /見積|初期費用|ピックアップ|探|お送り|ご紹介/;
const CONFIRM_LIKE_RE = /確認|管理会社|聞いて|問い合わせ|伺/;
export function isConfirmPromiseAsk(a: Pick<ContractAsk, "route" | "aixKey" | "answer" | "topic">): boolean {
  if (a.route === "aix") return /^(?:property_check_result|guarantor_info|acknowledge_check)/.test(a.aixKey ?? "");
  if (a.route !== "promise") return false;
  const ans = a.answer ?? "";
  if (CONFIRM_LIKE_RE.test(ans)) return true;
  if (ESTIMATE_OR_PICKUP_RE.test(ans)) return false;
  return a.topic !== "cost" && a.topic !== "pickup";
}
const canConfirm = (a: ContractAsk) => isConfirmPromiseAsk(a);
const ROUTE_JA: Record<AnswerRoute, string> = { reply: "返信で答える", promise: "約束する（結果は後で AIX）", aix: "AIX の番（結果の中身は本文に書かない。まだ送っていなければ約束の一文で受ける＝確認・見積の AIX は「確認／作成しお送りさせて頂きます」・内覧日調整の AIX は確認の約束にしない）", none: "触れない" };

/** 生成プロンプトの最上位に置く1ブロック（場面と返信方針の一番上）。中身が無ければ空 */
export function renderTurnContractNote(c: TurnContract | null | undefined): string {
  if (!c) return "";
  if (!c.asks.length && !c.closeOnly && !c.alreadySaid.length && !c.settled.length) return "";
  const L: string[] = [];
  L.push(`【🧭 この番の本質（${c.source === "brain" ? "ブレインの判断" : "依頼の一覧"}・最上位）】中身（何に答える・何を約束する・何を言わない）はここで決まる。下の場面の型・学習ルール・手本・注記は**形**（開口語・字数・言い回し・締め）だけに使い、ここと違う中身を足さない・消さない。ただし安全の線（スタッフだけが知る事・金額・空き・内覧の確定を本文で言い切らない）はここより上。`);
  if (c.closeOnly) L.push("- 返事の要らない番: 受けの一言＋締めだけ（竹内さんの形「はい😊！！⏎何卒よろしくお願い致します！！」・よろしくだけへの返し 62%・了承だけ 65% が何卒）。前にした約束・予定・日付を言い直さない。新しい約束・提案・説明を足さない（お客様が『決まったら連絡します』等と待ってと言った時は「お決まりになりましたらご連絡ください」の形・物件を送り続ける約束をしない）。");
  c.asks.forEach((a, i) => L.push(`- ${i === c.leadWith ? "★先に " : ""}${i + 1}. 「${a.quote}」→ ${ROUTE_JA[a.route]}${a.answer ? `：${a.answer}` : ""}${a.route === "aix" && a.aixKey ? `（AIX ${a.aixKey}）` : ""}`));
  if (c.alreadySaid.length) L.push(`- もう言った事（繰り返さない・言い直さない）: ${c.alreadySaid.map((s) => `「${s}」`).join(" ")}`);
  if (c.settled.length) L.push(`- 決まった事（蒸し返さない・日付はこのまま）: ${c.settled.join(" ／ ")}`);
  if (c.mustNot.length) L.push(`- 言わない: ${c.mustNot.join(" ／ ")}`);
  if (c.proposals.length) L.push(`- こちらから添える提案（消さない・確認の約束に置き換えない）: ${c.proposals.join(" ／ ")}`);
  if (c.feeling.acknowledge && c.feeling.kind) L.push(`- 気持ち（${FEELING_JA[c.feeling.kind]}）を本題の前に一言で受ける（お客様が書いた言葉に触れる・新しい言い回しを作らない）`);
  if (c.humanChecks.includes("H14_exhausted")) L.push("- 出し切った番: 物件の話は AIX【全力サポート】で送る（本文に新着待ち・再ピックアップを書かない）。");
  L.push(`- 人の当たり前: ${c.humanChecks.map((h) => HUMAN_CHECK_JA[h]).join("／")}`);
  if (c.source === "brain") L.push("- この一覧に無い確認・作成・探す・交渉の約束は書かない（route=約束 の項目だけ約束してよい）。");
  return L.join("\n");
}
const FEELING_JA: Record<FeelingKind, string> = { anxious: "不安", apologetic: "恐縮・謝罪", hurried: "急ぎ", disappointed: "落胆", positive: "前向き" };

/** 確認の約束を許すか（ブレインの本質がある時だけ判断する。null＝判断しない＝旧の語判定） */
export function contractAllowsConfirmPromise(c: TurnContract | null | undefined, env?: Record<string, string | undefined>): boolean | null {
  if (!c || c.source !== "brain" || !turnContractConfirmGateEnabled(env)) return null;
  return c.asks.some(canConfirm);
}

/**
 * 最終チェックの書き直しを本質の仕様で絞る（true＝この指摘は書き直しに渡さない。指摘は記録に残す）。
 * - 閉じる番に要素を足させる指摘（WE_DO・締め・往復の必須要素・段階）
 * - 本質に約束が無いのに確認の約束を足させる指摘
 * - 本質で触れない／AIX とした項目への「質問に答えていない」
 */
export function issueContradictsContract(issue: { code: string; message?: string; evidence?: string; suggestion?: string }, c: TurnContract | null | undefined, env?: Record<string, string | undefined>): boolean {
  if (!c || c.source !== "brain" || !turnContractFinalCheckEnabled(env)) return false;
  const ADD_CODES = /^(?:WE_DO_MISSING|WE_DO_MISSING_DET|CLOSER_MISSING|PAIR_ELEMENT_MISSING|STAGE_MISMATCH)$/;
  if (c.closeOnly && ADD_CODES.test(issue.code)) return true;
  const msg = `${issue.message ?? ""} ${issue.evidence ?? ""} ${issue.suggestion ?? ""}`;
  if (!c.asks.some(canConfirm) && /確認(?:出来|でき)次第|確認の約束|確認させて|確認宣言/.test(msg) && /(?:足|入れ|加え|書|追加|挿入)/.test(msg)) return true;
  // 刺さりの基準の担当から（10/08）: 段階・撮影の前提の指摘（STAGE_MISMATCH・STAGE_SKIP・PHOTO_NO_PREMISE）が、ブレインの決めた提案（抑える・オンライン内見・撮影）の文に付いて消させていた
  if (c.proposals.length && /^(?:STAGE_MISMATCH|STAGE_SKIP|PHOTO_NO_PREMISE)$/.test(issue.code) && /抑え|撮影|オンライン|動画|写真/.test(msg)) return true;
  // 10/09 調査の担当: 最終チェックのフィードバック再生成で本質の中身を消していた型
  //   提案を押しすぎと見る指摘（UNPROMPTED_PROPOSAL・APPLY_PUSH_NO_INTENT・CONSIDER_PUSH）は、ブレインが決めた提案（proposals）の文なら見送る
  if (/^(?:UNPROMPTED_PROPOSAL|APPLY_PUSH_NO_INTENT|CONSIDER_PUSH)$/.test(issue.code) && c.proposals.some((p) => { const k = p.replace(/[\s（）()「」]/g, "").slice(0, 6); return k.length >= 3 && /抑え|撮影|オンライン|申込/.test(p) && (msg.includes(k) || /抑え|撮影|オンライン|申込/.test(msg)); })) return true;
  //   見積のきっかけが無いと見る指摘（ESTIMATE_NO_TRIGGER）は、ブレインが見積を答え方に入れていれば見送る
  if (issue.code === "ESTIMATE_NO_TRIGGER" && c.asks.some((a) => (a.route === "promise" || a.route === "aix") && /estimate_sheet|見積|初期費用/.test(`${a.aixKey ?? ""} ${a.answer ?? ""}`))) return true;
  //   AIX の関所の指摘（AIX_BOUNDARY_ESTIMATE・AIX_BOUNDARY_VIEWING）は、指摘の文が本質の約束の文（金額・結果の言い切りでない）の時だけ見送る（安全の線＝金額・結果の言い切りはそのまま）
  if (/^AIX_BOUNDARY_(?:ESTIMATE|VIEWING)$/.test(issue.code) && issue.evidence && contractProtectsSentence(c, issue.evidence, env ?? (typeof process !== "undefined" ? process.env : {}))) return true;
  if (issue.code === "MISSED_QUESTION") {
    const hit = c.asks.find((a) => { const k = a.quote.slice(0, 8); return k.length >= 4 && msg.includes(k); });
    if (hit && (hit.route === "none" || hit.route === "aix")) return true;
  }
  return false;
}

/** 出口の確かめ（記録・監査用・本文は変えない）: 本質の仕様に対する下書きの抜け・はみ出し */
export function auditDraftAgainstContract(draft: string, c: TurnContract, lastStaffTexts: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const t = String(draft ?? "").normalize("NFKC");
  if (c.source === "brain" && !c.asks.some(canConfirm) && /確認(?:させて|出来次第|でき次第|しご連絡)/.test(t)) out.push("H4:本質に無い確認の約束");
  if (c.closeOnly && t.replace(/\s/g, "").length > 120) out.push("H5:閉じる番で長い");
  const split = (s: string) => s.split(/(?<=[。！!])\s*|\n+/).map((x) => x.trim()).filter((x) => x.length >= 15 && !/何卒|全力でサポート|お気軽に|ご査収/.test(x));
  const grams = (s: string) => new Set(Array.from({ length: Math.max(s.length - 1, 0) }, (_, i) => s.slice(i, i + 2)));
  const prev = lastStaffTexts.flatMap((p) => split(String(p ?? "").normalize("NFKC"))).map(grams);
  for (const s of split(t)) {
    const g = grams(s);
    if (prev.some((h) => { let hit = 0; for (const x of g) if (h.has(x)) hit++; return (2 * hit) / (g.size + h.size) >= 0.8; })) { out.push(`H1:もう言った文「${s.slice(0, 20)}」`); }
  }
  return [...new Set(out)];
}

/**
 * 確認の約束の関門（confirmation-context の語の判定）にブレインの本質を当てる（竹内さん Q1「本質を勝たせる」）。
 *   本質に約束（promise）が無い → 確認の約束を書かせない／本質に約束がある → 語の判定が「対象なし」でも許す（対象は約束の中身）。
 *   本質が無い・TURN_CONTRACT_CONFIRM_GATE=off は語の判定のまま。
 */
export function applyContractToConfirm<V extends { allowed: boolean; source: string; object: string | null; reason: string }>(v: V, c: TurnContract | null | undefined, env?: Record<string, string | undefined>): V {
  const allow = contractAllowsConfirmPromise(c, env);
  if (allow === null) return v;
  // 10/09: 全 source に当てる（直前の確認の約束の復唱 staff_confirm_promise も＝もう言った事）
  if (!allow && v.allowed) return { ...v, allowed: false, object: null, reason: `本質（ブレイン）に確認・作成の約束が無い（語の判定は ${v.source}）` };
  if (allow && !v.allowed && v.source !== "customer_self_confirm") {
    const p = c!.asks.find(canConfirm);
    return { ...v, allowed: true, source: "brain_confirm_action", object: v.object ?? CONFIRM_OBJECT_BY_TOPIC[p?.topic ?? "other"] ?? "ご質問の件", reason: "本質（ブレイン）が約束にした項目がある" };
  }
  return v;
}

/** 約束の項目の種類 → 確認の対象の言い方（confirmation-context の CONFIRM_OBJECT_LABELS と同じ語） */
const CONFIRM_OBJECT_BY_TOPIC: Partial<Record<RequestTopic, string>> = {
  cost: "初期費用", vacancy: "募集状況", viewing: "ご内覧可否", screening: "保証会社・審査条件", move_in: "ご入居可能日", equipment: "設備・利用条件", contract: "費用・条件交渉の可否",
};

/**
 * 2026-10-09 調査の担当（audit-brain-interference）: 出口の AIX の関所（validate-reply.enforceAixGates）が、本質（ブレイン）が決めた約束の文
 *   （空室の確認の約束・見積の作成の約束・探す約束）を「再宣言」として消し、「かしこまりました！！」だけにしていた（5中4 が邪魔）。
 *   本質に約束（promise・確認や見積の AIX）がある時は、その種類の約束の文を消さない（金額・結果の言い切りは消す＝安全の線はそのまま）。戻す TURN_CONTRACT_PROTECT=off
 */
const PROMISE_SENT_RE = /(?:させて|して)(?:頂|いただ)きます|お送り(?:させて|して)?(?:頂|いただ)?きます|ご連絡(?:させて)?(?:頂|いただ)?きます/;
const RESULT_CLAIM_RE = /[0-9０-９][0-9０-９,，]{2,}\s*円|募集(?:中|終了)(?:です|となります|でした|しております)|空いて(?:おります|います)|ございました/;
export function contractProtectsSentence(c: TurnContract | null | undefined, sentence: string, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  if (!c || c.source !== "brain" || (env.TURN_CONTRACT_PROTECT ?? "").toLowerCase() === "off") return false;
  const s = String(sentence ?? "");
  if (!PROMISE_SENT_RE.test(s) || RESULT_CLAIM_RE.test(s)) return false;
  return c.asks.some((a) => {
    if (a.route !== "promise" && a.route !== "aix") return false;
    const kind = `${a.aixKey ?? ""} ${a.answer ?? ""} ${a.topic}`;
    if (/estimate_sheet|見積|初期費用|cost/.test(kind) && /見積/.test(s)) return true;
    if (/property_check_result|確認|vacancy|equipment|contract|move_in/.test(kind) && /確認/.test(s)) return true;
    if (/property_send|property_recommendation|ピックアップ|探|pickup/.test(kind) && /ピックアップ|お探し/.test(s)) return true;
    return false;
  });
}

/**
 * 2026-10-09 調査の担当: 出口で決定論に差し込む文（初期費用の割引の一文・連絡の日の約束・ポータルの説明）が、本質（ブレイン）の「閉じる番」「言わない事」と食い違っても差し込まれていた。
 *   本質がブレインの判断の時だけ見る（無い時は今まで通り差し込む）。戻す TURN_CONTRACT_POSTPROCESS=off
 */
export type ContractInsertKind = "initial_cost" | "waiting" | "portal";
export function contractSkipsInsertion(c: TurnContract | null | undefined, kind: ContractInsertKind, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  if (!c || c.source !== "brain" || (env.TURN_CONTRACT_POSTPROCESS ?? "").toLowerCase() === "off") return false;
  const ng = c.mustNot.join(" ");
  if (kind === "initial_cost") return c.closeOnly || /初期費用|割引|費用|見積/.test(ng);
  if (kind === "waiting") return /連絡|約束|日付|予定/.test(ng);
  if (kind === "portal") return /ポータル|SUUMO|オトリ|掲載/.test(ng);
  return false;
}

/**
 * 2026-10-09 調査の担当: brain-core の決定論の規則（2段の約束・出し切り・確認します→物件確認した 等）で最終の AIX を変えた時、本質の asks の AIX と食い違ったまま保存されていた。
 *   最終の AIX が無い（返信の番）のに route=aix の項目 → promise に（AIX は約束の後で立つ＝2段）。最終の AIX と違う AIX の項目は記録だけ。
 */
export function reconcileTurnContractWithAix(raw: BrainTurnContractRaw | null, finalAix: string | null, conversationId?: string): BrainTurnContractRaw | null {
  if (!raw || !Array.isArray(raw.asks)) return raw;
  let changed = 0;
  const asks = raw.asks.map((a) => {
    if (a?.route !== "aix") return a;
    if (!finalAix) {
      changed++;
      // 約束の種類が分かるように、元の AIX から約束の中身を足す（見積・探すは「確認」の約束ではない＝isConfirmPromiseAsk）
      const k = String(a.aix ?? "");
      const hint = /estimate_sheet|cost_/.test(k) ? "最大限割引の御見積書を作成しお送り" : /property_send|property_recommendation|property_search|zenryoku/.test(k) ? "ご条件でピックアップしお送り" : /property_check_result|guarantor_info|acknowledge_check/.test(k) ? "確認しご連絡" : null;
      return { ...a, route: "promise", answer: a.answer ?? hint };
    }
    if (a.aix && a.aix !== finalAix) console.log(JSON.stringify({ tag: "brain:tc-aix-mismatch", conversationId: conversationId ?? null, ask: a.aix, final: finalAix }));
    return a;
  });
  if (changed) console.log(JSON.stringify({ tag: "brain:tc-reconciled", conversationId: conversationId ?? null, toPromise: changed }));
  return { ...raw, asks };
}

/** 10/09 試験 q006 q007: 出し切りで全力サポートにした番は、探す・約束の項目を「AIX【全力サポート】（新着待ち）」に直す */
export function exhaustContract(raw: BrainTurnContractRaw | null, exhausted: boolean): BrainTurnContractRaw | null {
  if (!raw || !exhausted || !Array.isArray(raw.asks)) return raw;
  return {
    ...raw,
    asks: raw.asks.map((a) => (a?.route === "promise" || (a?.route === "aix" && /property_send|property_recommendation|property_search/.test(String(a.aix ?? ""))))
      && /探|ピックアップ|お送り|条件|希望|エリア|北側|方面|設備|コンロ/.test(`${a.quote ?? ""}${a.answer ?? ""}`)
      ? { ...a, route: "aix", aix: "zenryoku_support", answer: "そのご希望も含めて新着状況を随時確認し募集に出次第お送り" } : a),
  };
}
