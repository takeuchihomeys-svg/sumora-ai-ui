// app/lib/aix-owner-answers-1021.ts（純関数・DB/ネットに触れない）
// 2026-10-21 竹内さんの答え（AIX 側）。
//   C9 AIX に新しく【審査について】のボタン（中に 保証会社について・職業・名義・保証人・外国籍・時期・その他）。
//      既存の【保証会社について】（guarantor_info）と『審査について（ご相談）』（property_check_result/mgmt_screening）を1か所にまとめる。
//      action_type の値は変えない（記録・ブレインの値はそのまま＝旧の値 → 新しいボタンの名前に読み替えるだけ）。審査の事情は必ず Claude。
//   C2/C3 他社の見積が安い・『なぜ安い』→ AIX【初期費用について】の説明の部分（会社の事実: 貸主様からの手数料を初期費用に還元／他社は保証料など別払い・弊社は全部込み）
//   C5 他社に見積の抜けを指摘された → AIX【見積書送る】から送り直す（2通目の言い方を『訂正しました御見積書』に）
//   C6 他社で紹介・仮押さえ・内覧予定の物件の見積には毎回『弊社でもお申込み・ご内覧頂けます』を添える（決定論・既定 on）
// 切替（どれも off で今まで通り）:
//   AIX_SCREENING_BUTTON（既定 on）= ブレインのカードの名前『AIX 審査について』・ブレインの一覧で 保証会社について／審査について（ご相談）を【審査について】の中に並べる。
//     値 "brain" の時だけ、AIX_NEW_PICKERS_1020 が off でもブレインが mgmt_screening を選べる（まだ測っていないので既定にしない）
//   COST_COMPARE_FACT（既定 on）・ESTIMATE_CORRECTION_WORDING（既定 on）・ESTIMATE_OTHER_AGENT_LINE（既定 on）

import { OTHER_AGENT_RE } from "./other-agent-viewing";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
const offOf = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "off";

// ─── C9 審査について ─────────────────────────────────────────────────────────

/** 新しいボタンの名前（四者同名: 画面のメニュー・ブレインのカード・ブレインの一覧・記録の読み替え） */
export const SCREENING_BUTTON = "審査について";

export function screeningButtonEnabled(env: Env = envOf()): boolean {
  return !offOf(env.AIX_SCREENING_BUTTON);
}
/** ブレインが mgmt_screening（審査について→審査内容）を選べるか（AIX_SCREENING_BUTTON=brain の時だけ・既定は選ばない） */
export function screeningBrainEnabled(env: Env = envOf()): boolean {
  return (env.AIX_SCREENING_BUTTON ?? "").trim().toLowerCase() === "brain";
}

/** 審査について の中の選択肢。guarantor＝既存の【保証会社について】（guarantor_info）・他は 審査について（ご相談）（mgmt_screening）＋話題 */
export type ScreeningTopic = "guarantor" | "job" | "holder" | "guarantor_person" | "nationality" | "timing" | "other";
export const SCREENING_TOPIC_OPTIONS: ReadonlyArray<{ value: ScreeningTopic; label: string; desc: string }> = [
  { value: "guarantor", label: "保証会社について", desc: "物件ごとの保証会社名・種類を入れて一覧と審査の通りやすさ・並行審査の勧めを1通で" },
  { value: "job", label: "職業・収入について", desc: "お勤め先・雇用形態・収入（夜職・内定・無職など）の審査の相談に答える" },
  { value: "holder", label: "名義について", desc: "ご本人以外（ご家族・パートナー）の名義での契約の相談に答える" },
  { value: "guarantor_person", label: "保証人について", desc: "保証人がいない・立てられない時の審査の相談に答える" },
  { value: "nationality", label: "外国籍について", desc: "外国籍・在留資格の審査の相談に答える" },
  { value: "timing", label: "時期について", desc: "いつ審査にかけるか（先に審査・内定後など）の相談に答える" },
  { value: "other", label: "その他", desc: "上に無い審査の相談（確認した結果を入れて返す）" },
];
export function isScreeningTopic(v: unknown): v is ScreeningTopic {
  return typeof v === "string" && SCREENING_TOPIC_OPTIONS.some((o) => o.value === v);
}
export function screeningTopicLabel(v: unknown): string | null {
  return SCREENING_TOPIC_OPTIONS.find((o) => o.value === v)?.label ?? null;
}

/** 生成に渡す話題の1行（文の中心を決めるだけ・事実はスタッフの入力のまま） */
export function screeningTopicLine(v: unknown): string {
  switch (v) {
    case "job": return "相談の中身：職業・収入（お勤め先・雇用形態・収入の事情）。お客様の職業・収入を文に繰り返さない";
    case "holder": return "相談の中身：契約の名義（ご本人以外の名義）。名義の方の情報を文に書かない";
    case "guarantor_person": return "相談の中身：保証人（保証人がいない・立てられない）。保証会社の審査で進める考え方を中心に";
    case "nationality": return "相談の中身：外国籍・在留資格。国籍・在留資格を文に繰り返さない";
    case "timing": return "相談の中身：審査にかける時期（先に審査・内定後 等）";
    case "other": return "相談の中身：審査の相談（その他）";
    default: return "";
  }
}

/**
 * 記録・ブレインの値（旧の action_type）→ 審査について のボタンか。
 *   guarantor_info（保証会社について）・property_check_result/mgmt_screening（審査について（ご相談））＝審査について
 *   mgmt_guarantor（管理会社に確認した→保証会社について（審査面））は物件の条件の確認なので今まで通り 確認した（条件・交渉）
 */
export function isScreeningButtonAction(action: string | null | undefined, checkPattern?: string | null): boolean {
  if (action === "guarantor_info") return true;
  return action === "property_check_result" && checkPattern === "mgmt_screening";
}
/** ブレインのカード・2択の名前（切替 on の時だけ・off＝null＝呼び出し側の今までの名前） */
export function screeningCardLabel(action: string | null | undefined, checkPattern?: string | null, env: Env = envOf()): string | null {
  if (!screeningButtonEnabled(env) || !isScreeningButtonAction(action, checkPattern)) return null;
  return action === "guarantor_info" ? `AIX ${SCREENING_BUTTON}（保証会社）` : `AIX ${SCREENING_BUTTON}`;
}

// ─── C2/C3 他社の見積と比べている・なぜ安い ───────────────────────────────────────

// 他社の話の網は other-agent-viewing.ts の1か所（他社で内覧する話と同じ語）＋「業者さんの見積」の「の」
const OTHER_AGENT_WORD_RE = new RegExp(`${OTHER_AGENT_RE.source}|(?:不動産屋|業者)(?:さん)?の`, "i");
const COST_WORD_RE = /見積|初期費用|費用|金額|値段|料金|総額|合計/;
const CHEAP_Q_RE = /(?:なぜ|なんで(?!す)|何で|どうして|どうやって)[^。\n]{0,20}(?:安|お安|抑え|割引|0円|無料)|(?:安|お安)(?:い|すぎ|過ぎ)[^。\n]{0,12}(?:理由|なぜ|なんで|何で|どうして|大丈夫|怪し|裏|本当|ほんと)|(?:安|お安)(?:い|すぎ|過ぎ)(?:んですか|のですか)/;
const COMPARE_RE = /(?:より|と比べ|に比べ|比較)[^。\n]{0,20}(?:安|高|お安)|(?:安|高|お安)[^。\n]{0,8}(?:かった|いです|くて|い見積|い金額)|相見積|あいみつ/;

/**
 * お客様の発言が「他社の見積と比べている」か「なぜ安いのか」を聞いているか（会社の事実を足す時だけ使う＝関係ある時だけ）。
 *   例: 「他社の見積だと〇〇円でした」「他社のほうが安かったんですが」「なんでこんなに安いんですか？」
 */
export function isOtherAgentCostCompare(text: string | null | undefined): boolean {
  const s = String(text ?? "").normalize("NFKC").replace(/\s+/g, " ");
  if (!s.trim()) return false;
  // 画像の読み取りは見ない（180日で当たった画像 18枚の多くは弊社の御見積書・物件資料・ポータルの画面。他社の見積の画像は「他社がこれを提示してきて」等の文と一緒に来る）
  if (/^\[画像\]/.test(s.trim())) return false;
  if (CHEAP_Q_RE.test(s)) return true;
  if (OTHER_AGENT_WORD_RE.test(s) && /(?:ほう|方|より)が?(?:安|お安)/.test(s) && !/お部屋|物件|家賃/.test(s)) return true;
  return OTHER_AGENT_WORD_RE.test(s) && COST_WORD_RE.test(s) && (COMPARE_RE.test(s) || /[0-9０-９,，]{3,}円|万円?/.test(s));
}
export function costCompareFactEnabled(env: Env = envOf()): boolean {
  return !offOf(env.COST_COMPARE_FACT);
}
/**
 * 竹内さんが承認した会社の事実（10/21 C2/C3・言い方は竹内さんの実送信 8/23・7/11・6/17 のまま）。
 *   関係ある時（他社の見積と比べている・なぜ安い）だけ AIX【初期費用について】に足す。金額は御見積書の内訳だけ（ここに金額は無い）
 */
export const COST_COMPARE_FACT_BLOCK = [
  "【他社の御見積書と比べている／なぜ安いのかを聞かれている時の説明（竹内さんが承認した会社の事実・この場面だけ使う）】",
  "・弊社は貸主様からの手数料（広告料）を初期費用として還元させて頂く形なので、初期費用を大きく抑える事が出来る（竹内さんの言い方「貸主様からの手数料を初期費用としまして還元させて頂く形となりますのでかなり初期費用を抑える事が出来ます😊！！」）",
  "・他社様の御見積書は初回保証料などの費用を別途お支払いとして省いている事がある。弊社の御見積書はご入居にかかる初期費用を全て含めた金額（言い方「他社様は初回保証料の費用を別途お支払いとしまして省いておりますが、弊社はご入居にかかる初期費用を全て含めて計算させて頂きました！！」「弊社の金額は全費用込みの最大割引後の金額となりますのでご安心ください！！」）",
  "・他社様の金額に何が含まれているかは分からないので、他社様が省いていると断言しない（「省いている事がございます」「含まれているかご確認頂けますと」の形）。他社様を悪く言わない",
  "・物件ごとの還元額・貸主様からの手数料の金額は書かない（御見積書の内訳に無い金額は書かない決まりのまま）",
  "・説明は①お客様の質問への答え（御見積書の内訳）の後に1〜2文。他社と比べていない・安さを聞いていない時は書かない",
].join("\n");

// ─── C5 訂正した御見積書／C6 他社の物件 ───────────────────────────────────────────

type Msg = { sender?: string | null; text?: string | null };
const isCustomer = (m: Msg) => m.sender === "customer" || m.sender === "user";

const MISSING_RE = /抜け|漏れ|入って(?:い)?ない|入っていません|含まれて(?:い)?ない|含まれていません|記載(?:が)?(?:ない|無い|ありません)|足りない|足りてない|指摘/;
const STAFF_CORRECTION_PROMISE_RE = /(?:訂正|修正)(?:しました|させて(?:頂|いただ)きました|した|版の)?[^\n。]{0,6}(?:御|お)見積/;
export function estimateCorrectionWordingEnabled(env: Env = envOf()): boolean {
  return !offOf(env.ESTIMATE_CORRECTION_WORDING);
}
/**
 * 送り直す御見積書が「訂正した御見積書」か（最後のこちらの御見積書より後の会話で読む）。
 *   ・スタッフが「訂正しました御見積書（作成しお送り）」と約束している（竹内さん 9/06 の実送信）
 *   ・お客様が御見積書の抜け・漏れを指摘した（他社に指摘された 等）
 *   画面で選んだ値（explicit）があればそれが正。
 */
export function isEstimateCorrectionContext(msgs: ReadonlyArray<Msg>, explicit?: boolean | null, env: Env = envOf(), o: { justSent?: boolean } = {}): boolean {
  if (typeof explicit === "boolean") return explicit;
  if (!estimateCorrectionWordingEnabled(env)) return false;
  let arr = Array.isArray(msgs) ? [...msgs] : [];
  // justSent: 今送ったばかりの御見積書（1通目・画像）が末尾にある（2通目の生成）＝それは除いて読む
  if (o.justSent) {
    while (arr.length && !isCustomer(arr[arr.length - 1]) && /初期費用[：:]|御見積書|お見積書|^\[画像\]$|割引させて頂き/.test(String(arr[arr.length - 1].text ?? "").trim())
      && !STAFF_CORRECTION_PROMISE_RE.test(String(arr[arr.length - 1].text ?? ""))) arr = arr.slice(0, -1);
  }
  // 最後にこちらが御見積書を送った位置（無ければ訂正ではない＝初めての見積書）
  let lastEst = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!isCustomer(m) && /御見積書|お見積書|初期費用[：:]/.test(String(m.text ?? ""))) {
      // 約束の文（訂正しました御見積書作成しお送り）は送った御見積書ではない
      if (STAFF_CORRECTION_PROMISE_RE.test(String(m.text ?? "")) && /作成|お送りさせて(?:頂|いただ)きます|お送り致します/.test(String(m.text ?? ""))) continue;
      lastEst = i; break;
    }
  }
  if (lastEst < 0) return false;
  for (let i = lastEst + 1; i < arr.length; i++) {
    const t = String(arr[i].text ?? "").normalize("NFKC");
    if (!isCustomer(arr[i]) && STAFF_CORRECTION_PROMISE_RE.test(t)) return true;
    // 画像の読み取り（物件資料の「記載なし」等）は見ない（180日の実データで、物件資料の画像だけで次の御見積書が『訂正』になった外れ）
    if (isCustomer(arr[i]) && !/^\[画像\]/.test(t.trim()) && MISSING_RE.test(t) && /見積|費用|代|料|金額|円/.test(t)) return true;
  }
  return false;
}

/** 他社で紹介・仮押さえ・内覧（予定）・見積の話の物件（お客様の発言）。「他社で決まりました」でも当たるが、その時は見積書を送らない */
const OTHER_PROP_ACT_RE = /紹介|仮押さ|仮押え|押さえ|抑え|内覧|内見|見学|案内|申込|申し込|見積|検討/;
export function estimateOtherAgentLineEnabled(env: Env = envOf()): boolean {
  return !offOf(env.ESTIMATE_OTHER_AGENT_LINE);
}
/** お客様が他社で紹介・仮押さえ・内覧（予定）・見積を受けた物件の話をしているか（直近のお客様の発言） */
export function mentionsOtherAgentProperty(msgs: ReadonlyArray<Msg>, env: Env = envOf(), window = 30): boolean {
  if (!estimateOtherAgentLineEnabled(env)) return false;
  const arr = (Array.isArray(msgs) ? msgs : []).slice(-window);
  return arr.some((m) => {
    if (!isCustomer(m)) return false;
    const s = String(m.text ?? "").normalize("NFKC").replace(/\s+/g, " ");
    // 画像の読み取り・引越しの業者（「運ぶのは業者さんに頼みます」180日の実データで当たった外れ）は見ない
    if (/^\[画像\]/.test(s.trim()) || /引っ?越し?(?:の)?業者|運ぶ|搬入|搬出|配送/.test(s)) return false;
    return OTHER_AGENT_WORD_RE.test(s) && OTHER_PROP_ACT_RE.test(s);
  });
}

/** C6 の一文（竹内さん 10/21「弊社でもお申込み・ご内覧できます」を添える・実送信 7/16「弊社でお申込みも可能です」の言い方） */
export const OTHER_AGENT_HERE_LINE = "弊社でもお申込み・ご内覧頂けます！！";
const OTHER_AGENT_HERE_SENT_RE = /弊社(?:でも|にて|で)[^\n]{0,12}(?:お申込|お申し込|ご内覧|ご内見|内覧|内見)/;
/** C5 の言い方（竹内さん 9/06「訂正しました御見積書作成しお送りさせて頂きます」の送る番の形） */
export const ESTIMATE_CORRECTION_LINE = "訂正しました御見積書となります！！";
const CORRECTION_SENT_RE = /訂正|修正/;
const MAX_DISCOUNT_ESTIMATE_RE = /最大限割引(?:しました|させて(?:頂|いただ)いた|した)(?:初期費用の)?(?:御|お)見積書/;

/**
 * 見積書の2通目（カバーの文）の出口（足す・言い換えるだけ・他は消さない）。
 *   correction: 「最大限割引しました（初期費用の）御見積書」を「訂正しました御見積書」に。無ければ挨拶の後に1行足す
 *   otherAgent: 「弊社でもお申込み・ご内覧頂けます！！」が無ければ締め（ご査収・お気軽に）の前に足す（無ければ最後）
 */
export function applyEstimateOwnerLines(text: string, o: { correction?: boolean; otherAgent?: boolean }): { text: string; added: string[] } {
  let src = String(text ?? "").replace(/\r\n/g, "\n").trim();
  const added: string[] = [];
  if (!src) return { text: src, added };
  if (o.correction && !CORRECTION_SENT_RE.test(src)) {
    if (MAX_DISCOUNT_ESTIMATE_RE.test(src)) {
      src = src.replace(MAX_DISCOUNT_ESTIMATE_RE, "訂正しました御見積書");
    } else {
      const lines = src.split("\n");
      let at = 0;
      while (at < lines.length && (/^\s*$/.test(lines[at]) || /お世話になっております|^\s*\S{1,15}(?:さん|様)\s*$/.test(lines[at]))) at++;
      lines.splice(at, 0, ESTIMATE_CORRECTION_LINE);
      src = lines.join("\n");
    }
    added.push("correction");
  }
  if (o.otherAgent && !OTHER_AGENT_HERE_SENT_RE.test(src)) {
    const lines = src.split("\n");
    let k = lines.length - 1;
    while (k >= 0 && !lines[k].trim()) k--;
    if (k >= 0 && /^(?:お手隙の際に|お気軽に)/.test(lines[k].trim())) lines.splice(k, 0, OTHER_AGENT_HERE_LINE);
    else lines.push(OTHER_AGENT_HERE_LINE);
    src = lines.join("\n");
    added.push("other_agent");
  }
  return { text: src, added };
}

/** 2通目の指示に足す文（指示だけでは落ちるので出口の applyEstimateOwnerLines と両方） */
export function estimateOwnerNote(o: { correction?: boolean; otherAgent?: boolean }): string {
  const L: string[] = [];
  if (o.correction) L.push(`・今回の御見積書はお客様のご指摘で直した物（訂正版）。1文目は「${ESTIMATE_CORRECTION_LINE}」の形（「最大限割引しました」とは書かない）。何を直したか（項目・金額）は書かない。謝罪の言葉（申し訳ございません）は使わない`);
  if (o.otherAgent) L.push(`・お客様は他社でこのお部屋の紹介・仮押さえ・内覧の話をしている。締めの前に「${OTHER_AGENT_HERE_LINE}」を必ず入れる（他社を悪く言わない）`);
  return L.length ? `【この御見積書の事情（竹内さん 10/21 の決定）】\n${L.join("\n")}` : "";
}
