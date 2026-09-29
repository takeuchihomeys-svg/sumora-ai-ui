// app/lib/equipment-question.ts（純関数・DB/ネットに触れない。依存は listing-equipment の型と読み取りだけ）
// お客様が「送った物件の設備」を聞いた時に、資料（設備欄の文字・間取り図）から有無を読んで答えの材料にする。
//
// 2026-09-28 竹内（林田尚貴さん・スモラ）: お客様 18:07「ガスコンロはついてないのですか？」
//   「この場合はガスコンロ付きかどうか画像分析をおこなう。設備ついていれば設備や間取りにもあるから」
//
// ■ 実物で分かった事（scripts/audit-equipment-question.ts・365日の実送信を目で読んだ・当たり21通の誤当たり0）
//   ・林田さんの直前の🌟は メゾン本庄東 203（リアプロ・画像で送った物件＝売上サポの行も文字層も無い）。資料の設備欄は
//     「【キッチン】給湯器・ガスコンロ」、間取り図にもコンロの記号がある。ところが室内写真のキッチンは流しだけでコンロが無く、
//     スタッフの実送信は「ご入居後にガスコンロを設置いただく形」。同じ時に送った MSR天満東 506 は設備欄が空なのに、
//     写真に2口のガスコンロが写っていて「2口のガスコンロが備わったお部屋」（室内イメージを添えて）。
//     → 設備欄の「ガスコンロ」・間取り図の記号は「付いている」の証拠にならない（設置できる場所の意味で書かれる）。
//   ・写真の読み取り（DeepSeek・推論なし・温度0）も試したが、コンロの有無を両向きに読み違えた:
//     資料の全体1枚 → MSR天満東「なし」4/4回（本当は2口）／室内写真の部分を3倍に拡大 → メゾン本庄東「ガス 2口」3/3回（本当は無い）。
//     → 写真の読みでは決めない。コンロは「資料に記載あり（言い切れない）」までにして、スタッフが写真で確かめる。
//   ・スタッフの実送信（当たり21通を目で読んだ）: 有ると答えた 5（エアコン2・ネット無料1・エレベーター1・コンロ1〔写真を添えて〕）／
//     無いと答えた 5（ネット無料3＝設備欄に記載なしから・洗濯機置場ベランダ2＝管理会社に確認して）／確認します→AIX【管理会社に確認した：設備】1／
//     確認します 1／返信なし 7／その他 2。有る物は「〇〇が備わったお部屋となります！！」の形。
//   → 決まり: 本文で答えてよいのは「資料の設備欄に有ると書いてある」物だけ（コンロは除く）。無い・分からない・食い違い・コンロは
//     断言せず「確認させて頂きます」側に倒し、確かめた結果は AIX【物件確認した】（室内写真を確認した／管理会社に確認した：設備）で送る
//     （根拠が要る回答は AIX に振る＝室内写真と同じ考え方・feedback_photo_request_aix_picker）。
//
// ■ 読む順（安い順・新しい LLM 呼び出しは「文字層が無い物件の設備欄を画像から写す」1回だけ＝同じ画像は保存して読み直さない）
//   ① 資料の文字層（property_pickups.pdf_text → parseListingEquipment）
//   ② 文字層が無い（画像だけで送った）物件は、送った資料の画像から設備欄の文字をそのまま写す（equipment-answer-server）
//   ③ 画像で分析の間取り図の読み取り（property_sheet_facts の water）は食い違いの見張りだけ
import { readEquipmentItemsFromText, BUILDING_KEYS, type EquipKey, type EquipFact } from "./listing-equipment";

// ═════════════════════════════════════════════════════════════════════════════
// 1. 質問の検出
// ═════════════════════════════════════════════════════════════════════════════

export type EquipTopic =
  | "gas_stove" | "ih" | "burners" | "aircon" | "bath_toilet" | "washbasin" | "laundry_in" | "autolock" | "delivery_box"
  | "net_free" | "elevator" | "reheating" | "bath_dryer" | "washlet" | "city_gas" | "balcony";

export const EQUIP_TOPIC_LABEL: Record<EquipTopic, string> = {
  gas_stove: "ガスコンロ", ih: "IHコンロ", burners: "コンロの口数", aircon: "エアコン", bath_toilet: "バス・トイレ別", washbasin: "独立洗面台",
  laundry_in: "室内洗濯機置場", autolock: "オートロック", delivery_box: "宅配ボックス", net_free: "インターネット無料", elevator: "エレベーター",
  reheating: "追い焚き", bath_dryer: "浴室乾燥機", washlet: "温水洗浄便座", city_gas: "都市ガス", balcony: "バルコニー",
};

/** 話題 → 資料の設備の鍵（listing-equipment） */
const TOPIC_KEY: Record<EquipTopic, EquipKey> = {
  gas_stove: "gas_stove", ih: "ih", burners: "burner2", aircon: "aircon", bath_toilet: "bath_toilet", washbasin: "washbasin",
  laundry_in: "laundry_in", autolock: "autolock", delivery_box: "delivery_box", net_free: "net_free", elevator: "elevator",
  reheating: "reheating", bath_dryer: "bath_dryer", washlet: "washlet", city_gas: "city_gas", balcony: "balcony",
};

/** 売上サポの資料（同じ物件名の行）を読んでよい古さの上限（日） */
export const PICKUP_MATERIAL_MAX_DAYS = 60;
/**
 * 2026-09-29 反証: 売上サポの資料は物件名だけで引くので、号室が分からない時に同じ建物の別の部屋の資料で答えてしまう。
 *   号室が無い時は、建物単位の設備（listing-equipment.BUILDING_KEYS: エレベーター・宅配BOX・オートロック・ネット無料・駐車場）だけの質問に限る
 */
export function pickupMaterialUsable(topics: ReadonlyArray<EquipTopic>, roomNo: string | null | undefined): boolean {
  if (String(roomNo ?? "").trim()) return true;
  return topics.length > 0 && topics.every((t) => BUILDING_KEYS.includes(TOPIC_KEY[t]));
}

/** 設備欄・間取り図の記号・写真の読みでは「付いている」と言い切れない物（林田さん事例・上の説明） */
const PHOTO_REQUIRED: ReadonlySet<EquipTopic> = new Set(["gas_stove", "ih", "burners"]);

const TOPIC_RES: Array<[EquipTopic, RegExp]> = [
  ["ih", /IH|クッキングヒーター/i],
  ["gas_stove", /ガスコンロ|ガスキッチン|コンロ/],
  ["burners", /(?:[2-4２-４二三四])口|口数|何口/],
  ["aircon", /エアコン|クーラー|冷暖房/],
  ["bath_toilet", /(?:バス|お?風呂|浴室).{0,3}トイレ.{0,4}(?:別|一緒|同じ)|トイレ.{0,4}(?:バス|お?風呂|浴室).{0,3}(?:別|一緒|同じ)|ユニットバス|(?:3|３|三)点(?:式|ユニット)/],
  ["washbasin", /独立洗面|洗面(?:台|所)(?:は|って|が)?(?:独立|別|あり|あります|付い|つい|ない|無い|なし)/],
  ["laundry_in", /洗濯機(?:置き?場|を?置く|の?置き場所|置ける)|洗濯機.{0,8}(?:外|室内|中|ベランダ|バルコニー)/],
  ["autolock", /オートロック/],
  ["delivery_box", /宅配(?:ボックス|BOX|ロッカー)/i],
  ["net_free", /インターネット|ネット(?:無料|代|料|回線|環境)|Wi-?Fi|ワイファイ/i],
  ["elevator", /エレベータ/],
  ["reheating", /追い?焚/],
  ["bath_dryer", /浴室乾燥/],
  ["washlet", /ウォシュレット|温水洗浄|シャワートイレ/],
  ["city_gas", /都市ガス|プロパン|LPガス/i],
  ["balcony", /ベランダ|バルコニー/],
];

/** 聞いている形（有無・付いているか） */
const QUESTION_RE = /[?？]|ですか|ますか|でしょうか|ますでしょう|ありますか|ある(?:の|ん)(?:です|でしょう)?か|無し(?:です|でしょう)?か|なし(?:です|でしょう)?か|ない(?:の|ん)?(?:です|でしょう)?か(?![らもっ])|ですよね|ますよね|どう(?:です|なって|でしょう)|確認(?:を)?お願い|聞いて(?:て)?(?:欲しい|ほしい|もらえ|頂け|いただけ)|知りたい/;
/**
 * 設備の有無の質問ではない文（文単位で外す）:
 *   ・探す条件（「〜の部屋ありますか」「探して」「〜でもいい」「なくても」「高くなりますか」）
 *   ・入居後の困りごと・手続き（故障・つかない・暗証番号・電気ガスの契約・開栓・型番・サイズ）
 *   ・取付・設置できるか（資料では答えられない＝ここでは扱わない。管理会社に確認する話）
 */
const NOT_EQUIP_Q_RE = new RegExp([
  "(?:部屋|物件|ところ|とこ|マンション|アパート|所)(?:で|は|って|が|も)?(?:ありますか|あります？|ない(?:です|でしょう)?か|ありませんか|あったりしますか|紹介)",
  "探して|探せ|探し|ピックアップ|で探|高く(?:なり|なって|なる)|家賃|相場|なくても|でも(?:いい|良い|大丈夫|構い|OK)|こだわり|あったりしますか|(?:LDK|DK|[0-9]K|[0-9]R)(?:で|は|の|が)?(?:あり|あった)|がいい|が良い|広め|大きめ|なかなか|中々|気になって|厳しい|きつい|大変",
  "プレゼント|新しく|新品|新設|リフォーム|故障|壊れ|つかない|点かない|点滅|修理|交換|汚れ|カビ|剥げ|暗証番号|番号|開通|開栓|手続|契約|電気(?:・|、|と)?ガス|ガス(?:・|、|と)?電気|メーカー|型番|何センチ|何キロ|サイズ|磁石|音(?:が|は)?響|届いて",
  "取り?付(?:け)?|設置(?:でき|出来|可能|不可)|つけられ|付けられ|エアコン不可",
].join("|"));

/** 希望の書式（条件のフォームの答え）は質問ではない */
const CONDITION_FORM_RE = /【ご希望|ご希望のお部屋|お部屋お探し中|①【|⑧【/;

function splitSentences(text: string): string[] {
  return String(text ?? "").normalize("NFKC").split(/(?<=[。！!？?\n])/).map((s) => s.trim()).filter(Boolean);
}

export type EquipmentQuestion = { topics: EquipTopic[]; sentences: string[] };

/**
 * お客様の文から「物件の設備の有無の質問」を読む。当たらなければ null（決定論・LLM なし）。
 * 1文の中に設備の語と聞く形の両方があり、探す条件・入居後の困りごと・手続きの文ではない時だけ。
 */
export function detectEquipmentQuestion(text: string | null | undefined): EquipmentQuestion | null {
  const t = String(text ?? "");
  if (!t.trim() || CONDITION_FORM_RE.test(t)) return null;
  const topics = new Set<EquipTopic>();
  const sentences: string[] = [];
  for (const s of splitSentences(t)) {
    if (/^\s*\[(?:画像|動画|スタンプ|ファイル)\]/.test(s)) continue;
    if (!QUESTION_RE.test(s) || NOT_EQUIP_Q_RE.test(s)) continue;
    const hit: EquipTopic[] = [];
    for (const [topic, re] of TOPIC_RES) if (re.test(s)) hit.push(topic);
    // 「洗濯機置場はベランダですか」は洗濯機置場の話（ベランダの有無ではない）
    if (hit.includes("laundry_in")) { const i = hit.indexOf("balcony"); if (i >= 0) hit.splice(i, 1); }
    // 「IH」があればコンロの話は IH（「IHコンロ」を ガスコンロ と読まない）
    if (hit.includes("ih")) { const i = hit.indexOf("gas_stove"); if (i >= 0) hit.splice(i, 1); }
    if (!hit.length) continue;
    hit.forEach((h) => topics.add(h));
    sentences.push(s);
  }
  if (!topics.size) return null;
  return { topics: [...topics], sentences };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. どの物件の話か（決定論: 物件名 ＞ 引用 ＞ 直前に送ったまとまり）
// ═════════════════════════════════════════════════════════════════════════════

export type SentPropertyLite = { property_name: string; room_no: string | null; channel: string | null; created_at: string; image_url: string | null };
export type EquipTarget = SentPropertyLite & { by: "name" | "quote" | "latest" | "same_batch" };

/**
 * 2026-09-29 反証: 送った物件に無い建物名らしい語（「プレジオグループでは使用WiFiは統一されて…」8/27 ad469d13）を聞かれても、
 *   直前に送った関係の無い3件の資料を読んでいた → 文の中のカタカナ・英字の語（3文字以上）から、設備・住まいの一般の語と
 *   送った物件の名前に含まれる語を除いて、まだ残る語があれば「別の建物の話かもしれない」（latest に倒さない）
 */
const COMMON_KATAKANA = /(?:ガス|コンロ|キッチン|システム|カウンター|エアコン|クーラー|トイレ|バス|ユニット|セパレート|シャワー|ウォシュレット|オートロック|モニター|モニタ|インターホン|カメラ|ボックス|ロッカー|インターネット|ネット|ワイファイ|エレベーター|エレベータ|ベランダ|バルコニー|フローリング|クローゼット|クロゼット|シューズ|クッキング|ヒーター|プロパン|ロフト|スペース|タイプ|マンション|アパート|ハイツ|コーポ|オススメ|ペット|ゴミ|サイズ|エリア|ドラム|コンセント|テレビ|カーテン|ポスト|パソコン|リモート|ワーク|ルーム|ドア|キー|スマート|オール|セキュリティ|ボタン|メーター|タンク|ホース|パン|ケーブル|プラン|ドライヤー|ランドリー|ワンルーム|リビング|ダイニング|チェック|ページ|データ|イメージ|サービス|オプション|レンジ|グリル|シンク|ガスレンジ|ビルトイン|エコ|ジョーズ|ディスポーザー|ウォークイン|ハンガー|パイプ|トランク|アンテナ|ケーブルテレビ|ブロードバンド|ルーター|モデム|ポケット|ワイマックス)/g;
const COMMON_LATIN = /^(?:WIFI|WI|FI|IH|BOX|EV|TV|BS|CS|CATV|LINE|OK|NG|UB|LDK|DK|WIC|SIC|LAN|WIMAX|NHK|PC|URL|PDF|LED|WEB|AC)$/;
export function mentionsUnknownBuilding(text: string, sentNames: ReadonlyArray<string>): boolean {
  const t = String(text ?? "").normalize("NFKC");
  const names = sentNames.map((n) => String(n ?? "").normalize("NFKC").replace(/\s+/g, "").toUpperCase());
  const inSent = (w: string) => names.some((n) => n.includes(w));
  for (const m of t.matchAll(/[ァ-ヴー]{3,}/g)) {
    const rest = m[0].replace(COMMON_KATAKANA, " ").split(" ").filter((x) => x.replace(/ー/g, "").length >= 3);
    if (rest.some((w) => !inSent(w))) return true;
  }
  for (const m of t.matchAll(/[A-Za-z]{3,}/g)) {
    const w = m[0].toUpperCase();
    if (!COMMON_LATIN.test(w) && !inSent(w)) return true;
  }
  return false;
}

const nameCore = (s: string) => String(s ?? "").normalize("NFKC").replace(/[\s　・,.'’\-ー()（）【】🌟★☆]/g, "").toLowerCase();

/**
 * 送った物件（新しい順）から、質問の対象を決める。
 *   ① 文に物件名（3文字以上の芯）→ その物件 ② 引用返信の画像が送った物件の画像 → その物件
 *   ③ それ以外 → 一番新しく送った物件＋同じまとまり（10分以内）に送った物件（最大3件・一番新しいのを先頭）
 * 質問の時刻より前・14日以内の送付だけ。
 */
export function pickEquipmentTargets(
  text: string, sentNewestFirst: ReadonlyArray<SentPropertyLite>,
  o: { askedAt: string; quotedImageUrl?: string | null; max?: number;
    /** 2026-09-29 反証: お客様が送った画像の時刻（直前の送付より後にお客様の画像があれば、お客様が見つけた物件の話かもしれない＝latest に倒さない） */
    customerImageAts?: ReadonlyArray<string> },
): EquipTarget[] {
  const max = o.max ?? 3;
  const asked = Date.parse(o.askedAt);
  const seen = new Set<string>();
  const rows: SentPropertyLite[] = [];
  for (const r of sentNewestFirst) {
    const at = Date.parse(r.created_at);
    if (!r.property_name || !Number.isFinite(at) || at > asked || asked - at > 14 * 86_400_000) continue;
    const k = `${nameCore(r.property_name)}|${String(r.room_no ?? "").replace(/^0+/, "")}`;
    if (seen.has(k)) continue;
    seen.add(k); rows.push(r);
  }
  if (!rows.length) return [];
  const tn = nameCore(text);
  const named = rows.filter((r) => { const c = nameCore(r.property_name); return c.length >= 3 && tn.includes(c); });
  if (named.length) return named.slice(0, max).map((r) => ({ ...r, by: "name" as const }));
  if (o.quotedImageUrl) {
    const q = rows.find((r) => r.image_url && r.image_url === o.quotedImageUrl);
    if (q) return [{ ...q, by: "quote" }];
  }
  const head = rows[0];
  const t0 = Date.parse(head.created_at);
  // 2026-09-29 反証: 物件名も引用も無い時、次のどれかなら「直前に送った物件」に倒さず対象なし（材料を渡さない＝今まで通り）
  //   ・送った物件に無い建物名らしい語がある ・直前の送付より後にお客様が画像を送っている
  if (mentionsUnknownBuilding(text, rows.map((r) => r.property_name))) return [];
  if ((o.customerImageAts ?? []).some((a) => { const x = Date.parse(a); return Number.isFinite(x) && x > t0 && x <= asked; })) return [];
  const batch = rows.slice(1).filter((r) => t0 - Date.parse(r.created_at) <= 10 * 60_000);
  return [{ ...head, by: "latest" as const }, ...batch.map((r) => ({ ...r, by: "same_batch" as const }))].slice(0, max);
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. 資料から有無を決める
// ═════════════════════════════════════════════════════════════════════════════

/** 資料の画像から写した設備欄の文字（equipment-answer-server の DeepSeek・保存して使い回す） */
export type SheetEquipText = {
  see: string;
  /** 資料の「設備」欄（と備考・条件）の文字を、見えるとおりそのまま */
  equip_text: string;
};

/** 間取り図の読み取り（画像で分析・sheet-prompt の SheetImageFacts のうち使う所だけ） */
export type PlanFactsLite = {
  kitchen?: { stove?: string | null; burners?: number | null } | null;
  water?: { bath_toilet?: string | null; washbasin?: string | null; laundry?: string | null } | null;
} | null;

/**
 * yes＝資料に有ると書いてある（本文で答えてよい）／listed＝資料に書いてあるが付いているとは言い切れない（コンロ）／
 * no＝資料に反対がはっきり書いてある（本文で断言はしない）／unknown＝資料で分からない／conflict＝資料の中で食い違い
 */
export type EquipVerdict = "yes" | "listed" | "no" | "unknown" | "conflict";
export type EquipAnswer = {
  topic: EquipTopic;
  verdict: EquipVerdict;
  /** 答えの文に使ってよい具体（「2口」） */
  detail: string | null;
  /** 根拠（資料のどこに何と書いてあるか・間取り図で何が読めたか） */
  basis: string[];
};

export type EquipSources = {
  /** 資料の文字（文字層を parseListingEquipment した items か、画像から写した設備欄を readEquipmentItemsFromText した物） */
  text?: Partial<Record<EquipKey, EquipFact>> | null;
  /** 文字の出どころ（表示用）: 「資料の設備欄」 */
  textLabel?: string;
  /** 画像で分析の間取り図の読み取り（切り出した間取り図・食い違いの見張りだけに使う） */
  plan?: PlanFactsLite;
};

/** 間取り図の読みで食い違いを見る話題（水回り・洗濯機置場）。図だけで「有る」とは言わない（読み違いがある） */
function planSays(topic: EquipTopic, plan: PlanFactsLite | undefined): { v: "あり" | "なし" | "不明"; why: string | null } {
  const w = plan?.water ?? null;
  switch (topic) {
    case "bath_toilet": return w?.bath_toilet === "別" ? { v: "あり", why: "間取り図: 浴室とトイレが別" } : w?.bath_toilet === "同室" ? { v: "なし", why: "間取り図: 浴室とトイレが同じ部屋" } : { v: "不明", why: null };
    case "washbasin": return w?.washbasin === "独立" ? { v: "あり", why: "間取り図: 浴室の外に洗面" } : w?.washbasin === "浴室内" ? { v: "なし", why: "間取り図: 洗面は浴室の中" } : { v: "不明", why: null };
    case "laundry_in": return w?.laundry === "室内" ? { v: "あり", why: "間取り図: 室内に洗濯機置場" } : w?.laundry === "屋外" ? { v: "なし", why: "間取り図: 洗濯機置場はバルコニー" } : { v: "不明", why: null };
    default: return { v: "不明", why: null };
  }
}

/**
 * 1つの話題について、資料から有無を決める（誤って「有る」「無い」と言わない側に倒す）。
 *   ・コンロ（ガス・IH・口数）: 設備欄に書いてあっても listed（付いているとは言い切れない）。
 *     林田さん事例: メゾン本庄東は設備欄「ガスコンロ」・間取り図に記号があるのに、写真は流しだけで実送信は「入居後に設置」。
 *     写真の読み取り（DeepSeek）はコンロの有無を両向きに読み違えた（MSR天満東: 写っている2口を「なし」4/4回・
 *     メゾン本庄東の写真の拡大: 無いのに「ガス2口」3/3回）ので、写真の読みでも決めない＝スタッフが写真で確かめる
 *   ・それ以外: 設備欄 ok → yes（間取り図が反対なら conflict）／設備欄 ng → no／書いていない → unknown（無いとは限らない）
 */
export function resolveEquipAnswer(topic: EquipTopic, src: EquipSources): EquipAnswer {
  const key = TOPIC_KEY[topic];
  const tf = src.text?.[key] ?? null;
  const tLabel = src.textLabel ?? "資料の設備欄";
  const basis: string[] = [];
  if (tf?.status === "ok" || tf?.status === "ng") basis.push(`${tLabel}「${tf.evidence}」`);
  else if (src.text) basis.push(`${tLabel}に記載なし${tf?.hint ? `（${tf.hint}）` : ""}`);
  else basis.push("資料の文字を読めなかった");
  const pl = planSays(topic, src.plan);
  if (pl.why) basis.push(pl.why);
  if (PHOTO_REQUIRED.has(topic)) {
    const b2 = src.text?.burner2?.status === "ok" ? src.text.burner2.evidence : null;
    if (topic === "burners" && b2 && !basis.some((b) => b.includes(b2))) basis.push(`${tLabel}「${b2}」`);
    if (tf?.status === "ng") return { topic, verdict: "no", detail: null, basis };
    const listed = tf?.status === "ok" || (topic === "burners" && !!b2);
    return { topic, verdict: listed ? "listed" : "unknown", detail: listed ? b2 : null, basis };
  }
  if (tf?.status === "ok") return { topic, verdict: pl.v === "なし" ? "conflict" : "yes", detail: tf.detail ?? null, basis };
  if (tf?.status === "ng") return { topic, verdict: pl.v === "あり" ? "conflict" : "no", detail: null, basis };
  return { topic, verdict: "unknown", detail: null, basis };
}

/** 画像から写した設備欄の文字を設備の items にする（文字層が無い物件＝お客様に送った画像だけの物件） */
export function textItemsFromSheetText(r: SheetEquipText | null | undefined): Partial<Record<EquipKey, EquipFact>> | null {
  return r ? readEquipmentItemsFromText(String(r.equip_text ?? "").trim()) : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. 答え方（本文で答えるか・確認するか）と、ブレイン・返信生成へ渡す文
// ═════════════════════════════════════════════════════════════════════════════

export type EquipPropertyAnswer = { name: string; roomNo: string | null; by: EquipTarget["by"]; answers: EquipAnswer[]; materialRead: boolean };
export type EquipAnswerPlan = {
  /** answer＝全部「有る」と資料に書いてある（本文で答えてよい）／confirm＝1つでも言い切れない（確認する） */
  mode: "answer" | "confirm";
  /** コンロの話題がある（スタッフが写真で確かめる＝AIX【物件確認した】→「室内写真を確認した」で写真を添えて答えられる） */
  stoveAsked: boolean;
  properties: EquipPropertyAnswer[];
};

export function equipAnswerPlan(properties: EquipPropertyAnswer[]): EquipAnswerPlan {
  const all = properties.flatMap((p) => p.answers);
  const mode = all.length > 0 && all.every((a) => a.verdict === "yes") ? "answer" : "confirm";
  return { mode, stoveAsked: all.some((a) => PHOTO_REQUIRED.has(a.topic)), properties };
}

const VERDICT_JA: Record<EquipVerdict, string> = {
  yes: "有る（資料の設備欄に記載）", listed: "資料に記載はあるが付いているとは言い切れない（設置できる場所の意味で書かれる事がある）",
  no: "資料に無いと書いてある（本文で断言はしない）", unknown: "資料で分からない（記載なし＝無いとは限らない）", conflict: "資料の中で食い違い",
};
const roomLabel = (p: { name: string; roomNo: string | null }) => `${p.name}${p.roomNo ? ` ${p.roomNo}号室` : ""}`;

/**
 * ブレイン・返信生成へ渡す材料（毎回変わる所に置く＝キャッシュの前置きは変えない）。
 * 本文に書いてよい事・書いてはいけない事と、確かめた後の AIX を添える（文面を決めるのは生成）。
 */
export function buildEquipmentAnswerNote(plan: EquipAnswerPlan): string {
  if (!plan.properties.length) return "";
  const lines: string[] = ["【🔧 お客様が聞いた設備（送った物件の資料から読んだ事実・決定論）】"];
  for (const p of plan.properties) {
    const byJa = p.by === "name" ? "お客様が名前を出した物件" : p.by === "quote" ? "お客様が引用した物件" : p.by === "latest" ? "直前にお送りした物件" : "同じ時にお送りした物件";
    lines.push(`■ ${roomLabel(p)}（${byJa}）${p.materialRead ? "" : "※資料を読めなかった"}`);
    for (const a of p.answers) {
      lines.push(`・${EQUIP_TOPIC_LABEL[a.topic]}: ${VERDICT_JA[a.verdict]}${a.detail ? `〔${a.detail}〕` : ""}${a.basis.length ? ` ← ${a.basis.join("／")}` : ""}`);
    }
  }
  if (plan.mode === "answer") {
    lines.push("→ 本文で答えてよい（資料に有ると書いてある物だけ・資料の言葉のまま）。形:「〇〇は△△が備わったお部屋となります！！」。口数・台数は〔〕にある時だけ書く。");
  } else {
    lines.push("→ 言い切れない物がある: 有無を断言しない（「ございません」「付いていません」「付いています」「設置いただく形」と書かない）。本文は「〇〇の△△につきまして確認させて頂きます！！確認出来次第ご連絡させて頂きます！！」の形まで（資料に有ると書いてある物だけはその分を答えてよい）。");
    lines.push(plan.stoveAsked
      ? "→ コンロはスタッフが室内写真で確かめる: 写真に写っていれば AIX【物件確認した】→「室内写真を確認した」で写真を添えて答える（実送信: 室内イメージを添えて「2口のガスコンロが備わったお部屋」）。写真で分からなければ AIX【物件確認した】→「管理会社に確認した：設備」（mgmt_equipment・timing=after_confirm）。"
      : "→ 確かめた結果はスタッフが AIX【物件確認した】→「管理会社に確認した：設備」（mgmt_equipment・timing=after_confirm）で送る。");
  }
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. 文字層が無い物件は、送った資料の画像から設備欄の文字を1回写す（固定の前置き・推論なし・保存して読み直さない）
// ═════════════════════════════════════════════════════════════════════════════

/** 前置きを変えたら上げる（保存した読み取りの鍵＝property_sheet_facts.prompt_version） */
export const SHEET_EQTEXT_PROMPT_VERSION = "sheet-eqtext-v1";
export const SHEET_EQTEXT_MAX_TOKENS = 600;

/**
 * 固定の前置き（先頭・毎回同じ＝DeepSeek の前置きキャッシュ）。物件ごと・お客様ごとの値は入れない（画像だけが後ろで変わる）。
 * 写真の中の設備（コンロ等）は読ませない（上の resolveEquipAnswer の説明: 読み違いが両向きに出た）。欄の文字を写すだけ。
 */
export const SHEET_EQTEXT_PROMPT = `あなたは賃貸物件の資料（マイソク）の画像から文字を写す係です。次の JSON 1つで返してください（説明文・コードブロック不要）。
{"see":"","equip_text":""}
- see: どこに設備欄があったかを30字以内で書く（例「左の表の下・『設備』の帯の下」）
- equip_text: 資料の「設備」欄（あれば「備考」「条件」の欄も）の文字を、見えるとおり一字も変えずに写す（400字まで・改行は詰める）。欄が空・無ければ ""
- 写真・間取り図・地図から設備を推測して書かない（欄に書いてある文字だけ）
画像:`;

/** 返事を読む（形が崩れていれば null＝読み直し） */
export function parseSheetEquipText(text: string): SheetEquipText | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  if (typeof j.equip_text !== "string") return null;
  return { see: String(j.see ?? "").slice(0, 60), equip_text: j.equip_text.replace(/\s+/g, " ").trim().slice(0, 500) };
}
