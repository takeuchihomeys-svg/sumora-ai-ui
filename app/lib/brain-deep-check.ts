// app/lib/brain-deep-check.ts — ブレインが「根拠が足りない」時だけ、足りない種類の材料を追加で引いて、もう1回だけ判断させる（純関数・DB/LLM なし）
//
// 2026-10-15 竹内さん（設計知見 56ecf24a・P1）「自信が無い時・根拠が見つからない時は深く調査する等、さらに深く考える人間的な動きをブレインが出来れば質がよくなる」
//   「全部に毎回かけない（質が上がり無駄な API を使わない）」。管理会社しか知らない事は AIX で答える（確認の約束→管理会社に確認→AIX【物件確認した】）が正しい（10/14）。
// 決まり（P0 9eb6aa9c ブレイン基準・0593a0aa）:
//   ・「自信が無い」はブレイン自身が出す欄（turn_contract.asks[].gap＝"material"）が主。網（決定論）は ブレインがその欄を出さなかった時の候補だけ
//     （約束 route=promise の依頼の言葉が資料で答えられる型に当たり、管理会社しか知らない事の語が無い）。
//   ・追加で引く材料は「足りない型」の分だけ（設備・契約条件・間取り/広さ・入居時期/手続き・会社の事実・過去の会話の該当行）。
//     1回目に同じ材料が既に入っていた／何も見つからなかった時は2回目を呼ばない（同じ答えになる）。
//   ・2回目の判断で返信にするか約束にするかはブレインが決める（ここは材料を足すだけ・答えを上書きしない）。
//   ・安全の線: 管理会社しか知らない事（空き・募集・内覧の可否/日程・審査・交渉・見積の金額・写真）はかけない。申込以降もかけない。
// 戻す: BRAIN_DEEP_CHECK=off（全部・旧の1回だけ）／BRAIN_DEEP_CHECK_NET=off（ブレインの欄だけで決め、網の候補を使わない）
// 物差し: scripts/audit-brain-deep-check.ts（30日・倒れた番×手元の材料×人の答え）

export type DeepCheckTopic =
  | "parking" | "pet" | "deposit_key" | "guarantor" | "move_in" | "layout" | "equipment" | "internet"
  | "occupancy" | "renewal" | "access" | "building" | "company" | "procedure" | "meeting";

export const DEEP_CHECK_TOPIC_JA: Record<DeepCheckTopic, string> = {
  parking: "駐車場・駐輪場", pet: "ペット", deposit_key: "敷金・礼金", guarantor: "保証会社・保証人", move_in: "入居時期・退去予定",
  layout: "間取り・広さ・水回り", equipment: "設備", internet: "インターネット", occupancy: "入居者の条件（二人入居・子ども・楽器・法人）",
  renewal: "更新料", access: "駅・徒歩", building: "築年・構造・建物", company: "会社の事実", procedure: "手続き（審査の期間・必要書類）",
  meeting: "待ち合わせ・当日の段取り",
};

const TOPIC_Q: Array<[DeepCheckTopic, RegExp]> = [
  ["parking", /駐車場|駐輪|パーキング|バイク置|車(?:で|は)(?:行|停|止)/],
  ["pet", /ペット|犬|猫/],
  ["deposit_key", /敷金|礼金|保証金|敷引|契約一時金/],
  ["guarantor", /保証会社|保証人/],
  ["move_in", /入居(?:可能|時期|日|でき|って)|いつから(?:住|入)|退去予定|即入居|いつ(?:頃)?(?:空|入れ)/],
  ["layout", /間取り|何帖|何畳|広さ|平米|㎡|洗面|トイレ|お風呂|浴室|ロフト|収納|クローゼット|何階|角部屋|日当たり|向き/],
  ["equipment", /エアコン|コンロ|IH|オートロック|宅配|エレベーター|独立洗面|追い?焚|浴室乾燥|洗濯(?:機|パン|置)|室内干し|ウォシュレット|温水洗浄|モニター|設備|ベランダ|バルコニー/],
  ["internet", /インターネット|ネット(?:無料|回線|環境|使|は|って)|wi-?fi|光回線/i],
  ["occupancy", /二人(?:入居|で住)|2人(?:入居|で住)|同棲|ルームシェア|子ども|子供|お子様|赤ちゃん|楽器|ピアノ|事務所|SOHO|法人(?:契約|名義)|学生|高齢/],
  ["renewal", /更新料|更新(?:は|って|の費用)/],
  ["access", /駅(?:から|まで)|徒歩(?:何|で)|何分|最寄り/],
  ["building", /築(?:何|年)|何年(?:築|前)|構造|鉄筋|鉄骨|木造|防音|音(?:は|って|が)(?:響|気に)/],
  ["meeting", /待ち合わせ|集合|現地(?:集合|で)|どこに(?:行|向か|集ま)|(?:車|パーキング)[^。\n]{0,10}(?:停め|止め)/],
];
const QUESTION_RE = /[?？]|ですか|ますか|でしょうか|ますでしょう|ありますか|あります？|(?:な|の)(?:感じ|ん)(?:です|でしょう)?か|ですよね|ますよね|どう(?:です|なって|でしょう)|どんな|知りたい|教えて|不可|可能/;
/** 探す条件・希望の文（「〜な部屋ありますか」「〜がいい」）は資料の質問ではない */
const NOT_Q_RE = /(?:部屋|物件|ところ|とこ|マンション|アパート)(?:で|は|って|が|も)?(?:ありますか|あります？|ない(?:です|でしょう)?か|ありませんか|紹介)|探して|ピックアップ|がいい|が良い|希望(?:です|します)|①【|【ご希望/;

/**
 * 管理会社しか知らない事（AIX が正しい・竹内さん 10/14）。ここに当たる依頼は追加の調査をかけない。
 * 空き・募集・内覧の可否と日程・審査の結果や通りやすさ・交渉・見積の金額・写真・申込の状況
 */
// 10/15 レビュー（30日の実データで取りこぼし）: 「募集終わって」「空きはありますか」「見に行けますか」「礼金下げる」「少し安くなったり」
//   「初期費用はだいたいどのぐらい」「初期費用30万以内にできない」を足した（初期費用の払い方・時期は会社の事実なので外す）
export const STAFF_ONLY_RE = /空いて|空き(?!家)|空室|募集|埋ま|まだ(?:あり|ある)|内覧|内見|見学|見に行|審査|通り(?:ます|そう|やす|づら|にく)|交渉|値下|値引|下げ|減額|安く(?:なり|なっ|でき|なら|して)|割引|見積|初期費用(?![^。\n]{0,12}(?:支払|払い|振込|カード|現金|分割|いつ))|総額|いくら(?:に|くらい|ぐらい)|写真|動画|申込(?:状況|入って)|進捗/;

/** お客様の問いの型（決定論の網・候補を拾うだけ）。質問の文の中の語だけを見る */
export function classifyDeepCheckTopics(text: string | null | undefined): DeepCheckTopic[] {
  const units = String(text ?? "").split("⁣").map((u) => u.trim())
    .filter((u) => u && !/^\[(?:画像|動画|スタンプ|ファイル)\]/.test(u) && !/【物件の(?:資料|画面|写真)】|by SUUMO|https?:\/\//.test(u));
  const out = new Set<DeepCheckTopic>();
  for (const s of units.join("\n").normalize("NFKC").split(/(?<=[。！!？?\n])/).map((x) => x.trim()).filter(Boolean)) {
    // 10/15 レビュー: 管理会社しか知らない事の文（「礼金下げられますか」「この物件の見積と入居可能日を」）は型に数えない
    if (!QUESTION_RE.test(s) || NOT_Q_RE.test(s) || STAFF_ONLY_RE.test(s)) continue;
    for (const [k, re] of TOPIC_Q) if (re.test(s)) out.add(k);
  }
  return [...out];
}

export function brainDeepCheckEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_DEEP_CHECK ?? "").trim().toLowerCase() !== "off";
}
/** gap 欄（ブレインの出力の指定と規則）を出すか。全部の番のブレインの出力の指定が変わるので、網とは別に止められるようにする（10/15 レビュー） */
export function brainDeepCheckGapEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return brainDeepCheckEnabled(env) && (env.BRAIN_DEEP_CHECK_GAP ?? "").trim().toLowerCase() !== "off";
}
export function brainDeepCheckNetEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return brainDeepCheckEnabled(env) && (env.BRAIN_DEEP_CHECK_NET ?? "").trim().toLowerCase() !== "off";
}

/** ブレインの出力の指定に足す1行（turn_contract.asks の1つずつに付ける欄の説明） */
export const BRAIN_DEEP_CHECK_ASK_FIELD = `"gap": "確認の約束（promise）や確認の AIX（property_check_result 等）にした依頼で、資料・会話・会社の事実に書いてあれば返信で答えられる事なのに、渡された材料に根拠が見つからない時だけ \\"material\\"。管理会社・スタッフしか知らない事（空き・内覧の可否・審査・交渉・見積の金額・写真）は \\"staff\\"。根拠がある・関係ない時は null"`;

/** ブレインの判断の仕方に足す短い規則 */
export const BRAIN_DEEP_CHECK_RULE = `- gap（根拠の足りなさの印・竹内さん 10/15「自信が無い時だけ深く調べる」）: 資料・会話・会社の事実で答えられる種類の問い（設備・駐車場・ペット・敷金礼金・保証会社・入居時期・間取り・広さ・待ち合わせ 等）なのに、渡された材料に答えが見つからず確認の約束（promise）や確認の AIX にした依頼だけ gap="material" を付ける（コードが材料を追加で調べて、もう1回だけ判断を頼む）。分かっている時・管理会社しか知らない時は付けない。`;

export type DeepCheckAsk = { quote: string; route: string | null; gap: string | null; basis: string | null; aix: string | null };
/** 追加の調査の対象にする AIX（確認の AIX だけ。物件の送付・探す・内覧 等の AIX の依頼にはかけない・10/15 レビュー） */
const CHECK_AIX_RE = /^(?:property_check_result|acknowledge_check|other_room_check)$/;
/** 約束か確認の AIX の依頼か */
function checkRoute(a: DeepCheckAsk): boolean {
  return a.route === "promise" || (a.route === "aix" && (!a.aix || CHECK_AIX_RE.test(a.aix)));
}

/** ブレインの出力（parsed.turn_contract）から依頼を読む */
export function readContractAsks(parsed: Record<string, unknown> | null | undefined): DeepCheckAsk[] {
  const c = parsed?.turn_contract as { asks?: unknown } | null | undefined;
  if (!c || !Array.isArray(c.asks)) return [];
  return (c.asks as Array<Record<string, unknown>>).filter((a) => a && typeof a === "object").map((a) => ({
    quote: typeof a.quote === "string" ? a.quote : "",
    route: typeof a.route === "string" ? a.route : null,
    gap: typeof a.gap === "string" ? a.gap : null,
    basis: typeof a.basis === "string" ? a.basis : null,
    aix: typeof a.aix === "string" ? a.aix : null,
  }));
}

export type DeepCheckDecision = {
  /** 追加の調査をかけるか */
  run: boolean;
  /** brain＝ブレインが gap=material を出した／net＝約束の依頼の言葉が資料で答えられる型（網） */
  by: "brain" | "net" | null;
  /** 調べる言葉（依頼の quote・無ければお客様の番の文） */
  queries: string[];
  topics: DeepCheckTopic[];
  reason: string;
};

/**
 * 追加の調査をかけるか（1回目のブレインの判断の後・決定論）。
 * ①ブレインが gap="material" を出した依頼（管理会社しか知らない事の語が無い物）→ かける
 * ②（網・BRAIN_DEEP_CHECK_NET）gap が1つも無い出力で、route=promise の依頼の言葉が資料で答えられる型に当たり、管理会社しか知らない事の語が無い → かける
 */
export function decideDeepCheck(i: {
  parsed: Record<string, unknown> | null | undefined;
  customerText: string;
  postApply: boolean;
  env?: Record<string, string | undefined>;
}): DeepCheckDecision {
  const env = i.env ?? (typeof process !== "undefined" ? process.env : {});
  const none = (reason: string): DeepCheckDecision => ({ run: false, by: null, queries: [], topics: [], reason });
  if (!brainDeepCheckEnabled(env)) return none("off");
  if (i.postApply) return none("post_apply");
  const asks = readContractAsks(i.parsed);
  // 返信で答えた依頼（route=reply）は印があってもかけない（10/15 試験 q146: 答えた依頼に gap が付き、2回目で約束に倒れた）
  const brainGaps = asks.filter((a) => a.gap === "material" && checkRoute(a) && a.quote.trim() && !STAFF_ONLY_RE.test(a.quote));
  if (brainGaps.length) {
    const topics = [...new Set(brainGaps.flatMap((a) => classifyDeepCheckTopics(questionize(a.quote))))];
    return { run: true, by: "brain", queries: brainGaps.map((a) => a.quote), topics, reason: "brain_gap" };
  }
  if (!brainDeepCheckNetEnabled(env)) return none("no_brain_gap");
  // ブレインが gap 欄を1つでも出していれば（null を含む）ブレインの判断に任せる＝網は出さない
  if (asks.some((a) => a.gap !== null)) return none("brain_judged");
  const promised = asks.filter((a) => checkRoute(a) && a.quote.trim() && !STAFF_ONLY_RE.test(a.quote));
  const hits = promised.map((a) => ({ a, topics: classifyDeepCheckTopics(questionize(a.quote)) })).filter((x) => x.topics.length);
  if (!hits.length) return none(asks.length ? "no_promise_topic" : "no_asks");
  // 網の確かめ: お客様の文にも同じ型の質問がある（ブレインの言い換えだけで当たった物は外す）
  const turnTopics = new Set(classifyDeepCheckTopics(i.customerText));
  const both = hits.filter((x) => x.topics.some((t) => turnTopics.has(t)));
  if (!both.length) return none("turn_not_question");
  return { run: true, by: "net", queries: both.map((x) => x.a.quote), topics: [...new Set(both.flatMap((x) => x.topics.filter((t) => turnTopics.has(t))))], reason: "net_promise_topic" };
}

/**
 * 2回目の判断を使うか（安全の線）: 追加の材料で返信で答えた依頼が増えた時だけ使う。
 *   増えない（やはり確認の約束・AIX）時は1回目の判断のまま＝空振りの2回目で AIX の種類・2段の印が揺れない
 *   （10/15 試験 q149 q151: 2回目が aix→promise に言い換え、2段の印が消えて返信になった）
 */
export function adoptSecondJudgement(
  first: Record<string, unknown> | null | undefined,
  second: Record<string, unknown> | null | undefined,
  /** 追加の調査をかけた依頼の言葉（1回目の quote）。ここに無い約束・AIX の依頼は2回目でも減らさない */
  queries: ReadonlyArray<string> = [],
): { adopt: boolean; firstReply: number; secondReply: number; reason: string } {
  const replies = (p: Record<string, unknown> | null | undefined) => readContractAsks(p).filter((a) => a.route === "reply").length;
  const f = replies(first), s = replies(second);
  if (!second || s <= f) return { adopt: false, firstReply: f, secondReply: s, reason: "no_more_reply" };
  // 10/15 レビュー: 調べた依頼の外の約束・AIX（管理会社に確認する事・物件の AIX）が2回目で消えると AIX の種類・2段の印が落ちる → その時は1回目のまま
  const q = new Set(queries.map((x) => x.trim()));
  const others = readContractAsks(first).filter((a) => (a.route === "promise" || a.route === "aix") && !q.has(a.quote.trim()));
  if (others.length) {
    const kept = readContractAsks(second).filter((a) => a.route === "promise" || a.route === "aix").length;
    if (kept < others.length) return { adopt: false, firstReply: f, secondReply: s, reason: "lost_other_promise" };
    const fa = String((first as { aix?: unknown } | null | undefined)?.aix ?? "").trim();
    const sa = String((second as { aix?: unknown }).aix ?? "").trim();
    if (others.some((a) => a.route === "aix") && fa !== sa) return { adopt: false, firstReply: f, secondReply: s, reason: "aix_changed" };
  }
  return { adopt: true, firstReply: f, secondReply: s, reason: "more_reply" };
}

/** ブレインの quote（「駐車場の有無」等の名詞止め）を網に当たる質問の形にする */
function questionize(q: string): string {
  const t = q.trim();
  return QUESTION_RE.test(t) ? t : `${t}ですか？`;
}

/** 追加の材料が1回目に無かった物か（同じ文が既に入っていれば足さない） */
export function newMaterialOnly(notes: ReadonlyArray<string | null | undefined>, already: string): string[] {
  const out: string[] = [];
  for (const n of notes) {
    const t = String(n ?? "").trim();
    if (!t) continue;
    const head = t.slice(0, 80);
    if (already.includes(head)) continue;
    if (out.some((o) => o.slice(0, 80) === head)) continue;
    out.push(t);
  }
  return out;
}

/** 2回目の判断に足す材料のブロック */
export function deepCheckBlock(i: { queries: string[]; notes: string[] }): string {
  return `\n\n【追加で調べた材料（1回目の判断で根拠が見つからなかった依頼: ${i.queries.map((q) => `「${q.slice(0, 40)}」`).join("・")}）】
※1回目の判断では、この依頼の答えが材料に見つからず確認の約束にした。追加で資料・会話・会社の事実を調べた結果が下。ここに答えがあれば返信で答え（basis を material/conversation/company_fact に）、書いていない・言い切れない時は1回目と同じ判断（同じ route・同じ AIX）のままにする。管理会社しか知らない事（空き・内覧の可否・審査・交渉・見積の金額）は書いてあっても約束・AIX のまま。gap は付けない。
${i.notes.join("\n\n")}`;
}

/** 過去の会話から依頼の型の語がある行（こちらが前に言った文・お客様が貼った物件の文）を拾う（最大6行・新しい順） */
export function pastConversationLines(i: {
  messages: ReadonlyArray<{ sender: string; text: string | null; created_at: string }>;
  topics: ReadonlyArray<DeepCheckTopic>;
  beforeMs: number;
  max?: number;
  /** 型に当たらない依頼（火災保険・フリーレント 等）は依頼の言葉の語で探す（queryKeywords） */
  keywords?: ReadonlyArray<string>;
}): string[] {
  const res = i.topics.map((t) => PAST_LINE_RE[t]).filter(Boolean) as RegExp[];
  const kws = (i.keywords ?? []).filter((k) => k.length >= 2);
  if (kws.length) res.push(new RegExp(kws.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")));
  if (!res.length) return [];
  const out: string[] = [];
  const msgs = [...i.messages].filter((m) => Date.parse(m.created_at) < i.beforeMs).reverse();
  for (const m of msgs) {
    for (const line of String(m.text ?? "").split(/\n/).map((x) => x.trim()).filter(Boolean)) {
      if (line.length > 160 || /^https?:\/\//.test(line)) continue;
      if (!res.some((re) => re.test(line))) continue;
      const who = m.sender === "customer" ? "お客様" : "こちら";
      const ymd = new Date(Date.parse(m.created_at) + 9 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
      out.push(`- [${who} ${ymd}] ${line}`);
      if (out.length >= (i.max ?? 6)) return out;
    }
  }
  return out;
}
/** 依頼の言葉から探す語（漢字2字以上・片仮名3字以上・英字3字以上。どの会話にも出る語は外す） */
const KW_STOP = new Set(["物件", "部屋", "確認", "大丈夫", "認識", "必要", "昨日", "今日", "明日", "感じ", "場合", "可能", "連絡", "管理会社", "本当", "問題", "以外", "教", "最短", "入居"]);
export function queryKeywords(quotes: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const q of quotes) for (const m of String(q).normalize("NFKC").matchAll(/[一-龯々]{2,}|[ァ-ヶー]{3,}|[A-Za-z]{3,}/g)) {
    if (!KW_STOP.has(m[0])) out.add(m[0]);
  }
  return [...out].slice(0, 8);
}
const PAST_LINE_RE: Partial<Record<DeepCheckTopic, RegExp>> = {
  parking: /駐車|駐輪|パーキング|お停め/,
  pet: /ペット|犬|猫/,
  deposit_key: /敷金|礼金|保証金|敷引|契約一時金/,
  guarantor: /保証会社|保証人/,
  move_in: /入居(?:可能|時期|日)|即入居|退去予定/,
  layout: /間取り|帖|㎡|洗面|トイレ|浴室|収納|階/,
  equipment: /エアコン|コンロ|IH|オートロック|宅配|エレベーター|独立洗面|追い?焚|浴室乾燥|洗濯|モニター/,
  internet: /インターネット|ネット無料|wi-?fi/i,
  occupancy: /二人入居|2人入居|子ども|子供|お子様|楽器|法人|学生/,
  renewal: /更新料/,
  access: /駅.{0,4}徒歩|徒歩\d+分/,
  building: /築\d+|鉄筋|鉄骨|木造|RC造/,
  meeting: /待ち合わせ|現地集合|パーキング|お停め|集合/,
};
