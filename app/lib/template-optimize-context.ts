// app/lib/template-optimize-context.ts
// AIX の後の一言（テンプレの「✨ AIで最適化」＝ /api/generate-reply のテンプレ最適化・🟣 AIX モード）に渡す材料を決める純関数。
//
// 2026-09-27 竹内「AIXのあとのひとことはAIXテンプレートの部分の、この会話にあった文を生成のところとなる／
//   実際のスタッフが送った文のように質を上げるために必要な部分を改善していく」
//   実測（template_selection_logs 90日・AI 最適化を通して送った 398件・scripts/audit-template-adapt.ts）で、スタッフが毎回同じ直しをしていた所のうち、
//   入口（渡す材料・指示）で直せる物をここに置く。出口（本文の書き換え）は誤削除0が示せた物だけ route.ts 側に置く。
//
//   ① 「お客様のメッセージ」の枠: 入力欄が空の時、既に AIX で応えた古いお客様の発言を「今の発言」として入れていた
//      → 生成が「かしこまりました／とんでもございません／承知いたしました」から書き出す（返事の出だし 14件・スタッフが残したのは正当な1件だけ）。
//      スタッフの実送信（AIX テンプレ 380件）で返事の言い回しから書き出したのは 3件（最後のお客様の発言の後にこちらが送っている場面は 2/102）。
//      → 最後のお客様の発言の後にこちらが送っていたら、「お客様の新着なし・AIX の続きの1通」と明示する（resolveTemplateOptimizeMessage）
//   ② ピッカーの種類: 「新着1件」なのにテンプレの「お送りさせて頂きましたお部屋の中でも」（比べる言い方）を残していた（生成 31/58・スタッフは 39/58 で消した）。
//      ピックアップ（新規・継続）の時は 128/137 で残すのが正しいので、新着1件の時だけ注記する（pickerModeNote）
//   ③ 実際のスタッフの送った文を手本にする: 学習ルール（adaptation_improvement_rules）は食い違う物・「お待たせ」を推す物が「必ず守ること」で入っていた。
//      代わりに同じテンプレ（同じピッカーを優先）のスタッフの実送信を、他のお客様の物件名・金額・名前を伏せて「形の手本」として見せる（maskStaffExample）。
//      手本は他のお客様の会話なので、伏せた語が生成に出たら漏れとして記録する（findLeakedSpans・設計知見「別の顧客の情報が混ざった」の経路）
import { neutralizeWaitedInExample } from "./waited-scope";

export type TplMsg = { sender: string; text?: string | null; createdAt?: string | null; isAix?: boolean };

/** お客様の新着が無い時に「お客様のメッセージ」の枠へ入れる文（AIX の続きの1通） */
export const TEMPLATE_NO_NEW_CUSTOMER_MESSAGE =
  "（お客様の新着メッセージなし — こちらが直前に送った AIX（資料）の続きの1通。お客様の発言への返事ではない）";
/** 旧来の合成文（AIX でない テンプレ最適化・履歴にお客様の発言が1通も無い時） */
export const TEMPLATE_FALLBACK_MESSAGE = "（お客様の新着メッセージなし・テンプレート送信の文脈）";

const MEDIA_ONLY_RE = /^\s*\[(?:画像|動画|スタンプ|ファイル)\]\s*$/;

/**
 * テンプレ最適化の「お客様のメッセージ」の枠に入れる文を決める。
 *   ・afterAix（🟣 AIX モード＝aixSourceMessage あり）で、最後のお客様の発言の後にこちらが1通でも送っていれば「新着なし・AIX の続き」
 *   ・それ以外は旧来どおり、履歴の最後のお客様の発言（画像・動画だけの通は除く）。無ければ合成文
 */
export function resolveTemplateOptimizeMessage(msgs: ReadonlyArray<TplMsg>, opts: { afterAix: boolean }): { message: string; reason: "aix_continuation" | "last_customer" | "fallback" } {
  let lastCust = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].sender === "customer") { lastCust = i; break; }
  const staffAfter = msgs.slice(lastCust + 1).some((m) => m.sender === "staff");
  if (opts.afterAix && staffAfter) return { message: TEMPLATE_NO_NEW_CUSTOMER_MESSAGE, reason: "aix_continuation" };
  const lastText = [...msgs].reverse().find((m) => m.sender === "customer" && m.text && !MEDIA_ONLY_RE.test(m.text))?.text;
  if (lastText) return { message: lastText, reason: "last_customer" };
  return { message: opts.afterAix ? TEMPLATE_NO_NEW_CUSTOMER_MESSAGE : TEMPLATE_FALLBACK_MESSAGE, reason: "fallback" };
}

/** ピッカーの種類ごとの注記（新着1件の時だけ。ピックアップの続きの時は比べる言い方が正しいので何も足さない） */
export function pickerModeNote(pickerMode: string | null | undefined): string {
  const p = (pickerMode ?? "").trim();
  if (p === "新着1件") {
    return "◆ 今回お送りしたのは新着の1件だけ（ピッカー: 新着1件）: 比べる相手が無いので「お送りさせて頂きましたお部屋の中でも」等の比べる言い方は使わない。書き出しは物件名（号室まで）から（【AIX物件情報】に退去予定日があれば「〇月〇日退去予定の〇〇が」、または「新着で1件〇〇が」でもよい）。物件名から始まるこの一文は省かない（【この会話で既に送った言い回し】に似た文があっても、この段落は必ず書く）";
  }
  return "";
}

/**
 * AIX の文（資料）の先頭の物件名（「🌟プレアデス本田 703」「【サザンネスト住ノ江駅前 201号室】」）。無ければ ""。
 *   2026-09-27 再生（DeepSeek）で、一言の物件名が「こちらのお部屋」「プレアデス本田（号室なし）」になったり、
 *   会話の「既に送った言い回し」にある同じ建物の別の号室（505）に替わったりした（タクヤ 8回中3回）。
 *   → 資料の物件名をそのまま渡す（竹内「資料の文字は変えず抜かずそのまま」）。入口の材料なので出口の書き換えはしない
 */
export function extractAixPropertyName(aixSourceMessage: string | null | undefined): string {
  const src = aixSourceMessage ?? "";
  // 複数の物件の資料（ピックアップの一覧）はどれを推すか決められないので渡さない
  if ((src.match(/^\s*🌟/gmu) ?? []).length > 1) return "";
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const star = /^🌟\s*(.{2,60})$/u.exec(line);
    if (star) return star[1].trim();
    const kakko = /^【([^【】]{2,60})】$/u.exec(line);
    if (kakko && /[0-9０-９]|号室|号棟/.test(kakko[1])) return kakko[1].trim();
    return ""; // 先頭の行が物件名でなければ探さない（本文の途中の🌟は別の物件のことがある）
  }
  return "";
}

/** 物件名の注記（🟣 のプロンプトに入れる）。物件名が取れなければ空 */
export function aixPropertyNameNote(name: string): string {
  if (!name) return "";
  return `◆ 物件名: テンプレートの物件名の所（〇〇・マンション名〇〇号室 等）には「${name}」を1文字も変えずに入れる（号室を省かない・会話履歴にある同じ建物の別の号室と混ぜない・「こちらのお部屋」で済ませない）`;
}

/** 比べる言い方（「お送りさせて頂きましたお部屋の中でも特に」）。テンプレ「1件特にオススメ」「【退去予定】1件申込誘導」の書き出し */
const COMPARE_PHRASE_RE = /お送りさせて(?:頂|いただ)きました(?:お部屋の)?中でも(?:特に)?[、,]?/g;

/**
 * 入口: ピッカーが「新着1件」の時だけ、テンプレ原文から比べる言い方を外す（物件名から書き出す骨格にする）。
 *   2026-09-27 再生（DeepSeek・15件）で、注記（pickerModeNote）だけでは「骨格厳守」に負けて比べる言い方が残った（𝒮 9/21）。
 *   実送信（新着1件×比べる言い方を含むテンプレ 82件）: 比べる言い方を残した 20・物件名から書き出した 約48・「新着」から 12
 *   → 過半数の形（物件名から）をテンプレの骨格にする。入口（モデルに見せる骨格）なので厳しくてよい。出口の書き換えはしない
 *   ピックアップ（新規・継続）は 128/137 で残すのが正しいので触らない
 */
export function applyPickerToTemplate(template: string, pickerMode: string | null | undefined): string {
  if ((pickerMode ?? "").trim() !== "新着1件") return template;
  return template.replace(COMPARE_PHRASE_RE, "");
}

// ─── 手本（スタッフの実送信）を他のお客様の中身を伏せて見せる ─────────────────────────────

// 名前の文字: ひらがな・空白・句読点・括弧・中黒を含まない（「特に」「備わった」の後ろから始まる）
const NAME_CHARS = String.raw`[^\s\p{Script=Hiragana}、。！!？?・（）()「」【】件]`;
/** 物件名＋号室（「Veena弁天402が」「プレアデス本田 703が」「EBISU202号室」「上穂積住宅1号棟303号室」）。後ろが助詞・読点・空白・行末・「家賃」の時だけ */
const PROPERTY_ROOM_RE = new RegExp(String.raw`${NAME_CHARS}{2,30}?[ 　]?(?:[0-9０-９A-Z]{1,5}号室|(?:[A-Z]-?)?[0-9０-９]{2,4}(?:-[0-9])?(?=が|は|、|,|・|の|を|も|に|で|と|家賃|[ 　]*$|[ 　]*\n|！|!))`, "gmu");
/** 号室だけ（「特に402号室が」）・年（「2023年築」「2026年6月新築」「築2024年01月」）— 全件監査（AIX 後の実送信 404通）で残っていた物 */
const ROOM_ONLY_RE = /[0-9０-９]{2,4}号室/gu;
const YEAR_RE = /[0-9０-９]{4}年(?:[0-9０-９]{1,2}月)?/gu;
/** 🌟 で始まる行・「・」だけの物件の並び（ひらがなの無い行）は丸ごと物件名 */
const STAR_LINE_RE = /^🌟[^\n]*$/gmu;
const BULLET_NAME_LINE_RE = /^・[^\p{Script=Hiragana}\n]{2,40}$/gmu;
/**
 * 名前の呼びかけ（表示名と違う呼び名「moeさん」「HONOKAさん」「あいりさん」も伏せる）。
 * 2026-09-27 検証の指摘: 旧（NAME_CHARS の続き＋行頭の規則）は ①ひらがなの名前を取りこぼした（「、あいりさんに」がそのまま DeepSeek に届いた）
 *   ②行頭の規則が文ごと消した（「和室もなくかぁなさんに」→「〇〇さんに」）③「お客様」「管理会社様」を「お〇〇様」「〇〇様」に壊した。
 * 区切り（空白・句読点・括弧・行頭）から「さん／様」までの語を見る:
 *   ・ひらがなで終わらない → 末尾のひらがな以外の続き（従来どおり「備わったHONOKA」→ HONOKA）
 *   ・ひらがなで終わる（さんの時だけ。「〜様」は お疲れ様・お世話様 の方が多い）→ 末尾のひらがなの続き。
 *     前に漢字等があり先頭が助詞（に・も・は…）なら助詞は残す（「特にあいり」→ あいり）
 *   ・定型の語（お客様・管理会社様・オーナー様・皆さん 等）は伏せない
 */
const CALL_DELIM_RE = /[\s、。！!？?・（）()「」【】『』,，:：〜~\p{Extended_Pictographic}]/u;
const HIRA_CHAR_RE = /[\p{Script=Hiragana}ー]/u;
const HONORIFIC_WORDS = ["お客", "管理会社", "管理会社の担当者", "オーナー", "貸主", "借主", "家主", "大家", "保証会社", "業者", "仲介", "元付", "担当", "皆", "みな", "みんな", "入居者", "契約者", "申込者", "お疲れ", "ご苦労", "お世話", "おかげ", "お陰", "ご家族", "ご両親", "親御", "お父", "お母", "お兄", "お姉", "奥", "旦那", "お子", "お嬢", "ご主人", "ご本人", "本人", "〇〇"];
function maskCallNames(text: string): string {
  let out = "";
  let last = 0;
  const re = /さん|様/gu;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const offset = m.index;
    let start = offset;
    while (start > 0 && offset - start < 12 && !CALL_DELIM_RE.test(text[start - 1])) start--;
    const seg = text.slice(start, offset);
    if (!seg || start < last) continue;
    let name = "";
    if (!HIRA_CHAR_RE.test(seg[seg.length - 1])) {
      name = /[^\p{Script=Hiragana}ー]+$/u.exec(seg)?.[0] ?? "";
    } else if (m[0] === "さん") {
      name = /[\p{Script=Hiragana}ー]+$/u.exec(seg)?.[0] ?? "";
      if (seg.length > name.length && name.length >= 3 && /^[にもはがをでとへのな]/u.test(name)) name = name.slice(1);
    }
    if (!name || /〇/.test(name)) continue;
    const nameStart = offset - name.length;
    const joined = text.slice(Math.max(0, nameStart - 8), offset);
    if (HONORIFIC_WORDS.some((w) => joined.endsWith(w))) continue;
    out += text.slice(last, nameStart) + "〇〇";
    last = offset;
  }
  return out + text.slice(last);
}
/** 金額（72,000円・7万円・10万円以内の数字部分）*/
const AMOUNT_RE = /[0-9０-９][0-9０-９,，.．]*\s*(?:万)?円/gu;
/** 駅・徒歩（なんば駅徒歩7分・新大阪駅まで徒歩7分） */
const STATION_RE = new RegExp(String.raw`${NAME_CHARS}{1,10}駅(?:まで|から)?徒歩[0-9０-９]+分`, "gu");
/** 日付（9/30日・11月1日）と築年月（2025年3月築） */
const DATE_RE = /[0-9０-９]{1,2}\s*[/／月]\s*[0-9０-９]{1,2}\s*日?/gu;
const BUILT_RE = /[0-9０-９]{4}年[0-9０-９]{1,2}月築/gu;
/** 帖・㎡ */
const SIZE_RE = /[0-9０-９.．]+\s*(?:帖|畳|㎡|m²)/gu;
/** 時刻（16:00・16時）と日だけの日付（21日の）— 再生で手本の「21日の16:00より一緒にご案内」がそのまま見えていた */
const TIME_RE = /[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}|[0-9０-９]{1,2}時(?:[0-9０-９]{1,2}分)?/gu;
const DAY_ONLY_RE = /(?<![0-9０-９〇/／月])[0-9０-９]{1,2}日(?=の|に|より|から|、|\s)/gu;
/** 区＋町名（「西区本田の立地」）— 他のお客様の物件の場所 */
const WARD_RE = /[\p{Script=Han}]{1,3}区[\p{Script=Han}\p{Script=Katakana}]{0,4}(?=の|に|で|、|・|エリア)/gu;

/**
 * スタッフの実送信を「形の手本」にするため、他のお客様の中身を伏せる。
 * @param customerNames その手本の会話のお客様の表示名（〇〇さんに伏せる）
 * @returns text: 伏せた本文 / masked: 伏せた語（4文字以上・漏れの検査に使う）
 */
export function maskStaffExample(text: string, customerNames: ReadonlyArray<string | null | undefined>): { text: string; masked: string[] } {
  const masked: string[] = [];
  const keep = (s: string) => { const t = s.replace(/^🌟\s*/, "").trim(); if (t.length >= 4) masked.push(t); };
  let t = neutralizeWaitedInExample(text).replace(/\r\n/g, "\n");
  for (const n of customerNames) {
    const name = (n ?? "").trim();
    if (!name) continue;
    t = t.split(`${name}さん`).join("〇〇さん").split(`${name}様`).join("〇〇様");
  }
  // 数字の物（URL・駅・金額・日付・広さ）を先に伏せる（号室の判定が「家賃管理費込75」を拾わないように）
  t = t.replace(/https?:\/\/\S+/g, "（URL）");
  t = t.replace(STATION_RE, "〇〇駅徒歩〇分");
  t = t.replace(AMOUNT_RE, "〇〇円");
  t = t.replace(BUILT_RE, "〇〇年〇月築");
  t = t.replace(DATE_RE, "〇月〇日");
  t = t.replace(TIME_RE, "〇〇時");
  t = t.replace(DAY_ONLY_RE, "〇日");
  t = t.replace(SIZE_RE, "〇帖");
  t = t.replace(WARD_RE, "〇〇");
  // 中国の字「收」（9/21 慶次「ご査收」がそのまま送られた）は手本で写させない
  t = t.replace(/査收/g, "査収");
  t = t.replace(STAR_LINE_RE, (m) => { keep(m); return "🌟〇〇"; });
  t = t.replace(BULLET_NAME_LINE_RE, (m) => { keep(m.slice(1)); return "・〇〇"; });
  t = t.replace(PROPERTY_ROOM_RE, (m) => { keep(m); return "〇〇"; });
  t = t.replace(ROOM_ONLY_RE, "〇〇号室");
  // 号室の無い物件名（「中でも特にファステート難波ヴィラントが」）
  t = t.replace(/(?<=中でも(?:特に)?)(?!〇〇|特に)[^\s、。！!？?\n]{2,30}?(?=が)/gu, (m) => { keep(m); return "〇〇"; });
  t = t.replace(YEAR_RE, "〇〇年");
  t = maskCallNames(t);
  return { text: t.trim(), masked: [...new Set(masked)] };
}

/**
 * 伏せた語（他のお客様の物件名）が生成に出たか。今回の材料（AIX の文・テンプレ・会話）に同じ語があれば漏れではない。
 */
export function findLeakedSpans(output: string, masked: ReadonlyArray<string>, sources: string): string[] {
  const out: string[] = [];
  for (const m of masked) {
    const core = m.replace(/(?:が|は|、|の|を|も|に|で|と)$/, "").trim();
    if (core.length < 4) continue;
    if (output.includes(core) && !sources.includes(core)) out.push(core);
  }
  return out;
}

/** 手本のブロック（🟣 のプロンプトに入れる）。手本が無ければ空 */
export function buildStaffExamplesNote(examples: ReadonlyArray<string>): string {
  const ex = examples.map((e) => e.trim()).filter(Boolean);
  if (ex.length === 0) return "";
  return `【スタッフが実際に送った文（同じテンプレートを最適化して、他のお客様に送った最近の文 — 形の手本）】
書き出しと締めの言い回しの参考にする。長さは手本に合わせない（【テンプレート原文】の段落と【AIX物件情報】の事実で決める。手本が短くても今回の物件の事実を削らない）。〇〇は伏せた他のお客様の中身なので、物件名・金額・設備・名前は必ず今回の【AIX物件情報】と会話から取る（手本から写さない）。
${ex.map((e, i) => `― 手本${i + 1} ―\n${e}`).join("\n\n")}`;
}

/**
 * 手本の候補から使う物を選ぶ（新しい順の候補を受け取る）。同じピッカーを優先し、足りなければ他のピッカーで埋める。
 * 同じ文（空白を除いて同じ）は1つに。「お待たせ」は neutralize 済みの文で数える。
 */
export function pickStaffExamples<T extends { text: string; pickerMode?: string | null; conversationId?: string | null }>(
  rows: ReadonlyArray<T>, opts: { pickerMode: string | null | undefined; excludeConversationId?: string | null; limit?: number },
): T[] {
  const limit = opts.limit ?? 3;
  const seen = new Set<string>();
  const ok = rows.filter((r) => {
    if (!r.text || !r.text.trim()) return false;
    if (opts.excludeConversationId && r.conversationId === opts.excludeConversationId) return false;
    const k = r.text.replace(/\s/g, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const p = (opts.pickerMode ?? "").trim();
  const same = p ? ok.filter((r) => (r.pickerMode ?? "") === p) : [];
  const rest = ok.filter((r) => !same.includes(r));
  // 1会話から1つまで（同じお客様の文ばかりにしない）
  const perConv = new Set<string>();
  const out: T[] = [];
  for (const r of [...same, ...rest]) {
    const c = r.conversationId ?? "";
    if (c && perConv.has(c)) continue;
    if (c) perConv.add(c);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 「DeepSeek に渡してよい線」（審査落ちで戻した時刻）で履歴を切る時、AIX の後の一言の材料（直前に送った AIX の文）を残してよいか。
 *   2026-09-27 YUMA のお客様役: 線のある会話では生成のたびに aixSourceMessage を空にしていた（呼び出し元が渡した文は時刻が分からない扱い）
 *   → 🟣 が 🟠（通常テンプレ）に落ち、見積書の一言が「お客様の最後の発言への返事＋新しい約束」になった（2/2回）。
 *   線より後に残った履歴（keptMessages）に同じ文のこちらの送信があれば、時刻が確かで、既に同じ文が履歴として渡る＝新しく外に出る物は無い。
 *   見つからなければ今まで通り渡さない（fail-closed）。比べるのは空白を除いた先頭40字
 */
export function aixSourceSurvivesCut(aixSourceMessage: string | null | undefined, keptMessages: ReadonlyArray<{ sender: string; text?: string | null }>): boolean {
  const norm = (s: string) => s.replace(/\s/g, "");
  const a = norm(aixSourceMessage ?? "");
  if (a.length < 10) return false;
  const head = a.slice(0, 40);
  return keptMessages.some((m) => {
    if (m.sender !== "staff" || !m.text) return false;
    const t = norm(m.text);
    return t.length >= 10 && (t.startsWith(head) || a.startsWith(t.slice(0, 40)));
  });
}

/** テンプレ原文の崩れた締め（「1件特にオススメ」「【複数】見積書」等） */
const BROKEN_CLOSING_RE = /お気に召されたお部屋ご都合よろしい/g;
/**
 * 入口: 🟣 のテンプレ原文の崩れた締め「お気に召されたお部屋ご都合よろしい」を、スタッフの多数派の形「お気に召されましたらご都合よろしい」にして見せる。
 *   2026-09-27 検証の指摘: 「締めはテンプレ原文のまま」にしたら、再生15件で崩れた締めが 6〜8/15（本番の文 0・スタッフの文 0）。
 *   本番が直していたのは、外した「強制置換」の指示に同じ文が入っていたから。9/1 以降のこのテンプレの実送信: 崩れた締め 11・お気に召されましたら 31・締めなし/別 38
 *   → 骨格（モデルに見せる物）だけを多数派の形にする。入口なので厳しくてよい。出口の書き換えはしない。根本はテンプレの UPDATE（竹内さんの確認待ち）
 */
export function fixTemplateClosing(template: string): string {
  return template.replace(BROKEN_CLOSING_RE, "お気に召されましたらご都合よろしい");
}
