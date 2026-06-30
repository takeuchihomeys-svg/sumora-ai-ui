import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import {
  GENERATION_SYSTEM,
  SMORA_QUICK_PATTERNS,
  SMORA_RULES,
  REAL_ESTATE_RULES,
  REPLY_CONTENT_RULES,
  PHASE_GUIDE,
  AIX_PROPERTY_RECOMMENDATION_RULES,
  AIX_PROPERTY_SEND_RULES,
} from "@/app/lib/line-reply-prompts";

const PROMPT_DEFAULTS: Record<string, { label: string; content: string; readonly?: boolean; auto?: boolean; group?: string }> = {
  generation_system: {
    label: "生成システムプロンプト",
    content: GENERATION_SYSTEM,
  },
  phase_guide_first_reply: {
    label: "初回返信ガイド",
    content: PHASE_GUIDE.first_reply,
  },
  phase_guide_hearing: {
    label: "ヒアリングガイド",
    content: PHASE_GUIDE.hearing,
  },
  phase_guide_proposing: {
    label: "提案フェーズガイド",
    content: PHASE_GUIDE.proposing,
  },
  phase_guide_applying: {
    label: "申込フェーズガイド",
    content: PHASE_GUIDE.applying,
  },
  real_estate_rules: {
    label: "不動産ルール",
    content: REAL_ESTATE_RULES,
  },
  smora_rules: {
    label: "スモラルール",
    content: SMORA_RULES,
  },
  management_company_hours: {
    label: "管理会社の営業時間ルール",
    readonly: true,
    content: `【管理会社の営業時間ルール（コードで自動判定・変更はAIに依頼）】

■ 平日 〜18時（営業中）
→ 空室確認・問い合わせOK
→ 「管理会社に確認させていただきます！！確認出来次第ご連絡させていただきます！！」と伝えてよい

■ 平日 18時〜（営業時間終了）
→ 空室確認・問い合わせ・交渉NG
→ 「本日は管理会社の営業時間が終了しておりますので、明日一番でご確認しご連絡させて頂きます！！」

■ 土日（お休み）
→ 空室確認のみOK（募集状況確認は可能）
→ 「確認させていただきます！確認出来次第ご連絡させていただきます！！」と伝えてよい
→ 交渉（フリーレント・値引き・条件変更・審査再挑戦等）はNG
→ 「月曜日一番で管理会社に交渉させていただきます！！」`,
  },
  template_adapt_rules: {
    label: "テンプレートAI最適化ルール",
    content: `【テンプレートAI最適化の追加ルール】

■ プレースホルダー置換
・「アカウント名」→ お客様の名前＋「さん」
・「マンション名」「物件名」「〇〇マンション」→ 会話・予約送信から読み取った実際の物件名
・「○月○日」「〇〇円」「〇〇分」→ 実際の値（情報がない場合は「〇〇」のまま残す）
・テンプレートに前回の物件名が残っている場合は今回の物件名に必ず置き換える

■ 訴求の具体化
・「条件が良いお部屋」「オススメポイント」→ 家賃・間取り・設備等の具体的な数字に書き換える
・「ご予算内」「ご上限に近い家賃」→ 実際の家賃金額に書き換える

■ 絶対禁止
・設備（Wi-Fi・エアコン等）を「月額○円お得」のような金額換算で表現しない
・謝罪表現（「申し訳ございません」「失礼いたしました」）は使わない
・テンプレートにない全く新しい段落・話題を追加しない
・でたらめな数値・架空の駅名・前回の物件名をそのまま使わない`,
  },
  reply_content_rules: {
    label: "返信ルール（内容について）",
    content: REPLY_CONTENT_RULES,
  },
  aix_logic_estimate_sheet: {
    label: "見積書送る",
    group: "aix_logic",
    content: `【AIX「見積書送る」の発動条件】

■ 発動するキーワード・状況
・「初期費用」「見積もり」「見積書」「費用」「いくら」「いくらですか」
・「出して欲しい」「送って欲しい」＋入居日の指定（例：「7/30入居で出して欲しい」）
・他社と比較中・競合他社の費用を聞かれた時
・見積書を受け取った後に入居日を変えて再送依頼が来た時

■ 発動しないケース
・単純に「家賃はいくら？」と聞かれた場合 → 不動産ルールで答えるだけ
・既に見積書を送った後に「ありがとうございます」など反応が来た場合 → 申込誘導`,
  },
  aix_logic_property_send: {
    label: "物件送る",
    group: "aix_logic",
    content: `【AIX「物件送る」の発動条件】

■ 発動するキーワード・状況
・「物件」「部屋」「お部屋」「探して」「紹介して」「ピックアップ」
・条件（エリア・家賃・間取り等）が揃った・条件ヒアリング完了後
・「他にいい物件ありますか」「別の物件を」
・スタッフの最後の送信から3日以上返信なし（追客タイミング）
・お客様から物件希望・条件変更が来た時

■ 発動しないケース
・物件URLをお客様が送ってきた場合 → 「物件確認した」を使う
・見積書を要求された場合 → 「見積書送る」を使う`,
  },
  aix_logic_property_check: {
    label: "物件確認した",
    group: "aix_logic",
    content: `【AIX「物件確認した」の発動条件】

■ 発動するキーワード・状況
・お客様が物件URL（athome・suumo・homes等）を送ってきた
・「この物件どうですか」「まだありますか」「空いていますか」「空室ですか」
・お客様が物件画像・動画を送ってきた
・「空室確認」「募集状況確認」を依頼された

■ 発動しないケース
・スタッフが物件URLを送った場合（スタッフ側の送信）
・既に空室確認済みで回答した後`,
  },
  aix_logic_viewing_invite: {
    label: "内覧へ！",
    group: "aix_logic",
    content: `【AIX「内覧へ！」の発動条件】

■ 発動するキーワード・状況
・「内覧」「見に行く」「見学」「案内」「見てみたい」
・物件の詳細・設備について具体的に質問してきた（興味あり）
・「いつ見れますか」「いつ行けますか」

■ 発動しないケース
・内覧日時が既に確定している場合 → 「待ち合わせ」を使う
・内覧後のお客様 → 「申込へ！」を使う`,
  },
  aix_logic_application_push: {
    label: "申込へ！",
    group: "aix_logic",
    content: `【AIX「申込へ！」の発動条件】

■ 発動するキーワード・状況
・内覧後のお客様が感想・反応を示した時
・「申込みたい」「お願いします」「進めたい」「決めます」
・「キャンセルできますか」「キャンセル料は」（→ キャンセル無料を伝えながら申込促し）
・「検討します」が来た後の返し

■ 発動しないケース
・まだ物件を見ていない・内覧前の段階`,
  },
  aix_logic_meeting_place: {
    label: "待ち合わせ",
    group: "aix_logic",
    content: `【AIX「待ち合わせ」の発動条件】

■ 発動するキーワード・状況
・内覧日時が確定した（日付・時間が決まった）
・「〇月〇日〇時でお願いします」「その日時で大丈夫です」
・「どこで待ち合わせ」「どこに行けばいいですか」

■ 発動しないケース
・「入居で出してほしい」など入居日指定の見積書依頼 → 「見積書送る」を使う（誤検知注意）
・まだ日時が決まっていない内覧希望 → 「内覧へ！」を使う`,
  },
  aix_logic_property_recommendation: {
    label: "物件オススメ",
    group: "aix_logic",
    content: `【AIX「物件オススメ」の発動条件】

■ 発動するキーワード・状況
・条件ヒアリングが完了した直後（エリア・家賃・間取り等が揃った）
・お客様から代替物件を求められた（物件なかった後）
・「他の物件も見せて欲しい」「もっとオススメを」
・物件確認した後（空室あり）にオススメ文を添えて送る時

■ 代替物件の場合（2ボタン誘導）
・複数物件を送る → 「物件送る」を選択
・1件のみオススメする → 「物件オススメ」を選択`,
  },
  customer_summary_system: {
    label: "顧客サマリー（どうやったら決まるか）",
    group: "customer_summary",
    content: `あなたは賃貸仲介の営業アシスタントです。
担当者がLINEを送る直前に確認する「このお客さんの特徴まとめ」を作成してください。

ルール：
・4〜6項目の箇条書き（「・」で始める）
・条件の羅列は禁止（エリア・家賃・間取り等はすでに画面表示済み）
・必ず以下の2つをカバーする：
  ①お客さんの性格・タイプ・感情状態・営業上のヒント（条件ではなく人物像）
  ②【決まるパターン認識】会話・状況を読んで「今どうすれば成約に繋がるか」を1行で書く
・前回の要約がある場合は、変わっていない情報はそのまま維持し、変化した部分のみ更新すること
・入力にない情報は書かない
・各項目は1行以内で簡潔に
・**（アスタリスク2つの太字）・# 見出し・_イタリック_ 等のmarkdown記法は絶対に使わない
・「・」での箇条書きと「★決まるパターン: 〜」の形式だけを使うこと

【★どうやったら決まるか — 必ずどれか1つを選んで「★決まるパターン: 〜」の形で書く】
・条件が絞られていて合う物件がまだない → 「★決まるパターン: 条件に合う1件を出せば申込む。物件探しが鍵」
・気に入った物件があって内覧前 → 「★決まるパターン: 内覧に誘えば決まる。日程提案が最優先」
・物件は気に入っているが迷っている → 「★決まるパターン: 申込みでお部屋を抑えるよう促せば動く」
・交渉が失敗した直後・NGが出た → 「★決まるパターン: 別物件の内覧に誘導すればリカバリーできる」
・申込み済みで書類待ち → 「★決まるパターン: 書類（身分証・緊急連絡先）を揃えれば次に進む」
・物件送付後まだ反応が薄い → 「★決まるパターン: 追客LINEを送って反応を確認する」
・条件が厳しくて物件がない → 「★決まるパターン: 条件緩和を提案して再ピックアップが鍵」
・内覧済みで申込み前 → 「★決まるパターン: 今すぐ申込みを促せば決まる」`,
  },
  aix_flow_guide: {
    label: "AIXフロー誘導ガイド",
    auto: true,
    content: `【AIXフロー誘導ガイド — AIが毎日15:00・03:00に成功会話を分析して自動更新】

▶ 条件ヒアリング完了後
→「物件オススメ」AIX を使う
→ 物件資料と一緒にAIが提案文を生成。送信前に確認してから送る

▶ お客様から「初期費用は？」「見積もりが欲しい」が来た / 他社と比較中
→「見積書送る」AIX を使う
→ テンプレートから「見積書送る【AIX】」を選択 → AIが文章生成 → 見積書と一緒に送信

▶ 物件を気に入った / 内覧を促したい
→「内覧へ！」AIX を使う
→ カレンダーで日程選択 → AIが日程提案文を生成 → 確認後送信

▶ 内覧確定後（待ち合わせ場所を案内する）
→「待ち合わせ」AIX を使う
→ 物件住所を自動読み取り → 日時・場所をセットで案内文生成

▶ 内覧後・申込を促したい
→「申込へ！」AIX を使う
→ 会話の流れから最適な申込促しを生成 → 確認後送信

【バナーが出たら即AIXを使う】
・オレンジバナー（初期費用）→ 見積書送るAIX
・紫バナー（物件オススメ）→ 物件オススメAIX
・申込フォームバナー（ピンク）→ 長押し「申込」ボタンで学習記録

【半自動3ステップ】
AIXを選ぶ → 生成された文を確認 → 送信`,
  },
  smora_quick_patterns: {
    label: "スモラ返信パターン集",
    content: SMORA_QUICK_PATTERNS,
  },
  aix_property_recommendation_rules: {
    label: "物件オススメ 絶対禁止ルール【AIX共通】",
    group: "aix_logic",
    content: AIX_PROPERTY_RECOMMENDATION_RULES,
  },
  aix_property_send_rules: {
    label: "物件送る 絶対禁止ルール【AIX共通】",
    group: "aix_logic",
    content: AIX_PROPERTY_SEND_RULES,
  },
};

type PromptRow = { key: string; label: string; content: string; updated_at: string };

// GET: 全プロンプトを取得（DBにあればカスタム値、なければデフォルト）
export async function GET() {
  const [{ data }, { count: knowledgeCount }] = await Promise.all([
    supabase.from("ai_prompts").select("key, label, content, updated_at"),
    supabase.from("ai_reply_knowledge").select("*", { count: "exact", head: true }),
  ]);

  const dbMap: Record<string, PromptRow> = {};
  for (const row of (data || []) as PromptRow[]) {
    dbMap[row.key] = row;
  }

  const prompts = Object.entries(PROMPT_DEFAULTS).map(([key, defaults]) => ({
    key,
    label: defaults.label,
    content: dbMap[key]?.content ?? defaults.content,
    updated_at: dbMap[key]?.updated_at ?? null,
    is_custom: !!dbMap[key],
    readonly: defaults.readonly ?? false,
    auto: defaults.auto ?? false,
    group: defaults.group ?? null,
  }));

  return NextResponse.json({ prompts, knowledgeCount: knowledgeCount ?? 0 });
}

// PATCH: プロンプトを保存（upsert）
export async function PATCH(req: NextRequest) {
  const body = await req.json() as { key?: string; content?: string };
  const { key, content } = body;
  if (!key || content === undefined) return NextResponse.json({ ok: false, error: "key and content required" }, { status: 400 });
  if (!(key in PROMPT_DEFAULTS)) return NextResponse.json({ ok: false, error: "unknown key" }, { status: 400 });
  if (PROMPT_DEFAULTS[key].readonly) return NextResponse.json({ ok: false, error: "readonly" }, { status: 403 });

  const label = PROMPT_DEFAULTS[key].label;
  const { error } = await supabase.from("ai_prompts").upsert({
    key, label, content, updated_at: new Date().toISOString(),
  }, { onConflict: "key" });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// DELETE: プロンプトをデフォルトにリセット（DBレコードを削除）
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");
  if (!key) return NextResponse.json({ ok: false, error: "key required" }, { status: 400 });

  const { error } = await supabase.from("ai_prompts").delete().eq("key", key);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
