// app/lib/viewing-access.ts
// 内覧が決まった後の「道順・場所」の質問に、決まっている事実（住所）で答えるための材料と出口（純関数・DB 依存なし）。
//
// 2026-09-16 竹内（𝒮 さん事例）「根本的な部分を、住所わかっている。また適当な事出さない為にも、
//   詳細明日等適当なことを俺は入れないし、バスの説明の部分もわかりにくい。このずれを改善する」:
//   明日 9/17 12:00 に CRESTTAPP野田 204号室（住所: 大阪府大阪市福島区吉野5丁目11-4）で待ち合わせ済み。
//   お客様「今の家から野田阪神までバス出てるからバスで行こうと考えてて」「野田阪神からは少し距離ありますかね、土地勘なくてすみません」
//   → 下書き「…バスでお越しの際は野田阪神からお近くのバス停をご利用いただく形が便利かと思います😊！！／
//      当日迷われないよう明日また詳細ご案内させて頂きます！！」
//   実送信「…バスでお越しの際は野田阪神から下車頂き、徒歩でマンションまで到着出来ます😊！！／
//      マンションの住所:が／大阪府大阪市福島区吉野5丁目11-4／となります😌！！」
//
//   【ズレの正体】住所は viewing_history に構造化されて入っているのに返信生成に届いておらず（材料の断線）、
//   さらにプロンプトが「段取りを聞かれても『内覧の詳細については改めてご連絡させて頂きます！！』まで」と
//   **先送りを明示的に命じていた**（line-reply-prompts の viewing フェーズ・待ち合わせのゲート）。
//   「新しく待ち合わせを決める文は AIX 専用」という正しい分業が、「決まっている事実を答える」ことまで禁じていた。
//   実データ: 先送りの言い回し（明日／後ほど／改めて…詳細…ご案内）はスタッフの実送信 11,429通中3件（0.03%）で、
//   うち手打ちの本物は「明日午前中に初期費用詳細確認させて頂き御見積しお送りさせて頂きます」＝何を・いつ・どうするかが決まった約束だけ。

/** お客様が内覧の場所・行き方を聞いている（内覧が決まっている会話でだけ使う） */
export const VIEWING_ACCESS_QUESTION_RE =
  /最寄(?:り)?(?:駅)?|何駅|どの駅|どこの駅|行き方|道順|どうやって(?:行|伺|向か)|アクセス|土地勘|バス|電車|歩い|徒歩|距離|何分|住所|場所(?:は|って|を|教え)|どこ(?:です|ですか|でしょう|になり|にな)/;
/** 物件探しの条件の話（「駅徒歩10分以内で」「徒歩圏内がいい」「他に物件あれば送って」）— 内覧の道順ではない */
const SEARCH_CONDITION_RE =
  /(?:徒歩|駅から)\s*[0-9０-９]{1,2}\s*分(?:以内|くらい|程度|圏内)?|徒歩圏内|探し|ピックアップ|物件[^\n]{0,10}(?:送|出|教え|あれ|ありまし)|お部屋[^\n]{0,10}(?:送|出|教え)/;

/**
 * 内覧の道順・場所を聞いているか。内覧が決まっている会話（hasAppointment）でだけ true にする。
 * 物件探しの条件（駅徒歩10分以内で探して）は除く
 */
export function isViewingAccessQuestion(text: string | null | undefined, hasAppointment: boolean): boolean {
  if (!hasAppointment) return false;
  const t = (text ?? "").trim();
  if (!t) return false;
  if (SEARCH_CONDITION_RE.test(t)) return false;
  return VIEWING_ACCESS_QUESTION_RE.test(t);
}

/**
 * 決まっている内覧の事実（生成に渡す材料）。住所は viewing_history.property_address（お客様に送った待ち合わせと同じ値）。
 * 鍵の開け方・キーボックスの番号などの社内情報は**渡さない**（カレンダーの notes には入っているので、この関数には住所だけを渡すこと）
 */
export function buildViewingAccessNote(o: {
  propertyName?: string | null;
  address?: string | null;
  dateMD?: string | null;
  time?: string | null;
}): string {
  const addr = (o.address ?? "").trim();
  const name = (o.propertyName ?? "").trim();
  if (!addr && !name) return "";
  const when = [(o.dateMD ?? "").trim(), (o.time ?? "").trim()].filter(Boolean).join(" ");
  const lines = [
    "【決まっている内覧（お客様に案内済みの事実・そのまま答えてよい）】",
    when ? `日時: ${when}` : "",
    name ? `物件: ${name}` : "",
    addr ? `住所: ${addr}` : "",
    "・お客様が場所・行き方を聞いた時は、この住所をそのまま答える（「改めてご連絡」「明日また詳細」で先送りしない）",
    "・ここに無いこと（最寄り駅名・徒歩の分数・バス停の名前・所要時間）は書かない。会話でこちらが既に伝えた数字だけ使う",
    "・お客様が決めている行き方（例: 〇〇駅までバスで行く）は否定も言い換えもせず、その続き（降りた後どうするか）だけ答える",
  ].filter(Boolean);
  return lines.join("\n");
}

// ── 出口: 中身のない先送りを落とす ───────────────────────────────
/** 「明日また詳細ご案内させて頂きます」型（いつ＋詳細＋案内）。何を送るのかが決まっていない先送り */
const VAGUE_DEFERRAL_RE =
  /(?:明日|翌日|後ほど|のちほど|改めて|追って|後日|当日|別途|随時)[^\n]{0,24}(?:詳細|詳しく|詳しい)[^\n]{0,24}(?:ご案内|ご連絡|お伝え|お送り|案内)/;
/** 何を届けるかが決まっている約束は残す（実データの本物: 「明日午前中に初期費用詳細確認させて頂き御見積しお送りさせて頂きます」） */
const CONCRETE_OBJECT_RE =
  /御?見積|初期費用|資料|図面|間取|物件|お部屋|番手|審査|保証会社|住所|地図|マップ|写真|動画|条件|募集状況/;
/** 1文（末尾の「！！」のような連続した句読点までを1つに） */
const SENTENCE_RE = /[^。！!？?]*[。！!？?]*/g;

/**
 * 中身のない先送りの文だけを落とす（何を届けるかが決まっている約束はそのまま）。
 * 竹内さん「詳細明日等適当なことを俺は入れない」。全部落ちる時は元のまま返す（返信を空にしない）
 */
export function stripVagueDeferral(text: string): string {
  const src = text ?? "";
  if (!VAGUE_DEFERRAL_RE.test(src)) return src;
  const out = src
    .split("\n")
    .map((line) => (line.match(SENTENCE_RE) ?? [])
      .filter((s) => s !== "")
      .filter((s) => !(VAGUE_DEFERRAL_RE.test(s) && !CONCRETE_OBJECT_RE.test(s)))
      .join(""))
    .filter((line, i, arr) => line.trim() !== "" || (i > 0 && i < arr.length - 1 && arr[i - 1].trim() !== ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trimEnd();
  return out.trim() ? out : src;
}
