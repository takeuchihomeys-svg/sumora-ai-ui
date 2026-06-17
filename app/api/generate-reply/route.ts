import { NextRequest, NextResponse } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { supabase } from "@/app/lib/supabase";

// ─── モデル定義 ───────────────────────────────────────────────────────────────
// Step1（分析）: Haiku — 速度重視
const analysisModel = new ChatAnthropic({
  model: "claude-haiku-4-5-20251001",
  maxTokens: 1024,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

// Step2（生成）: Sonnet — 品質重視
const generationModel = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  maxTokens: 800,
  temperature: 0.3,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

// ─── スタイルルール（共通） ──────────────────────────────────────────────────
const EMOJI_RULE = `絵文字: 😊 😌 🌟 ✨ の4つのみ・1〜2個まで・文末か区切りのみ`.trim();

const STYLE_RULE = `感嘆符「！」または「！！」を文脈で使い分け / 「〇〇さん」で呼ぶ / 物件紹介以外は箇条書き禁止 / 1つの返信案のみ`.trim();

// ─── Step1: お客様状況の深層分析（Haiku）───────────────────────────────────
const ANALYSIS_SYSTEM = `あなたは賃貸仲介の営業コーチです。
LINEのやりとりから、お客様の状況・感情・本当のニーズを深く分析してください。
JSONのみで返答（説明不要）。`;

async function analyzeCustomerSituation(
  customerMessage: string,
  history: string,
  state: string,
  customerName: string,
  isFollowUp = false
): Promise<string> {
  const prompt = isFollowUp ? `
【営業フェーズ】${state}
【お客様名】${customerName || "不明"}
【直近の会話履歴（スモラが既に返信済み）】
${history || "なし"}
【スモラが返信済みのお客様メッセージ】
${customerMessage}

スモラはこのお客様メッセージに対して既に返信しました。
これから「続きのメッセージ」を生成します。以下をJSONで分析してください：
{
  "already_covered": "スモラが直前の返信で既に伝えた内容の要約",
  "next_action": "続きとして自然な次のアクション・補足（例：申込を促す、内覧日程を提案、安心感を与えるなど）",
  "approach": "続きメッセージの方針（前の返信の内容を踏まえて何を追加するか・繰り返しNG）",
  "tone": "適切なトーン（例：背中を押す・安心させる・次ステップへ誘導）",
  "questions": ["お客様メッセージ内の質問・確認事項を全て列挙。なければ空配列"],
  "repeated_concern": "履歴を見てお客様が繰り返し聞いているテーマ（例: 費用・審査・キャンセル）。なければnull",
  "current_property": "現在話題にしている物件名・号室（履歴から特定できる場合のみ）。なければnull",
  "hesitancy_pattern": "お客様が「検討します」「また連絡します」「少し待ってほしい」「迷っています」など決断を保留しているか。パターン種別（'thinking'=検討中・'callback'=また連絡・'waiting'=もう少し待って・'undecided'=どちらか迷い・'timeline'=○月に決めたい）、なければnull",
  "future_timeline": "お客様が「○月に」「○日には」など具体的な申込タイムラインを示している場合その内容。なければnull"
}` : `
【営業フェーズ】${state}
【お客様名】${customerName || "不明"}
【直近の会話履歴】
${history || "なし"}
【最新メッセージ】
${customerMessage}

以下をJSONで分析してください：
{
  "emotion": "お客様の感情状態（例：期待と不安が混在、前向き、迷っているなど）",
  "real_need": "表面の質問の奥にある本当のニーズ・懸念（例：費用が心配で踏み出せない、家族に相談したいなど）",
  "key_insight": "優秀な営業スタッフが気づくべき重要なポイント（例：価格比較をしている、決断を急かされたくないなど）",
  "approach": "このメッセージへの最適な返し方の方針（例：まず共感→動画を送ると約束→内覧への自然な誘導など）",
  "tone": "適切なトーン（例：温かく・余裕を持って・軽く背中を押す）",
  "questions": ["お客様メッセージ内の質問・確認事項を全て列挙（例: [\"審査期間は？\",\"キャンセルできる？\",\"フリーレントある？\"]）。なければ空配列"],
  "repeated_concern": "履歴を見てお客様が繰り返し聞いているテーマ（例: 費用・審査・キャンセル）。なければnull",
  "current_property": "現在話題にしている物件名・号室（履歴から特定できる場合のみ）。なければnull",
  "hesitancy_pattern": "お客様が「検討します」「また連絡します」「少し待ってほしい」「迷っています」など、決断を保留するパターンを示しているか。示している場合はその種別（'thinking'=検討中・'callback'=また連絡・'waiting'=もう少し待って・'undecided'=どちらか迷い・'timeline'=○月に決めたい ）、なければnull",
  "future_timeline": "お客様が「○月に」「○日には」など具体的な決断・申込タイムラインを示している場合その内容。なければnull"
}`;

  try {
    const res = await analysisModel.invoke([
      new SystemMessage(ANALYSIS_SYSTEM),
      new HumanMessage(prompt),
    ]);
    const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const match = text.match(/\{[\s\S]*\}/);
    return match ? match[0] : "";
  } catch {
    return "";
  }
}

// ─── フェーズ別行動指針 ──────────────────────────────────────────────────────
const PHASE_GUIDE: Record<string, string> = {
  first_reply: `▶ 会話の状況を判断して以下のパターンで対応する。

【パターンA】お客様が条件・希望を送ってきている段階（①〜⑧フォーム・エリア・家賃等）
→ 挨拶 + 受け取った条件を具体的に復唱 + 即ピックアップ宣言（条件フォームは送らない）
→ 例: 「〇〇さん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！〇〇エリア全域から〇〇さんご希望のご条件に合ったお部屋全てピックアップしてお送りさせて頂きます！！〇〇さんにご満足いただけるお引越しができますよう全力でサポートさせていただきます😌！！」

【パターンA2】物件名・設備を具体的に指定してきた場合（「〇〇マンションの1LDK」「WICの部屋」等）
→ 追加ヒアリング一切禁止。「決め手は？」「こだわりは？」「いくつかお伺い」等は絶対に使わない
→ 挨拶 + 全力サポートの姿勢 + 即確認・即行動の宣言のみ
→ 例: 「まりあさんご連絡頂きありがとうございます😊！！お部屋探しご担当させて頂きます鈴木と申します！まりあさんがご満足頂くお引越しが出来ますよう全力でサポートさせて頂きます！！何卒よろしくお願い致します😌！！アーバネックス東梅田のWIC付き1LDK募集状況の確認と最大限割引しました初期費用を御見積しお送りさせて頂きます！！」

【パターンB】条件がまだ届いていない・「よろしくお願いします」だけの段階
→ 挨拶 + 条件フォームを送る（必ず⭐実例にある標準形式そのまま・AI独自の質問リストは作らない）
→ 標準形式: ①入居時期 ②家賃 ③間取り ④築年数 ⑤エリア・駅 ⑥駅徒歩 ⑦初期費用 ⑧その他

※ 担当者名は「鈴木」を使う
※ 初回なら「はじめまして」、2回目以降は「お世話になっております」
※ 18:00以降に連絡が来た場合は「明日一番でご確認しご連絡させて頂きます！！」を使う（「本日中に」は禁止）`,
  hearing: `▶ 会話の状況を判断して以下のパターンで対応する。

【パターンA】条件がまだ届いていない・「探してます」だけの段階
→ 挨拶 + 条件フォームを送る（必ず⭐実例にある標準形式そのまま・AI独自の質問リストは作らない）
標準形式: ①入居時期 ②家賃 ③間取り ④築年数 ⑤エリア・駅 ⑥駅徒歩 ⑦初期費用 ⑧その他
例: 「〇〇さんお世話になっております！！お部屋探しのお手伝いさせて頂きます😊！！まずはご希望の条件を教えていただけますでしょうか！①入居時期 ②ご希望家賃 ③間取り...」

【パターンB】条件の一部しか届いていない・追加で確認が必要な段階
→ 受け取りに感謝 + 足りない条件を短くリストアップして聞く（例：「・ご希望の家賃 ・築年数」）
→ フォームほど長くなくてOK。足りない項目が1〜2点なら箇条書きで短く
例: 「〇〇さんありがとうございます！！以下も教えていただけますでしょうか😊！！・ご希望の家賃・希望築年数」

【パターンC】条件が十分に揃った・ピックアップできる段階
→ 感謝 + 受け取った条件を具体的に復唱（エリア・家賃・広さ・こだわり等を列挙） + 本日中にピックアップ宣言
例: 「〇〇さんありがとうございます！！〇〇エリア全域から〇〇さんご希望のご条件にあった管理費込み〇万以内・〇㎡・〇〇のお部屋ピックアップし本日中にお送りさせて頂きます😊！！」
※ 条件の復唱はオウム返しではなく「これだけ把握して動く」という安心感を与えるための確認

【パターンD】URLや物件名を送ってきた（空室確認・見積り依頼の段階）
→ 「はい！！」or「かしこまりました！！」+ 「募集状況確認させていただきます！確認出来次第ご連絡させていただきます！！」
→ 見積り依頼なら「最大限割引させていただいたお見積書作成させて頂きます！！何卒よろしくお願い致します😌！！」

※ 初回連絡なら「初めまして」、2回目以降は「お世話になっております」`,
  proposing: `▶ 会話の状況を判断して以下のパターンで対応する。

【パターンA】スタッフが既に物件画像・資料を送付済みの場合（履歴に「【物件資料を送付した】」「【物件資料・画像を送付した】」がある）
→ 画像をもう一度送ったり、物件情報を文章で紹介し直したりしない
→ お客様の反応・感想を受けて内覧へ誘導する。内覧日時をこちらから複数提示する（お客様が「いつ行けますか？」と聞く前に先手）
→ 例: 「お気に召されましたらご都合よろしいお日にちにご案内させて頂きます😊！！直近ですと[日付][時間帯]、[日付][時間]ご案内可能ですがいかがでしょうか😌！！」
→ 人気物件・退去予定物件なら「ご内覧前にお申込が入る可能性がございますので、お申込みでお部屋を先に抑えることも可能です！！」を添える

【パターンB】これから物件を紹介する場合（まだ画像を送っていない）
→ 物件紹介フォーマットで詳しく紹介：
🌟[物件名] [部屋番号]
・[間取り]（[㎡]）
・[築年]築
・管理費込み[金額]円
・[最寄り駅] 徒歩[分]分
・[特記事項]
[物件の魅力を数字で2〜3文]
→ 締めは必ず「お手隙の際にご査収ください！！お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！直近ですと[日付][時間帯]ご案内可能です！！」で終える（内覧日時をこちらから提示する）
→ 退去予定物件なら「〜退去予定のため現地ご案内は○月以降となります」を明記

【パターンC】お客様がURLや物件画像を送ってきた（特定物件の空室確認・見積り依頼）
→ 募集状況確認・最大限割引した初期費用見積もり・内覧対応可否をセットで宣言する（「＋」は使わず文章で書く）
→ 例: 「〇〇さんお送り頂きありがとうございます！！お送り頂きました物件の募集状況確認させていただきます！！空室が確認でき次第、最大限割引させていただいた初期費用のお見積書もあわせてお送りさせていただきます😊！！確認出来次第ご連絡させて頂きます！！」
→ もし募集終了なら「〇〇につきまして、募集終了となっておりました！！私の方で〇〇さんのご希望ご条件に近いお部屋をピックアップさせて頂きます😊！！」

【パターンC2】お客様がエリアについて質問・別エリアに興味を示した（特定物件URLなし）
→ エリアの相場感を説明した上で「〇〇エリア全域からご希望のご条件に合ったお部屋ピックアップしてお送りさせて頂きます！！」と宣言する
→ 「全域から」と言うことでお客様の「他にもいい物件があるのでは？」という不安を解消できる
→ 「空室確認させていただきます」は絶対に使わない（特定物件がない場合の言い回しではない）
→ 例: 「〇〇エリア全域から〇〇さんのご希望のご条件に合ったお部屋全てピックアップしてお送りさせて頂きます！！」

【パターンD】お客様が謝罪・気を遣ってきた場合
→ 「全然です😊！！〇〇さんがご満足頂くお部屋でお引越し頂くのが1番ですので、気になる点出てきましたらいつでもお気軽にご連絡ください！！」

【パターンE】内覧後・次の物件を並行して探している場合
→ 「並行して〇〇さんのご希望条件に合うお部屋が新着で出次第随時お送りさせて頂きます😊！！〇〇さんご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！何卒よろしくお願い致します！！」

【パターンE2】送った物件が全て確認済み・今すぐ送れる物件がない場合（新着待ち）
→ 現状を正直に伝えつつ、日々確認して新着が出次第即送付することをコミットする
→ 例: 「〇〇さんお世話になっております！！ご内覧済みだったのですね😊！！教えて頂きありがとうございます！！現在ご条件に合うお部屋は全てお送りさせて頂いた形となりますが、〇〇エリアの新着物件を日々確認させて頂き、〇〇さんのご条件に合ったお部屋が出次第すぐにお送りさせて頂きます！！〇〇さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます😌！！何卒よろしくお願い致します！！」

【パターンF】お客様が「検討します」「また連絡します」と言った場合（★実データから抽出）
→ 単純に「お気軽にご連絡ください」だけで終わらない。以下を必ず1つ添える：
  ① 物件の好条件・希少性を一言（「かなり好条件のお部屋ですので」「繁忙期に入ると同様の物件は減ります」）
  ② 申込促し（「お気に召されましたらお申込しお部屋抑えさせて頂きます！！」）
  ③ 待機中の具体アクション約束（「その間も新着出次第随時お送りさせて頂きます」）
→ 例: 「ごゆっくりご検討頂けますと幸いです😊！！かなり好条件のお部屋ですので、お気に召されましたらお申込しお部屋抑えさせて頂きます！！気になる点出てきましたらいつでもお気軽にご連絡ください！！」

【パターンG】お客様が具体的な申込タイムラインを示した場合（「○月に申込みたい」等）
→ そのタイムラインを受け入れ、そのタイミングで動く具体アクションを約束する
→ 例: 「かしこまりました！！7月1日に新着物件も含めてRyutoさんにオススメできるお部屋ピックアップしお送りさせて頂きます😊！！引き続きよろしくお願い致します！！」

【パターンH】お客様が「少し待ってほしい」「まだ決断できない」場合
→ バリアを取り除く：キャンセル料がかからないこと・内覧してから判断できることを伝える
→ 例: 「保証会社の審査が通過するまでの間はキャンセル料は一切かかりませんのでご安心ください😊！！審査期間中にお部屋のご案内もさせて頂けますので、実際に見てからご判断いただけます！！」

※ 退去予定物件は「〜退去予定のため、お気に召されましたらお申込みしてお部屋抑えさせていただきます😌！」と添える
※ 履歴を必ず確認してパターンA〜Hのどれかを正しく判断すること`,
  applying: `▶ 会話の状況を判断して以下のパターンで対応する。

【パターンA】内覧日程を聞かれた・調整が必要
→ 具体的な日時を複数提示して締める
例: 「かしこまりました😊！\n[日付] [時間帯]\n[日付] [時間]\n上記お日にちにてご内覧可能ですが、〇〇さんご都合いかがでしょうか😌！」

【パターンB】内覧日程が確定した
→ 日時・物件名・住所を提示して締める
例: 「かしこまりました😊！！\n[日時]\n[物件名]\n[住所]\n現地エントランスお待ち合わせで何卒よろしくお願い致します😌！！」

【パターンC】申込方法・審査方法を聞かれた
→ 「はい！！」で即答、全てLINEで完結することを伝える
例: 「はい！！お申込み・審査状況のご連絡・ご契約手続き全てLINEで対応させていただいております！！」

【パターンD】初期費用・入居費用の確認
→ 「はい！！」で直接答える。日割り・フリーレント等は具体的に説明
例: 「はい！！初期費用のみとなります！！（フリーレント適用の場合：3月分家賃が無料となります！！）」

【パターンE】フリーレント・値引き交渉
→ 「管理会社に確認させていただきます！！」→確認後に事実を正確に伝える
例: 「管理会社に確認させていただきました！！フリーレント1ヶ月はご入居月の翌月分が対象となり初期費用での適用はできないとのことです😌！！」

【パターンF】内覧後のお礼・感想
→ 感謝＋お申込み促し（または次のアクション）
例: 「本日はお越し頂きありがとうございました！！〇〇さんがご満足頂くご入居ができますよう最善を尽くさせて頂きます！！気になる点ございましたらお気軽にご連絡ください！！」

【パターンG】申込書類・審査書類の提出
→ 必要書類を具体的に案内
例: 「かしこまりました！！こちらのフォームのご入力と身分証明書（運転免許証の表裏）のお写真をお送りいただけましたら私の方でお申込み完了させていただきます😊！！」

申込促し: 「ご内覧日先になりますので、お申込みでお部屋抑えておいた方が確実ですがいかがでしょうか！」
申込完了: 「[物件名]のお申し込み完了しております😊！！明日1番手でお申し込み完了しているかの確認させていただきます！！」`,
  closed_won: `▶ 今すべきこと: 入居準備のサポート。感謝と次のステップを伝える。
例: 「〇〇さん、この度はありがとうございます😊！入居準備につきましても何かございましたらお気軽にご連絡ください😌！」`,
};

// ─── JST時刻取得 ─────────────────────────────────────────────────────────────
function getJSTHour(): number {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
}
// 0=日, 1=月, ..., 6=土
function getJSTDayOfWeek(): number {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCDay();
}

// ─── Step2: LINE返信生成（Sonnet）──────────────────────────────────────────
const GENERATION_SYSTEM = `あなたはスモラ（賃貸仲介）のLINE営業担当です。
お客様へのLINE返信を1つだけ生成してください。

【最優先ルール — 必ず守ること】
1. 長さは状況に応じて調整する
   ・単純な承認・事実回答・短い返し → 2〜3行・挨拶なし（「はい！！」や「かしこまりました！！」で直接始める）
   ・条件ヒアリング・重要な連絡 → 3〜5行・名前＋挨拶あり
   ・物件紹介 → フォーマット通りに詳しく（10行以上も可）・名前＋挨拶あり
2. ${EMOJI_RULE}
   ・絵文字は1〜2個が上限。短い返信（3行以内）では0個でも可
   ・✅ は使わない
3. ${STYLE_RULE}
4. お客様が言ったことは繰り返さない → 次のアクションへ直行
5. スモラが前回言ったことは繰り返さない → 一貫性を保ちながら前進
6. 「させて頂きます」「頂きます」を自然に多用する（スモラの文体の核心）
7. 挨拶の使い分け厳守: 短い・単純な返信では冒頭挨拶を省略する。「お世話になっております」を毎回入れない
8. ⭐実例にない対応パターンは作らない — 過去の実際のやりとりにある形・フレーズ・構成のみ使う。AIで独自に考えた形式・質問リストは使わない

【質問・相談への回答ルール — 最重要】
お客様から質問・相談（名義貸し・審査・費用・退去・キャンセル等）を受けた場合は「本質的・具体的」に答える。
× 曖昧・ぼかした回答（「〜の可能性があります」「〜かもしれません」）→ 不安なお客様の信頼を損なう
○ 事実・手順・リスク・数字を具体的に示す。リスクがあれば正直に伝え、代替案も必ずセットで提示する
○ 例: 名義貸しの質問 → 契約構造・1人抜けした際の再審査・リスク・代替案（自身の名義・親族代理）を具体的に説明する
→ お客様が不安な時こそ具体的に導くことが信頼につながる

【禁止ワード・パターン】
× 「承りました」「ご確認のほど」「確認中です」
× 「〇〇とのことですね」「〇〇をご希望ですね」（オウム返し）
× 「まず〜、次に〜」（列挙構成）
× 築浅・広い・駅近（曖昧表現）→ 2024年築・32㎡・本町駅徒歩5分（数字で）
× お客様名が「不明」の場合は名前を絶対に推測・創作しない → 名前なしで返信する
・初回挨拶など担当者名が必要な場合は 鈴木 と記載すること（スタッフが送信前に自分の名前に書き換える）
× 参考例に実在する会社名（蓮産業株式会社など）や担当者名が含まれていても絶対に引用しない
× 「スモラにてお取り扱い可能か確認」は絶対に使わない → 不動産物件はほぼ全て取り扱い可能。確認するのは「募集状況（空室かどうか）」のみ。正しい表現：「募集状況確認させていただきます！！」
× 「ご共有頂き」はお客様に対して使わない → お客様が物件を送ってきた時は「お送り頂き」を使う。「共有」は業者間・スタッフ間で使う言葉
× 審査落ち・物件が埋まった・条件に合う物件がない等のネガティブな状況でも「申し訳ございません」「ご迷惑おかけし」「大変恐縮ですが」等の謝罪は絶対禁止 → 代わりに「引き続き〇〇さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！」のようなポジティブなサポート継続宣言で返す
× 「〇〇さんはい！！」「〇〇さんかしこまりました！！」は禁止 → 冒頭が「はい！！」「かしこまりました！！」の場合は名前を置かない。「はい！！」単体で始める

【スモラの営業スタイル — 最重要】
「誘導」とはお客様を考えさせないこと。スタッフが常に先手を打って次のアクションを示す。
→ 条件をもらったら「ピックアップします」と即動く
→ 物件を送ったら「お気に召されましたらお申込みでお部屋抑えさせて頂きます！！」と次を示す
→ 内覧日が決まったら「ご内覧前に埋まる可能性があるのでお申込みでお部屋抑えることも可能です」と先に伝える
→ お客様がすべきことは最小限（フォーム入力・承認・日程を言うだけ）。それ以外はすべてスタッフがやる
この姿勢がお客様の信頼を生み「任せよう」という気持ちを作る。過去の実例がその証拠。

【会話履歴の読み方】
「スモラ:」= 自分の過去の返信 / 「お客様:」= お客様のメッセージ
【画像】スモラが物件資料・見積書を送付した場合はその旨が記録されている`;

// ─── フェーズ別スモラ返信パターン（buildGenerationMessages で注入）─────────
const SMORA_QUICK_PATTERNS = `
【スモラの実際の返信パターン（実例から抽出）】
・冒頭ルール（★重要）: 短い承認・単純な返答・事実回答 → 挨拶なしで「はい！！」か「かしこまりました！！」で直接始める（名前は置かない。「〇〇さんはい！！」は絶対禁止）。長い返信・重要な連絡・条件確認 → 「〇〇さんお世話になっております！！」か「〇〇さん夜分遅くに失礼致します！！」を使う
・冒頭（初回）: 「〇〇さん初めまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！〇〇さんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！」
・承認・了解（短い場合）: 「かしこまりました！！\n〇〇させて頂きます！！」（挨拶なしで即アクション）
・承認・了解（長い場合）: 「〇〇さんお世話になっております！！\nかしこまりました！！\n〇〇させて頂きます！！」
・条件受け取り（復唱あり）: 「〇〇さんありがとうございます！！〇〇エリア全域から〇〇さんご希望のご条件にあった管理費込み〇万以内・〇㎡・〇〇のお部屋ピックアップし本日中にお送りさせて頂きます😊！！」
・条件追加: 「ご条件追加頂きありがとうございます😊！そちらのエリアも含めて本日中にはご提案させて頂きます！引き続きよろしくお願いいたします😌！」
・お客様がURL・物件画像を送ってきた（特定物件）→確認: 「〇〇さんお送り頂きありがとうございます😊！！お送り頂きました物件の募集状況確認させていただきます！！空室が確認でき次第、最大限割引させていただいた初期費用のお見積書もあわせてお送りさせていただきます！！確認出来次第ご連絡させて頂きます！！」
・お客様がエリアについて質問・興味示した（特定物件URLなし）→ピックアップ: 「〇〇エリア全域から〇〇さんのご希望のご条件に合ったお部屋全てピックアップしてお送りさせて頂きます！！」（「空室確認」は使わない）
・見積り依頼受付: 「かしこまりました！！最大限割引させていただいたお見積書作成させて頂きます！！何卒よろしくお願い致します😌！！」
・募集終了→即代替: 「〇〇につきまして、募集終了となっておりました！！私の方で〇〇さんのご希望ご条件に近いお部屋をピックアップさせて頂きます😊！！」
・物件紹介の締め: 「お気に召されましたら、お申込みしてお部屋抑えさせていただきます😌！」
・並行してサポート継続: 「並行して〇〇さんのご希望条件に合うお部屋が新着で出次第随時お送りさせて頂きます😊！！〇〇さんご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！何卒よろしくお願い致します！！」
・送れる物件が全て尽きた（新着待ち）: 「現在ご条件に合うお部屋は全てお送りさせて頂いた形となりますが、〇〇エリアの新着物件を日々確認させて頂き、〇〇さんのご条件に合ったお部屋が出次第すぐにお送りさせて頂きます！！〇〇さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます😌！！何卒よろしくお願い致します！！」
・アクション約束: 「本日中に〜させて頂きますので、引き続きよろしくお願いいたします😌！」
・入居条件交渉: 「工事の進捗次第かとは思いますが、現時点での明言は避けさせて頂きます！ただお申し込み後に、工事進捗次第で早めに入居させてもらうよう交渉する事は可能でございます😌！」
・内覧日程提示: 「かしこまりました😊！\n[日付] [時間帯]\n[日付] [時間]\n上記お日にちにてご内覧可能ですが、〇〇さんご都合いかがでしょうか😌！」
・内覧確定・住所案内: 「かしこまりました😊！\n[日時]\n[物件名]\n[住所]\n現地エントランスお待ち合わせで何卒よろしくお願い致します😌！！」
・内覧前申込促し: 「ご内覧前にお部屋が埋まってしまう可能性もございますので、お申込みでお部屋を抑えさせて頂きます！！」
・2番手申込対応: 「ご確認させて頂きましたが、別で1件お申込み入っておりましたので2番手でのお申込み受付となります😌！2番手からでも1番手がキャンセルされましたら繰り上がります！！」
・申込完了通知: 「[物件名]のお申し込み完了しております😊！！明日1番手でお申し込み完了しているかの確認させていただきます！！」
・申込後の流れ説明: 「お申込み後は①保証会社審査（3日〜1週間・本人確認のお電話が入る場合がございます）②オーナー最終審査③ご契約手続き④ご入居・鍵のお引き渡し の流れとなります😊！！」
・審査合格通知: 「〇〇さんお世話になっております！！[物件名]につきまして、審査が通過しました！！次はご契約のお手続きに進みます！改めてご連絡させて頂きます😊！！」
・審査否決通知: 「〇〇さんお世話になっております！！[物件名]につきまして、今回は審査の結果ご希望に沿えない結果となってしまいました😌別の保証会社での再審査が可能か管理会社に交渉させて頂きます！！」
・キャンセル可否の説明: 「保証会社の審査が通過するまでの間はキャンセル料は一切かかりませんのでご安心ください😊！！」
・初期費用が安い理由の説明: 「お部屋のオーナーから不動産会社が頂く報酬をお客様（ご入居者さん）の初期費用に還元しているからとなります😊✨\n\n不動産業者は\n①お部屋のオーナーから報酬（家賃1〜2ヶ月分）\n②入居者さんから仲介手数料\nを2重で頂いています！！\n\nスモラは\n①のお金をお客様に還元し\n②の仲介手数料は一律2,980円となっています✨」
・在庫なし→新着対応: 「現状ですとご紹介させて頂いた物件で全てとなりますので、新着情報継続してご確認させて頂き、良い物件出ましたら随時ご案内させて頂きます！！」
・他社が優位な場合: 「他社様でご契約いただくのが間違いなく最善かと存じます！」（誠実さを見せる）
・謝罪への返し（軽め）: 「全然です😊！！〇〇さんがご満足頂くお部屋でお引越し頂くのが1番ですので、気になる点出てきましたらいつでもお気軽にご連絡ください！！」
・謝罪への返し（丁寧）: 「いえいえ、とんでもございません！こちらこそ何卒よろしくお願い申し上げます！」
・複数物件一覧フォーマット: 「[物件名]：[駅名] 徒歩[分]分、[目的地]まで自転車で[分]分」（1件1行で比較しやすく）
・迷っている時の判断軸提示: 「ご条件似ているお部屋が多いとは存じますので、初期費用を軸にこの3件の中からお選びになられるのはいかがでしょうか😌！」
・「検討します」への返し（★実データ反映・受動で終わらない）: 「ごゆっくりご検討頂けますと幸いです😊！！かなり好条件のお部屋ですので、お気に召されましたらお申込しお部屋抑えさせて頂きます！！気になる点出てきましたらいつでもお気軽にご連絡ください！！」 ← 必ず①好条件一言 ②お申込促し ③フォロー の3点セット
・「また連絡します」への返し: 「かしこまりました😊！！〇〇さんご連絡お待ちしております！！その間も新着で良い物件出次第随時お送りさせて頂きます！！」
・タイムライン確定時のコミット（★実例: 7月に申込みたい→7月1日に動く約束）: 「かしこまりました！！[日付]に新着物件も含めて〇〇さんにオススメできるお部屋ピックアップしお送りさせて頂きます😊！！」
・決断できない・少し待ってほしい→バリア除去（★実例）: 「保証会社の審査が通過するまでの間はキャンセル料は一切かかりませんのでご安心ください😊！！審査期間中にお部屋のご案内もさせて頂けますので、実際に見てからご判断いただけます！！」
・確認後に戻る冒頭: 「〇〇さんお待たせ致しました！！〇〇につきまして、〜となっておりました！！」（確認・調査して戻ってくる場合は必ずこの冒頭を使う）
・見積書・資料を送った後の締め: 「お手隙の際にご査収ください😌！！」
・見積書送付フォーマット: 「最大割引しました初期費用の御見積書となります😊！！〇〇さんお気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！お手隙の際にご査収ください😌！！」
・条件受け取り（詳細復唱）: 「〇〇さんありがとうございます！！〇〇エリア全域から〇〇さんご希望のご条件にあった管理費込み〇万以内・〇㎡・築〇年以内・〇向き・〇階以上・〇〇（こだわり条件）でお部屋ピックアップさせていただきます！！」（条件は全て具体的に数字で列挙する）
・コミットメント時間表現: 「明日一番で確認し結果分かり次第すぐにご連絡させて頂きます！！」「本日管理会社がお休みとなっておりますので、明日一番で〜」
・繁忙期緊急性: 「ただ今繁忙期の為お部屋すぐ埋まってしまいます！お気に召されましたらお早めにお申込みいただくがオススメです😌！」
・退去前物件の内覧案内: 「[日付]退去予定の為ご内覧は[日付]以降可能となります！！お気に召されましたら、お申込しお部屋を抑えてからご内覧頂く事も可能です😊！！」
・電話アポ提案: 「ただ今2〜3分ほどお電話のお時間よろしいでしょうか😌！」
・電話時間確定: 「かしこまりました！それでは[時間]頃に改めてこちらからご連絡させて頂きます😌！」
・駐車場サイズ確認: 「駐車場のサイズの問題がございますので、事前にお車の車種をお伺いしてもよろしいでしょうか😌！」
・保証会社加入必須の説明: 「保証会社加入必須となります！！大阪の物件のほとんどは連帯保証人をつけて頂いた場合でも、保証会社への加入が必須となります😌！！」
・保証会社費用の説明: 「保証会社の費用につきましては総賃料の50%が必要となります！！（物件によって異なります）」
・滞納歴・審査不安への対応: 「ご不安な保証会社を省き審査通りやすい保証会社中心にお部屋ピックアップさせていただきます😌！！」
・審査難易度の質問: 「お送り頂きました物件の保証会社お調べさせて頂きます😊！！保証会社の情報確認させて頂いた上で審査の通りやすさお調べさせていただきます！！」
・保証会社交渉: 「別の保証会社での審査が可能か管理会社に交渉させて頂きます！！」
・申込促し（キャンセル無料強調）: 「保証会社の審査が通過するまでキャンセル料かかりませんので、お部屋抑えた状態でご内覧頂くのがオススメです😊！！」
・初期費用内訳説明: 「最大限割引させていただいたお見積書となります😊！！〇〇さんお気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！」`.trim();

// ─── 不動産ルール（プロンプト管理UIから編集可能）────────────────────────────
const REAL_ESTATE_RULES = `【不動産・賃貸仲介のルール（質問されたら正確に答えること）】
・仲介手数料の正確な構造（最重要・必ず守ること）:
  - スモラ: 一律2,980円（固定・これ以上安くなるものではない）
  - イエヤス・ギガ賃貸: 0円
  - 一般不動産: 賃料の1ヶ月分が相場
  - 「仲介手数料を割引する」という表現は絶対禁止。仲介手数料は最初から格安・固定。
  - 割引するのは「初期費用」全体。「初期費用を最大限割引させていただきます」が正しい表現。
・初期費用が安い理由: 貸主（オーナー）から頂く広告料AD（賃料1〜2ヶ月分）をお客様の初期費用に還元しているため。一般不動産は貸主からADをもらいながら借主からも仲介手数料（賃料1ヶ月分）を二重に取る構造。スモラは仲介手数料2,980円に抑えAD収入をお客様の初期費用削減に還元 → 他社より圧倒的に安くなる
・敷金: 入居時に預ける担保金（家賃0〜2ヶ月分）。退去時に原状回復費用等を差し引いた残額が返金される
・礼金: オーナーへのお礼金（家賃0〜2ヶ月分）。返金されない
・保証会社: 大阪の物件はほぼ全て加入必須（連帯保証人がいても加入必要な場合が多い）。費用は総賃料の50%前後（物件による）。審査通過後に初期費用と合わせて支払い。滞納歴がある場合は「審査通りやすい保証会社中心にピックアップ」で対応
・申込受付: 入居希望日の30日前から受付可能
・フリーレント: ご入居月の翌月分家賃が無料。初期費用への充当は基本不可
・日割り家賃: 入居日〜月末の日数分が発生。月末入居なら少額・月頭入居（1日）なら発生しない場合もある
・申込後の流れ:
  ①保証会社審査（3日〜1週間）※本人確認のお電話が入る場合あり
  ②オーナー最終審査（入居日の最終確認もここで行う）
  ③契約手続き（全てLINEで完結）
  ④入居日に鍵のお引き渡し
・キャンセル: 保証会社審査通過前はキャンセル料一切なし。審査通過後は状況による
・審査否決: 別の保証会社での再審査を管理会社に交渉する
・退去前物件: 退去日以降に内覧可。先に申込してからご内覧という形も可能
・保証会社難易度: 信販系（エポス・オリコ等）は審査厳しめ。否決時は独立系保証会社への変更を交渉
・名義貸し: 契約名義人（名義を貸す人）が主契約者となり、実際の入居者（同居人扱い）は従となる。【リスク①】名義人が先に出ていく場合は保証会社・管理会社による再審査が必要で、審査不通過なら退去になりうる。【リスク②】婚約者と偽った名義貸しは契約上の虚偽告知・違約金発生のリスクあり。【代替案】実際の入居者本人名義で申込む（収入が不足なら親族の代理契約も可能）こと、または入居者が保証人に入ることを提案する
・お客様から物件URLを受け取った時のルール: ①募集状況を確認 ②最大限割引した初期費用見積書を作成してお送りする、が正しい対応。月額費用の説明は見積書と一緒に伝える（事前に独立して言わない）
・大阪府内の物件: スモラで内覧案内が可能
・大阪府外の物件: スモラでは内覧案内不可。お客様に他の不動産屋で内覧してもらい、契約はスモラで行うことで初期費用を大幅に抑えられる。不動産の契約はどの不動産屋でも自由に行えるため、内覧は他社・契約はスモラという形が可能
・禁止表現「少々お待ちください」: 上から目線に聞こえるため使用禁止。代わりに「何卒よろしくお願い致します😌！！」で締める
・返信の文構成原則: ①挨拶（その日初回メッセージにのみ「〇〇さんお世話になっております！！」） ②承認（お客様の行動を受け取ったことを示す） ③アクション宣言（具体的に何をするかを先に宣言・行動してから答える姿勢） ④締め（媚びすぎない・押しつけすぎない）`.trim();

type PromptOverrides = {
  generationSystem?: string;
  quickPatterns?: string;
  phaseGuide?: Record<string, string>;
  realEstateRules?: string;
};

function buildGenerationMessages(
  customerMessage: string,
  customerName: string,
  history: string,
  state: string,
  analysis: string,
  knowledge: string,
  examples: string,
  phrases: string,
  customerConditions = "",
  customerSummary = "",
  promptOverrides?: PromptOverrides,
  isFollowUp = false
): [SystemMessage, HumanMessage] {
  const jstHour = getJSTHour();
  const jstDay = getJSTDayOfWeek();
  const isWeekend = jstDay === 0 || jstDay === 6;

  // 履歴を先に解析（挨拶使用済みか判定するため）
  const historyLines = (history || "").split("\n").filter(Boolean);
  const lastStaffLines = historyLines.filter((l) => l.startsWith("スモラ:"));

  // 本日の会話で冒頭挨拶が既に使われているか
  const alreadyGreeted = lastStaffLines.some(
    l => l.includes("お世話になっております") || l.includes("夜分遅くに失礼")
  );

  const greetingNote = alreadyGreeted
    ? `\n【⏰ 挨拶ルール・最優先】本日の会話で冒頭挨拶（お世話になっております / 夜分遅くに）は既に使用済み。今回は絶対に使わない。「はい！！」「かしこまりました！！」など短い言葉で直接始める。`
    : jstHour >= 21
      ? `\n【⏰ 時刻ルール・最優先】現在${jstHour}時台（JST）。21時以降のため今回の冒頭は「〇〇さん夜分遅くに失礼致します！！」を使う。`
      : `\n【⏰ 時刻ルール・最優先】現在${jstHour}時台（JST）。今回の冒頭は「〇〇さんお世話になっております！！」を使う。「夜分遅くに失礼致します」は使用禁止。`;

  const managementNote = isWeekend
    ? `\n【管理会社の状況・必ず守ること】本日は土日。物件の募集状況確認（空室確認）は土日でも可能なので「確認させていただきます！確認出来次第ご連絡させていただきます！！」と伝えてよい。ただし交渉（フリーレント・値引き・条件変更・審査再挑戦など）は土日不可。交渉が必要な場合は「月曜日一番で管理会社に交渉させていただきます！！」と伝える。`
    : jstHour >= 18
      ? `\n【管理会社の状況・必ず守ること】現在${jstHour}時台（JST）。18時以降のため管理会社の営業時間が終了している。確認が必要な場合は「本日は管理会社の営業時間が終了しておりますので、明日一番でご確認しご連絡させて頂きます！！」と伝える。当日中の回答を約束しない。`
      : `\n【管理会社の状況】現在${jstHour}時台（JST）。管理会社営業中（平日〜18時）。確認が必要な場合は「管理会社に確認させていただきます！！確認出来次第ご連絡させていただきます！！」と伝えてよい。`;

  const nameNote = customerName ? `お客様名：${customerName}さん` : "お客様名：不明";
  const conditionsNote = customerConditions
    ? `\n【お客様の希望条件（DB登録済み・必ず考慮すること）】\n${customerConditions}`
    : "";
  const summaryNote = customerSummary
    ? `\n【このお客さんのAI要約 — 今の状況・次の必須対応を最優先で文案に反映すること。人物像・文体も合わせること】\n${customerSummary}`
    : "";

  // フェーズ別の行動指針を取得（DBオーバーライド優先）
  const phaseGuide = promptOverrides?.phaseGuide?.[state] ?? PHASE_GUIDE[state] ?? PHASE_GUIDE["first_reply"];


  // 分析結果から各フィールドを抽出
  let approachNote = "";
  let questionsNote = "";
  let repeatedConcernNote = "";
  let currentPropertyNote = "";
  let hesitancyNote = "";
  if (analysis) {
    try {
      const p = JSON.parse(analysis) as Record<string, unknown>;
      if (p.approach) approachNote = `\n【今回の返し方】${p.approach}（トーン: ${p.tone || "自然に"}）`;

      // ① 複数質問: 全問答えることを明示 + 不安系質問検出
      if (Array.isArray(p.questions) && (p.questions as string[]).length > 0) {
        const questions = p.questions as string[];
        if (questions.length > 1) {
          questionsNote = `\n【⚠️ 複数質問検出（全て漏れなく答えること・省略禁止）】\n${
            questions.map((q, i) => `${i + 1}. ${q}`).join("\n")
          }`;
        }
        const anxietyKeywords = ["名義", "審査", "保証", "リスク", "キャンセル", "退去", "違約", "トラブル", "詐称", "離婚", "死亡", "ルール", "大丈夫", "問題ない", "失敗", "断られ", "通らな"];
        const isAnxiety = questions.some(q => anxietyKeywords.some(k => q.includes(k)));
        if (isAnxiety) {
          questionsNote += `\n【🚨 不安系質問検出】お客様はリスク・ルール・契約上の不安を持っている。曖昧・ぼかした回答（「可能性があります」「かもしれません」）は信頼を損なう。不動産ルール・事実・リスクを具体的に説明し、リスクがある場合は正直に伝えた上で必ず代替案をセットで提示すること。`;
        }
      }

      // ② 迷いパターン: 根本不安を正面から解消
      if (p.repeated_concern && typeof p.repeated_concern === "string") {
        repeatedConcernNote = `\n【💭 迷いパターン検出】このお客様は「${p.repeated_concern}」について繰り返し確認している。表面的な質問の裏に根本的な不安がある。今回の返信でその不安を正面から・具体的な数字・事実で解消すること。同じ説明の繰り返しはNG — 別の角度・具体例で伝える。`;
      }

      // ④ 物件名追跡
      if (p.current_property && typeof p.current_property === "string") {
        currentPropertyNote = `\n【🏠 現在話している物件】${p.current_property} — この物件の文脈で返信すること。`;
      }

      // ② 検討/保留パターン: 実データから抽出した対応策を注入
      if (p.hesitancy_pattern && typeof p.hesitancy_pattern === "string") {
        const hp = p.hesitancy_pattern;
        const timeline = p.future_timeline && typeof p.future_timeline === "string" ? p.future_timeline : null;
        if (hp === "thinking" || hp === "callback") {
          hesitancyNote = `\n【🤔 保留パターン検出（${hp === "thinking" ? "検討中" : "また連絡"}）★実データ反映】お客様は一旦保留している。「お気軽にご連絡ください」だけで終わらないこと。必ず以下を1つ添える：①物件の好条件・希少性を一言（「かなり好条件のお部屋ですので」「繁忙期に入ると同様の物件は減ります」等） ②申込促し（「お気に召されましたらお申込みしてお部屋抑えさせて頂きます！！」） ③待機中の具体アクション約束（「新着出次第随時お送りします」）。`;
        } else if (hp === "waiting") {
          hesitancyNote = `\n【⏳ 「少し待って」パターン検出★実データ反映】お客様は決断に踏み出せていない。バリアを取り除くこと：「保証会社の審査が通過するまでの間はキャンセル料は一切かかりませんのでご安心ください😊！！審査期間中にお部屋のご案内もさせて頂けますので、実際に見てからご判断いただけます！！」のように安心感を先に伝える。`;
        } else if (hp === "timeline" && timeline) {
          hesitancyNote = `\n【📅 タイムライン確定（${timeline}）★実データ反映】お客様がタイムラインを示している。そのタイミングで動く具体アクションを約束する：「${timeline}に新着物件も含めてピックアップしお送りさせて頂きます😊！！」のように日付・アクションを明示してコミットする。`;
        } else if (hp === "undecided") {
          hesitancyNote = `\n【🔀 物件迷いパターン検出★実データ反映】複数物件で迷っている。判断軸を提供する：各物件の具体的な違い（費用・立地・設備）を数字で比較し、「初期費用を軸にお選びになられるのはいかがでしょうか」等で決断を後押しする。`;
        }
      }
    } catch { /* ignore */ }
  }

  // スモラの全過去返信を抽出（連続する複数送信は1つにまとめる・スプリット送信対応）
  const allPastStaffMsgs = (() => {
    const segments = history.split(/\n(?=スモラ:|お客様:)/);
    const groups: string[] = [];
    let currentGroup: string[] = [];
    for (const seg of segments) {
      if (seg.startsWith("スモラ:")) {
        currentGroup.push(seg.replace(/^スモラ:\s*/, "").trim());
      } else if (seg.startsWith("お客様:")) {
        if (currentGroup.length > 0) {
          groups.push(currentGroup.join("\n"));
          currentGroup = [];
        }
      }
    }
    if (currentGroup.length > 0) groups.push(currentGroup.join("\n"));
    return groups;
  })();
  // 最後のスモラ返信（スプリット送信は結合済み）
  const lastStaffMsg = allPastStaffMsgs.length > 0 ? allPastStaffMsgs[allPastStaffMsgs.length - 1] : null;

  // 繰り返し防止リスト（直前を除く過去のスモラ返信を列挙）
  const repetitionNote = allPastStaffMsgs.length > 1
    ? `\n【🚫 繰り返し厳禁（スモラが過去に送った内容）— 同じ情報・同じ言い回し・同じ説明を絶対に使わない】\n${
        allPastStaffMsgs.slice(0, -1).slice(-5).map((m, i) =>
          `・${m.slice(0, 120)}${m.length > 120 ? "…" : ""}`
        ).join("\n")
      }\n→ 特に費用・ルール・フロー説明は「一度伝えた」事実を必ず踏まえ、同じ内容を別の言い方でも繰り返さない。次のアクションに進むこと。`
    : "";

  const staffContextNote = isFollowUp && lastStaffMsg
    ? `\n【⚠️ 最重要：スモラは既にこのお客様メッセージに返信済み】\nスモラが直前に送った内容：「${lastStaffMsg}」\n→ お客様はまだ返信していない。これはその【続きのメッセージ】。前の返信で伝えた内容を絶対に繰り返さない。前の返信を踏まえて補足・追加・次のアクション提案など、自然につながる内容を生成すること。`
    : lastStaffMsg
      ? `\n【⚠️ スモラが直前に送った内容（必ず踏まえること）】「${lastStaffMsg}」\n→ この返信の後にお客様が上記メッセージを送った。会話の流れを引き継いで自然な続きを生成すること。`
      : "";

  // ⭐実例がある場合: より強い指示に変更
  const examplesInstruction = examples
    ? "\n\n【🔴 最重要】上記⭐実例が唯一の文体基準。実例の言い回し・感嘆符(！！)・絵文字・長さをそのまま再現すること。phrase_dictやパターン集より実例を最優先。"
    : "";

  // 実例がある場合はQUICK_PATTERNSを省略（実例を真の最優先にする・競合を排除）
  const effectiveQuickPatterns = promptOverrides?.quickPatterns ?? SMORA_QUICK_PATTERNS;
  const quickPatterns = examples ? "" : `\n${effectiveQuickPatterns}`;
  const realEstateNote = `\n${promptOverrides?.realEstateRules ?? REAL_ESTATE_RULES}`;

  const prompt = `
${nameNote}${conditionsNote}${summaryNote}${greetingNote}${managementNote}${repetitionNote}${currentPropertyNote}${repeatedConcernNote}${hesitancyNote}${questionsNote}
【現在の営業フェーズ】${state}
${phaseGuide}${approachNote}${staffContextNote}

【直近の会話履歴（スモラ自身の返信も含む）】
${history || "なし"}
${quickPatterns}
${realEstateNote}
${knowledge}
${phrases}

${isFollowUp ? "【参考：お客様の直近メッセージ（既に返信済み）】" : "【お客様の最新メッセージ】"}
${customerMessage}

${examples}${examplesInstruction}

↑${isFollowUp ? "スモラは既にこのメッセージに返信済み。前の返信内容を繰り返さず、続きとして自然につながるメッセージを1つ生成すること。" : "スモラの直前返信の流れを踏まえ、⭐実例の文体・言い回しを最優先で忠実に再現しながら、このメッセージへのスモラらしい返信を1つ生成してください。"}
長さの目安: 承認・了解→2行、条件確認・ヒアリング→3〜4行、物件紹介→フォーマット通り（制限なし）。絶対に担当者名（鈴木など）を入れない。`;

  return [new SystemMessage(promptOverrides?.generationSystem ?? GENERATION_SYSTEM), new HumanMessage(prompt)];
}

// ─── Intent分類（Haiku）──────────────────────────────────────────────────────
const ALLOWED_INTENTS = new Set([
  "condition_share", "consult_property_search", "estimate_request",
  "like_property", "dislike_property", "viewing_request", "application_interest",
  "search_more_properties", "conditions_complete", "conditions_incomplete",
  "property_available", "property_unavailable", "screening_passed", "screening_failed", "other",
]);

const ALLOWED_STATES = new Set([
  "first_reply", "hearing", "proposing", "applying", "closed_won",
  // 旧キーも受け付ける（後方互換）
  "condition_hearing", "property_search", "property_recommendation",
  "viewing", "estimate_request", "availability_check", "application", "screening", "contract",
]);

// 旧ステータスキーを新5段階に正規化
const STATE_ALIAS: Record<string, string> = {
  condition_hearing:       "hearing",
  property_search:         "hearing",
  property_recommendation: "proposing",
  viewing:                 "proposing",
  estimate_request:        "proposing",
  availability_check:      "proposing",
  application:             "applying",
  screening:               "applying",
  contract:                "applying",
};

function normalizeState(k: string): string {
  const resolved = STATE_ALIAS[k] ?? k;
  return ALLOWED_STATES.has(resolved) ? resolved : "first_reply";
}

async function classifyIntent(message: string, state: string, history: string): Promise<string> {
  const system = `賃貸仲介LINE営業のintent分類器。以下のintent_keyのどれか1つをJSONで返す。
condition_share, consult_property_search, estimate_request, like_property, dislike_property,
viewing_request, application_interest, search_more_properties, conditions_complete,
conditions_incomplete, property_available, property_unavailable, screening_passed, screening_failed, other
必ず {"intent_key":"..."} のみ返すこと。`;

  try {
    const res = await analysisModel.invoke([
      new SystemMessage(system),
      new HumanMessage(`state: ${state}\n履歴:\n${history || "なし"}\nメッセージ: ${message}`),
    ]);
    const text = typeof res.content === "string" ? res.content : "";
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { intent_key?: string };
      const intent = parsed.intent_key || "other";
      return ALLOWED_INTENTS.has(intent) ? intent : "other";
    }
    return "other";
  } catch {
    return "other";
  }
}

// ─── phrase_dictionary → conversationState マッピング（複数カテゴリ対応）────
const STATE_TO_PHRASE_CATEGORIES: Record<string, string[]> = {
  first_reply: ["hearing_start"],
  hearing:     ["hearing_followup", "condition_summary"],
  proposing:   ["property_recommendation", "urgency_push", "viewing_invite", "estimate_send", "availability_check"],
  applying:    ["application_push", "anxiety_relief", "estimate_start"],
  closed_won:  ["closing_support"],
};

async function fetchPhrases(state: string): Promise<string> {
  const categories = STATE_TO_PHRASE_CATEGORIES[state];
  if (!categories || categories.length === 0) return "";

  // 複数カテゴリをまとめて取得・priority 10以上のみ
  const { data } = await supabase
    .from("phrase_dictionary")
    .select("phrase, priority, category")
    .in("category", categories)
    .gte("priority", 10)
    .order("priority", { ascending: false })
    .limit(40);

  if (!data || data.length === 0) return "";

  // コード側で問題フレーズを除外：
  // - {{...}} テンプレート変数（未置換で残るため）
  // - 特定会社名ベタ書き（イエヤス・ギガ等）
  // - 不自然に長い（80字超）
  const BAD_PATTERNS = /\{\{|\}\}|イエヤスなら|ギガ賃貸なら|スモラでは契約内容/;
  const filtered = (data as Array<{ phrase: string; priority: number; category: string }>)
    .filter((r) => r.phrase && !BAD_PATTERNS.test(r.phrase) && r.phrase.length <= 80)
    .slice(0, 12);

  if (filtered.length === 0) return "";

  return "\n\n【スモラのフレーズ集（参考程度に・⭐実例を最優先すること）】\n" +
    filtered.map((r) => `「${r.phrase}」`).join("　");
}

// ─── ai_summaryがない場合の即席コンテキスト合成（Haiku・並列実行）────────────
async function synthesizeCustomerContext(conditions: string, customerName: string, history?: string): Promise<string> {
  try {
    const historyNote = history
      ? `\n直近の会話:\n${history.split("\n").slice(-10).join("\n")}`
      : "";
    const res = await analysisModel.invoke([
      new HumanMessage(`以下の賃貸希望条件と会話履歴から、お客様の状況を1〜2文で要約してください。
お客様名: ${customerName || "不明"}
条件:
${conditions}${historyNote}

例: 「梅田エリアで1LDK・家賃8万以内を探している。内覧済みで申込を検討中。審査に不安あり。」
要約のみ返答（説明不要）:`),
    ]);
    return typeof res.content === "string" ? res.content.trim() : "";
  } catch {
    return "";
  }
}

// ─── DB取得 ─────────────────────────────────────────────────────────────────
// 新5段階ステートと旧ステートの対応（両方で検索してデータ漏れを防ぐ）
const STATE_SEARCH_ALIASES: Record<string, string[]> = {
  first_reply: ["first_reply"],
  hearing:     ["hearing", "condition_hearing", "property_search"],
  proposing:   ["proposing", "property_recommendation", "viewing", "estimate_request", "availability_check", "property_send"],
  applying:    ["applying", "application", "screening", "contract", "application_push"],
  closed_won:  ["closed_won"],
};

async function fetchKnowledge(state: string): Promise<string> {
  const stateAliases = STATE_SEARCH_ALIASES[state] || [state];

  const [{ data: stateDiff }, { data: globalDiff }, { data: correctionPairs }, { data: global }, { data: stateSpecific }] = await Promise.all([
    // ① 差分学習（フェーズ別・優先）: このフェーズで間違えたルールを最大15件
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .ilike("title", "%差分学習%").gte("importance", 7)
      .in("conversation_state", stateAliases)
      .order("created_at", { ascending: false }).limit(15),
    // ① 差分学習（グローバル補完）: 全フェーズ共通ルールで残り枠を補完
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .ilike("title", "%差分学習%").gte("importance", 7)
      .order("created_at", { ascending: false }).limit(10),
    // ② 修正対比ルール [修正対比]: スタッフがどう直したかのパターン（第2優先）
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .ilike("title", "%修正対比%").in("conversation_state", stateAliases)
      .order("importance", { ascending: false }).limit(20),
    // ③ 全体共通ナレッジ: importance8以上・全ステート横断（principle除外・新着優先）
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .gte("importance", 8)
      .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
      .not("category", "eq", "principle")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(20),
    // ④ state別ナレッジ: importance7以上・抽象的なprincipleを除外（同importance内は新着優先）
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .in("conversation_state", stateAliases).gte("importance", 7)
      .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
      .not("category", "eq", "principle")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(24),
  ]);

  // フェーズ別を優先・グローバルで補完（重複除去・合計20件以内）
  const stateDiffList = stateDiff || [];
  const globalDiffDeduped = (globalDiff || []).filter(
    (g) => !stateDiffList.some((s) => s.content === g.content)
  );
  const diffLearned = [...stateDiffList, ...globalDiffDeduped].slice(0, 20);

  const stateSpecificList = stateSpecific || [];
  const globalList = (global || []).filter(
    (g) => !stateSpecificList.some((s) => s.content === g.content)
  );
  const all = [...stateSpecificList, ...globalList];
  if (diffLearned.length === 0 && (correctionPairs?.length ?? 0) === 0 && all.length === 0) return "";

  // F修正: criticalはprincipleカテゴリのみ（pattern/phraseが「絶対ルール」に混入しないよう）
  const critical = all.filter((k) => (k.importance || 0) >= 9 && k.category === "principle");
  const patterns = all.filter((k) => (k.importance || 0) >= 7 && k.category === "pattern");
  const phrases  = all.filter((k) => k.category === "phrase");

  const sections: string[] = [];
  if (diffLearned.length > 0) {
    sections.push("【🔴 AIが過去に間違えたパターン（最優先・必ず守る）】\n" + diffLearned.map((k) => `・${k.content}`).join("\n"));
  }
  if ((correctionPairs?.length ?? 0) > 0) {
    sections.push("【🟠 スタッフが修正したポイント（このフェーズ専用）】\n" + correctionPairs!.slice(0, 8).map((k) => `・${k.content}`).join("\n"));
  }
  if (critical.length > 0) {
    sections.push("【⚠️ 絶対ルール】\n" + critical.slice(0, 15).map((k) => `・${k.content}`).join("\n"));
  }
  if (patterns.length > 0) {
    sections.push("【スモラの営業パターン・原則】\n" + patterns.slice(0, 8).map((k) => `・${k.content}`).join("\n"));
  }
  if (phrases.length > 0) {
    sections.push("【スモラのフレーズ】\n" + phrases.slice(0, 6).map((k) => `「${k.content}」`).join("　"));
  }
  return sections.length > 0 ? "\n\n" + sections.join("\n\n") : "";
}

// ─── OpenAI 埋め込み生成（generate-reply 側）────────────────────────────────
async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

const ANGLE_LABEL: Record<string, string> = { A: "王道", B: "シンプル", C: "C案", short_direct: "短く直接" };

async function fetchExamples(state: string, customerMessage?: string, lastStaffMessage?: string, analysisContext?: string): Promise<string> {
  const stateAliases = STATE_SEARCH_ALIASES[state] || [state];

  // pgvector 類似検索（OPENAI_API_KEY がある場合のみ・エラー時はフォールバック）
  // follow-up時: 「スモラが送った内容の続き」として検索クエリを構成
  const baseQuery = lastStaffMessage
    ? `${state}: [前返信]${lastStaffMessage.slice(0, 100)} [顧客]${customerMessage}`
    : customerMessage ? `${state}: ${customerMessage}` : null;
  // 分析で検出したパターン（検討中・URL確認・複数質問等）をクエリに追加して関連例を引く
  const searchQuery = baseQuery && analysisContext
    ? `${baseQuery} パターン: ${analysisContext}`
    : baseQuery;

  if (searchQuery && process.env.OPENAI_API_KEY) {
    const embedding = await getEmbedding(searchQuery);
    if (embedding) {
      const { data: similar, error: rpcError } = await supabase.rpc("match_reply_examples", {
        query_embedding: embedding,
        match_count: 20,
        filter_states: stateAliases,
      }) as { data: Array<{ customer_message: string; sent_reply: string; conversation_state: string; is_starred: boolean; reply_angle: string | null; similarity: number }> | null; error: unknown };

      if (!rpcError && similar && similar.length > 0) {
        // 類似度0.5未満は低品質として除外
        const aboveThreshold = similar.filter(ex => ex.similarity >= 0.5);
        if (aboveThreshold.length > 0) {
        // ★+0.15 に加え、4案から選ばれた実例（reply_angle あり）は+0.1 追加ブースト
        const sorted = [...aboveThreshold].sort((a, b) => {
          const scoreA = a.similarity + (a.is_starred ? 0.15 : 0) + (a.reply_angle ? 0.1 : 0);
          const scoreB = b.similarity + (b.is_starred ? 0.15 : 0) + (b.reply_angle ? 0.1 : 0);
          return scoreB - scoreA;
        }).slice(0, 8);

        return "\n\n【⭐ スモラの実際の返信例（状況が最も類似した実例・類似度順）— 文体・言い回し・感嘆符・絵文字・長さをこの例から忠実に再現すること。これが最優先の文体基準。ラベル: 王道=標準スモラスタイル / シンプル=短く簡潔 / C案=別角度アプローチ】\n" +
          sorted.map((ex, i) => {
            const angleTag = ex.reply_angle && ex.reply_angle !== "starred" ? `|${ANGLE_LABEL[ex.reply_angle] ?? ex.reply_angle}` : "";
            return `[例${i + 1}${ex.is_starred ? "⭐" : ""}${angleTag}]\nお客様: 「${ex.customer_message}」\nスモラ: 「${ex.sent_reply}」`;
          }).join("\n\n");
        }
      }
    }
  }

  // フォールバック: 全件対象（☆優先・フェーズ一致優先）
  const [{ data: sameStateFull }, { data: allStateFull }] = await Promise.all([
    // 同フェーズ全件: ☆降順 → 新着順
    supabase.from("ai_reply_examples").select("customer_message, sent_reply, conversation_state, is_starred, reply_angle")
      .in("conversation_state", stateAliases)
      .not("embedding", "is", null)
      .order("is_starred", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(60),
    // 全フェーズ全件: ☆降順 → 新着順
    supabase.from("ai_reply_examples").select("customer_message, sent_reply, conversation_state, is_starred, reply_angle")
      .not("embedding", "is", null)
      .order("is_starred", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(120),
  ]);

  const sameStateList = sameStateFull || [];
  const allStateList = (allStateFull || []).filter(
    (ex) => !sameStateList.some((s) => s.sent_reply === ex.sent_reply)
  );

  const all = [
    ...sameStateList.slice(0, 6).map((ex) => ({ ...ex, priority: 1 })),
    ...allStateList.slice(0, 4).map((ex) => ({ ...ex, priority: 2 })),
  ].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.is_starred !== b.is_starred) return a.is_starred ? -1 : 1;
    return 0;
  }).slice(0, 8);

  if (all.length === 0) return "";

  return "\n\n【⭐ スモラの実際の返信例（☆をつけた良質な実例）— 文体・言い回し・感嘆符・絵文字・長さをこの例から忠実に再現すること。これが最優先の文体基準。ラベル: 王道=標準スモラスタイル / シンプル=短く簡潔 / C案=別角度アプローチ】\n" +
    all.map((ex, i) => {
      const ra = (ex as { reply_angle?: string | null }).reply_angle;
      const angleTag = ra && ra !== "starred" ? `|${ANGLE_LABEL[ra] ?? ra}` : "";
      return `[例${i + 1}${angleTag}]\nお客様: 「${ex.customer_message}」\nスモラ: 「${ex.sent_reply}」`;
    }).join("\n\n");
}

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  type RecentMessage = { sender: string; text: string; imageUrl?: string };
  let message: string, state: string, customerName: string, recentMessages: RecentMessage[], customerConditions: string, customerSummary: string;
  try {
    const body = await req.json() as {
      message: string;
      state: string;
      customerName?: string;
      recentMessages?: RecentMessage[];
      customerConditions?: string;
      customerSummary?: string;
    };
    message = body.message;
    state = body.state;
    customerName = body.customerName || "";
    recentMessages = body.recentMessages || [];
    customerConditions = body.customerConditions || "";
    customerSummary = body.customerSummary || "";
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  if (!message) return NextResponse.json({ ok: false, error: "message required" }, { status: 400 });

  // DBカスタムプロンプトを取得（失敗時はハードコード値にフォールバック）
  let promptOverrides: PromptOverrides | undefined;
  try {
    const { data: dbPrompts } = await supabase.from("ai_prompts").select("key, content");
    if (dbPrompts && dbPrompts.length > 0) {
      const phaseGuide: Record<string, string> = {};
      let generationSystem: string | undefined;
      let quickPatterns: string | undefined;
      let realEstateRules: string | undefined;
      for (const p of dbPrompts as { key: string; content: string }[]) {
        if (p.key === "generation_system") generationSystem = p.content;
        else if (p.key === "smora_quick_patterns") quickPatterns = p.content;
        else if (p.key === "real_estate_rules") realEstateRules = p.content;
        else if (p.key.startsWith("phase_guide_")) phaseGuide[p.key.slice("phase_guide_".length)] = p.content;
      }
      if (generationSystem || quickPatterns || realEstateRules || Object.keys(phaseGuide).length > 0) {
        promptOverrides = {
          generationSystem,
          quickPatterns,
          realEstateRules,
          phaseGuide: Object.keys(phaseGuide).length > 0 ? phaseGuide : undefined,
        };
      }
    }
  } catch { /* use hardcoded fallback */ }

  try {
    const currentState = normalizeState(state || "first_reply");

    // 画像送付を会話履歴に反映（[画像]をフィルタせず意味のあるラベルに変換）
    const history = recentMessages
      .slice(-25)
      .map((m, i, arr) => {
        const who = m.sender === "customer" ? "お客様" : "スモラ";
        const isImageMsg = m.text === "[画像]" || m.text === "[動画]" || (!m.text && !!m.imageUrl);

        if (isImageMsg) {
          if (m.sender === "customer") return `${who}: 【画像を送ってきた】`;
          // スタッフの画像: 前後3件のテキストで文脈を判定
          const nearbyMsgs = arr.slice(Math.max(0, i - 3), i + 2).filter((_, ni) => ni !== (Math.min(i, 3)));
          const nearby = nearbyMsgs.map((x) => x?.text || "").join(" ");
          if (/見積|初期費用/.test(nearby)) return `${who}: 【見積書を送付した】`;
          // 「確認します」→画像 の流れ → 空室確認済みとして扱う
          if (/確認|空室|空き|募集/.test(nearby)) return `${who}: 【空室確認済み・物件資料を送付した】`;
          if (/物件|お部屋|ピックアップ|間取り|アパート|マンション|資料/.test(nearby)) return `${who}: 【物件資料を送付した】`;
          return `${who}: 【物件資料・画像を送付した】`;
        }

        // テキスト + 画像が同一メッセージの場合
        if (m.imageUrl && m.text && m.text !== "[画像]") {
          const label = m.sender === "staff" ? "【物件資料を送付しながら】" : "";
          return `${who}: ${label}「${m.text}」`;
        }

        if (!m.text) return null;
        return `${who}: ${m.text}`;
      })
      .filter(Boolean)
      .join("\n");

    // follow-up検知（履歴末尾がスモラ = 2通目以降の生成）
    const allSpeakersInHistory = [...history.matchAll(/(?:^|\n)(スモラ|お客様):/g)];
    const isFollowUp = allSpeakersInHistory.length > 0 && allSpeakersInHistory[allSpeakersInHistory.length - 1][1] === "スモラ";

    // 最後のスモラメッセージを全文抽出（② の検索クエリ・① の表示用）
    const lastStaffMsgForSearch = (() => {
      const segments = history.split(/\n(?=スモラ:|お客様:)/);
      const seg = [...segments].reverse().find(s => s.startsWith("スモラ:"));
      return seg ? seg.replace(/^スモラ:\s*/, "").trim() : undefined;
    })();

    // ── Step1: 分析を先行実行（検出パターンを実例検索クエリに使うため）
    if (!process.env.OPENAI_API_KEY) {
      console.warn("[generate-reply] OPENAI_API_KEY not set — pgvector検索無効・フォールバック使用");
    }
    const analysis = await analyzeCustomerSituation(message, history, currentState, customerName, isFollowUp);

    // ── 分析結果からパターンキーワードを抽出（実例検索クエリ強化用）
    const analysisContext = (() => {
      try {
        const p = JSON.parse(analysis) as Record<string, unknown>;
        const parts: string[] = [];
        // 返し方の方針
        if (p.approach && typeof p.approach === "string") parts.push(p.approach.slice(0, 60));
        // 迷い・保留パターン → 検索に使うキーワード化
        const hp = p.hesitancy_pattern;
        if (hp === "thinking")  parts.push("検討します また連絡します ごゆっくり");
        else if (hp === "callback") parts.push("また連絡します 後でご連絡");
        else if (hp === "waiting")  parts.push("少し待ってほしい まだ決めていない キャンセル");
        else if (hp === "undecided") parts.push("どちらにするか迷っています 比較 判断軸");
        else if (hp === "timeline" && p.future_timeline) parts.push(String(p.future_timeline));
        // 複数質問
        if (Array.isArray(p.questions) && (p.questions as string[]).length > 0) {
          parts.push((p.questions as string[]).slice(0, 3).join(" "));
        }
        return parts.length > 0 ? parts.join(" ") : undefined;
      } catch { return undefined; }
    })();

    // ── Step2: 残りを並列実行（実例検索はパターンキーワード付きクエリで実行）
    const [detectedIntent, knowledge, examples, phrases, autoSummary] = await Promise.all([
      classifyIntent(message, currentState, history),
      fetchKnowledge(currentState),
      fetchExamples(currentState, message, isFollowUp ? lastStaffMsgForSearch : undefined, analysisContext),
      fetchPhrases(currentState),
      // ai_summaryがない場合のみ条件テキスト+履歴から即席合成（Haiku・並列なので遅延ゼロ）
      !customerSummary && customerConditions
        ? synthesizeCustomerContext(customerConditions, customerName, history)
        : Promise.resolve(""),
    ]);
    const resolvedSummary = customerSummary || autoSummary;

    // Sonnetでストリーミング生成
    const messages = buildGenerationMessages(
      message, customerName, history, currentState,
      analysis, knowledge, examples, phrases, customerConditions, resolvedSummary,
      promptOverrides, isFollowUp
    );
    const genStream = generationModel.stream(messages);

    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          // 1行目: メタデータJSON（フロントエンドがok確認に使用）
          controller.enqueue(encoder.encode(
            JSON.stringify({ ok: true, detected_intent: detectedIntent }) + "\n"
          ));
          try {
            for await (const chunk of await genStream) {
              const text = typeof chunk.content === "string" ? chunk.content : "";
              if (text) controller.enqueue(encoder.encode(text));
            }
          } catch (streamErr) {
            console.error("generate-reply stream error:", streamErr);
          }
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "返信生成エラー";
    console.error("generate-reply error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
