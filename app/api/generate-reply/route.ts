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
  temperature: 0.7,
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
  customerName: string
): Promise<string> {
  const prompt = `
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
  "tone": "適切なトーン（例：温かく・余裕を持って・軽く背中を押す）"
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
  first_reply: `▶ 今すべきこと: 挨拶 + 条件ヒアリング開始
初回例: 「〇〇さん初めまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！〇〇さんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます！！」
2回目以降: 「〇〇さん、お世話になっております😊！！」で始める
※ 担当者名は「鈴木」を使う
※ 条件フォームを送る場合: ①入居時期 ②家賃 ③間取り ④築年数 ⑤エリア・駅 ⑥駅徒歩 ⑦初期費用 ⑧その他 の形式で送る`,
  hearing: `▶ 会話の状況を判断して以下のパターンで対応する。

【パターンA】条件がまだ届いていない・「探してます」だけの段階
→ 挨拶 + 条件フォームを送る（①入居時期 ②家賃 ③間取り ④築年数 ⑤エリア・駅 ⑥駅徒歩 ⑦初期費用 ⑧その他 の形式）
例: 「〇〇さんお世話になっております！！お部屋探しのお手伝いさせて頂きます😊！！まずはご希望の条件を教えていただけますでしょうか！①入居時期 ②ご希望家賃 ③間取り...」

【パターンB】条件の一部しか届いていない・追加で確認が必要な段階
→ 受け取りに感謝 + 足りない条件を「1点だけ」確認する（複数聞かない）
例: 「〇〇さんありがとうございます！！ご希望エリアも教えていただけますでしょうか😊！！」

【パターンC】条件が十分に揃った・ピックアップできる段階
→ 感謝 + 受け取った条件を具体的に復唱（エリア・家賃・広さ・こだわり等を列挙） + 本日中にピックアップ宣言
例: 「〇〇さんありがとうございます！！〇〇エリア全域から〇〇さんご希望のご条件にあった管理費込み〇万以内・〇㎡・〇〇のお部屋ピックアップし本日中にお送りさせて頂きます😊！！」
※ 条件の復唱はオウム返しではなく「これだけ把握して動く」という安心感を与えるための確認

【パターンD】URLや物件名を送ってきた（空室確認・見積り依頼の段階）
→ 「はい！！」or「かしこまりました！！」+ 「募集状況確認させていただきます！確認出来次第ご連絡させていただきます！！」
→ 見積り依頼なら「最大限割引させていただいたお見積書作成させて頂きます！！少々お待ちください！」

※ 初回連絡なら「初めまして」、2回目以降は「お世話になっております」
※ 絶対に複数の質問を一度にしない（1点だけ）`,
  proposing: `▶ 会話の状況を判断して以下のパターンで対応する。

【パターンA】スタッフが既に物件画像・資料を送付済みの場合（履歴に「【物件資料を送付した】」「【物件資料・画像を送付した】」がある）
→ 画像をもう一度送ったり、物件情報を文章で紹介し直したりしない
→ お客様の反応・感想を受けて内覧/申込へ自然に誘導する
→ 「空室確認して画像を送った」流れなら「ご確認いただけましたでしょうか😊！！お気に召されましたらお申込みでお部屋を抑えさせて頂きます！！」などで締める

【パターンB】これから物件を紹介する場合（まだ画像を送っていない）
→ 物件紹介フォーマットで詳しく紹介：
🌟[物件名] [部屋番号]
・[間取り]（[㎡]）
・[築年]築
・管理費込み[金額]円
・[最寄り駅] 徒歩[分]分
・[特記事項]
[物件の魅力を数字で2〜3文]
[退去予定・申込促し・内覧案内で締める]

【パターンC】お客様がURLや物件名を送ってきた（空室確認・見積り依頼）
→ 「はい！！お送り頂きました物件の募集状況確認させていただきます😊！！確認出来次第ご連絡させていただきます！！」
→ もし募集終了だったことが履歴でわかれば「〇〇につきまして、募集終了となっておりました！！私の方で〇〇さんのご希望ご条件に近いお部屋をピックアップさせて頂きます😊！！」

【パターンD】お客様が謝罪・気を遣ってきた場合
→ 「全然です😊！！〇〇さんがご満足頂くお部屋でお引越し頂くのが1番ですので、気になる点出てきましたらいつでもお気軽にご連絡ください！！」

【パターンE】内覧後・次の物件を並行して探している場合
→ 「並行して〇〇さんのご希望条件に合うお部屋が新着で出次第随時お送りさせて頂きます😊！！〇〇さんご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！何卒よろしくお願い致します！！」

※ 退去予定物件は「〜退去予定のため、お気に召されましたらお申込みしてお部屋抑えさせていただきます😌！」と添える
※ 履歴を必ず確認してパターンA〜Eのどれかを正しく判断すること`,
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

【禁止ワード・パターン】
× 「承りました」「ご確認のほど」「確認中です」
× 「〇〇とのことですね」「〇〇をご希望ですね」（オウム返し）
× 「まず〜、次に〜」（列挙構成）
× 築浅・広い・駅近（曖昧表現）→ 2024年築・32㎡・本町駅徒歩5分（数字で）
× お客様名が「不明」の場合は名前を絶対に推測・創作しない → 名前なしで返信する
・初回挨拶など担当者名が必要な場合は 鈴木 と記載すること（スタッフが送信前に自分の名前に書き換える）
× 参考例に実在する会社名（蓮産業株式会社など）や担当者名が含まれていても絶対に引用しない

【会話履歴の読み方】
「スモラ:」= 自分の過去の返信 / 「お客様:」= お客様のメッセージ
【画像】スモラが物件資料・見積書を送付した場合はその旨が記録されている`;

// ─── フェーズ別スモラ返信パターン（buildGenerationMessages で注入）─────────
const SMORA_QUICK_PATTERNS = `
【スモラの実際の返信パターン（実例から抽出）】
・冒頭ルール（★重要）: 短い承認・単純な返答・事実回答 → 挨拶なしで「はい！！」か「かしこまりました！！」で直接始める。長い返信・重要な連絡・条件確認 → 「〇〇さんお世話になっております！！」か「〇〇さん夜分遅くに失礼致します！！」を使う
・冒頭（初回）: 「〇〇さん初めまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！〇〇さんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！」
・承認・了解（短い場合）: 「かしこまりました！！\n〇〇させて頂きます！！」（挨拶なしで即アクション）
・承認・了解（長い場合）: 「〇〇さんお世話になっております！！\nかしこまりました！！\n〇〇させて頂きます！！」
・条件受け取り（復唱あり）: 「〇〇さんありがとうございます！！〇〇エリア全域から〇〇さんご希望のご条件にあった管理費込み〇万以内・〇㎡・〇〇のお部屋ピックアップし本日中にお送りさせて頂きます😊！！」
・条件追加: 「ご条件追加頂きありがとうございます😊！そちらのエリアも含めて本日中にはご提案させて頂きます！引き続きよろしくお願いいたします😌！」
・URL・物件名受信→確認: 「はい！！お送り頂きました物件の募集状況確認させていただきます😊！！確認出来次第ご連絡させていただきます！！」
・見積り依頼受付: 「かしこまりました！！最大限割引させていただいたお見積書作成させて頂きます！！少々お待ちください！」
・募集終了→即代替: 「〇〇につきまして、募集終了となっておりました！！私の方で〇〇さんのご希望ご条件に近いお部屋をピックアップさせて頂きます😊！！」
・物件紹介の締め: 「お気に召されましたら、お申込みしてお部屋抑えさせていただきます😌！」
・並行してサポート継続: 「並行して〇〇さんのご希望条件に合うお部屋が新着で出次第随時お送りさせて頂きます😊！！〇〇さんご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！何卒よろしくお願い致します！！」
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
・保証会社交渉: 「別の保証会社での審査が可能か管理会社に交渉させて頂きます！！」
・初期費用内訳説明: 「最大限割引させていただいたお見積書となります😊！！〇〇さんお気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！」`.trim();

// ─── 不動産ルール（プロンプト管理UIから編集可能）────────────────────────────
const REAL_ESTATE_RULES = `【不動産・賃貸仲介のルール（質問されたら正確に答えること）】
・仲介手数料の相場: 一般的な不動産屋は家賃の0.5ヶ月〜1ヶ月分。スモラは一律2,980円・イエヤスとギガ賃貸は0円
・初期費用が安い理由: スモラ・イエヤス・ギガ賃貸は貸主（オーナー）から頂く広告料（AD）をお客様に還元しているため、仲介手数料を大幅に下げられる。一般的な不動産屋は貸主からADをもらいつつ借主からも仲介手数料を取る二重取り構造
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
・保証会社難易度: 信販系（エポス・オリコ等）は審査厳しめ。否決時は独立系保証会社への変更を交渉`.trim();

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
  promptOverrides?: PromptOverrides
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
    : jstHour >= 20
      ? `\n【⏰ 時刻ルール・最優先】現在${jstHour}時台（JST）。20時以降のため今回の冒頭は「〇〇さん夜分遅くに失礼致します！！」を使う。`
      : `\n【⏰ 時刻ルール・最優先】現在${jstHour}時台（JST）。今回の冒頭は「〇〇さんお世話になっております！！」を使う。「夜分遅くに失礼致します」は使用禁止。`;

  const managementNote = isWeekend
    ? `\n【管理会社の状況・必ず守ること】本日は土日のため管理会社はお休み。管理会社への確認が必要な場合は「管理会社が本日お休みのため、月曜日一番でご確認しご連絡させて頂きます！！」と伝える。当日中の回答を約束しない。`
    : jstHour >= 18
      ? `\n【管理会社の状況・必ず守ること】現在${jstHour}時台（JST）。18時以降のため管理会社の営業時間が終了している。確認が必要な場合は「本日は管理会社の営業時間が終了しておりますので、明日一番でご確認しご連絡させて頂きます！！」と伝える。当日中の回答を約束しない。`
      : `\n【管理会社の状況】現在${jstHour}時台（JST）。管理会社営業中（平日〜18時）。確認が必要な場合は「管理会社に確認させていただきます！！確認出来次第ご連絡させていただきます！！」と伝えてよい。`;

  const nameNote = customerName ? `お客様名：${customerName}さん` : "お客様名：不明";
  const conditionsNote = customerConditions
    ? `\n【お客様の希望条件（DB登録済み・必ず考慮すること）】\n${customerConditions}`
    : "";
  const summaryNote = customerSummary
    ? `\n【このお客さんの人物像・特徴（AI要約）— 文体・トーン・アプローチに必ず反映すること】\n${customerSummary}`
    : "";

  // フェーズ別の行動指針を取得（DBオーバーライド優先）
  const phaseGuide = promptOverrides?.phaseGuide?.[state] ?? PHASE_GUIDE[state] ?? PHASE_GUIDE["first_reply"];


  // 分析結果から方針のみ抽出
  let approachNote = "";
  if (analysis) {
    try {
      const p = JSON.parse(analysis) as Record<string, string>;
      if (p.approach) approachNote = `\n【今回の返し方】${p.approach}（トーン: ${p.tone || "自然に"}）`;
    } catch { /* ignore */ }
  }

  // スモラの直前返信を履歴から抽出（文脈の引き継ぎに使用）
  const lastStaffMsg = lastStaffLines.length > 0 ? lastStaffLines[lastStaffLines.length - 1].replace(/^スモラ:\s*/, "") : null;

  // 履歴の末尾がスモラのメッセージ = お客様がまだ返信していない = 「続きのメッセージ」を生成する状況
  // ※ マルチライン対応: 行分割すると途中行が「スモラ:」で始まらないため、正規表現で最後のスピーカーを判定
  const allSpeakers = [...history.matchAll(/(?:^|\n)(スモラ|お客様):/g)];
  const historyEndsWithStaff = allSpeakers.length > 0 && allSpeakers[allSpeakers.length - 1][1] === "スモラ";

  const staffContextNote = historyEndsWithStaff && lastStaffMsg
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
${nameNote}${conditionsNote}${summaryNote}${greetingNote}${managementNote}
【現在の営業フェーズ】${state}
${phaseGuide}${approachNote}${staffContextNote}

【直近の会話履歴（スモラ自身の返信も含む）】
${history || "なし"}
${quickPatterns}
${realEstateNote}
${knowledge}
${phrases}

${historyEndsWithStaff ? "【参考：お客様の直近メッセージ（既に返信済み）】" : "【お客様の最新メッセージ】"}
${customerMessage}

${examples}${examplesInstruction}

↑${historyEndsWithStaff ? "スモラは既にこのメッセージに返信済み。前の返信内容を繰り返さず、続きとして自然につながるメッセージを1つ生成すること。" : "スモラの直前返信の流れを踏まえ、⭐実例の文体・言い回しを最優先で忠実に再現しながら、このメッセージへのスモラらしい返信を1つ生成してください。"}
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
async function synthesizeCustomerContext(conditions: string, customerName: string): Promise<string> {
  try {
    const res = await analysisModel.invoke([
      new HumanMessage(`以下の賃貸希望条件を持つお客様の特徴を1〜2文で要約してください。
お客様名: ${customerName || "不明"}
条件:
${conditions}

例: 「梅田エリアで1LDK・家賃8万以内を探している。ペット可・駅徒歩5分希望。入居は4月予定」
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
  proposing:   ["proposing", "property_recommendation", "viewing", "estimate_request", "availability_check"],
  applying:    ["applying", "application", "screening", "contract"],
  closed_won:  ["closed_won"],
};

async function fetchKnowledge(state: string): Promise<string> {
  const stateAliases = STATE_SEARCH_ALIASES[state] || [state];

  const [{ data: diffLearned }, { data: correctionPairs }, { data: global }, { data: stateSpecific }] = await Promise.all([
    // ① 差分学習ルール [差分学習]: AIが間違えた → 正解のルール（最優先）
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .ilike("title", "%差分学習%").gte("importance", 9)
      .order("created_at", { ascending: false }).limit(20),
    // ② 修正対比ルール [修正対比]: スタッフがどう直したかのパターン（第2優先）
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .ilike("title", "%修正対比%").in("conversation_state", stateAliases)
      .order("importance", { ascending: false }).limit(10),
    // ③ 全体共通ナレッジ: importance8以上・抽象的なprincipleを除外
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .is("conversation_state", null).gte("importance", 8)
      .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
      .not("category", "eq", "principle")
      .order("importance", { ascending: false }).limit(12),
    // ④ state別ナレッジ: importance7以上・抽象的なprincipleを除外
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .in("conversation_state", stateAliases).gte("importance", 7)
      .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
      .not("category", "eq", "principle")
      .order("importance", { ascending: false }).limit(18),
  ]);

  const all = [...(stateSpecific || []), ...(global || [])];
  if ((diffLearned?.length ?? 0) === 0 && (correctionPairs?.length ?? 0) === 0 && all.length === 0) return "";

  const critical = all.filter((k) => (k.importance || 0) >= 9);
  const patterns = all.filter((k) => (k.importance || 0) >= 7 && (k.importance || 0) < 9 && (k.category === "pattern" || k.category === "principle"));
  const phrases  = all.filter((k) => k.category === "phrase");

  const sections: string[] = [];
  if ((diffLearned?.length ?? 0) > 0) {
    sections.push("【🔴 AIが過去に間違えたパターン（最優先・必ず守る）】\n" + diffLearned!.slice(0, 15).map((k) => `・${k.content}`).join("\n"));
  }
  if ((correctionPairs?.length ?? 0) > 0) {
    sections.push("【🟠 スタッフが修正したポイント（このフェーズ専用）】\n" + correctionPairs!.slice(0, 8).map((k) => `・${k.content}`).join("\n"));
  }
  if (critical.length > 0) {
    sections.push("【⚠️ 絶対ルール】\n" + critical.slice(0, 10).map((k) => `・${k.content}`).join("\n"));
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

async function fetchExamples(state: string, customerMessage?: string): Promise<string> {
  const stateAliases = STATE_SEARCH_ALIASES[state] || [state];

  // pgvector 類似検索（OPENAI_API_KEY がある場合のみ・エラー時はフォールバック）
  if (customerMessage && process.env.OPENAI_API_KEY) {
    const embedding = await getEmbedding(`${state}: ${customerMessage}`);
    if (embedding) {
      const { data: similar, error: rpcError } = await supabase.rpc("match_reply_examples", {
        query_embedding: embedding,
        match_count: 20,
        filter_states: stateAliases,
      }) as { data: Array<{ customer_message: string; sent_reply: string; conversation_state: string; is_starred: boolean; similarity: number }> | null; error: unknown };

      if (!rpcError && similar && similar.length > 0) {
        // ☆に+0.15のスコアブースト → 類似度が高ければ非☆でも上位に来る
        const sorted = [...similar].sort((a, b) => {
          const scoreA = a.similarity + (a.is_starred ? 0.15 : 0);
          const scoreB = b.similarity + (b.is_starred ? 0.15 : 0);
          return scoreB - scoreA;
        }).slice(0, 8);

        return "\n\n【⭐ スモラの実際の返信例（状況が最も類似した実例・類似度順）— 文体・言い回し・感嘆符・絵文字・長さをこの例から忠実に再現すること。これが最優先の文体基準】\n" +
          sorted.map((ex, i) =>
            `[例${i + 1}${ex.is_starred ? "⭐" : ""}]\nお客様: 「${ex.customer_message}」\nスモラ: 「${ex.sent_reply}」`
          ).join("\n\n");
      }
    }
  }

  // フォールバック: 全件対象（☆優先・フェーズ一致優先）
  const [{ data: sameStateFull }, { data: allStateFull }] = await Promise.all([
    // 同フェーズ全件: ☆降順 → 新着順
    supabase.from("ai_reply_examples").select("customer_message, sent_reply, conversation_state, is_starred")
      .in("conversation_state", stateAliases)
      .not("embedding", "is", null)
      .order("is_starred", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(60),
    // 全フェーズ全件: ☆降順 → 新着順
    supabase.from("ai_reply_examples").select("customer_message, sent_reply, conversation_state, is_starred")
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

  return "\n\n【⭐ スモラの実際の返信例（☆をつけた良質な実例）— 文体・言い回し・感嘆符・絵文字・長さをこの例から忠実に再現すること。これが最優先の文体基準】\n" +
    all.map((ex, i) =>
      `[例${i + 1}]\nお客様: 「${ex.customer_message}」\nスモラ: 「${ex.sent_reply}」`
    ).join("\n\n");
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

    // 並列実行: intent分類 + 状況分析 + 知識取得 + 実例取得 + フレーズ取得 + コンテキスト補完
    const [detectedIntent, analysis, knowledge, examples, phrases, autoSummary] = await Promise.all([
      classifyIntent(message, currentState, history),
      analyzeCustomerSituation(message, history, currentState, customerName),
      fetchKnowledge(currentState),
      fetchExamples(currentState, message),
      fetchPhrases(currentState),
      // ai_summaryがない場合のみ条件テキストから即席合成（Haiku・並列なので遅延ゼロ）
      !customerSummary && customerConditions
        ? synthesizeCustomerContext(customerConditions, customerName)
        : Promise.resolve(""),
    ]);
    const resolvedSummary = customerSummary || autoSummary;

    // Sonnetでストリーミング生成
    const messages = buildGenerationMessages(
      message, customerName, history, currentState,
      analysis, knowledge, examples, phrases, customerConditions, resolvedSummary,
      promptOverrides
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
