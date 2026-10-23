// app/lib/aix-meaning-learn.ts — AIX のボタン×ピッカーの「意味」を DB から学ぶ時の物差し（純関数・DB/LLM なし）
//
// なぜ（2026-10-22 竹内さん「データベース見たらボタン毎の意味やピッカー毎の意味が分かるから、その意味を理解すればもっと判断の質上がる」）:
//   ＋同日の訂正: 「従業員は正しいボタン・ピッカーを押していない事が多い」→ 意味の基準は 竹内基準（竹内さんの送信・竹内さんの決定）。
//   ・意味（目的・書く中身・次の一手・お手本）は 定義（aix-pickers.ts の when・テンプレートの文・設計知見の竹内さんの決定）と
//     竹内さんが送った AIX（messages.staff_writer='takeuchi'）だけから作る。押された回数（従業員の多数派）から意味を作らない。
//   ・従業員の送信は「押し間違い」を見つける側にだけ使う（送った文の中身が押したピッカーの意味と合わない）。
//   ・竹内さんのお手本が少ないピッカーは「竹内さんに正解を聞く（owner gold）」に回す（作らない）。
// 使う所: scripts/learn-aix-meanings.ts（DB を読んで app/lib/aix-catalog-learned.ts を作る）

/** 送った文の中身の話題（ボタンの意味と比べる単位） */
export type ContentTopic =
  | "estimate" | "amount" | "property_list" | "recommend" | "new_arrival" | "from_sent" | "availability_ok" | "availability_ng"
  | "viewing_dates" | "meeting" | "apply_form" | "apply" | "hearing_form" | "move_in" | "photo" | "guarantor" | "screening"
  | "parking" | "pet" | "equipment" | "phone" | "zenryoku" | "viewing_greeting" | "cost_reason" | "breakdown" | "followup"
  | "daihyo" | "promise" | "rooms" | "contract_terms" | "lifeline" | "two_person" | "proxy" | "negotiation" | "occupant";

export const TOPIC_JA: Record<ContentTopic, string> = {
  estimate: "御見積書", amount: "金額", property_list: "物件の束", recommend: "1件の推し", new_arrival: "新着", from_sent: "送った中から",
  availability_ok: "募集中の結果", availability_ng: "募集終了の結果", viewing_dates: "内覧の日時", meeting: "待ち合わせ", apply_form: "申込フォーマット",
  apply: "申込", hearing_form: "条件ヒアリング", move_in: "入居日・退去日", photo: "室内写真", guarantor: "保証会社", screening: "審査",
  parking: "駐車場", pet: "ペット", equipment: "設備", phone: "電話", zenryoku: "全力サポート", viewing_greeting: "内覧の挨拶",
  cost_reason: "安さの理由", breakdown: "内訳", followup: "追客", daihyo: "代表", promise: "約束", rooms: "号室・部屋数",
  contract_terms: "契約の条件", negotiation: "交渉", lifeline: "ライフライン", two_person: "二人入居", proxy: "代理契約",
  occupant: "入居者の条件（お子様・年齢）",
};

const BRACKETS_RE = /【[^】]{1,40}】/g;
const TOPIC_RES: Array<[ContentTopic, RegExp]> = [
  ["estimate", /御見積書|お見積(?:り)?書?|見積書/],
  ["amount", /[\d,，]{3,}\s*円|\d+(?:\.\d+)?\s*万円/],
  ["recommend", /オススメ|おすすめ|お勧め|イチオシ|特に(?:オススメ|おすすめ)|一押し/],
  ["new_arrival", /新た(?:に|な)|新着|新しく(?:募集|出)|募集に出(?!て(?:い)?ない|ていません)/],
  ["from_sent", /中でも|お送りさせて(?:頂|いただ)きました(?:お部屋|物件)の中/],
  ["availability_ok", /募集中|ご紹介(?:が)?可能|まだ(?:空いて|募集)|空いております|入居可能(?:です|となります)|(?:ご)?内覧(?:が)?可能との|募集(?:されて|して)(?:おり|い)/],
  ["availability_ng", /募集(?:が)?終了|満室|申込(?:み)?(?:が)?入(?:って|り)|埋まって|ご紹介(?:が)?(?:出来|でき)(?:ない|ません|かねます)|専任|募集に出て(?:い)?ない|成約/],
  ["meeting", /待ち合わせ|現地集合|現地にて|集合場所|お待ちしております/],
  ["apply_form", /記入欄|申込書|申込(?:み)?フォーマット|・\s*(?:氏名|お名前)|下記(?:の)?(?:項目|内容)(?:を)?(?:ご)?記入/],
  ["apply", /お申込|お申し込|申込(?:み)?(?:を|の|へ)/],
  ["hearing_form", /ご希望(?:の)?(?:条件|エリア)|①[^\n]*エリア|ご入居(?:希望)?時期|間取り[^\n]{0,6}ご希望|お部屋探し(?:の)?ご?条件|ご希望築年数|ご予算/],
  ["move_in", /入居(?:可能)?日|ご入居可能|退去予定|退去日/],
  ["photo", /室内(?:の)?(?:写真|画像|動画|イメージ)|お写真/],
  ["guarantor", /保証会社/],
  ["screening", /審査/],
  ["parking", /駐車場|駐輪場|バイク/],
  ["pet", /ペット|猫|犬|小型犬/],
  ["equipment", /設備|エアコン|洗濯機|宅配ボックス|インターネット|オートロック|浴室乾燥|独立洗面/],
  ["phone", /お電話/],
  ["zenryoku", /全力で?(?:サポート|お探し)|出次第|見つかり次第|入り次第|見つかりませんでした|引き続き[^\n]{0,24}(?:探|お送り)/],
  ["viewing_greeting", /本日(?:は)?[^\n]{0,12}(?:ご)?内覧|(?:ご)?内覧(?:頂き|いただき)(?:まして)?ありがとう/],
  ["cost_reason", /貸主様?(?:から)?(?:の)?(?:報酬|手数料|広告料)|還元/],
  ["breakdown", /内訳|含まれ(?:て|ます)|込み(?:の|で|となり)/],
  ["followup", /その後(?:の)?|お部屋探し(?:は)?(?:いかが|如何|継続)|ご検討状況/],
  ["daihyo", /代表/],
  ["promise", /確認させて(?:頂|いただ)きます|確認(?:出来|でき)次第|お送りさせて(?:頂|いただ)きます(?:ね)?！|ご連絡させて(?:頂|いただ)きます/],
  ["rooms", /号室|部屋(?:が|も)?(?:空いて|募集)|何部屋|[0-9０-９]+部屋/],
  ["contract_terms", /違約金|短期解約|クリーニング|フリーレント/],
  ["negotiation", /交渉/],
  ["lifeline", /ライフライン|電気|ガス(?:会社)?|水道/],
  ["two_person", /二人入居|2人入居|お二人/],
  // 2026-10-23 入居者の条件について（お子様の入居・年齢）
  ["occupant", /(?:お子様|お子さん|子供|子ども|小学生|中学生|未就学|乳幼児|幼児|乳児)[^\n。！!]{0,14}(?:ご入居|入居|ご同居)|年齢(?:制限|の?条件)/],
  ["proxy", /代理契約/],
];

/** 文の中身の話題（重複なし・出た順） */
export function contentTopicsOf(text: string | null | undefined): ContentTopic[] {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim()) return [];
  const out: ContentTopic[] = [];
  for (const [k, re] of TOPIC_RES) if (re.test(t)) out.push(k);
  if ((t.match(BRACKETS_RE) ?? []).length >= 2 || /ピックアップさせて(?:頂|いただ)きました|お部屋(?:が)?[0-9０-９]+件|[0-9０-９]+件(?:の)?(?:お部屋|物件)/.test(t)) out.push("property_list");
  if (/内覧|内見|ご案内/.test(t) && /\d{1,2}\s*[\/月]\s*\d{1,2}|日時|候補|ご都合|何時|曜日|[0-9]{1,2}\s*時/.test(t) && !out.includes("viewing_greeting")) out.push("viewing_dates");
  return out;
}

/** 文の組み立て（受け／本題／金額／約束／訴求／締め）＝竹内さんの文の型を数える単位 */
export type Structure = { uke: boolean; amount: boolean; promise: boolean; appeal: boolean; close: boolean; lines: number };
export function structureOf(text: string | null | undefined): Structure {
  const t = String(text ?? "").normalize("NFKC");
  const body = t.replace(/^[^\n]{1,16}(?:さん|様)\s*\n/, "");
  return {
    uke: /^(?:お世話になっております|かしこまりました|承知(?:致し|いたし)ました|ありがとうございます|ご連絡ありがとう|お待たせ)/.test(body.trim()),
    amount: /[\d,，]{3,}\s*円|\d+(?:\.\d+)?\s*万円/.test(t),
    promise: /させて(?:頂|いただ)きます|次第(?:ご連絡|お送り)/.test(t),
    appeal: /オススメ|おすすめ|人気|早い者勝ち|お早めに|お得|最大限|割引|内覧(?:可能|出来|でき)|如何でしょうか|いかがでしょうか/.test(t),
    close: /何卒|よろしくお願い(?:致し|いたし)?ます|宜しくお願い/.test(t),
    lines: t.split(/\n+/).filter((l) => l.trim()).length,
  };
}

/** お客様の直前の発言の大まかな意図（前に来る物の数え方） */
export type CustomerIntent = "費用" | "内覧" | "申込・審査" | "条件" | "物件の共有" | "物件の質問" | "お礼・了承" | "検討中" | "なし" | "その他";
export function customerIntentOf(text: string | null | undefined): CustomerIntent {
  const t = String(text ?? "").normalize("NFKC").trim();
  if (!t) return "なし";
  if (/https?:\/\/|\[画像\]/.test(t)) return "物件の共有";
  if (/初期費用|見積|費用|安く|割引|いくら|敷金|礼金/.test(t)) return "費用";
  if (/申込|申し込|審査|保証|契約|書類/.test(t)) return "申込・審査";
  if (/内覧|内見|見学|見に行|日程|何時/.test(t)) return "内覧";
  if (/検討|考えます|相談します|また連絡/.test(t)) return "検討中";
  if (/家賃|万|LDK|[1-4]K|エリア|駅|条件|探して/.test(t)) return "条件";
  if (/[？?]|ですか|ますか/.test(t)) return "物件の質問";
  if (t.length <= 40 && /ありがと|了解|承知|かしこまり|わかりました|分かりました|お願い|おねがい|よろしく|宜しく|はい|大丈夫/.test(t)) return "お礼・了承";
  return "その他";
}

// ─── ピッカーの意味と送った文の中身が合うか（押し間違いの網） ─────────────────────────────────

/**
 * 鍵（ボタン か ボタン/ピッカー）ごとに「文に入っているはずの話題」（どれか1つ）。定義（aix-pickers.ts の when・カタログの staffOnly）から書いた物。
 *   入っていなければ押し間違いの候補（中身から見て、どのボタンの意味に近いかを suggestKeyFor で添える）。
 */
export const EXPECTED_TOPICS: Record<string, readonly ContentTopic[]> = {
  estimate_sheet: ["estimate", "amount"],
  "property_check_result/available": ["availability_ok", "estimate"],
  "property_check_result/unavailable": ["availability_ng"],
  "property_check_result/alternative": ["availability_ok", "availability_ng", "rooms"],
  "property_check_result/exclusive": ["availability_ng"],
  "property_check_result/mgmt_availability": ["availability_ok", "availability_ng"],
  "property_check_result/move_in_date": ["move_in"],
  "property_check_result/mgmt_move_in": ["move_in"],
  "property_check_result/vacate_date": ["move_in"],
  "property_check_result/interior_photo": ["photo"],
  "property_check_result/other_room_check": ["rooms", "availability_ok", "availability_ng"],
  "property_check_result/room_vacancies": ["rooms"],
  "property_check_result/mgmt_parking": ["parking"],
  "property_check_result/nearby_parking": ["parking"],
  "property_check_result/mgmt_pet": ["pet"],
  "property_check_result/mgmt_equipment": ["equipment"],
  "property_check_result/mgmt_guarantor": ["guarantor", "screening"],
  "property_check_result/mgmt_screening": ["screening", "guarantor"],
  "property_check_result/mgmt_application_status": ["apply", "screening"],
  "property_check_result/mgmt_initial_cost": ["amount", "estimate", "daihyo", "negotiation"],
  "property_check_result/mgmt_rent_negotiation": ["amount", "negotiation"],
  "property_check_result/mgmt_contract_terms": ["contract_terms"],
  "property_check_result/mgmt_lifeline": ["lifeline"],
  "property_check_result/mgmt_two_person": ["two_person"],
  "property_check_result/mgmt_occupant": ["occupant"],
  "property_check_result/mgmt_proxy": ["proxy"],
  property_send: ["property_list", "new_arrival"],
  property_recommendation: ["recommend", "new_arrival", "from_sent"],
  // 新着1件・継続ピックアップは「いつ出すか」（前に送った束との間）で分かれる＝文の語では決まらない（1件の推しが入っていればよい）
  viewing_invite: ["viewing_dates"],
  meeting_place: ["meeting"],
  "application_push/format": ["apply_form"],
  "application_push/confirm": ["apply", "apply_form"],
  "application_push/push": ["apply"],
  condition_hearing: ["hearing_form"],
  zenryoku_support: ["zenryoku"],
  cost_explain: ["cost_reason"],
  cost_breakdown: ["breakdown", "amount", "estimate"],
  guarantor_info: ["guarantor"],
  phone_call: ["phone"],
  "acknowledge_check/daihyo_initial_cost": ["daihyo"],
  followup_revive: ["followup"],
};

/** 鍵に当てる期待（ピッカーまでの鍵が無ければボタンの鍵） */
export function expectedTopicsFor(key: string): readonly ContentTopic[] | null {
  return EXPECTED_TOPICS[key] ?? EXPECTED_TOPICS[key.split("/")[0]] ?? null;
}

/** 結果を送るボタン（確認の約束だけの文はこのボタンの意味ではない＝結果が出てから押す物） */
const RESULT_BUTTONS = new Set(["property_check_result", "estimate_sheet", "meeting_place", "cost_breakdown"]);

export type MisPress = { reason: string; suggest: string | null };
/**
 * 押したピッカーの意味と送った文の中身が合わない時に理由を返す（null＝合う・判断できない）。
 *   文が短すぎる（画像だけ・固定の短い文）時は判断しない。
 */
export function misPressOf(key: string, text: string | null | undefined): MisPress | null {
  const t = String(text ?? "").normalize("NFKC");
  if (t.replace(/\s/g, "").length < 25) return null;
  const topics = contentTopicsOf(t);
  const exp = expectedTopicsFor(key);
  const btn = key.split("/")[0];
  // 結果のボタンで約束だけ（結果の話題が無い）
  if (RESULT_BUTTONS.has(btn) && topics.includes("promise") && exp && !exp.some((x) => topics.includes(x))) {
    return { reason: "結果のボタンで確認・作成の約束だけを送った（約束は返信・結果が出てから AIX）", suggest: "返信（約束）" };
  }
  if (!exp) return null;
  if (exp.some((x) => topics.includes(x))) {
    // 似たピッカーの取り違え（中身ははっきり別のピッカー）
    if (key === "property_recommendation/新着1件" && topics.includes("from_sent") && !topics.includes("new_arrival")) return { reason: "「送った中から」の文を 新着1件 で送った", suggest: "property_recommendation/継続ピックアップ" };
    if (btn === "viewing_invite" && topics.includes("meeting") && !/候補|ご都合/.test(t)) return { reason: "待ち合わせ（日時の確定と場所）を 内覧日調整 で送った", suggest: "meeting_place" };
    // 物件あった＋御見積書の同封は定義どおり（aix-pickers の when）＝押し間違いにしない
    return null;
  }
  return { reason: `押したピッカーの意味（${exp.map((x) => TOPIC_JA[x]).join("／")}）が文に無い`, suggest: suggestKeyFor(topics) };
}

/** 文の中身から近い鍵（押し間違いの「こちらでは」の候補・手打ちの文の AIX の候補） */
export function suggestKeyFor(topics: readonly ContentTopic[]): string | null {
  const has = (k: ContentTopic) => topics.includes(k);
  if (has("apply_form")) return "application_push/format";
  if (has("meeting")) return "meeting_place";
  if (has("estimate") && has("amount")) return "estimate_sheet";
  if (has("hearing_form")) return "condition_hearing";
  if (has("availability_ng")) return "property_check_result/unavailable";
  if (has("availability_ok")) return "property_check_result/available";
  if (has("viewing_dates")) return "viewing_invite";
  if (has("photo")) return "property_check_result/interior_photo";
  if (has("move_in")) return "property_check_result/mgmt_move_in";
  if (has("property_list")) return "property_send";
  if (has("recommend")) return "property_recommendation";
  if (has("zenryoku")) return "zenryoku_support";
  return null;
}

/**
 * 手打ちの文（AIX でない送信）のうち、AIX の結果を送っている物（竹内さんの決定 H3「手打ちの管理会社の答えは AIX が正解」）。
 *   はっきりした物だけ（御見積書の金額・待ち合わせ・申込フォーマット・募集の結果で約束でない）。null＝手打ちでよい。
 */
export function handTypedAixTopic(text: string | null | undefined): string | null {
  const t = String(text ?? "").normalize("NFKC");
  if (t.replace(/\s/g, "").length < 25) return null;
  const tp = contentTopicsOf(t);
  const has = (k: ContentTopic) => tp.includes(k);
  if (has("apply_form") && /記入欄|・\s*(?:氏名|お名前)/.test(t)) return "application_push/format";
  if (has("estimate") && (t.match(/[\d,，]{3,}\s*円/g) ?? []).length >= 3) return "estimate_sheet";
  if (has("meeting") && /内覧|内見/.test(t) && /\d{1,2}\s*[\/月:]\s*\d{1,2}|\d{1,2}\s*時/.test(t)) return "meeting_place";
  if (!has("promise") && /管理会社(?:様)?(?:に|へ)?(?:確認|問い合わせ|お問合せ)(?:致し|いたし|し)ました|確認(?:が)?取れ/.test(t) && (has("availability_ok") || has("availability_ng"))) return has("availability_ng") ? "property_check_result/unavailable" : "property_check_result/available";
  return null;
}

// ─── お手本の伏せ方（保存してよい形） ─────────────────────────────────────────────────────

/** お手本に残さない物: 物件名（【】の中）・住所・URL・電話・メール・数字の多い行。名前の伏せは呼ぶ側（maskExamText）で先に行う */
export function maskExemplar(text: string): string {
  return String(text ?? "")
    .replace(/【[^】]{1,40}】/g, "【物件名】")
    // 2026-10-22 レビュー: 号室はお客様の住む部屋（物件名＋号室＋入居日でお客様に近づく）＝伏せる
    .replace(/[0-9０-９]{1,5}\s*号室/g, "〇〇号室")
    // 2026-10-23 レビュー: 「…Eminence 1212」「…星田303」の様に物件名の後の部屋番号（3〜4桁）も伏せる
    .replace(/([A-Za-zぁ-んァ-ヶ一-龠ー])[ 　]?[0-9０-９]{3,4}(?![0-9０-９,.，円万千年月日時分秒㎡%％件人歳回階号kKmM])/g, "$1 〇〇〇")
    .replace(/[A-Za-z][A-Za-z0-9_.-]{0,15}(さん|様)/g, (m0, h) => (/^YUMA/.test(m0) ? m0 : `YUMA${h}`))
    .replace(/https?:\/\/[^\s　]+/g, "（URL）")
    .replace(/[^\n]*(?:住所|〒|丁目|番地|[0-9０-９]+\s*-\s*[0-9０-９]+\s*-\s*[0-9０-９]+)[^\n]*/g, "（住所の行）")
    .replace(/0\d{1,4}[-ー－]?\d{1,4}[-ー－]?\d{3,4}/g, "（電話番号）")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "（メール）")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── 学んだ意味（生成するデータの形） ─────────────────────────────────────────────────────

export type LearnedMeaning = {
  key: string;
  /** 目的（定義から: カタログの staffOnly・when＋竹内さんの決定の要点） */
  purpose: string;
  /** 竹内さんの送信で多い中身（話題の割合 ≥40%・竹内さんの送信 3件以上の時だけ） */
  writeContains: string[];
  /** 竹内さんの送信の型（受け・金額・約束・訴求・締めの割合） */
  structure: { uke: number; amount: number; promise: number; appeal: number; close: number } | null;
  /** 竹内さんの送信の後に多い次の一手（お客様の返事の意図・次の AIX）。少ない時は空 */
  nextStep: string[];
  /** 竹内さんの送信の前に多いお客様の発言の意図 */
  before: string[];
  /** 竹内さんのお手本（伏せた文・最大3） */
  exemplars: string[];
  /** 竹内さんの送信の数・全部の送信の数・押し間違いの候補の数（従業員） */
  counts: { owner: number; all: number; misPressStaff: number; misPressOwner: number };
  /** 竹内さんのお手本が足りない（3未満）＝竹内さんに正解を聞く */
  needsOwnerGold: boolean;
  /** 関係する竹内さんの決定（設計知見 id の先頭8字） */
  kb: string[];
  /**
   * 2026-10-23 竹内さんの手打ちで、本来はこのピッカーで送る物（aix-should-be.shouldBeAixOf がはっきり当てた文）のお手本の候補（伏せた文・最大3）。
   *   竹内さん 10/22 d04ed51b「手打ちの良い文はそのピッカーのお手本に足す」。AIX の送信のお手本（exemplars）とは分けて持つ（候補＝人が確かめて使う）
   */
  handExemplars?: string[];
  /** 本来はこのピッカーの竹内さんの手打ちの数（はっきり当てた物） */
  ownerHand?: number;
};

/** 割合の高い順に label (xx%) を返す（min 以上・最大 n） */
export function topShares(counts: Record<string, number>, total: number, o: { min?: number; n?: number } = {}): string[] {
  if (!total) return [];
  return Object.entries(counts)
    .map(([k, v]) => [k, v / total] as const)
    .filter(([, r]) => r >= (o.min ?? 0.2))
    .sort((a, b) => b[1] - a[1])
    .slice(0, o.n ?? 3)
    .map(([k, r]) => `${k}（${Math.round(r * 100)}%）`);
}

/**
 * 定型の文（テンプレートの固定行・フォームの項目）から正規表現が拾うだけの話題＝意味ではない（2026-10-22 レビュー）。
 *   例: 御見積書の「※ご入居日によって日割家賃」→ 入居日 99%／内訳の「1日でのご入居がオススメ」→ 1件の推し／条件ヒアリングの項目「駐車場等」→ 駐車場 100%。
 */
export const BOILERPLATE_TOPICS: Record<string, readonly ContentTopic[]> = {
  estimate_sheet: ["move_in", "breakdown"],
  cost_breakdown: ["recommend", "move_in"],
  condition_hearing: ["parking", "pet", "move_in", "equipment", "guarantor", "amount", "two_person"],
};
/** writeContains から定型の文の話題を外した物（ブレイン・生成に見せる中身） */
export function meaningfulWriteContains(m: LearnedMeaning): string[] {
  const bad = new Set((BOILERPLATE_TOPICS[m.key.split("/")[0]] ?? []).map((k) => TOPIC_JA[k]));
  return m.writeContains.filter((w) => !bad.has(w.replace(/（\d+%）$/, "")));
}

/** ブレインに渡す1行（ピッカーの行に添える・短く） */
export function learnedLine(m: LearnedMeaning | undefined): string {
  if (!m) return "";
  const parts: string[] = [];
  const wc = meaningfulWriteContains(m);
  if (wc.length) parts.push(`竹内さんの文の中身: ${wc.slice(0, 2).join("・")}`);
  if (m.nextStep.length) parts.push(`次: ${m.nextStep.slice(0, 1).join("・")}`);
  if (m.needsOwnerGold) parts.push(`竹内さんのお手本 ${m.counts.owner}件（少ない・定義で判断）`);
  if (m.counts.misPressStaff >= 3) parts.push(`押し間違いが多い（${m.counts.misPressStaff}件）＝中身で選ぶ`);
  return parts.join("｜");
}

// ─── 似たボタン・ピッカーの組（試験の候補・竹内さんに正解を聞く番） ─────────────────────────────

/** 取り違えやすい組（定義の lines から）。試験に使う時は topicKey が違う物どうしだけを比べる */
export const SIMILAR_GROUPS: ReadonlyArray<{ name: string; keys: readonly string[] }> = [
  { name: "束か1件か", keys: ["property_send", "property_recommendation"] },
  { name: "探した結果あり/なし", keys: ["property_send", "zenryoku_support"] },
  { name: "保証会社・審査", keys: ["guarantor_info", "property_check_result/mgmt_guarantor", "property_check_result/mgmt_screening"] },
  { name: "費用（交渉・見積・内訳・理由・代表）", keys: ["estimate_sheet", "property_check_result/mgmt_initial_cost", "acknowledge_check", "cost_breakdown", "cost_explain"] },
  { name: "内覧の候補日か確定か", keys: ["viewing_invite", "meeting_place"] },
  { name: "別の部屋・号室", keys: ["property_check_result/other_room_check", "property_check_result/room_vacancies", "property_check_result/alternative"] },
  { name: "室内写真か募集状況か", keys: ["property_check_result/interior_photo", "property_check_result/available"] },
  { name: "入居日の2つ", keys: ["property_check_result/move_in_date", "property_check_result/mgmt_move_in", "property_check_result/vacate_date"] },
  { name: "駐車場（物件か近隣か）", keys: ["property_check_result/mgmt_parking", "property_check_result/nearby_parking"] },
  { name: "申込の後押しか手続きか", keys: ["application_push/push", "application_push/confirm", "application_push/format"] },
];

/** 鍵が入る組（ボタンの鍵も、ピッカーの鍵のボタンの部分でも当てる） */
export function groupsOfKey(key: string): Array<{ name: string; keys: readonly string[]; hit: string }> {
  const btn = key.split("/")[0];
  const out: Array<{ name: string; keys: readonly string[]; hit: string }> = [];
  for (const g of SIMILAR_GROUPS) {
    const hit = g.keys.find((k) => k === key) ?? g.keys.find((k) => !k.includes("/") && k === btn);
    if (hit) out.push({ ...g, hit });
  }
  return out;
}
