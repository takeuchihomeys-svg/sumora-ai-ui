// app/lib/guarantor-companies.ts
// 2026-09-15 竹内（YUYA 事例）「AIX に保証会社についてを作る。物件ごとに物件名・保証会社名（選択・無ければ登録）・種類を5件〜入れて会話を合わせる。
//   並行して審査かけるトグルで、かぶっていない保証会社なら並行審査を勧める」— 純関数・DB 依存なし
//   静的な一覧（名寄せ・種類）はここにハードコード。スタッフが新しく登録した会社名だけ guarantor_companies テーブル（feedback_static_vs_dynamic_db）
//   本文の会社名・種類は入力値だけ（LLM に作らせない。入力に無い会社名は〇〇に伏せて送信前チェックで止める＝cost_breakdown の金額の照合と同じ考え）
// 依存ゼロ（他の app/lib/* を import しない・画面とサーバーの両方から使う）

// ─── 型 ───
export type GuarantorType = "independent" | "licc" | "credit" | "unknown";
export const GUARANTOR_TYPES: readonly GuarantorType[] = ["independent", "licc", "credit", "unknown"];
/**
 * UI の select と台帳の日本語ラベル。
 * 2026-09-26 竹内さん決定: スタッフの言う「信用系」は**信販系**（お客様への説明の呼び方は「信販系」にそろえる）。
 *   旧: 「信用系」を LICC系 のラベルに添えていた（LICC系（信用系））→ 外した。「信用系」の語はお客様向けの文に出さない
 */
export const GUARANTOR_TYPE_LABELS: Record<GuarantorType, string> = {
  independent: "独立系（審査ゆるめ）",
  licc: "LICC系",
  credit: "信販系（クレジット審査）",
  unknown: "不明・その他",
};
/** 本文で使う短い呼び名（「〇〇と独立系の保証会社」）。unknown は空＝種類に触れない */
export const GUARANTOR_TYPE_SHORT: Record<GuarantorType, string> = { independent: "独立系", licc: "LICC系", credit: "信販系", unknown: "" };
/** 種類→審査の説明（スタッフ実文から。LLM に種類から創作させない。unknown は空＝緩い／厳しいに触れない） */
export const GUARANTOR_TYPE_SCREENING_NOTE: Record<GuarantorType, string> = {
  independent: "独立系の保証会社となりますので、審査基準が緩い保証会社となります😊！！",
  licc: "LICC系の保証会社となり、独立系の保証会社に比べると審査基準は上がりますが、信用情報を重視した審査基準とはなりませんので審査通過する可能性十分に御座います！！",
  credit: "信販系の保証会社となり、クレジット審査となりますので比較的審査厳し目のお部屋となります！！",
  unknown: "",
};
/**
 * 種類ごとの「許された言い回し」（固定テンプレ buildGuarantorInfoText と、会話を合わせる formatGuarantorFacts の両方がこの1本を使う＝同じ判定を2か所に書かない）。
 * 「・物件名」の行に続く1行（先頭の「の保証会社は」は物件名の行を受ける）
 */
export const GUARANTOR_TYPE_SENTENCE: Record<GuarantorType, (company: string) => string> = {
  independent: (c) => `の保証会社は${c}と${GUARANTOR_TYPE_SCREENING_NOTE.independent}`,
  licc: (c) => `の保証会社は${c}と${GUARANTOR_TYPE_SCREENING_NOTE.licc}`,
  credit: (c) => `の保証会社は${c}と${GUARANTOR_TYPE_SCREENING_NOTE.credit}`,
  unknown: (c) => `の保証会社は${c}となります！！`,
};
export type GuarantorCompany = { name: string; aliases: readonly string[]; type: GuarantorType };
export type GuarantorProperty = { name: string; company: string; type: GuarantorType };

export function isGuarantorType(v: unknown): v is GuarantorType {
  return typeof v === "string" && (GUARANTOR_TYPES as readonly string[]).includes(v);
}

/** 画像の読み取り（extract-guarantor-info・AIX の mgmt_guarantor）と旧画面が使う日本語の種類名（unknown は「不明」） */
export type GuarantorTypeJa = "独立系" | "LICC系" | "信販系" | "不明";
export function guarantorTypeJa(t: GuarantorType): GuarantorTypeJa {
  return t === "independent" ? "独立系" : t === "licc" ? "LICC系" : t === "credit" ? "信販系" : "不明";
}
/**
 * 日本語の種類名 → GuarantorType。旧クライアントの「信用系」は**信販系**（2026-09-26 竹内さん決定・スタッフの「信用系」＝信販系）。
 * 読めない値は null（呼び出し側が会社名から resolveGuarantor で決める）
 */
export function parseGuarantorTypeJa(raw: string | null | undefined): GuarantorType | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (isGuarantorType(s)) return s;
  if (/^独立系/.test(s)) return "independent";
  if (/^LICC/i.test(s)) return "licc";
  if (/^(信販系|信用系)/.test(s)) return "credit";
  if (/^不明/.test(s)) return "unknown";
  return null;
}

// ─── マスタ（正規名・別名・既定の種類）───
// 出現頻度は 2025-09〜2026-09 のスタッフ実送信: 日本セーフティ(ー)24・エポス16・エルズサポート7・Casa5・全保連5・ジェイリース4・クレディセゾン3・
//   オリコ3・アセス保証2・いえらぶ2・ライフ2・他各1。種類の語もスタッフの使い方（独立系＝審査基準が緩い／LICC系＝独立系より上がるが信用情報重視ではない／
//   信販系＝クレジット審査・厳しめ）に合わせる
export const GUARANTOR_COMPANY_MASTER: readonly GuarantorCompany[] = [
  // 独立系
  { name: "日本セーフティー", aliases: ["日本セーフティ", "日本セーフティ―", "セーフティー", "セーフティ", "JSN"], type: "independent" },
  { name: "Casa", aliases: ["カーサ", "CASA", "casa"], type: "independent" },
  { name: "エルズサポート", aliases: ["エルズ", "L's"], type: "independent" },
  { name: "いえらぶパートナーズ", aliases: ["いえらぶ", "いえらぶ保証", "いえらぶ賃貸保証"], type: "independent" },
  { name: "アセス保証", aliases: ["アセス"], type: "independent" },
  { name: "フォーシーズ", aliases: ["フォーシーズンズ", "4seasons"], type: "independent" },
  { name: "ルームバンクインシュア", aliases: ["ルームバンク", "RoomBank"], type: "independent" },
  { name: "日本トラストコーポレーション", aliases: ["日本トラスト"], type: "independent" },
  { name: "ハウスリーブ", aliases: [], type: "independent" },
  { name: "ナップ", aliases: ["NAP", "ナップ賃貸保証"], type: "independent" },
  { name: "JPMC", aliases: ["ジェイピーエムシー", "日本管理センター", "JPMCファイナンス"], type: "independent" },
  { name: "イントラスト", aliases: ["intrust"], type: "independent" },
  { name: "ラクーン", aliases: ["ラクーンレント", "raccoon"], type: "independent" },
  { name: "ニッポンインシュア", aliases: ["日本インシュア"], type: "independent" },
  { name: "GTN", aliases: ["ジーティーエヌ", "グローバルトラストネットワークス"], type: "independent" },
  // 2026-09-26 竹内さん決定「マスタに無い会社はスタッフが過去に説明した種類で足す」（scripts/audit-guarantor.ts の調査・スタッフ実送信）:
  //   シノケン・ほっと保証 ab7ea742「シノケンコミュニケーションズ（独立系）…2番手ほっと保証（独立系）」／レンポッポ d25e07d1「レンポッポ（独立系）」／
  //   アーク 359e5a77「アーク保証会社と独立系の保証会社」／エイト d46290ff「エイト賃貸保証と独立系の保証会社」／
  //   オセロ 583171e6「オセロ・フィナンシャルサービス株式会社となり独立系の保証会社」
  //   短い呼び名（シノケン・アーク・エイト・オセロ）は一般語・不動産会社名と重なるので名寄せだけに使い、本文の走査はしない（SCAN_SKIP）
  { name: "シノケンコミュニケーションズ", aliases: ["シノケン", "シノケン保証"], type: "independent" },
  { name: "ほっと保証", aliases: [], type: "independent" },
  { name: "レンポッポ", aliases: [], type: "independent" },
  { name: "アーク保証", aliases: ["アーク賃貸保証", "アーク"], type: "independent" },
  { name: "エイト賃貸保証", aliases: ["エイト保証", "エイト"], type: "independent" },
  { name: "オセロ・フィナンシャルサービス", aliases: ["オセロフィナンシャルサービス", "オセロ"], type: "independent" },
  // LICC系
  { name: "全保連", aliases: ["ゼンホレン"], type: "licc" },
  { name: "ジェイリース", aliases: ["Jリース", "J-LEASE"], type: "licc" },
  { name: "日本賃貸保証", aliases: ["JID"], type: "licc" },
  // 信販系
  { name: "エポスカード", aliases: ["エポス", "EPOS", "ROOM iD", "ルームiD"], type: "credit" },
  { name: "オリコフォレントインシュア", aliases: ["オリコ", "オリコフォレント", "ORICO"], type: "credit" },
  { name: "クレディセゾン", aliases: ["セゾン", "SAISON"], type: "credit" },
  { name: "ジャックス", aliases: ["JACCS"], type: "credit" },
  { name: "アプラス", aliases: ["APLUS"], type: "credit" },
  // 2026-09-26 竹内さん決定: K-net はスタッフが「信用系」と説明（d25e07d1「3番手:K-net（信用系）」）＝信販系
  { name: "K-net", aliases: ["Knet", "ケーネット"], type: "credit" },
  // 種類が定まらない（スタッフが選ぶ）
  { name: "ライフ", aliases: ["ライフ保証", "ライフ賃貸保証"], type: "unknown" },
  // 2026-09-26 竹内さん決定「説明の無い会社は種類を推測しない」: 名寄せ・入力に無い会社名を伏せる走査のためだけに置く（種類は不明＝審査の緩い・厳しいに触れない）
  //   スタッフの実送信に種類の説明が無い（クレデンスは「比較的審査通過しやすい」だけで種類の語なし）
  { name: "クレデンス", aliases: [], type: "unknown" },
  { name: "興和アシスト", aliases: [], type: "unknown" },
  { name: "テナントファースト", aliases: [], type: "unknown" },
  { name: "プレサンスギャランティ", aliases: ["プレサンス"], type: "unknown" },
  { name: "ランドインシュア", aliases: [], type: "unknown" },
  { name: "パナソニックホームズ賃貸サポート", aliases: [], type: "unknown" },
  { name: "エフアール信用保証", aliases: [], type: "unknown" },
];

/** 種類ごとのマスタの正規名（プロンプトの一般知識の会社名はここから作る＝会社の種類の知識をマスタ1本に・2026-09-26） */
export function guarantorNamesByType(t: GuarantorType): string[] {
  return GUARANTOR_COMPANY_MASTER.filter((c) => c.type === t).map((c) => c.name);
}
/** 画像の読み取り用: 資料に出る会社名の手がかり（種類は付けない＝種類は読み取った会社名から resolveGuarantor で決める） */
export const GUARANTOR_OCR_NAME_HINT: string = `【よく出る保証会社名（表記の手がかり・この一覧に無い会社もある）】\n${GUARANTOR_COMPANY_MASTER.map((c) => c.name).join("、")}`;

// ─── 名寄せ ───
/** 比較用のキー（全角半角・空白・株式会社・末尾の「保証会社」「保証」を落とす。正規名側も同じ関数を通すので「アセス保証」は一致する） */
function nameKey(raw: string): string {
  return (raw ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/株式会社|\(株\)|（株）/g, "").replace(/(?:保証会社|保証)$/, "").toLowerCase();
}
const MASTER_BY_KEY: ReadonlyMap<string, GuarantorCompany> = (() => {
  const m = new Map<string, GuarantorCompany>();
  for (const c of GUARANTOR_COMPANY_MASTER) for (const w of [c.name, ...c.aliases]) if (!m.has(nameKey(w))) m.set(nameKey(w), c);
  return m;
})();
function masterOf(raw: string): GuarantorCompany | null {
  const k = nameKey(raw);
  return k ? MASTER_BY_KEY.get(k) ?? null : null;
}

/** 表記ゆれ（日本セーフティ／日本セーフティー／カーサ／オリコ／JID 等）を正規名に。マスタに無ければ trim してそのまま（カスタム会社） */
export function normalizeGuarantorName(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  return masterOf(s)?.name ?? s;
}

/** 会社名 → 正規名・既定の種類・既知か（UI の「会社を選んだら種類を自動」と API 側の既定値決定はこれ1本） */
export function resolveGuarantor(raw: string, customs: ReadonlyArray<{ name: string; type: GuarantorType }> = []): { name: string; type: GuarantorType; known: boolean } {
  const s = (raw ?? "").trim();
  const m = masterOf(s);
  if (m) return { name: m.name, type: m.type, known: true };
  const k = nameKey(s);
  const c = k ? customs.find((x) => nameKey(x.name) === k) : undefined;
  if (c) return { name: c.name, type: c.type, known: true };
  return { name: s, type: "unknown", known: false };
}

/** マスタの会社か（/api/guarantor-companies の POST がマスタ重複を弾くのに使う） */
export function isMasterGuarantor(raw: string): boolean {
  return masterOf((raw ?? "").trim()) !== null;
}

/** 正規名 → [正規名, ...別名]。マスタに無ければ [canonical] */
export function guarantorAliasesOf(canonical: string): string[] {
  const m = masterOf(canonical);
  return m ? [m.name, ...m.aliases] : [canonical];
}

// ─── 並行審査の判定（決定論・LLM に判断させない）───
export type ParallelScreeningPlan = {
  /** 正規名でまとめた会社ごとの物件名（入力順） */
  groups: Array<{ company: string; type: GuarantorType; properties: string[] }>;
  /** 2物件以上で同じ会社（＝並行して審査できない組） */
  overlapping: Array<{ company: string; properties: string[] }>;
  /** 会社が2社以上ある＝保証会社が異なるお部屋の並行審査を勧められる */
  canParallel: boolean;
};

/**
 * 会社を名寄せしてまとめる。同じ会社で種類が食い違っていたら最初の物件の種類。
 * YUYA 事例（カーザSun I=日本セーフティー・ノルデンハイム=オリコ・朝日プラザ=アセス保証・Renatus=日本セーフティ・ディザイア=日本賃貸保証）
 *   → groups 4・overlapping [{日本セーフティー, [カーザSun I, Renatus新大阪]}]・canParallel true
 */
export function planParallelScreening(properties: readonly GuarantorProperty[]): ParallelScreeningPlan {
  const groups: ParallelScreeningPlan["groups"] = [];
  for (const p of properties) {
    const company = normalizeGuarantorName(p.company);
    const g = groups.find((x) => nameKey(x.company) === nameKey(company));
    if (g) g.properties.push(p.name);
    else groups.push({ company, type: p.type, properties: [p.name] });
  }
  return {
    groups,
    overlapping: groups.filter((g) => g.properties.length >= 2).map((g) => ({ company: g.company, properties: g.properties })),
    canParallel: groups.length >= 2,
  };
}

const TYPE_ORDER: Record<GuarantorType, number> = { independent: 0, licc: 1, credit: 2, unknown: 3 };
/**
 * 並行審査の文の出し方（固定テンプレと LLM への指示の両方がこれ1本）。
 * 2026-09-15 検証指摘: 物件が1件だけの時に「いずれも同じ」「1件ずつ」は不自然なので、並行 ON でも2件以上ある時だけ並行／同一会社の文を出す
 */
function parallelMode(properties: readonly GuarantorProperty[], plan: ParallelScreeningPlan, parallel: boolean): "parallel" | "same_company" | "none" {
  if (!parallel || properties.length < 2) return "none";
  return plan.canParallel ? "parallel" : "same_company";
}
const PARALLEL_LINE = "審査無事通過する為、保証会社が異なるお部屋並行して審査かけさせて頂く事可能です！！";
const INVITE_LINE = "よろしければお気に召されたお部屋一度審査かけさせて頂きます！！";
const CANCEL_LINE = "※保証会社審査通過後、オーナー審査移行するまでキャンセル料不要となります！！";

// ─── 固定テンプレ（YUYA 9/15 17:31 の実送信の型）───
/**
 * 「文面を作る（固定）」の本文。LLM を呼ばない。会社名は正規名（「日本セーフティ」と入れても「日本セーフティー」）。
 * 挨拶行（「お世話になっております！！」）は他の AIX と同じく付けない。
 */
export function buildGuarantorInfoText(o: { customerName: string; properties: readonly GuarantorProperty[]; parallel: boolean }): string {
  const plan = planParallelScreening(o.properties);
  const head = [o.customerName ? `${o.customerName}さん` : "", "こちら保証会社一覧となります！！"].filter(Boolean).join("\n");
  // 会社ごとの段落: 種類の順（独立系 → LICC系 → 信販系 → 不明）、同じ種類の中は入力順
  const groups = [...plan.groups].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
  const paragraphs = groups.map((g) => `${g.properties.map((p) => `・${p}`).join("\n")}\n${GUARANTOR_TYPE_SENTENCE[g.type](g.company)}`);
  // 並行審査（parallelMode で固定テンプレと formatGuarantorFacts の分岐を1本にする）
  const closing: string[] = [];
  const mode = parallelMode(o.properties, plan, o.parallel);
  if (mode === "parallel") {
    closing.push(PARALLEL_LINE);
    for (const ov of plan.overlapping) closing.push(`${ov.properties.join("と")}は保証会社が同じ（${ov.company}）となりますので、どちらか1件の審査となります！！`);
    closing.push(INVITE_LINE);
  } else if (mode === "same_company") {
    closing.push(`保証会社がいずれも${plan.groups[0]?.company ?? ""}と同じとなりますので、お気に召されたお部屋1件ずつ審査かけさせて頂く形となります！！`);
  } else {
    closing.push(INVITE_LINE);
  }
  return [head, ...paragraphs, closing.join("\n"), CANCEL_LINE].join("\n\n");
}

// ─── 物件確認した（募集中）に添える説明（YUYA 事例・2026-09-17）───
// 竹内「保証会社名は見積書の下に項目いれて、そこに保証会社名入れれる形とする。ここで保証会社について説明された文が生成されるようになる」
//
// 【物件確認した】は「この1件（数件）の保証会社」を御見積書の直後に1〜2行で添える場面で、
// 【保証会社について】（保証会社一覧を送る場面）とは文の型が違う。文はスタッフの実送信そのまま（種類ごとに1つ）:
//   信販系 2026-09-16 YUYA「クレディセゾンという信用系の保証会社を使用しており、クレジットカードの滞納歴で審査する保証会社となります！！」
//     （🌟最大限割引しました御見積書同封させて頂きました！！ の直後に置かれている＝画面の入力欄も見積書の下に置く）
//   独立系 2026-06-29「保証会社:オセロ・フィナンシャルサービス株式会社となり独立系の保証会社となりますのでかなり審査通過しやすいお部屋となります😊！！」
//   複数件で同じ会社 2026-07-21「2部屋とも保証会社クレデンスという比較的審査通過しやすいもの採用しております！！」
//   LICC系 の実送信はこの場面に無いので【保証会社について】と同じ言い回し（GUARANTOR_TYPE_SCREENING_NOTE.licc）を使う
// ※ credit（クレディセゾン・エポス等）の呼び名は「信販系」（2026-09-26 竹内さん決定: スタッフの「信用系」＝信販系・お客様への説明は「信販系」にそろえる）。
//   旧: この場面だけ実送信に合わせて「信用系」と書いていた（一覧の AIX は「信販系」で、同じ会社が場面で呼び名が割れていた）
// ※ 旧実装（AixModal で generatedMsg に追記）は種類を見ずに「クレジットカードの滞納歴で審査する中級程の保証会社」固定で、
//   独立系（審査が緩い）の物件にも信販系の説明が付いていた。事実関係の説明なので種類ごとに分ける
export const GUARANTOR_CHECK_SENTENCE: Record<GuarantorType, (company: string) => string> = {
  independent: (c) => `${c}という独立系の保証会社を使用しており、審査基準が緩くかなり審査通過しやすいお部屋となります😊！！`,
  licc: (c) => `${c}というLICC系の保証会社を使用しており、${GUARANTOR_TYPE_SCREENING_NOTE.licc}`,
  credit: (c) => `${c}という信販系の保証会社を使用しており、クレジットカードの滞納歴で審査する保証会社となります！！`,
  unknown: (c) => `${c}という保証会社を使用しております！！`,
};

/**
 * 【物件確認した・募集中】の本文に添える保証会社の説明。会社名が入っている物件だけが対象（入れなければ空＝何も足さない）。
 * ・全部同じ会社: 1件ならそのまま／複数件は「こちら2部屋とも〜」（実送信の型）
 * ・会社が分かれる: 物件名を頭に付けて会社ごとに1行（どの部屋がどの会社か分かるように）
 * 会社名は正規名（「日本セーフティ」と入れても「日本セーフティー」）。種類は入力値をそのまま使う（LLM に決めさせない）
 */
export function buildGuarantorCheckNote(properties: readonly GuarantorProperty[]): string {
  const filled = properties.filter((p) => (p.company ?? "").trim());
  if (filled.length === 0) return "";
  const plan = planParallelScreening(filled);
  if (plan.groups.length === 1) {
    const g = plan.groups[0];
    const sentence = GUARANTOR_CHECK_SENTENCE[g.type](g.company);
    return filled.length >= 2 ? `こちら${filled.length}部屋とも${sentence}` : sentence;
  }
  return plan.groups
    .map((g) => `${g.properties.filter(Boolean).join("・")}は${GUARANTOR_CHECK_SENTENCE[g.type](g.company)}`)
    .join("\n");
}

// ─── 手打ちの一覧（YUYA 17:27 型・UI の「入力の確認」用。送信文には使わない）───
export function buildGuarantorListText(properties: readonly GuarantorProperty[]): string {
  return properties.map((p) => `⚪︎${p.name}\n${normalizeGuarantorName(p.company)}`).join("\n");
}

// ─── LLM に渡す事実ブロック（会話を合わせる用）───
export function formatGuarantorFacts(properties: readonly GuarantorProperty[], opts: { parallel: boolean }): { block: string; allowedNames: string[]; plan: ParallelScreeningPlan } {
  const plan = planParallelScreening(properties);
  const lines: string[] = ["【物件ごとの保証会社（スタッフ入力・確定事実。この会社名・種類だけを使う）】"];
  for (const p of properties) lines.push(`- ${p.name}: ${normalizeGuarantorName(p.company)}（${GUARANTOR_TYPE_LABELS[p.type]}）`);
  lines.push("【種類ごとに使ってよい言い回し（この文だけ。種類から別の説明を作らない）】");
  const types = GUARANTOR_TYPES.filter((t) => properties.some((p) => p.type === t));
  for (const t of types) {
    if (t === "unknown") lines.push("- 不明・その他: 種類には触れない（審査の緩い・厳しいを書かない）。「の保証会社は〇〇となります！！」まで");
    else lines.push(`- ${GUARANTOR_TYPE_SHORT[t]}: 「・物件名」の次行に「${GUARANTOR_TYPE_SENTENCE[t]("〇〇")}」`);
  }
  lines.push("【並行審査】");
  const mode = parallelMode(properties, plan, opts.parallel);
  if (mode === "parallel") {
    lines.push(`保証会社が異なるお部屋（${plan.groups.map((g) => g.company).join("／")}）は並行して審査をかけられる。文: 「${PARALLEL_LINE}」`);
    for (const ov of plan.overlapping) lines.push(`同じ会社の組（${ov.properties.join("と")}=${ov.company}）は「どちらか1件の審査となります」と1文で伝える`);
  } else if (mode === "same_company") {
    lines.push(`全物件が同じ会社（${plan.groups[0]?.company ?? ""}）＝並行審査は書かない。「お気に召されたお部屋1件ずつ審査」と書く`);
  } else {
    lines.push("並行審査の提案は書かない");
  }
  lines.push(`【必ず入れる】${CANCEL_LINE}`);
  lines.push("【禁止】上記に無い保証会社名・種類／「審査通ります」「通りそうです」等の通過の断言（許される言い回しは上の文の「審査通過する可能性十分に御座います」「審査無事通過する為」まで）／保証人・緊急連絡先の話");
  const allowedNames = [...new Set(properties.flatMap((p) => {
    const canonical = normalizeGuarantorName(p.company);
    return [p.company.trim(), canonical, ...guarantorAliasesOf(canonical)];
  }).filter(Boolean))];
  return { block: lines.join("\n"), allowedNames, plan };
}

// ─── 本文の事実の照合（決定論）───
/** 単独では走査しない一般語 */
const SCAN_SKIP = new Set(["ライフ", "シノケン", "アーク", "エイト", "オセロ", "プレサンス"]);
/** 2026-09-15 検証指摘: 会社名の直後にこの語が続く時は別の言葉（「ナップサック」）なので伏せない */
const SCAN_NOT_FOLLOWED_BY: Record<string, string[]> = { "ナップ": ["サック"] };
/** UI の「会話履歴から保証会社名を自動検出」にも使える走査語（長い順） */
export const GUARANTOR_SCAN_WORDS: readonly string[] = [...new Set(GUARANTOR_COMPANY_MASTER.flatMap((c) => [c.name, ...c.aliases]))].sort((a, b) => b.length - a.length);
const isAsciiWord = (w: string) => /^[\x20-\x7e]+$/.test(w);
const isAlnum = (ch: string) => /^[A-Za-z0-9]$/.test(ch);

/**
 * 本文から走査語の出現範囲 [start, end) を返す（元の本文の位置。NFKC で一致する半角カナ・全角英字も元の文字列上で範囲を取るので、
 * 伏せる時に本文全体を NFKC 化して「！！」→「!!」のように文体を崩さない＝2026-09-15 検証指摘）。
 * 英数字だけの語（NAP・JID・casa・EPOS 等）は語境界付き（「snapshot」「casablanca」「JIDAI」に当てない）。
 */
function findWordRanges(text: string, word: string): Array<[number, number]> {
  const target = word.normalize("NFKC").toLowerCase();
  const ascii = isAsciiWord(target);
  const notFollowed = SCAN_NOT_FOLLOWED_BY[word] ?? [];
  const ranges: Array<[number, number]> = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    let acc = "";
    let matched = -1;
    for (let j = i; j < n; j++) {
      acc += text[j];
      const norm = acc.normalize("NFKC").toLowerCase();
      if (norm.length > target.length) break;
      if (norm === target) { matched = j + 1; break; }
    }
    if (matched < 0) { i++; continue; }
    const before = i > 0 ? text[i - 1].normalize("NFKC") : "";
    const after = matched < n ? text[matched].normalize("NFKC") : "";
    const boundaryOk = !ascii || (!isAlnum(before) && !isAlnum(after));
    const tailOk = !notFollowed.some((s) => text.startsWith(s, matched));
    if (boundaryOk && tailOk) { ranges.push([i, matched]); i = matched; }
    else i++;
  }
  return ranges;
}

/**
 * 本文に入力に無い保証会社名（マスタの別会社・extraCompanies に渡したスタッフ登録の会社）が出たら「〇〇」に伏せ、種類の表現が入力と食い違えば typeWarnings に出す。
 * 長い順に走査するので「オリコフォレントインシュア」が伏せられた後に「オリコ」で再走査されない。固定テンプレの出力は必ず ok
 * @param extraCompanies guarantor_companies テーブルのスタッフ登録分（入力に無い登録会社名も走査する。純関数のまま＝呼び出し側が渡す）
 */
export function checkGuarantorFacts(
  text: string,
  properties: readonly GuarantorProperty[],
  extraCompanies: ReadonlyArray<{ name: string }> = [],
): { ok: boolean; cleaned: string; unmatched: string[]; typeWarnings: string[] } {
  const allowedCanonical = new Set(properties.map((p) => nameKey(normalizeGuarantorName(p.company))));
  const scan: Array<{ word: string; canonical: string }> = [];
  for (const c of GUARANTOR_COMPANY_MASTER) {
    if (allowedCanonical.has(nameKey(c.name))) continue;
    for (const w of [c.name, ...c.aliases]) {
      if (w.normalize("NFKC").length < 3 || SCAN_SKIP.has(w)) continue;
      scan.push({ word: w, canonical: c.name });
    }
  }
  for (const x of extraCompanies) {
    const w = (x?.name ?? "").trim();
    if (!w || w.normalize("NFKC").length < 3 || isMasterGuarantor(w) || allowedCanonical.has(nameKey(w))) continue;
    scan.push({ word: w, canonical: w });
  }
  scan.sort((a, b) => b.word.length - a.word.length);
  let cleaned = text ?? "";
  const unmatched: string[] = [];
  for (const { word, canonical } of scan) {
    const ranges = findWordRanges(cleaned, word);
    if (ranges.length === 0) continue;
    // 後ろから置き換えて位置がずれないようにする
    for (const [s, e] of ranges.reverse()) cleaned = cleaned.slice(0, s) + "〇〇" + cleaned.slice(e);
    if (!unmatched.includes(canonical)) unmatched.push(canonical);
  }
  // 種類の表現（伏せ字にはしない・notice にだけ出す）。LICC系の許された文「独立系の保証会社に比べると」の「独立系」は数えない
  const has = (t: GuarantorType) => properties.some((p) => p.type === t);
  const t = cleaned.replace(/独立系の保証会社に比べ/g, "");
  const typeWarnings: string[] = [];
  if (/独立系/.test(t) && !has("independent")) typeWarnings.push("種類:独立系");
  if (/LICC系/i.test(t) && !has("licc")) typeWarnings.push("種類:LICC系");
  // 2026-09-26 竹内さん決定: スタッフの「信用系」＝信販系
  if (/信販系|信用系/.test(t) && !has("credit")) typeWarnings.push("種類:信販系");
  if (/審査基準が緩|審査ゆるめ|緩め|審査(?:が|は)?緩/.test(t) && !has("independent")) typeWarnings.push("種類:緩い");
  return { ok: unmatched.length === 0 && typeWarnings.length === 0, cleaned, unmatched, typeWarnings };
}

/**
 * 会話の1通から保証会社名を拾う（UI の「会話から入れる」候補。長い会社名から当てるので「オリコフォレントインシュア」が「オリコ」に負けない）。
 * 2026-09-17 竹内（YUYA 事例）: 画面側に別の短い一覧（11社）がコピーされていたのをここに寄せた（名寄せ・種類・語境界の判定が1か所）
 */
export function detectGuarantorInText(text: string): { name: string; type: GuarantorType } | null {
  const t = text ?? "";
  if (!t.trim()) return null;
  for (const w of GUARANTOR_SCAN_WORDS) {
    if (w.normalize("NFKC").length < 3 || SCAN_SKIP.has(w)) continue;
    if (findWordRanges(t, w).length === 0) continue;
    const r = resolveGuarantor(w);
    return { name: r.name, type: r.type };
  }
  return null;
}

/** 会話（古い順の配列）から一番新しい保証会社名を拾う。スタッフ・お客様どちらの発言も見る（管理会社の回答をそのまま貼る運用があるため） */
export function detectGuarantorFromMessages(messagesOldestFirst: ReadonlyArray<{ text?: string | null }>): { name: string; type: GuarantorType } | null {
  for (let i = messagesOldestFirst.length - 1; i >= 0; i--) {
    const hit = detectGuarantorInText(messagesOldestFirst[i]?.text ?? "");
    if (hit) return hit;
  }
  return null;
}

// ─── スタッフの実文（会話を合わせるの手本・中身は写さない）───
export const GUARANTOR_INFO_STAFF_EXAMPLES: readonly string[] = [
  "お世話になっております！！\nこちら保証会社一覧となります！！\n・カーザSun I\n・Renatus新大阪\nの保証会社は日本セーフティと独立系の保証会社となりますので、審査基準が緩い保証会社となります😊！！\n\n審査無事通過する為、保証会社が異なるお部屋並行して審査かけさせて頂く事可能です！！\nよろしければお気に召されたお部屋一度審査かけさせて頂きます！！\n\n※保証会社審査通過後、オーナー審査移行するまでキャンセル料不要となります！！",
  "アベニュー西長居201号室の保証会社が全保連となりLICC系の保証となります！！LICC系保証会社となり、独立系の保証会社に比べると審査基準は上がりますが、信用情報を重視した審査基準とはなりませんので審査通過する可能性十分に御座います！！保証会社の審査が通過後オーナー審査に移行するまではキャンセル料かかりませんので、お気に召されましたら一度審査かけさせて頂くこと可能となります！！",
  "ヴィラ汐町・オーラコート杭瀬の保証会社が日本セーフティと独立系の保証会社となります！！独立系保証会社の為審査基準緩く、審査通過する可能性十分に御座います！！よろしければ一度お申込みし審査かけてみるのは如何でしょうか😌！！",
  "こちらのお部屋如何でしょうか😌！保証会社がアセス保証と他物件と被っておりませんので、お気に召されましたら審査かけさせて頂きます！",
  "H-Maison大正:保証会社JPMC\nソルテラスNAMBAサウスフィール:保証会社Casa\nとなり比較的審査通過しやすいお部屋となります😊！！お気に召されましたらお部屋お申込みいただくのをお勧めいたします！！",
];
