// app/lib/reply-scene.ts — 返信の「場面の整理」（2026-10-07 竹内「根本なおす　場面によって重要な部分だけ活用して不要な部分を入れない等　まず場面を整理する力が必要」）
//
// なぜ: 返信の下書きは毎回ほぼ全部の材料と指示（平均 107,181 トークン・本番 14日 430回）を LLM に渡し、
//   場面の判定は route.ts の中で30系統（短い了承だけで9系統・場面ラベル5系統）、さらに PHASE_GUIDE proposing（約1.9万字）が
//   「パターン判定ラダー」で LLM 自身にもう一度場面を選ばせていた（二重管理）。
//   下書きとスタッフの実送信の誤差（9/07〜 418番）を型で数えると、短いお礼・了承の番で AI が前の約束・別の話題を足して書き直される（27%）、
//   質問の番で答えずに確認の約束に逃げる、が目立った＝関係ない材料・指示に引っ張られる形（uran・チンシャン・五嶋）。
//
// ここが「この番の場面」の唯一の判定（お客様の今の番の文だけから・決定論・LLM なし）。
//   使う所: ①generate-reply の材料の取捨（SCENE_MATERIALS）②PHASE_GUIDE の proposing を場面のパターンだけに絞る（phaseGuideForScene）
//           ③手本（few-shot）の並べ替えで同じ場面の手本を先に（scene の一致）④監査（scripts の誤差の数え方）
//   ⚠ ブレインの判断（AIX の要否・種類）は変えない。返信の本文に渡す材料だけを場面で絞る。
//   ⚠ 安全の関門（URL 禁止・物件の事実の関門・内覧日時/待ち合わせの関門・見積の関門 等）は場面に関係なく残す。
//   戻す: REPLY_SCENE_MATERIALS=off（環境変数）。テストの会話だけ body.testSceneMaterials="off"|"on" で前後を比べられる
import { customerAsksRentLevel } from "./rent-question";

export type ReplyScene =
  | "ack"            // 短いお礼・了承・締めの挨拶だけ（話題を閉じる番）
  | "considering"    // 検討中・保留・また連絡します
  | "question"       // 質問（相場・手続き・設備・可否 等。条件の依頼を伴わない）
  | "conditions"     // 条件の提示・変更・追加・もっと探して
  | "property_share" // お客様が物件（URL・画像の資料）を送ってきた
  | "cost"           // 初期費用・見積の依頼・質問
  | "viewing"        // 内覧・日程・当日の連絡
  | "apply"          // 申込・審査・契約・書類（申込前の相談を含む）
  | "other";

export const REPLY_SCENE_JA: Record<ReplyScene, string> = {
  ack: "短いお礼・了承", considering: "検討中・保留", question: "質問", conditions: "条件の提示・変更",
  property_share: "物件を送ってきた", cost: "初期費用・見積", viewing: "内覧・日程", apply: "申込・審査", other: "その他",
};

const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu;
const PORTAL_RE = /https?:\/\/|suumo|homes\.co|athome|chintai\.net|物件名\s*[:：]|号室名\s*[:：]|専有面積|賃料\s*[:：]/i;
const COST_RE = /初期費用|見積|総額|諸費用|費用|いくら(?:か|に|ぐらい|くらい)?(?:かかり|になり|ですか|でしょうか)|お金/;
const APPLY_RE = /申込|申し込み|審査|契約|書類|保証(?:会社|人)|入居日|名義|在籍確認|仮押さえ|仮おさえ|抑え(?:て|たい|られ)|押さえ(?:て|たい|られ)/;
// 条件のフォーム（「（ご希望のお部屋探しご条件）①ご入居時期…」）は中に「初期費用」の語があっても条件の提示
const CONDITION_FORM_RE = /お部屋探しご条件|お部屋お探し中|ご希望の家賃|①[^\n]{0,30}\n?[\s\S]{0,80}②/;
/** 「1.入居時期 12月 2.希望家賃 3万円〜…」の番号つきの条件（フォームを手で打った形） */
const NUMBERED_CONDITIONS_RE = /(?:^|\s)1\s*[.．、)）]\s*\S[\s\S]{0,120}?(?:^|\s)2\s*[.．、)）]\s*\S[\s\S]{0,120}?(?:家賃|エリア|間取|入居|広さ|駅)/;
/** 内覧の強い語（これがあれば内覧） */
const VIEWING_RE = /内覧|内見|見学|待ち合わせ|現地|到着|着きました|着いた|向かって|遅れ(?:ます|そう|て)/;
/** 日時の弱い語（検討中・また連絡の文に負ける） */
const VIEWING_WEAK_RE = /[0-9０-９]{1,2}\s*時|日程|空いて(?:る|ます|い)日|[0-9０-９]{1,2}\s*[日\/／]\s*(?:[0-9０-９]|\(|（|曜|$)|[月火水木金土日]曜|平日|週末|明日|明後日|来週|今週/;
const CONSIDER_RE = /検討|考え(?:ます|させ|てみ|中)|相談(?:して|します)|迷(?:って|い)|また(?:ご)?連絡|改めて(?:ご)?連絡|決まり次第|後ほど|保留|一旦|しばらく/;
const COND_RE = /エリア|家賃|[0-9０-９.]+\s*万|間取|駅|徒歩|[1-4１-４]\s*(?:K|DK|LDK|R)\b|ワンルーム|ペット|築|条件|希望|広さ|広め|広く|周辺|あたり|敷金|礼金|㎡|帖|畳|オートロック|バス・?トイレ|独立洗面|駐車場|階以上|角部屋|他に|ほかに|他の(?:物件|お部屋|部屋)|もっと|別の(?:物件|お部屋|部屋)|探して/i;
const REQUEST_VERB_RE = /探して|探し(?:です|てます|中)|(?<!よろしく|宜しく)お願い|送って|紹介|ピックアップ|変更|広げ|追加|(?:部屋|物件)[^。？?\n]{0,6}(?:ございます|あります|ない)(?:でしょう|です)?か|見ること可能|出して|(?:あれば|ありそう)|教えて(?:頂|いただ|下さ|くださ)|(?:は|とか|も)(?:ない|あり)(?:です|ます)か/;
/** 書類の画像の読み取り文 */
const DOC_IMAGE_RE = /御見積書|クレジットカード|本人確認|運転免許|マイナンバー|保険証|給与明細|源泉徴収|在籍証明/;
/** 初期費用の語があっても「その条件で探して」の依頼（「初期費用23万くらいで探し」「初期費用安いお部屋ありますか」） */
const COST_AS_CONDITION_RE = /初期費用[^。？?\n]{0,10}(?:以内|くらいで|位で|安い(?:お部屋|部屋|物件)|抑え(?:た|られる)(?:お部屋|部屋|物件))|(?:安い|抑え(?:た|られる))(?:お部屋|部屋|物件)/;
const QUESTION_RE = /[?？]|ですか|ますか|でしょうか|ますかね|可能(?:です)?か|できますか|でき(?:ません)?か|ありますか|ないですか|どう(?:です|でしょう|なり)|なんですか|かな$/m;
/** 評価の語（appeal-timing の CUSTOMER_APPRAISAL_RE と同じ語＋「気になります」） */
const APPRAISAL_RE = /いいですね|良いですね|よいですね|良さそう|よさそう|いい感じ|良い感じ|素敵|気に入り|気に入っ|気になり|魅力|綺麗|きれい|最高|ありですね|アリですね|惹かれ|いいかも|良いかも|めっちゃいい|すごくいい|理想/;
/** お礼・了承・挨拶の語（剥がして残りを見る） */
const ACK_STRIP_RE = /ありがとう(?:ございます|ございました)?|有難う(?:ございます)?|(?:引き続き|今後とも|本日は?|今日は?|明日は?|当日は?)?(?:何卒)?(?:よろしく|宜しく)(?:お願い(?:し|致し|いたし)ます|です|おねがいします)?|(?:お願い|おねがい)(?:し|致し|いたし)ます|了解(?:です|しました|致しました)?|わかりました|分かりました|承知(?:です|しました|致しました|いたしました)?|かしこまりました|はい|助かります|大丈夫(?:です)?|了承(?:しました)?|こちらこそ|いえいえ|とんでもない(?:です)?|すみません|お世話になっております|お疲れ様です|お手数(?:を)?(?:お掛け|おかけ)(?:して(?:しまい)?|します|しますが|致しますが)?|ご無理(?:を)?(?:言って|いって)(?:しまい)?|申し訳(?:ありません|ございません|ないです)|ご丁寧に|ご親切に|誠に|本当に|引き続き|お忙しい中|(?:早い|迅速な)?(?:ご)?対応(?:頂き|いただき)?|諸々|ご確認(?:頂き|いただき)|ご説明|ありがとござい(?:ます)?|おはようございます|こんにちは|こんばんは|お待ちして(?:ます|おります)|そうなんですね|わがままで|ご無理を言いまして|\((?:emoji|よろしく|すみません)\)|m\(\*_ _\)m|\(;_;\)|では|それでは|ok|OK|おけ|了|鈴木様|鈴木さん/g;
const ACK_RE = /ありがと|よろしく|宜しく|了解|わかりました|分かりました|承知|かしこまり|はい|(?:お願い|おねがい)(?:し|致し|いたし)ます|助かり|大丈夫|了承|こちらこそ|いえいえ|とんでもない|すみません|ok|おけ|了$/i;

// 2026-10-07 7巡目（見張りの外れを1番ずつ読んだ・竹内「一致しなかった番は1件ずつなぜ」）: 場面の語の抜け（その他に落ちていた）
//   W34「ギリギリに着くか少し遅れるかもです」・W45「付き添いで1人着いてきます」＝内覧当日の連絡（人の手打ち 365日: 遅れ・向かう・付き添いの連絡の
//   返事は「かしこまりました！！⏎お気をつけてお越しください😌！！」が 内覧の前の返事で 12/17）・W56「ここの頭金おしえてほしいです」＝初期費用
//   （人は「2部屋の最大限割引させていただいたお見積書お送り」）・W35「今日中に決めて折り返します」＝検討中（また連絡）。
//   線は scripts/audit-r7-scene-words.ts（365日の発言で場面が変わる番を全部読む）。戻す: REPLY_SCENE_R7=off
const VIEWING_R7_RE = /遅れる|遅刻|ギリギリ(?:に|で)?(?:着|到着)|着きます|着く(?:と思|予定|かも|ので)|もうすぐ着|向かいます|付き添い|同伴/;
const COST_R7_RE = /頭金/;
const CONSIDER_R7_RE = /折り返(?:し|します)|決め(?:て|次第)[^。\n]{0,6}(?:連絡|返信|折り返)/;
export function replySceneR7Enabled(env: Record<string, string | undefined> = process.env): boolean { return env.REPLY_SCENE_R7 !== "off"; }

/** 番の文（連投は改行でつないだ物）から場面を1つ決める。evidence は当たった理由 */
export function resolveReplyScene(i: { customerText: string }): { scene: ReplyScene; evidence: string } {
  const original = String(i.customerText ?? "");
  const raw = original.normalize("NFKC");
  const t = raw.replace(/⁣/g, "").trim();
  if (!t) return { scene: "other", evidence: "empty" };
  // 3巡目: スタンプだけ（「[スタンプ]」）はお礼・了承と同じ（analyzeSubstance の decor_only と同じ）
  if (/^(?:\[スタンプ\]\s*)+$/.test(t)) return { scene: "ack", evidence: "stamp_only" };
  const isImageOnly = /^\s*\[画像\]\s*$/.test(t);
  const hasImageText = /^\s*\[画像\]\s*\S/m.test(t);
  // 書類の画像（御見積書・クレジットカード・本人確認書類）は物件ではない（申込・手続きの番）
  if (hasImageText && DOC_IMAGE_RE.test(t)) return { scene: "apply", evidence: "document_image" };
  // 条件のフォーム・①②の箇条書き（NFKC で ① が 1 になるので元の文で見る）は物件の URL より先（「↑の物件がなければ・家賃約5万…」）
  if (CONDITION_FORM_RE.test(original) || NUMBERED_CONDITIONS_RE.test(t) || (/^(?!\s*\[画像\])/.test(t) && /物件がなければ|以下(?:の)?(?:希望|条件)/.test(t))) return { scene: "conditions", evidence: "condition_form" };
  if (PORTAL_RE.test(t) || hasImageText || isImageOnly) return { scene: "property_share", evidence: isImageOnly ? "image" : "portal/image_text" };
  // 家賃の相場の問い（「2LDKだと上がりますか」「いくらまでにしたら出てきますか」）は質問（条件の語があっても依頼ではない）
  if (customerAsksRentLevel(t)) return { scene: "question", evidence: "rent_level" };
  const condNoCost = COND_RE.test(t.replace(/初期費用/g, ""));
  if (COST_RE.test(t) && condNoCost && (COST_AS_CONDITION_RE.test(t) || /探し|ピックアップ|紹介して|条件/.test(t))) return { scene: "conditions", evidence: "cost_as_condition" };
  const r7 = replySceneR7Enabled();
  if (COST_RE.test(t)) return { scene: "cost", evidence: "cost" };
  if (r7 && COST_R7_RE.test(t)) return { scene: "cost", evidence: "cost_r7" };
  if (APPLY_RE.test(t)) return { scene: "apply", evidence: "apply" };
  if (VIEWING_RE.test(t)) return { scene: "viewing", evidence: "viewing" };
  if (r7 && VIEWING_R7_RE.test(t)) return { scene: "viewing", evidence: "viewing_r7" };
  // 電話の依頼・時刻の連絡（「10時半頃に電話かけさせて頂きます」「電話して貰えますか」）は内覧の日程ではない（今まで通り全部の材料）
  if (/電話/.test(t)) return { scene: "other", evidence: "phone" };
  if (CONSIDER_RE.test(t) || /(?:ご)?返信いたします|返信します|連絡させて頂きます|連絡します/.test(t)) return { scene: "considering", evidence: "considering" };
  if (r7 && CONSIDER_R7_RE.test(t)) return { scene: "considering", evidence: "considering_r7" };
  const isQuestion = QUESTION_RE.test(t);
  // 家賃・間取りの語がはっきりある条件の文（「2028/3月以降入居 4~7万 2LDK」）は日付の語より先に条件
  if (/家賃|[0-9.]+\s*万|[1-4]\s*(?:K|DK|LDK)\b|エリア|間取/i.test(t) && (!isQuestion || REQUEST_VERB_RE.test(t))) return { scene: "conditions", evidence: "conditions_strong" };
  // 地名だけを挙げて「〇〇市は無いですか」「〇〇町とかもありますか」＝そのエリアでも探して（条件の追加）
  if (isQuestion && /(?:市|区|町|駅|線)[^。？?\n]{0,6}(?:は|とか|も|で)(?:ない|あり|ござい)(?:です|ます)/.test(t)) return { scene: "conditions", evidence: "area_ask" };
  if (VIEWING_WEAK_RE.test(t)) return { scene: "viewing", evidence: "viewing_time" };
  if (COND_RE.test(t) && (!isQuestion || REQUEST_VERB_RE.test(t))) return { scene: "conditions", evidence: "conditions" };
  if (isQuestion) return { scene: "question", evidence: "question" };
  const core = t.replace(EMOJI_RE, "").replace(/[\s!！。、.~〜ー]/g, "");
  // 3巡目（10/07）: お礼に評価が付いた発言（「ありがとうございます！アーバネックス気になります！」）は短いお礼ではない＝前向きな反応（材料を絞らない・訴求のタイミングは内覧）
  //   本番の発言 922 で4つのお礼の判定を並べた時、場面だけがお礼と読んだ 58 の中にあった
  // 3巡目: お礼・了承の語を除いた残りに中身（「福島区も」「宅配ボックスの件だけ確認」）があれば短いお礼ではない（依頼・質問を落とさない）
  const ackResidue = core.replace(ACK_STRIP_RE, "");
  if (core.length <= 40 && ACK_RE.test(core) && !APPRAISAL_RE.test(core) && ackResidue.length <= 3) return { scene: "ack", evidence: "short_ack" };
  if (core.length <= 40 && ACK_RE.test(core)) return { scene: "other", evidence: "ack_with_appraisal" };
  if (COND_RE.test(t)) return { scene: "conditions", evidence: "conditions_kw" };
  return { scene: "other", evidence: "none" };
}

// ─── 場面ごとの材料（generate-reply の dynamicBlock の部品の名前）─────────────────────────
//   入れない物だけを書く（書いていない物は今まで通り入る＝漏れても今より悪くならない側）。
//   安全の関門・会話履歴・お客様の発言・台帳（何をしたか）・挨拶・名前・日付は全部の場面で残す。
export type SceneMaterialKey =
  | "knowledge"        // ai_reply_knowledge（営業パターン・差分学習・失注パターン 等）
  | "phrases"          // phrase_dictionary の言い回し（12件）
  | "conditions"       // 希望条件・条件のフォールバック・足りない条件
  | "summary"          // 要約・意見・セーブポイント
  | "closingFallback"  // 戦略が無い時の勝ちパターン・次の一手
  | "direction"        // conversation_direction の方向性
  | "questions"        // 質問の決定論の抜き出し（ブレインの質問とは別）
  | "conditionChange"  // 条件変更・新しい条件・条件の拡大・もう一度探すの指示
  | "budgetInventory"  // 予算と在庫の言い方
  | "moveInTiming"     // 入居時期の質問の指示
  | "management"       // 管理会社への確認の指示
  | "caseStudies";     // ナレッジの中の「申込・内見に至った事例」（JSON の展開・ブレインの contractExamples と同じ材料）

// 版の履歴（再生の前後・本番の過去の番 34番×DeepSeek）:
//   v1（10/07）ナレッジとフレーズも短いお礼・検討中・内覧で落とした → 一致 26%→26%（変わらず）・検討中と内覧で人の訴求の一文
//      （「お気に召されましたら実際にお部屋ご案内させて頂きますので…」）が消えた＝ナレッジの営業パターン・AI の間違いの例は文の形に効いていた
//   v2: ナレッジは全部の場面で残し、大きいだけの「申込・内見に至った事例」（JSON・ブレインと二重）だけを落とす。フレーズ（200字弱）も残す
export const SCENE_MATERIALS: Record<ReplyScene, { drop: readonly SceneMaterialKey[]; why: string }> = {
  ack: { drop: ["caseStudies", "conditions", "summary", "closingFallback", "direction", "questions", "conditionChange", "budgetInventory", "moveInTiming", "management"],
    why: "話題を閉じる番。前の約束の復唱・物件探しの宣言・条件の復唱は人の実送信ではほぼ書かない（はい😊！！＋お気軽に＋何卒）" },
  considering: { drop: ["caseStudies", "closingFallback", "questions", "conditionChange", "budgetInventory", "moveInTiming", "management"],
    why: "急かさず受け止める番。条件の変更・在庫は関係ない（訴求の一文はナレッジの営業パターンが運ぶので残す）" },
  question: { drop: ["caseStudies", "closingFallback", "conditionChange"],
    why: "聞かれた事に答える番。条件変更の指示・勝ちパターンの締め・事例の展開は答えから離れる" },
  conditions: { drop: ["caseStudies", "closingFallback"], why: "条件を受けて探す宣言の番（材料はほぼ全部要る）" },
  property_share: { drop: ["caseStudies", "closingFallback", "questions", "conditionChange", "budgetInventory", "moveInTiming"],
    why: "送られた物件の確認の番。画像の文字を条件・質問として扱わない" },
  cost: { drop: ["caseStudies", "closingFallback", "conditionChange", "budgetInventory", "moveInTiming"],
    why: "初期費用・見積の番（見積の関門は残す）" },
  viewing: { drop: ["caseStudies", "closingFallback", "conditionChange", "budgetInventory"],
    why: "内覧の日程・当日の番（内覧の関門は残す）" },
  apply: { drop: ["caseStudies", "closingFallback", "conditionChange", "budgetInventory"],
    why: "申込・審査の相談の番" },
  other: { drop: [], why: "決めきれない番は今まで通り全部" },
};

/** ナレッジの文から、行頭の見出し（【… / ## …）で始まる節を落とす（次の行頭の見出しまで）。落とす節が無ければ元のまま */
export function stripKnowledgeSections(text: string, headingPrefixes: readonly string[]): string {
  if (!text || !headingPrefixes.some((h) => text.includes(h))) return text;
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("【") || /^#{1,3} /.test(line)) skipping = headingPrefixes.some((h) => line.startsWith(h));
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

/** 環境変数とテストの上書きから、場面の取捨を効かせるか（既定: 効かせる） */
export function sceneMaterialsEnabled(env: Record<string, string | undefined>, testOverride?: string | null): boolean {
  if (testOverride === "off") return false;
  if (testOverride === "on") return true;
  return (env.REPLY_SCENE_MATERIALS ?? "").toLowerCase() !== "off";
}

export function keepMaterial(scene: ReplyScene | null | undefined, key: SceneMaterialKey, enabled = true): boolean {
  if (!enabled || !scene) return true;
  return !SCENE_MATERIALS[scene].drop.includes(key);
}

// ─── PHASE_GUIDE proposing を場面のパターンだけに絞る ─────────────────────────────
//   proposing は「パターン判定ラダー」で LLM に約30のパターンから選ばせていた（約1.9万字・毎回全部）。
//   場面はコードで決めたので、その場面のパターン＋フェーズの禁止ルールだけを渡す（other は全部のまま）。
const PROPOSING_PATTERNS: Record<ReplyScene, readonly string[] | null> = {
  ack: ["F3", "F4", "W", "Y", "D", "F2"],
  // W（確認中・宣言への承諾＝受けだけ）は入れない: 再生で「ごゆっくり＋お気軽に」だけで締めて人の扉の1文（ご内覧出来ますので）が落ちた
  considering: ["F", "F2", "H", "L", "J", "N", "M"],
  question: ["TQ", "Q", "G2", "C2", "CR", "I2", "N", "AI", "DL", "W"],
  conditions: ["C1", "I", "I-拡大", "I2", "E", "E2", "E3", "B", "W", "Y"],
  property_share: ["C", "CR", "A", "I2", "F4"],
  cost: ["L", "J", "C", "CR", "F4"],
  viewing: ["Q", "M", "Z", "E", "AR", "W"],
  apply: ["G", "G2", "AP", "W"],
  other: null,
};

const SCENE_LADDER_ITEMS: Partial<Record<ReplyScene, readonly string[]>> = {
  cost: ["⑥ "],
  // ⑦'（特定物件の質問は確認の宣言だけで締める）は質問の番には渡さない: 実送信ではスタッフが答えを書く番（パーキング・名前の違い・入居日）に
  //   AI が「確認させて頂きます」に逃げて消される形が 9/07〜で 25番（確認の約束に逃げた）。物件を送ってきた番だけに残す
  property_share: ["⑦' "],
};

/** 「【パターンX…】」「【⛔ …】【パターンK2】」の見出しからパターンの名前を取る */
function patternNameOf(section: string): string | null {
  const m = section.match(/【パターン([A-Z]{1,2}[0-9]?(?:'|-拡大)?)(?=[\s】—（(])/);
  return m ? m[1] : null;
}

/**
 * PHASE_GUIDE のフェーズ本文を場面で絞る。proposing 以外・other・パターンが1つも見つからない時は元のまま（壊れない側）。
 *   残す: 冒頭の1行・選んだパターン・【🚫 … 絶対禁止ルール】以降（フェーズ共通の禁止）・パターンの外の注意書き（【ラダー⑪の分解】等は落とす）
 */
export function phaseGuideForScene(phaseKey: string, guide: string, scene: ReplyScene | null | undefined, enabled = true): { text: string; kept: string[] | null } {
  if (!enabled || !scene || phaseKey !== "proposing") return { text: guide, kept: null };
  const want = PROPOSING_PATTERNS[scene];
  if (!want) return { text: guide, kept: null };
  const lines = guide.split("\n");
  const banIdx = lines.findIndex((l) => /^【🚫 .*絶対禁止ルール】/.test(l));
  const body = banIdx >= 0 ? lines.slice(0, banIdx) : lines;
  const tail = banIdx >= 0 ? lines.slice(banIdx) : [];
  // 見出しの行（【パターン… または 【⛔ …】【パターン…）で区切る
  const sections: Array<{ name: string | null; text: string[] }> = [];
  for (const l of body) {
    const isHead = /^【(?:パターン|⛔[^】]*】【パターン)/.test(l);
    if (isHead || !sections.length) sections.push({ name: isHead ? patternNameOf(l) : null, text: [l] });
    else sections[sections.length - 1].text.push(l);
  }
  const kept = sections.filter((s) => s.name && want.includes(s.name));
  if (!kept.length) return { text: guide, kept: null };
  const head = `▶ この番の場面は「${REPLY_SCENE_JA[scene]}」（コードで判定済み）。下のパターンの中から会話に合う物を使う（他のパターンは今回は使わない）。`;
  // ラダーの中にだけ書いてある指示（⑥ 見積書・初期費用の質問／⑦' 特定物件の設備・条件・審査の質問）は、その場面の時だけ残す
  const ladderKeep = SCENE_LADDER_ITEMS[scene] ?? [];
  const ladderLines = body.filter((l) => ladderKeep.some((k) => l.startsWith(k)));
  return { text: [head, ...ladderLines, "", ...kept.flatMap((s) => s.text), ...tail].join("\n"), kept: kept.map((s) => s.name!) };
}

/** 手本（few-shot）の並べ替えの加点: 手本のお客様の発言が同じ場面なら加点 */
export const SCENE_EXAMPLE_BOOST = 0.12;

// ─── 検討中の決まりを1か所に（3巡目・2026-10-07 竹内さん「２ 大丈夫」＝扉の1文を正式に許す）─────────────────
//   旧は4か所で食い違っていた: PHASE_GUIDE パターンF（扉の1文を必ず1つ）／isThinkingMsg の方向（扉の1文を「必ず」＋同じ文で「申込誘導 絶対禁止」）／
//   TPO の場面の札（申込誘導・希少性煽り 絶対禁止）／避ける話題（申込誘導・内見誘導 ＋「言い換え・同義語も禁止・書いたら削除して書き直す」）。
//   → LLM は「お気に召されましたらお申込しお部屋抑え…」を申込誘導と読んで消していた（2巡目の最後の Claude で扉の1文が落ちた）。
//   決まり: ①扉の1文（条件付きの「お気に召されましたら…」）は申込誘導・内見誘導に当たらない＝書いてよい
//           ②禁止は催促だけ（お申込いかがでしょうか・お早めに・人気のため・残りわずか）③入れるかは必須ではない（実送信 検討の番の約2割・
//           appeal-timing の材料があればその種類＝今ご内覧頂ける部屋は内覧・退去予定/御見積書の後は申込）
//   戻す: REPLY_CONSIDERING_DOOR=off（旧の4か所の文に戻る）
export const CONSIDERING_DOOR_LINES = {
  apply: "お気に召されましたらお申込みでお部屋抑えさせて頂きます！！",
  viewing: "お気に召されましたら実際にお部屋ご内覧出来ますので、いつでもお気軽にご連絡ください😌！！",
} as const;
/** 検討中の番の「避ける話題」の名前（催促だけを避ける。扉の1文と取り違えない名前にする） */
export const CONSIDERING_AVOID_PUSH = "申込の催促（お申込いかがでしょうか・お早めに・人気のため）";
export const CONSIDERING_AVOID_VIEWING_PUSH = "内覧の日程の打診（日時の候補を出す）";
/** 避ける話題の行に足す但し書き（検討中の番だけ） */
export const CONSIDERING_DOOR_EXEMPT_NOTE = `※ 検討中の番の扉の1文（「${CONSIDERING_DOOR_LINES.apply}」／「お気に召されましたら…ご内覧出来ますので」の条件付きの1文）は申込誘導・内見誘導・催促に当たらない（竹内さん 2026-10-07 正式に許可）。消さない。`;
export function consideringDoorEnabled(env: Record<string, string | undefined>): boolean {
  return (env.REPLY_CONSIDERING_DOOR ?? "").toLowerCase() !== "off";
}
/** 避ける話題の名前を検討中の番の名前に置き換える（申込誘導→申込の催促・内見誘導→内覧の日程の打診） */
export function consideringAvoidTopics(topics: readonly string[], enabled = true): string[] {
  if (!enabled) return [...topics];
  return [...new Set(topics.map((t) => t === "申込誘導" ? CONSIDERING_AVOID_PUSH : t === "内見誘導" || t === "内覧誘導" ? CONSIDERING_AVOID_VIEWING_PUSH : t))];
}

// ─── 会社のルール（ai_prompt_rules generate_reply 296行・約4.2万字）を場面で絞る試し（3巡目・10/07）─────────────
//   今は条件なしで全場面に毎回入る（system の準静的ブロック・1時間キャッシュ）。場面の語で分けると場面ごとに 28〜50% になる
//   （scripts/_tmp-r3-rules-scene の試算: 全場面に入れる＝語なし・永久・3場面以上 73行 1.2万字）。
//   ⚠ 絞るとキャッシュの鍵が場面ごとに分かれる（9通りの書き込み）＝本番に入れるかは質の差（再生）と費用を見て竹内さんと決める。
//   今はテストの会話の testFlags.rules_scene=on だけで効く（本番は何も変わらない）。永久ルールの節は絞らない。
export const RULE_SCENE_RE: Partial<Record<ReplyScene, RegExp>> = {
  viewing: /内覧|内見|待ち合わせ|現地|案内日|ご案内/,
  cost: /見積|初期費用|費用|敷金|礼金|仲介手数料|割引|スモ割|分割/,
  apply: /申込|審査|保証会社|契約|書類|本人確認|在籍/,
  considering: /検討|保留|迷/,
  conditions: /条件|エリア|間取|家賃.{0,6}(?:以内|上限)|ヒアリング|ピックアップ/,
  property_share: /URL|SUUMO|持ち込|送ってき|お客様が送|画像/,
  ack: /了承|お礼|感謝|ありがとう/,
};
/** 1行のルールが当たる場面（0＝全場面向け・3つ以上も全場面向け） */
export function ruleScenesOf(text: string): ReplyScene[] {
  const hits = (Object.keys(RULE_SCENE_RE) as ReplyScene[]).filter((k) => RULE_SCENE_RE[k]!.test(text));
  return hits.length >= 3 ? [] : hits;
}
/** formatPromptRuleSections の文字列から、この場面に関係ない「AI学習ルール」の行を落とす（永久ルールの節・見出しは残す・other は全部） */
export function filterRulesTextForScene(text: string, scene: ReplyScene | null | undefined): string {
  if (!text || !scene || scene === "other") return text;
  let inPermanent = false;
  return text.split("\n").filter((l) => {
    if (l.startsWith("【")) { inPermanent = l.startsWith("【永久ルール"); return true; }
    if (inPermanent || !l.startsWith("・")) return true;
    const sc = ruleScenesOf(l);
    return !sc.length || sc.includes(scene);
  }).join("\n");
}
