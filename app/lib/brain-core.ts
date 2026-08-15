import Anthropic from "@anthropic-ai/sdk";
import { after } from "next/server";
import { supabase } from "@/app/lib/supabase";

// ── brain-core: 脳分析の単一実装（single writer）─────────────────────────────
// これまで brain/list と cron/brain-weekly に約250行が copy-paste され、
// 線引きルールのヒューリスティック等が乖離していた。本モジュールが唯一の実装。
//
// 呼び出し元:
//   - line-webhook: 顧客メッセージ受信時（suggested_aix_meta を null に消すのと同じ場所で
//     after() から analyzeAndSaveBrainMeta を fire-and-forget 起動 = イベント駆動再計算）
//   - cron/brain-sweep: webhook の分析が失敗した会話を拾うバックストップ（5分毎）
//   - brain/list は純粋な read のみ（Haiku は一切呼ばない）

const HAIKU = "claude-haiku-4-5-20251001";
// B8(Fable5): maxRetries: 0 — sweep自体がリトライ機構のため、SDKの自動リトライ（デフォルト2回）は
// 最悪 ~45秒/件 × 4件直列 = maxDuration 120秒超過 → cron_run_logs が "running" のまま残る事故の原因だった
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 15_000, maxRetries: 0 });

// Statuses that indicate a closed/inactive conversation — excluded from brain analysis
export const BRAIN_SKIP_STATUSES = ["contract", "closed_won", "closed_lost", "lost"];

// Conversations updated within this window are flagged as urgent
export const URGENT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

export type SuggestedAixMeta = {
  action: string;
  note: string;
  source: string;
  enforcement_level: "required" | "recommended";
  closing_strategy?: string;
  template_hint?: string;  // 次に送るべき【AIX】テンプレートのラベル名（DBのtemplatesテーブルから選ぶ。例: "1件特にオススメ", "【申込誘導】", "②申込時フォーマット（続き）"）
  next_steps?: string[];  // ["Step1: 具体的アクション", "Step2: AIXボタン○○を押す", "Step3: 【AIX】○○テンプレートを送る"]
  reply_mode?: "aix" | "auto_reply";  // 'aix'=スタッフがAIXで手動対応 / 'auto_reply'=AI自動返信OK
  // Chrome拡張フィードバックループ用: 拡張が brain/list API 経由で取得し検索フォームに自動入力する
  property_search_params?: {
    area: string | null;
    floor_plan: string | null;
    rent_max: number | null;
    walk_minutes: number | null;
    move_in_time: string | null;
    preferences: string | null;
    ng_points: string | null;
    ng_properties: Array<{ property_name: string; room_no: string }>;
    search_urgency: string; // "★★★" | "★★" | "★" | "─"
  } | null;
} | null;

// Canonical mapping from AIX action key → staff guidance note
// Keys must match AIX_ACTION_META keys in page.tsx
const AIX_BRAIN_NOTES: Record<string, string> = {
  viewing_invite:          "内覧日程の候補を提示してください → AIX【内覧日調整】で日時を選択して送信してください",
  property_send:           "物件URLが揃ったら → AIX【物件ピックアップした】でカバーメッセージを生成して一緒に送ってください",
  estimate_sheet:          "見積書が届いたら → AIX【見積書送る】で読み取って自動計算＋カバーメッセージを生成できます",
  application_push:        "AIX【申込へ！】でクロージングメッセージを生成できます",
  condition_hearing:       "AIX【条件ヒアリング】ボタンで既知情報をスキップした形式で送れます",
  acknowledge_check:       "送信後 → AIX【確認します】で管理会社への空室確認＋見積書依頼を送ってください（宛先は管理会社です）",
  followup_revive:         "AIX【追客する】で再接触メッセージを生成できます",
  property_check_result:   "管理会社から返答が来たら → AIX【物件確認した（募集状況）】で結果報告文を生成してください",
  property_recommendation: "お客様の条件に最も合う1件を特にオススメとしてAIX【物件オススメ】で提案してください",
  meeting_place:           "内覧の日時・物件が確定したら → AIX【待ち合わせ】で待ち合わせ場所の案内を送ってください",
  greeting_viewing:        "内覧前後の挨拶は → AIX【内覧挨拶】でシーンに合わせた挨拶メッセージを生成できます",
  // ※ STATUS_MEANING にも会話ステータスとして property_search が存在するが、これは意図的な同名
  //   （ステータス=条件ヒアリング段階 / アクション=拡張ツールでの物件検索実行）。混同注意。
  //   このキーを提案として活かすには page.tsx の AIX_ACTION_META にも同キーの追加が必要（TODO）。
  property_search:         "お客さんの条件に合う物件をChrome拡張ツール（リアプロ/itandi/レインズ）で検索してください。送付済み物件は候補から除外すること",
};

// Maps raw DB conversation status to a Japanese meaning string injected into the Haiku prompt
const STATUS_MEANING: Record<string, string> = {
  first_reply:             "完全初回（はじめてのお客様・挨拶必須）",
  hearing:                 "条件ヒアリング段階（物件未提案・条件確認中）",
  condition_hearing:       "条件ヒアリング段階（物件未提案・条件確認中）",
  property_search:         "条件ヒアリング段階（物件未提案・条件確認中）",
  proposing:               "物件提案中（物件を送った後・内覧調整段階）",
  property_recommendation: "物件提案中（物件を送った後・内覧調整段階）",
  viewing:                 "物件提案中（内覧調整段階）",
  estimate_request:        "物件提案中（見積書依頼段階）",
  availability_check:      "物件提案中（空室確認段階）",
  applying:                "申込・審査中（クロージング段階）",
  application:             "申込・審査中（申込書類収集段階）",
  screening:               "申込・審査中（審査進行中）",
  contract:                "契約済み（成約完了）",
};

// Concise AIX capability summary injected into Haiku prompts for action/template reasoning
const AIX_CAPABILITY_MAP = `
【AIXボタン能力マップ】
- viewing_invite: 内覧日程の候補をLINEで提案するメッセージを生成
- property_send: 物件ピックアップのカバーメッセージを生成（物件URL送信時）→ 複数件ピックアップ後は必ず1〜2分以内（実測38秒／58秒）に「物件ピックアップ紹介（後続）」を、駅指定・条件外れ告知ありなら「駅周辺物件ピックアップ（後続）」（実測1分33秒）をAI最適化して自発送信する
- estimate_sheet: 見積書を読み取り自動計算+カバーメッセージ生成 → 送付直後（同分〜1分以内）に「【申込誘導】」テンプレートで申込を促す（use_count:10・見積書→申込誘導→申込の3ステップが成約最短ルート）
- application_push: 申込クロージングメッセージ（①申込時フォーマット本体）を生成 → 送信直後（実測32秒〜4分48秒）に「②申込時フォーマット（続き）」を一字一句そのまま自発送信する（AI最適化禁止）
- condition_hearing: 既知条件をスキップした条件ヒアリングを生成
- acknowledge_check: 管理会社への空室確認+見積書依頼を生成
- followup_revive: 追客・再接触メッセージを生成
- property_check_result: 空室確認結果の報告文を生成 → 2番手での申込が可能と判明した場合は+1分30秒で「（2番手・申込）」を顧客名の置換のみで自発送信する
- property_recommendation: Vision読み取りで物件紹介文を生成（1件詳細）→ 押下後は「1件特にオススメ」で感情的フォローを追加する（実測1分22秒。原文そのままの送信実績はゼロなので"1件に絞って推す"思想のみ流用し全面リライトする）
- meeting_place: 内覧の待ち合わせ場所案内を生成
- greeting_viewing: 内覧前後の挨拶メッセージを生成
- property_search: お客さんの条件に合う物件を拡張ツールで検索する（適用条件: 最終物件送付から7日以上経過、または送付件数0件。next_steps例:「リアプロ/itandiでエリア×間取りを検索」「家賃上限以下・駅徒歩条件で絞り込み」「検索結果から送付済み物件を除いて候補をピックアップ」）
`.trim();

// 返信文体・共感フレーズ・条件変更文脈の恒久ルール（generate-reply の同名ルールと同一の単一基準）
// closing_strategy / next_steps / template_hint がこのルールに反する提案を出さないようにするための静的ブロック。
const REPLY_STYLE_RULES = `
【返信スタイルの恒久ルール（closing_strategy・next_steps の内容もこれに従うこと）】
■ 冒頭挨拶（許可されるのはこの3つのみ）
- 「〇〇さん、お世話になっております！！」（標準・迷ったらこれ）
- 「〇〇さん、お待たせ致しました！！」（お待たせした後・物件や資料をお送りする時）
- 「〇〇さん、いつもありがとうございます！！」（継続的なやりとりで感謝が自然な文脈のみ）
- 完全初回（first_reply）のみ「〇〇さん、はじめまして😊！！…お部屋探しを担当させて頂きます鈴木と申します！！」
- 「ありがとうございます」だけを挨拶代わりの書き出しにするのは禁止。「夜分遅くに失礼致します」は返信時は禁止

■ 共感フレーズの使い分け（AIが最も間違えるポイント）
- 「全然大丈夫です」→ 使ってOK。顧客が「すみません」「申し訳ない」等と恐縮している場合に使う
- 「全然わがままじゃないですよ」「わがままじゃないです」等『わがまま』を含むフレーズ → 顧客自身が「わがままですみません」等と『わがまま』というワードを使った場合のみ使用可。顧客が言っていない場合は絶対に使わない
- どちらにも当てはまらない場合は共感フレーズを入れず、行動宣言に直行する

■ 条件変更・新条件文脈（顧客が「〇〇の条件の部屋はありますか？」「〇〇でも大丈夫です」等の新条件・要望を出した場合）
- 返信の型: 挨拶 →（該当時のみ共感）→ 条件を理解した旨 → 物件ピックアップの行動宣言 → 満足いくお部屋が見つかるまでサポートする旨
- 【絶対NG】この場面で申込フォーマット・見積書・ヒアリングフォーム等のフォーマット送付／申込誘導CTAを提案すること。aix・template_hint・next_steps にも申込/見積書系を選ばない（正しくは property_search / property_send 方向）

■ 募集状況確認の文脈（property_check_result / acknowledge_check フェーズ）
- 該当する場面: 顧客が物件URL・物件名・物件資料を送ってきた／「この物件は？」「空きありますか？」「まだ募集中ですか？」等で募集状況を尋ねた段階
- この段階では「空いているかどうか」がまだ管理会社に確認できていない。確認して初めて次（内覧・申込）の話になる
- 返信の型（この4ステップで完結・余分なフレーズを足さない）: ① 挨拶 → ② 物件の募集状況を確認する旨 → ③ 確認でき次第ご連絡する旨 → ④ 終わり
- 【絶対NG】この段階で内覧誘導を含めること。「お気に召されましたら」「ご都合よろしいお日にちに」「ご案内させて頂きます」等の内覧誘導フレーズ・内覧日程の提案・申込誘導は返信文にも closing_strategy / next_steps / template_hint にも入れない
- 【絶対NG】未確認の空室状況・退去日・入居可能日を断言すること
- 内覧・申込の提案は募集状況（空き）が確認できた後（property_check_result で結果を報告した後）に初めて行う

■ AIがやりがちなNG（提案文にも含めない）
- 顧客が言っていない言葉（「わがまま」等）を勝手に使う
- 文脈に合わない共感フレーズを挿入する
- 物件探し文脈で申込・フォーマット関連のCTAを入れる
- 募集状況が未確認の段階で内覧誘導フレーズを付ける（「確認して連絡する」で完結させる）
`.trim();

// 実態ベースのフェーズ別推奨テンプレートマップ
// 母集団: closed_won 13会話 / うちAIX使用5会話 / 検出された自発送信14件（顧客返信ゼロでのstaff手動送信）の実測。
// AIXボタン操作は「前半: 成果物配達（AIX自動送信）」と
// 「後半: 締めの1通（スタッフ自発送信テンプレート）」の2フェーズで1セット。後半が成約率に直結する。
// ★use_count を推奨順位に使わないこと: インクリメント経路は page.tsx:4384（TemplateModalから選択して送信）と
//   page.tsx:9323（AIX動線でモーダル経由）の2つだけで、コピペ・手打ち送信は一切カウントされない。
//   実際に成約会話で使われた3本は全て use_count=0。use_count は「モーダル利用率」であって成約寄与ではない。
const PHASE_TEMPLATE_HINTS = `
【AIXボタン後に送るべきテンプレート（template_hint の選び方）】
※運用は2フェーズ1セット: AIXボタン＝成果物配達 → 中央値1分20秒後にテンプレ追撃（顧客返信を待たない・14件中10件が2分以内）。AIXを使用した5会話すべてこの構造（closed_won 13件中3件はAIX未使用で成約＝AIXは成約の必要条件ではない）。
※これは「顧客の無反応を見て追撃した」のではなく、AIXボタン押下と同一オペレーションの一部として締めの1通を手で足す動作。
※追撃には2種類ある: 「AI最適化して送る」（物件事実を含むテンプレ）と「そのまま送る」（定型追撃・編集すると1分以内の追撃速度が落ちる）。必ず区別すること。
- property_send（複数件ピックアップ後）→ 「物件ピックアップ紹介（後続）」。実測38秒／58秒で顧客返信なしに自発送信。AI最適化必須: 顧客名＋条件スロットに主訴（初期費用を抑えたい・審査が不安 等）を意味置換して差し込む
- property_send（駅指定・希望条件から外れる旨の告知あり）→ 「駅周辺物件ピックアップ（後続）」。実測1分33秒。AI最適化必須: 駅名置換＋「〜のみの募集となります」の断定化リライト
- property_send（ピックアップ全件が即入居可能）→ 「【全件案内可能】」相当文。「審査通過次第ご入居可能」の一括保証でAIXが残した唯一の不安（いつ入れるか）を潰す。実測8分56秒→顧客が2分45秒で物件確定した最強事例あり（原文一致なしの手打ちのため骨格のみ流用）
- property_recommendation（1件詳細）→ 「1件特にオススメ」。実測1分22秒。※原文そのままの送信実績はゼロ。1件に絞って感情的に推す"思想"だけを流用し全面リライトすること
- estimate_sheet（見積書送付直後・同分〜1分以内が必須）→ 「【申込誘導】」。実測33秒／1分06秒。AI最適化必須: 物件名・号室を文中に溶かす（「〇〇901号室の最大限割引させていただいたお見積書をお送りさせて頂きました」）。顧客の申込まで最短2分の実証あり
- application_push で①申込時フォーマット本体を送った直後 → 「②申込時フォーマット（続き）」。実測32秒〜4分48秒。★一字一句そのまま送る（AI最適化禁止）。トリガーは顧客の申込意思表示ではなく「①を送ったこと」そのもの（意思表示は数時間前にあることが多い）。2会話2/2で申込情報の全項目を回収した唯一の再現性100%テンプレ
- property_check_result（2番手での申込が可能と判明）→ 「（2番手・申込）」。実測1分29秒・顧客名の置換のみ。AIXが別物件の見積を送っていても社内進捗（2番手確保済み）を差し込むと顧客の関心が戻り内覧アポに転換する
- 条件ヒアリングAIX後 → 「ヒアリング締め」／「物件探しテンプレート【続き】」。実測1分17秒でそのまま送る（顧客名と関係性の文脈だけ補正）
- viewing_invite / meeting_place（内見確定文）→ 追撃テンプレなし（顧客返信を待つ）。自発送信14件中0件。AIX本文は日時・物件・住所の1対1置換のみ
- 条件に合う物件が現状ゼロ → 「【物件なし】条件変更のご提案」
- 同棲・カップル向けの新着1件 → 「【同棲・カップル向け広め】新着オススメ」
- 該当テンプレが存在しない3型（①申込完了の進捗報告 ②見積送付の報告 ③即入居可の一括保証）は全面手打ちでよい。自発送信14件中5件がこれ。無理に既存テンプレへ寄せないこと

【AI最適化（TemplateModalの「AI最適化」ボタン）を通す / 絶対に通さない】
- 通す（物件事実系）: 「物件ピックアップ紹介（後続）」「駅周辺物件ピックアップ（後続）」「1件特にオススメ」「【申込誘導】」「【全件案内可能】」
  → 原文に「〇〇さん」「アカウント名さん」「〇〇駅」等のプレースホルダーが残っており、そのまま送ると顧客に生で飛ぶ事故になる
- 通さない（定型追撃系）: 「②申込時フォーマット（続き）」「ヒアリング締め」「（2番手・申込）」
  → 特に「②申込時フォーマット（続き）」はAI最適化を通すと本文が壊れる。generate-reply のテンプレート最適化プロンプトに
    「『お申込フォーマット』『ご本人確認書類』を含む文は出力禁止」という強制置換ゲートがあり、
    このテンプレの中核（本人確認書類の写真依頼）が削除される。文体の好みではなくコード上必須の回避策。

【template_hint に選んではいけないテンプレート】
- 本文に顧客実名・物件名が焼き込まれている10件（他顧客への誤送信事故になるためDBクリーンアップ完了まで禁止）:
  「【新着】」（🐈‍⬛さん）/ YUMAさん / mai.tさん / Mさん / 𝚂𝚊𝚗𝚊.さん / ニアさん / 夏奈さん（レジュールアッシュ梅田AXIA）/ サムティ町合能越寺803号室 / コーポまえだ303号室 / アドバンス難波ラシュレ を含むもの
- 文体が別人格のもの（✅🙏を多用する箇条書き調）
※ use_count が 0 であることは除外理由にならない。成約会話で実際に使われた「物件ピックアップ紹介（後続）」「駅周辺物件ピックアップ（後続）」「（2番手・申込）」はいずれも use_count 0（モーダルを通さず手打ちで送られたため計上されていないだけ）。逆に use_count 96 の「1件特にオススメ」は成約会話の自発送信で一度も原文送信されていない。
`.trim();

// ① 成約・申込到達ステータス（brainが成功事例として読む対象）
// applying は line-webhook が申込フォーム検知で自動セットする機械検証済みシグナル。
// application/screening/contract は旧データの後方互換エイリアス（auto-seiyaku と同一集合 + closed_won）
const SUCCESS_EXAMPLE_STATUSES = ["closed_won", "applying", "application", "screening", "contract"];

// ── 自発送信の決定論的検出 ───────────────────────────────────────────────────
// 「自発送信」= AIXボタン押下後、顧客の返信を待たずにスタッフが手で足した締めの1通。
// 検出定義（成約会話14件の実測に使ったものと同一）:
//   顧客メッセージで区切った staff 連続ブロック内で、
//   is_aix_generated=true の最終メッセージより後にある is_aix_generated=false の staff メッセージ。
// これまで analyze-applying は [AIX]/[スタッフ] ラベルをLLMに渡して推測させていたが、
// is_aix_generated から機械的に確定できるためLLMに確定リストとして渡す（推測をやめさせる）。
export type SelfInitiatedSend = {
  text: string;
  created_at: string | null;
  /** 同一staffブロック内の直前AIXメッセージからの経過秒（実測の中央値は約80秒・14件中10件が120秒以内） */
  seconds_after_aix: number | null;
  /** その直前AIXメッセージの本文（先頭120字。どのAIXボタンへの追撃かを判定する材料） */
  aix_source_text: string;
};

export function extractSelfInitiatedSends(
  msgs: Array<{ sender: string; text: string | null; created_at: string | null; is_aix_generated?: boolean | null }>
): SelfInitiatedSend[] {
  const result: SelfInitiatedSend[] = [];

  // [start, end) は顧客メッセージで挟まれた staff 連続ブロック
  const scanBlock = (start: number, end: number) => {
    let lastAixIdx = -1;
    for (let i = start; i < end; i++) {
      if (msgs[i].is_aix_generated === true) lastAixIdx = i;
    }
    if (lastAixIdx === -1) return; // AIXを含まないブロックは自発送信の定義対象外
    const aix = msgs[lastAixIdx];
    for (let i = lastAixIdx + 1; i < end; i++) {
      const m = msgs[i];
      if (m.is_aix_generated === true) continue;
      if (!(m.text ?? "").trim()) continue;
      const gapSec =
        m.created_at && aix.created_at
          ? Math.round((new Date(m.created_at).getTime() - new Date(aix.created_at).getTime()) / 1000)
          : null;
      result.push({
        text: m.text ?? "",
        created_at: m.created_at,
        seconds_after_aix: gapSec,
        aix_source_text: (aix.text ?? "").slice(0, 120),
      });
    }
  };

  let blockStart = 0;
  for (let i = 0; i <= msgs.length; i++) {
    if (i === msgs.length || msgs[i].sender === "customer") {
      if (i > blockStart) scanBlock(blockStart, i);
      blockStart = i + 1;
    }
  }
  return result;
}

// ── フェーズ検出ヘルパー ─────────────────────────────────────────────────────
// brain分析結果（SuggestedAixMeta）の各フィールドから現在フェーズを推定する。
// conversation_direction の current_phase 更新判定に使用する。
function detectPhaseFromBrainMeta(meta: Record<string, unknown>): "hearing" | "proposing" | "viewing" | "applying" {
  const txt = [meta.action, meta.closing_strategy, meta.next_steps].filter(Boolean).join(" ");
  // 優先1: 審査落ち・再スタート文脈 → hearing（「また探したい」「別の物件」等が共存）
  if (/再探し|また探|別の物件|審査落/.test(txt)) return "hearing";
  // 優先2: 純粋な申込・審査待ち（「再」「また」「別」が共存しない場合のみ）
  if (/申込|審査/.test(txt) && !/再|また|別/.test(txt)) return "applying";
  // 優先3: 内覧・内見
  if (/内覧|内見/.test(txt)) return "viewing";
  // 優先4: 物件提案中
  if (/提案|物件/.test(txt)) return "proposing";
  return "hearing";
}

/**
 * Calls Claude Haiku with enriched context (last 15 messages, customer conditions,
 * conversation status) and returns a SuggestedAixMeta to cache in conversations.
 *
 * `source` はこの分析の呼び出し経路（"brain" = イベント駆動/sweep）。
 * 品質ゲートは自分自身の経路の採択率（SOURCE_ACCEPT_RATE:{action}:{source}）を読む。
 * （旧実装は analysis_step1 という他コンポーネントのキーを読んでいたバグがあった）
 */
export async function analyzeConversation(
  conversationId: string,
  isUrgent: boolean,
  convStatus: string | null,
  propertyCustomerId: string | null,
  source: string = "brain",
  // B2/H6(Fable5): 呼び出し元（analyzeAndSaveBrainMeta）が conversations から取得したフラグ。
  // auto_send_enabled=false の会話に auto_reply を提案しない・is_flagged はスタッフ要対応なので aix 強制
  opts?: { autoSendEnabled?: boolean; isHot?: boolean; isFlagged?: boolean },
): Promise<SuggestedAixMeta> {
  // Fetch last 30 messages and customer conditions in parallel
  // H5(Fable5): limit 15→30 — 会話あたりメッセージ数の中央値は25件。checkpoints が0行（書き込み側未実装）の間、
  // limit 15 だと中央値会話の前半を完全に忘れるため引き上げ。count: "exact" は総メッセージ数のプロンプト注入用（B3）
  const [msgResult, pcResult, examplesResult, checkpointsResult, sentPropsResult, promptRulesResult, knowledgePrinciplesResult, templatesResult, boundaryPromptRulesResult, boundaryTriggerRulesResult, contractKnowledgeResult, contractExamplesResult, aixLogsResult, scheduledMsgsResult, openTasksResult, viewingsResult, viewingHistoryResult] = await Promise.all([
    supabase
      .from("messages")
      .select("sender, text, created_at, line_message_id, is_aix_generated", { count: "exact" })
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(30),
    propertyCustomerId
      ? supabase
          .from("property_customers")
          .select("desired_area, floor_plan, rent_min, rent_max, move_in_time, preferences, ng_points, walk_minutes, last_property_sent_at, property_send_count")
          .eq("id", propertyCustomerId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Recent starred reply examples for this conversation (context for Haiku)
    supabase
      .from("ai_reply_examples")
      .select("sent_reply, is_starred")
      .eq("conversation_id", conversationId)
      .eq("is_starred", true)
      .order("created_at", { ascending: false })
      .limit(3),
    // Latest 2 checkpoints for long-conversation context
    supabase
      .from("conversation_checkpoints")
      .select("checkpoint_index, summary, key_facts, conversation_stage")
      .eq("conversation_id", conversationId)
      .order("checkpoint_index", { ascending: false })
      .limit(2),
    // Sent properties for this customer (duplicate/history awareness)
    propertyCustomerId
      ? supabase
          .from("sent_properties")
          .select("property_name, room_no, sent_at")
          .eq("property_customer_id", propertyCustomerId)
          .order("sent_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: null }),
    // Global permanent operator rules (apply to all conversations, no pgvector needed)
    // B4(Fable5): limit 10→20 — 本番で恒久ルールがちょうど10行に達しており、11個目から無言欠落する状態だった
    supabase
      .from("ai_prompt_rules")
      .select("rule_text, priority")
      .eq("is_active", true)
      .eq("is_permanent", true)
      .is("action_type", null)
      .order("priority", { ascending: false })
      .limit(20),
    // Confirmed top-importance principles (importance >= 9, no pgvector needed)
    // B11(Fable5): .neq は NULL 行を除外する（SQL <> セマンティクス）→ .or で NULL 許容に。
    // created_at 降順タイブレークで同 importance 内の選抜を決定的にする
    supabase
      .from("ai_reply_knowledge")
      .select("content, importance")
      .eq("category", "principle")
      .gte("importance", 9)
      .or("hypothesis_status.is.null,hypothesis_status.neq.rejected")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(3),
    // Top templates by win_rate for context (brain uses these to recommend best template)
    // B1(Fable5): 旧 .like("category", "AIX%") は前方一致で、実カテゴリ「見積書送る【AIX】」等に
    // 一度もマッチしていなかった（本番0件を実測確認 = このデータソースは死んでいた）。
    // use_count>=3 で「1回使用でwin_rate 100%」の統計ノイズを排除、nullsFirst:false でNULL win_rateを後ろへ
    supabase
      .from("templates")
      .select("category, label, win_rate, use_count")
      .like("category", "%【AIX】%")
      .gte("use_count", 3)
      .order("win_rate", { ascending: false, nullsFirst: false })
      .limit(5),
    // 線引きルール: BOUNDARY-* rules that define when to use AIX vs auto-reply
    // B4(Fable5): limit 15→40 — 本番に31行あり、旧limitでは線引きルールの半分以上が無言欠落していた。
    // 線引きルールは reply_mode（aix/auto_reply）判定の根幹のため全件注入する
    supabase
      .from("ai_prompt_rules")
      .select("rule_key, action_type, rule_text")
      .like("rule_key", "BOUNDARY-%")
      .eq("is_active", true)
      .order("priority", { ascending: false })
      .limit(40),
    supabase
      .from("trigger_action_rules")
      .select("keyword, action_type, rule_text")
      .like("keyword", "BOUNDARY%")
      .gte("confidence", 0.5)
      .limit(10),
    // 成約パターン（distilled）: notify-viewing / analyze-closed-conversation が書く高価値ナレッジ
    // （既存の principle クエリは category='principle' のみで、これら pattern 行は拾えない）
    supabase
      .from("ai_reply_knowledge")
      .select("title, content, importance")
      .eq("category", "pattern")
      // B11(Fable5): NULL 許容（.neq は hypothesis_status IS NULL の行を除外してしまう）
      .or("hypothesis_status.is.null,hypothesis_status.neq.rejected")
      .or("title.ilike.成約パターン%,title.ilike.[成約分析]%,title.ilike.[転換点]%")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(4),
    // 成約・申込到達の会話の実際の優良返信（success × starred × line_reply）
    // FK: ai_reply_examples.conversation_id → conversations.id（migrate-schema L681）で inner join
    supabase
      .from("ai_reply_examples")
      .select("sent_reply, conversation_state, conversations!inner(status)")
      .in("conversations.status", SUCCESS_EXAMPLE_STATUSES)
      .eq("is_starred", true)
      .eq("entry_source", "line_reply")
      .not("sent_reply", "is", null)
      .order("created_at", { ascending: false })
      .limit(8),
    // ② この会話で使われたAIXアクション履歴（メッセージ単位の厳密ラベル用）
    supabase
      .from("aix_usage_logs")
      .select("aix_type, line_message_id, sent_at, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(30),
    // H6(Fable5): 予約送信済みメッセージ（pending）— 追客提案が予約済み送信と重複するのを防ぐ
    supabase
      .from("scheduled_messages")
      .select("text, scheduled_at")
      .eq("conversation_id", conversationId)
      .eq("status", "pending")
      .order("scheduled_at", { ascending: true })
      .limit(5),
    // H6(Fable5): この会話の未完了タスク — next_steps を実際の保留作業に接地させる
    supabase
      .from("line_tasks")
      .select("task_type, created_at")
      .eq("conversation_id", conversationId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(5),
    // H6(Fable5): 内覧予定/完了 — 次アクション判断の核となるシグナル
    supabase
      .from("viewings")
      .select("viewing_date, viewing_time, status")
      .eq("conversation_id", conversationId)
      .order("viewing_date", { ascending: false })
      .limit(3),
    // viewing_history（is_primary=true）を優先参照 — viewingsの後継テーブル
    supabase
      .from("viewing_history")
      .select("scheduled_date, scheduled_time, status")
      .eq("conversation_id", conversationId)
      .order("scheduled_date", { ascending: false })
      .limit(3),
  ]);

  const { data: messages, error, count: totalMessageCount } = msgResult;
  if (error || !messages || messages.length === 0) return null;
  // H5(Fable5): 全メッセージが画像/添付のみ（テキスト0件）の場合は分析しない。
  // 「（画像/添付）×N」だけを読んだHaikuの当てずっぽう提案がキャッシュされるのを防ぐ
  if (messages.every((m) => !m.text)) return null;

  // AIXアクションのメッセージ単位ラベル解決
  // 1) line_message_id 完全一致（P4以降のログ・直近30日で97%カバー）
  // 2) 旧ログ fallback: is_aix_generated=true × sent_at ±3分
  type AixLog = { aix_type: string | null; line_message_id: string | null; sent_at: string | null; created_at: string };
  const aixLogs = (aixLogsResult.data ?? []) as AixLog[];
  const aixTypeByLmid = new Map<string, string>();
  for (const l of aixLogs) {
    if (l.line_message_id && l.aix_type) aixTypeByLmid.set(l.line_message_id, l.aix_type);
  }
  const aixLogsNoLmid = aixLogs.filter((l) => !l.line_message_id && l.aix_type);

  // Reverse so the history reads oldest → newest
  // B3(Fable5): 各行に日付（M/D）を付与 — 旧実装は created_at を取得しながらプロンプトから捨てており、
  // Haiku が「5分前の返信」と「12日間沈黙」を区別できず followup_revive 判断が原理的に不可能だった
  const typedMessages = messages as Array<{ sender: string; text: string | null; created_at: string; line_message_id: string | null; is_aix_generated: boolean | null }>;
  const history = [...typedMessages]
    .reverse()
    .map((m) => {
      let senderLabel = "顧客";
      if (m.sender === "staff") {
        const exact = m.line_message_id ? aixTypeByLmid.get(m.line_message_id) : undefined;
        const fuzzy = (!exact && m.is_aix_generated)
          ? aixLogsNoLmid.find((l) => Math.abs(new Date(l.sent_at ?? l.created_at).getTime() - new Date(m.created_at).getTime()) < 3 * 60 * 1000)?.aix_type
          : undefined;
        const aixType = exact ?? fuzzy;
        senderLabel = aixType ? `AIX:${aixType}` : (m.is_aix_generated ? "AIX" : "スタッフ");
      }
      const dateLabel = new Date(m.created_at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", timeZone: "Asia/Tokyo" });
      return `[${senderLabel} ${dateLabel}] ${m.text ?? "（画像/添付）"}`;
    })
    .join("\n");

  // B3(Fable5): 今日の日付・最終顧客メッセージからの経過日数・総メッセージ数をプロンプト冒頭に注入。
  // これが無いと Haiku は経過時間を知り得ず、closing_strategy に架空の日付を創作していた
  const lastCustomerMsg = typedMessages.find((m) => m.sender === "customer"); // messagesは新しい順
  const daysSinceLastCustomerMsg = lastCustomerMsg
    ? Math.floor((Date.now() - new Date(lastCustomerMsg.created_at).getTime()) / 86_400_000)
    : null;
  const todayStr = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  const timingText = `\n【時間情報】今日: ${todayStr} / 最終顧客メッセージ: ${daysSinceLastCustomerMsg !== null ? `${daysSinceLastCustomerMsg}日前` : "不明"} / 総メッセージ数: ${totalMessageCount ?? typedMessages.length}件（履歴は直近${typedMessages.length}件のみ表示）`;

  // Build customer conditions context
  type PC = { desired_area?: string | null; floor_plan?: string | null; rent_min?: number | null; rent_max?: number | null; move_in_time?: string | null; preferences?: string | null; ng_points?: string | null; walk_minutes?: number | null; last_property_sent_at?: string | null; property_send_count?: number | null } | null;
  const pc = (pcResult.data ?? null) as PC;
  const condParts: string[] = [];
  if (pc?.desired_area) condParts.push(`エリア: ${pc.desired_area}`);
  if (pc?.floor_plan) condParts.push(`間取り: ${pc.floor_plan}`);
  if (pc?.rent_max) condParts.push(`家賃上限: ${Math.floor((pc.rent_max as number) / 10000)}万`);
  if (pc?.walk_minutes) condParts.push(`駅徒歩: ${pc.walk_minutes}分以内`);
  if (pc?.move_in_time) condParts.push(`入居: ${pc.move_in_time}`);
  if (pc?.preferences) condParts.push(`希望: ${pc.preferences}`);
  const condText = condParts.length > 0 ? `\n顧客条件: ${condParts.join(" / ")}` : "";

  const statusMeaning = convStatus && STATUS_MEANING[convStatus] ? STATUS_MEANING[convStatus] : (convStatus ?? "");
  const statusText = convStatus ? `\n現在のステータス: ${statusMeaning}` : "";

  // Recent starred examples (good replies) for this customer
  const examples = (examplesResult.data ?? []) as Array<{ sent_reply: string | null; is_starred: boolean | null }>;
  const examplesText = examples.length > 0
    ? `\n過去のスタッフ優良返信例:\n${examples.map((e) => `- ${e.sent_reply ?? ""}`).join("\n")}`
    : "";

  // Checkpoint summaries for long-conversation context (セーブポイント)
  type Checkpoint = { checkpoint_index: number; summary: string | null; key_facts: string | null; conversation_stage: string | null };
  const checkpoints = ((checkpointsResult.data ?? []) as Checkpoint[]).reverse(); // oldest first
  const checkpointText = checkpoints.length > 0
    ? `\n【過去の会話まとめ（セーブポイント）】\n${checkpoints.map((cp) => `■ ブロック${cp.checkpoint_index}: ${cp.summary ?? ""}${cp.key_facts ? ` / ${cp.key_facts}` : ""}`).join("\n")}`
    : "";

  // Sent properties — what has already been proposed to this customer
  type SentProp = { property_name: string; room_no: string; sent_at: string };
  const sentProps = ((sentPropsResult.data ?? []) as SentProp[]);
  const sentPropsText = sentProps.length > 0
    ? `\n【すでに送付済みの物件（${sentProps.length}件）】\n${sentProps.map((p) => `- ${p.property_name} ${p.room_no}（${new Date(p.sent_at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}送付）`).join("\n")}`
    : "";

  // ── 物件検索統括コンテキスト ─────────────────────────────────────────
  // sent_properties + property_customers から「物件検索の全体像」を動的に組み立てて注入する。
  // 脳が property_search / property_send の使い分け（検索すべきか・送付を控えるべきか）を
  // 判断できるようにするための統括ブロック。propertyCustomerId が無い会話ではスキップ。
  //
  // TODO(P2): Chrome拡張フィードバックループ
  //   脳の suggested_aix_meta に property_search_params を追加し、
  //   Chrome拡張が起動時にWebAppのbrain/list APIからこれを取得して
  //   検索フォームに自動入力できるようにする
  //   必要なフィールド: { area, floor_plan, rent_max, walk_minutes, ng_properties: sent_properties }
  //
  // TODO(P2): 物件評価API
  //   /api/evaluate-property POST を新設。候補物件のスペックをbodyで受け取り、
  //   お客さんの条件とsent_propertiesを照合してスコア（0-100）とNG理由を返す
  //   Chrome拡張のscore-overlay.jsがこれを呼んでリアルタイムスコア表示に使う
  //
  // TODO(P3): 物件在庫連携
  //   Chrome拡張がリアプロ/itandi/レインズの検索結果を /api/property-inventory POST で
  //   サーバーに送信し、brain-core.tsがその在庫データを見て「今日オススメできる物件」を
  //   特定してChrome拡張に返す。完全自律物件選定の実現
  let propertySearchText = "";
  if (pc) {
    // sentCount: sent_properties の直近10件クエリ結果（10件で頭打ちのため「以上」表記）
    const sentCount = sentProps.length;
    // daysSinceLastSend: last_property_sent_at 優先、無ければ sent_properties の最新 sent_at
    const lastSentIso = pc.last_property_sent_at ?? sentProps[0]?.sent_at ?? null;
    const daysSinceLastSend = lastSentIso
      ? Math.floor((Date.now() - new Date(lastSentIso).getTime()) / 86_400_000)
      : null;
    // property_send_count = 連続未返信送付数（顧客が反応するとUI側で0にリセットされる）
    const unansweredSendCount = pc.property_send_count ?? 0;
    // 物件検索推奨度（★の数）:
    //   ─   : 連続未返信送付2件以上 → お客さんが反応していない。property_send は控える
    //   ★★★: 7日以上送付なし or 送付0件 → 今すぐ property_search を提案
    //   ★★ : 3-6日 → property_send または property_search を検討
    //   ★  : 3日未満 → 様子見
    let searchPriority: string;
    if (unansweredSendCount >= 2) {
      searchPriority = "─（送付済みがあり返信待ち → property_sendは控える）";
    } else if (daysSinceLastSend === null || daysSinceLastSend >= 7) {
      searchPriority = "★★★（7日以上送付なし → 今すぐproperty_searchを提案）";
    } else if (daysSinceLastSend >= 3) {
      searchPriority = "★★（3-6日 → property_sendまたはproperty_searchを検討）";
    } else {
      searchPriority = "★（3日未満 → 様子見）";
    }
    propertySearchText = `
【物件検索統括】
送付済み件数: ${sentCount}件${sentCount >= 10 ? "以上" : ""}
最終送付: ${daysSinceLastSend !== null ? `${daysSinceLastSend}日前` : "まだ送付なし"}
連続未返信送付: ${unansweredSendCount}件（2件以上 = お客さんが反応していない）
検索条件:
  エリア: ${pc.desired_area ?? "未設定"}
  間取り: ${pc.floor_plan ?? "未設定"}
  家賃上限: ${pc.rent_max ? `${pc.rent_max}円` : "未設定"}
  入居時期: ${pc.move_in_time ?? "未設定"}
  駅徒歩: ${pc.walk_minutes ? `${pc.walk_minutes}分以内` : "未設定"}
  希望条件: ${pc.preferences ?? "未設定"}
物件検索推奨度: ${searchPriority}`;
  }

  type PromptRule = { rule_text: string; priority: number };
  const promptRules = (promptRulesResult.data ?? []) as PromptRule[];
  const promptRulesText = promptRules.length > 0
    ? `\n【絶対ルール（オペレーター設定）】\n${promptRules.map((r) => `- ${r.rule_text}`).join("\n")}`
    : "";

  type KnowledgePrinciple = { content: string; importance: number };
  const knowledgePrinciples = (knowledgePrinciplesResult.data ?? []) as KnowledgePrinciple[];
  const knowledgeText = knowledgePrinciples.length > 0
    ? `\n【重要原則】\n${knowledgePrinciples.map((k) => `- ${k.content}`).join("\n")}`
    : "";

  // Top-performing AIX templates (for template_hint context)
  type TopTemplate = { category: string | null; label: string | null; win_rate: number | null; use_count: number | null };
  const topTemplates = (templatesResult.data ?? []) as TopTemplate[];
  const templatesText = topTemplates.length > 0
    ? `\n【モーダル経由の使用実績が多いテンプレート（参考値・成約寄与ではない）】\n${topTemplates.map((t) => `- ${t.category}: ${t.label} (win_rate: ${((t.win_rate ?? 0) * 100).toFixed(0)}%, モーダル経由${t.use_count ?? 0}回)`).join("\n")}\n※use_count はTemplateModal経由の送信のみ計上され、コピペ・手打ち送信は数えない。この一覧に無い＝成約実績が無い ではないので、template_hint は必ず上記フェーズ別推奨マップを優先して選ぶこと。`
    : "";

  // Boundary rules — when AIX is required vs auto-reply is allowed
  type BoundaryRule = { rule_key?: string; keyword?: string; action_type: string | null; rule_text: string };
  const boundaryRulesFromPrompts = (boundaryPromptRulesResult.data ?? []) as BoundaryRule[];
  const boundaryRulesFromTrigger = (boundaryTriggerRulesResult.data ?? []) as BoundaryRule[];
  const allBoundaryRules = [...boundaryRulesFromPrompts, ...boundaryRulesFromTrigger];
  const boundaryText = allBoundaryRules.length > 0
    ? `\n【線引きルール（AIX必須 vs 自動返信OK）】\n${allBoundaryRules.map((r) => {
        const aix = r.action_type && r.action_type !== 'generate_reply' ? `→ AIX: ${r.action_type}` : '→ 自動返信禁止';
        return `- ${r.rule_text} ${aix}`;
      }).join("\n")}`
    : "";

  // ── 成約パターン注入 ─────────────────────────────────────────────
  // 過去に closed_won（成約）に至った会話から学習したパターンと実返信例。
  // データが無ければ空文字（ブロックごとスキップ）。
  type ContractKnowledge = { title: string | null; content: string | null; importance: number | null };
  const contractKnowledge = (contractKnowledgeResult.data ?? []) as ContractKnowledge[];

  type ContractExample = {
    sent_reply: string | null;
    conversation_state: string | null;
    conversations: { status: string | null } | { status: string | null }[] | null;
  };
  // 成約/申込到達の別（[成約]=closed_won / [申込到達]=applying等）をラベル化
  const outcomeOf = (e: ContractExample): string => {
    const st = Array.isArray(e.conversations) ? e.conversations[0]?.status : e.conversations?.status;
    return st === "closed_won" ? "成約" : "申込到達";
  };
  const rawContractExamples = (contractExamplesResult.data ?? []) as ContractExample[];
  // 現在のステータスと同じ段階の返信例を優先し、最大3件・各100字に切り詰め
  const stateMatched = rawContractExamples.filter((e) => e.conversation_state === convStatus);
  const stateOthers = rawContractExamples.filter((e) => e.conversation_state !== convStatus);
  const contractExamples = [...stateMatched, ...stateOthers].slice(0, 3);

  const contractKnowledgeLines = contractKnowledge
    .map((k) => `- ${(k.title ?? "").slice(0, 40)}: ${(k.content ?? "").replace(/\n/g, " ").slice(0, 150)}`)
    .join("\n");
  const contractExampleLines = contractExamples
    .map((e) => `- [${outcomeOf(e)}] (${e.conversation_state ?? "不明"}段階) 「${(e.sent_reply ?? "").replace(/\n/g, " ").slice(0, 100)}」`)
    .join("\n");

  const contractPatternsText = (contractKnowledge.length > 0 || contractExamples.length > 0)
    ? `\n【成約・申込到達パターン（過去に契約/申込に至った会話から学習・参考）】${contractKnowledgeLines ? `\n■ 成功法則・転換点:\n${contractKnowledgeLines}` : ""}${contractExampleLines ? `\n■ 成約した会話の実際の返信例:\n${contractExampleLines}` : ""}\n※現在の会話がこれらのパターンに近い場合、closing_strategy と next_steps は成約パターンの流れに沿って提案すること。`
    : "";

  // この会話で使用済みのAIXアクション一覧（重複提案の抑止・次段階の推奨材料）
  const usedAixTypes = [...new Set(aixLogs.map((l) => l.aix_type).filter((t): t is string => Boolean(t)))];
  const aixHistoryText = usedAixTypes.length > 0
    ? `\n【この会話で使用済みのAIXアクション】${usedAixTypes.join(" / ")}\n※既に使用済みのアクションを再提案する場合は理由が必要。原則は次の段階のアクションを提案すること。`
    : "";

  // H6(Fable5): 予約送信・未完了タスク・内覧予定を注入（重複提案防止・next_steps の接地）
  type ScheduledMsg = { text: string | null; scheduled_at: string };
  const scheduledMsgs = (scheduledMsgsResult.data ?? []) as ScheduledMsg[];
  const scheduledText = scheduledMsgs.length > 0
    ? `\n【予約送信済みメッセージ（送信待ち${scheduledMsgs.length}件）】\n${scheduledMsgs.map((s) => `- ${new Date(s.scheduled_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" })}送信予定: ${(s.text ?? "（画像）").replace(/\n/g, " ").slice(0, 60)}`).join("\n")}\n※これらと重複する追客・送信提案はしないこと。`
    : "";

  type OpenTask = { task_type: string; created_at: string };
  const openTasks = (openTasksResult.data ?? []) as OpenTask[];
  const taskLabel: Record<string, string> = { property_check: "物件確認（空室確認）", property_send: "物件送付" };
  const tasksText = openTasks.length > 0
    ? `\n【この会話の未完了タスク】${openTasks.map((t) => taskLabel[t.task_type] ?? t.task_type).join(" / ")}\n※next_steps はこれらの未完了タスクを考慮すること。`
    : "";

  type Viewing = { viewing_date: string; viewing_time: string | null; status: string | null };
  // viewing_history（is_primaryを含む全件）を優先・存在しなければviewingsにフォールバック
  type ViewingHistoryRow = { scheduled_date: string; scheduled_time: string | null; status: string | null };
  const viewingHistoryRows = (viewingHistoryResult.data ?? []) as ViewingHistoryRow[];
  const viewings: Viewing[] = viewingHistoryRows.length > 0
    ? viewingHistoryRows.map(h => ({ viewing_date: h.scheduled_date, viewing_time: h.scheduled_time, status: h.status }))
    : (viewingsResult.data ?? []) as Viewing[];
  const viewingStatusLabel: Record<string, string> = { scheduled: "予定", done: "完了", cancelled: "キャンセル" };
  const viewingsText = viewings.length > 0
    ? `\n【内覧履歴・予定】${viewings.map((v) => `${v.viewing_date}${v.viewing_time ? ` ${String(v.viewing_time).slice(0, 5)}` : ""}（${viewingStatusLabel[v.status ?? ""] ?? v.status ?? "予定"}）`).join(" / ")}`
    : "";

  // H6(Fable5): ホット顧客・スタッフ要対応フラグ
  const flagParts: string[] = [];
  if (opts?.isHot) flagParts.push("ホット顧客（成約意欲高・プッシュ強めOK）");
  if (opts?.isFlagged) flagParts.push("スタッフ要対応フラグあり（自動返信不可・必ずスタッフ対応）");
  const flagsText = flagParts.length > 0 ? `\n【フラグ】${flagParts.join(" / ")}` : "";

  // H4(Fable5): 会話に依存しない静的ブロック（能力マップ・線引きルール・恒久ルール等）を system に分離し
  // prompt caching（ephemeral）を適用。brain-sweep は5分毎バッチのため入力コストを約40-60%削減できる。
  // ※ contractPatternsText は convStatus 依存の並べ替えがあるため user 側に残す
  const systemText = `あなたはスモラAI。与えられた会話履歴を読んで、スタッフが次にすべき1アクションを20字以内で答えてください。必ずJSON形式のみで返してください。

${AIX_CAPABILITY_MAP}

${REPLY_STYLE_RULES}

${PHASE_TEMPLATE_HINTS}${promptRulesText}${knowledgeText}${boundaryText}${templatesText}

【日付の厳守】closing_strategy・next_steps には会話に実際に出た物件名・日付のみ使用（推測日付の創作禁止）。

回答形式（JSONのみ・説明文・コードブロック不要）:
{"action": "スタッフが次にすべき具体的なアクション（20字以内）", "reason": "その理由（30字以内）", "aix": "上記能力マップのキー1つ、該当なしならnull", "closing_strategy": "この顧客が契約に至るための具体的な戦略を1〜2文で", "template_hint": "次に送るべき【AIX】テンプレートのラベル名。上記フェーズ別推奨マップに従いAIXボタン使用後は必ず対応テンプレートを推奨（property_send（複数件）後→'物件ピックアップ紹介（後続）'・駅指定なら'駅周辺物件ピックアップ（後続）'・全件即入居可なら'【全件案内可能】' / property_recommendation（1件詳細）後→'1件特にオススメ' / estimate_sheet後→'【申込誘導】' / application_pushで①申込時フォーマットを送った直後→'②申込時フォーマット（続き）' / property_check_resultで2番手可と判明→'（2番手・申込）' / 条件ヒアリング後→'ヒアリング締め' / 物件なし→'【物件なし】条件変更のご提案' / viewing_invite・meeting_place後→null）。顧客実名・物件名が焼き込まれたテンプレート（'【新着】'等）は選ばない。use_countが0であることは除外理由にしない（手打ち送信が計上されないだけで成約実績はある）。該当なければnull", "next_steps": ["Step1（今すぐ）: 具体的アクション", "Step2: AIXボタン○○を押す", "Step3: 物件事実系（物件ピックアップ紹介（後続）・駅周辺物件ピックアップ（後続）・1件特にオススメ・【申込誘導】・【全件案内可能】）は『【AIX】○○をAI最適化して送る（AIXクラスター完了1〜2分後・顧客返信を待たない）』、定型追撃系（②申込時フォーマット（続き）・ヒアリング締め・（2番手・申込））は『【AIX】○○をそのまま送る（1分以内・編集不要・AI最適化禁止）』の書式でテンプレートまでセットで提示"], "reply_mode": "aixまたはauto_reply。auto_replyはAIが人の確認なしで送信する。線引きルール該当時・金額/契約/入居日/内覧日程の確定に関わる時・判断に迷う時は必ずaix。雑談や単純な質問への一般返信のみauto_reply"}`;

  const userPrompt = `${statusText}${timingText}${flagsText}${aixHistoryText}${condText}${scheduledText}${tasksText}${viewingsText}${examplesText}${checkpointText}${sentPropsText}${propertySearchText}${contractPatternsText}

会話履歴（[AIX:xxx 日付]=AIXツールxxxで送信済み / [AIX 日付]=AIX送信(種別不明) / [スタッフ 日付]=手動送信 / [顧客 日付]=顧客メッセージ）:
${history}`;

  try {
    const response = await client.messages.create({
      model: HAIKU,
      max_tokens: 512,
      system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userPrompt }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text : "";
    // M2(Fable5): 最初の { 〜 最後の } を抽出（旧 non-greedy 正規表現は最初の } で切れる罠があった）
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace <= firstBrace) return null;
    const jsonMatch = [raw.slice(firstBrace, lastBrace + 1)];

    const parsed = JSON.parse(jsonMatch[0]) as {
      action?: string;
      reason?: string;
      aix?: string | null;
      closing_strategy?: string;
      template_hint?: string;
      next_steps?: string[];
      reply_mode?: "aix" | "auto_reply";
    };

    // Use a canonical action key from AIX_BRAIN_NOTES if Haiku returned one we recognise.
    // If the aix value is unknown or null, fall back to empty string so the row still gets saved.
    let finalAix = parsed.aix && AIX_BRAIN_NOTES[parsed.aix] ? parsed.aix : null;
    // Quality gate: suppress AIX suggestions with < 30% acceptance rate over 10+ samples.
    // FIX(Fable5 #3): 自経路の採択率キー（:brain 等）を読む。旧実装は :analysis_step1 固定で
    // 他コンポーネントの統計をゲートに使っており、脳の自己修正が一度も機能していなかった。
    if (finalAix) {
      const { data: rateData } = await supabase
        .from("trigger_action_rules")
        .select("confidence, total_occurrence")
        .eq("keyword", `SOURCE_ACCEPT_RATE:${finalAix}:${source}`)
        .eq("action_type", finalAix)
        .maybeSingle();
      if (rateData) {
        const occ = (rateData.total_occurrence as number | null) ?? 0;
        const conf = (rateData.confidence as number | null) ?? 1;
        if (occ >= 10 && conf < 0.3) finalAix = null;
      }
    }
    // B2(Fable5): reply_mode のフェイルクローズ強制（コード側で決定的に上書き — プロンプト任せにしない）
    // 旧実装は線引きルール0件時に Haiku が auto_reply へ倒れる「安全側でない」デフォルトだった
    let replyMode: "aix" | "auto_reply" | undefined =
      (parsed.reply_mode === "aix" || parsed.reply_mode === "auto_reply") ? parsed.reply_mode : undefined;
    if (finalAix) replyMode = "aix";                       // AIX提案がある時点でスタッフ操作前提
    if (!boundaryText) replyMode = "aix";                  // 線引きルール取得失敗/0件時はフェイルクローズ
    if (opts?.autoSendEnabled === false) replyMode = "aix"; // auto_send無効の会話に auto_reply を提案しない
    if (opts?.isFlagged) replyMode = "aix";                // スタッフ要対応フラグ済み

    // 初回例外: スタッフの非AIXテキスト返信がまだ無い会話（真の初回）は
    // reply_mode と AIX提案を出さない。generate-reply の初回挨拶ドラフト生成が最優先。
    // generate-reply/route.ts の deriveSuggestedAix first_reply 例外と同じ設計意図。
    // auto_send_enabled=NULL → ?? false でフェイルクローズしてしまうバグの根本対処でもある。
    const hasStaffNonAixText = typedMessages.some(
      m => m.sender === "staff" && !m.is_aix_generated && m.text
    );
    if (!hasStaffNonAixText) {
      finalAix = null;
      replyMode = undefined;
    }

    return {
      action: finalAix ?? "",
      note: finalAix ? AIX_BRAIN_NOTES[finalAix] : (parsed.action ?? ""),
      source,
      enforcement_level: isUrgent ? "required" : "recommended",
      closing_strategy: parsed.closing_strategy || undefined,
      template_hint: parsed.template_hint || undefined,
      next_steps: Array.isArray(parsed.next_steps) && parsed.next_steps.length > 0 ? parsed.next_steps : undefined,
      reply_mode: replyMode,
      // Chrome拡張フィードバックループ: 検索フォーム自動入力用の構造化パラメータ（TODO(P2)対応）
      property_search_params: pc ? {
        area: pc.desired_area ?? null,
        floor_plan: pc.floor_plan ?? null,
        rent_max: pc.rent_max ?? null,
        walk_minutes: pc.walk_minutes ?? null,
        move_in_time: pc.move_in_time ?? null,
        preferences: pc.preferences ?? null,
        ng_points: pc.ng_points ?? null,
        ng_properties: sentProps.map((s) => ({ property_name: s.property_name, room_no: s.room_no })),
        search_urgency: (() => {
          // propertySearchText（物件検索統括ブロック）の searchPriority と同一ロジックの★のみ版
          if ((pc.property_send_count ?? 0) >= 2) return "─";
          const lastSentIso = pc.last_property_sent_at ?? sentProps[0]?.sent_at ?? null;
          const daysSince = lastSentIso
            ? Math.floor((Date.now() - new Date(lastSentIso).getTime()) / 86_400_000)
            : null;
          if (daysSince === null || daysSince >= 7) return "★★★";
          if (daysSince >= 3) return "★★";
          return "★";
        })(),
      } : null,
    };
  } catch (e) {
    console.warn(`[brain-core] Haiku analysis failed: conv=${conversationId}`, e instanceof Error ? e.message : e);
    return null;
  }
}

// ── 会話チェックポイント（セーブデータ）作成 ──────────────────────────────────
// 脳分析成功後に after() で fire-and-forget 起動。final-check anomaly_scan の
// 正解データ（ground truth）になるため「会話に明記された事実のみ・日付付き」が絶対条件。
// ローリング累積方式: 最新1行が常に現在の確認済み事実の全量（前回分を引き継いで更新）。
const MESSAGES_PER_CHECKPOINT = 15;  // 前回作成時から15件以上増えたら新規作成
const CHECKPOINT_MIN_MESSAGES = 11;  // 総メッセージ数 > 10 で初回作成

function formatJstDateShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function buildCheckpointPrompt(
  prevSummary: string | null, historyText: string, total: number, shown: number,
): string {
  return `あなたは不動産賃貸仲介のLINE会話の記録係です。会話の「セーブデータ」（チェックポイント）を作成してください。
このセーブデータは後で返信AIの事実確認（ハルシネーション検査）の正解データとして使われます。
会話に書かれていない事実を1つでも書くと、誤った返信が「正しい」と判定される事故になります。

絶対ルール:
- 会話に明記された事実のみ書く。推測・補完・一般知識での穴埋めは禁止
- 各事実に日付と出所を必ず付ける（例:「家賃12〜15万（8/3顧客提示）」）
- 金額・物件名・部屋番号・駅名・路線名・日付は一字一句そのまま写す（丸め・単位変換・言い換え禁止）
- 前回セーブデータの事実は、新しい会話で更新・撤回されていない限りそのまま引き継ぐ。
  更新された場合は新しい値のみ残す（例: 家賃上限が変わったら新値だけ・旧値は書かない）
- 解決した【未解決事項】は【確認済み事実】へ移す（例: 空室確認の回答が来たら結果を事実として記録）

【前回のセーブデータ】
${prevSummary ? prevSummary.slice(0, 1500) : "（なし・今回が最初のセーブ）"}

【新しい会話（全${total}件中の直近${shown}件・日付付き。スタッフ(AIX)=AIツールで送信済み）】
${historyText}

JSON形式のみで返答（説明・コードブロック不要）:
{
  "summary": "【確認済み事実】家賃: 12〜15万（8/3顧客提示）/ エリア: 渋谷・恵比寿（8/3顧客）/ 入居希望: 9月上旬（8/3顧客）\\n【AIX使用済み】viewing_invite: 8/5送付 / property_send: 8/7 3件\\n【未解決事項】空室確認: ライオンズ渋谷401（問い合わせ中）/ 内覧日程: 調整中",
  "key_facts": [
    {"type": "confirmed_fact", "value": "家賃12〜15万（8/3顧客提示）"},
    {"type": "aix_sent", "value": "viewing_invite 8/5送付"},
    {"type": "unresolved", "value": "ライオンズ渋谷401 空室確認中"}
  ],
  "stage": "hearing"
}
stage は hearing/proposing/applying/contract のいずれか。
該当事実の無いセクション行は省略可。key_facts の type は confirmed_fact/aix_sent/unresolved の3種のみ。`;
}

export async function maybeCreateCheckpoint(conversationId: string): Promise<void> {
  try {
    // 1) 総メッセージ数 + 最新チェックポイントを並列取得
    const [countRes, cpRes] = await Promise.all([
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId),
      supabase
        .from("conversation_checkpoints")
        .select("checkpoint_index, message_count_at_creation, summary")
        .eq("conversation_id", conversationId)
        .order("checkpoint_index", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (countRes.error || cpRes.error) {
      console.warn("[checkpoint] precheck failed:", conversationId,
        countRes.error?.message ?? cpRes.error?.message);
      return; // 最新CPが読めない状態で書くと index 衝突・事実退行の恐れ → 何もしない
    }
    const total = countRes.count ?? 0;
    if (total < CHECKPOINT_MIN_MESSAGES) return;
    const last = cpRes.data as
      { checkpoint_index: number; message_count_at_creation: number; summary: string } | null;
    if (last && total - last.message_count_at_creation < MESSAGES_PER_CHECKPOINT) return;

    // 2) 前回以降の新規メッセージ（最大40件・昇順に直す）
    const newSinceLast = last ? total - last.message_count_at_creation : total;
    const { data: msgsDesc, error: msgErr } = await supabase
      .from("messages")
      .select("sender, text, created_at, is_aix_generated")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(Math.min(newSinceLast, 40));
    if (msgErr || !msgsDesc || msgsDesc.length === 0) return;
    const msgs = [...msgsDesc].reverse();

    const historyText = msgs
      .map((m) => {
        const role = m.sender === "customer" ? "顧客" : (m.is_aix_generated ? "スタッフ(AIX)" : "スタッフ");
        return `${role} ${formatJstDateShort(m.created_at as string)}: ${(m.text ?? "").slice(0, 300)}`;
      })
      .join("\n");

    // 3) Haiku（モジュール共有 client: timeout 15s / maxRetries 0 — fire-and-forget なので失敗放置でOK）
    const prompt = buildCheckpointPrompt(last?.summary ?? null, historyText, total, msgs.length);
    const response = await client.messages.create({
      model: HAIKU,
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = response.content[0]?.type === "text" ? response.content[0].text : "";
    const fb = raw.indexOf("{");
    const lb = raw.lastIndexOf("}");
    if (fb === -1 || lb <= fb) return;
    const parsed = JSON.parse(raw.slice(fb, lb + 1)) as {
      summary?: string;
      key_facts?: Array<{ type: string; value: string }>;
      stage?: string;
    };
    if (!parsed.summary || !parsed.summary.trim()) return;
    const stage = ["hearing", "proposing", "applying", "contract"].includes(parsed.stage ?? "")
      ? (parsed.stage as string) : null;

    // 4) INSERT（並走時の UNIQUE 違反 23505 は「相手が先に書いた」= 正常）
    const { error: insErr } = await supabase.from("conversation_checkpoints").insert({
      conversation_id: conversationId,
      checkpoint_index: (last?.checkpoint_index ?? 0) + 1,
      message_count_at_creation: total,
      summary: parsed.summary.slice(0, 2000),
      key_facts: Array.isArray(parsed.key_facts) ? parsed.key_facts.slice(0, 20) : [],
      conversation_stage: stage,
    });
    if (insErr && insErr.code !== "23505") {
      console.error("[checkpoint] insert failed:", conversationId, insErr.message);
    }
  } catch (e) {
    console.warn("[checkpoint] failed (fire-and-forget):", conversationId,
      e instanceof Error ? e.message : e);
  }
}

/**
 * 会話1件の脳分析を実行して conversations.suggested_aix_meta + brain_analyzed_at を書き込む。
 * webhook（顧客メッセージ受信直後）と brain-sweep cron（バックストップ）から呼ばれる。
 * 分析対象外（クローズ済み等）や分析失敗時は何も書かない（meta は null のまま → sweep が再試行）。
 */
export async function analyzeAndSaveBrainMeta(conversationId: string): Promise<boolean> {
  const { data: conv, error: selectError } = await supabase
    .from("conversations")
    .select("id, status, updated_at, property_customer_id, auto_send_enabled, line_status, is_hot, is_flagged, conversation_direction")
    .eq("id", conversationId)
    .maybeSingle();
  if (selectError) {
    // B10(Fable5): 旧実装はエラーを握り潰し「会話が存在しない」と区別不能だった
    console.error("[brain-core] conversations select failed:", conversationId, selectError.message);
    return false;
  }
  if (!conv) return false;

  const status = (conv.status as string | null) ?? null;
  if (status && BRAIN_SKIP_STATUSES.includes(status)) return false;

  // H6(Fable5): ブロック済み/フォロー解除の顧客は分析しない（Haiku浪費 + 無意味な提案の防止）
  const lineStatus = (conv.line_status as string | null) ?? null;
  if (lineStatus === "blocked" || lineStatus === "unfollowed") return false;

  // B5(Fable5): stale-write 対策のウォーターマーク。連続メッセージで分析A→Bが並走した場合、
  // 古い方（msg2を含まない解析）が後着で勝つのを防ぐ — 書き込み時に updated_at 一致を条件にする
  const watermark = conv.updated_at as string;

  const isUrgent = Date.now() - new Date(watermark).getTime() <= URGENT_WINDOW_MS;
  const meta = await analyzeConversation(
    conversationId,
    isUrgent,
    status,
    (conv.property_customer_id as string | null) ?? null,
    "brain",
    {
      autoSendEnabled: (conv.auto_send_enabled as boolean | null) ?? false,
      isHot: (conv.is_hot as boolean | null) ?? false,
      isFlagged: (conv.is_flagged as boolean | null) ?? false,
    },
  );
  if (!meta) {
    // H3(Fable5): 失敗時も brain_analyzed_at を記録 → sweep の30分バックオフに使用。
    // これが無いと決定的に失敗する会話が5分毎に永久リトライされ（最大288 Haiku呼び出し/日/行）、
    // 新しい順ソートのため10件のスタック失敗で sweep 全体が飢餓状態になっていた
    await supabase
      .from("conversations")
      .update({ brain_analyzed_at: new Date().toISOString() })
      .eq("id", conversationId)
      .eq("updated_at", watermark);
    return false;
  }

  const { error } = await supabase
    .from("conversations")
    .update({ suggested_aix_meta: meta, brain_analyzed_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("updated_at", watermark); // B5: 会話が進んでいたら古い解析は静かに no-op（sweep が補填する）
  if (error) {
    // B10(Fable5): スキーマ変更後の型不一致等、恒常的なDB障害を診断可能にする
    console.error("[brain-core] suggested_aix_meta update failed:", conversationId, error.message);
  }
  // 脳分析成功時のみチェックポイント作成を fire-and-forget 起動（レスポンスを遅らせない）
  if (!error) {
    // ── conversation_direction フェーズ変化検知と更新 ─────────────────────────
    // brain分析が成功した場合のみ実行。フェーズ変化が無い場合・スタッフ手動修正中はスキップ。
    // 失敗しても fire-and-forget なのでメインフローへの影響なし。
    try {
      // STEP A: applying_pattern カテゴリの最重要ナレッジを取得
      const { data: applyingPatterns } = await supabase
        .from("ai_reply_knowledge")
        .select("id, title, content")
        .eq("category", "applying_pattern")
        .gte("importance", 8)
        .order("importance", { ascending: false })
        .limit(1);
      const bestPattern = applyingPatterns?.[0] ?? null;

      // STEP B: brain分析結果からフェーズを推定
      const newPhase = detectPhaseFromBrainMeta(meta as Record<string, unknown>);

      // STEP C: 既存 conversation_direction を取得（conv には conversation_direction を select 済み）
      const convAsRecord = conv as unknown as Record<string, unknown>;
      const existingDir = (convAsRecord?.conversation_direction ?? null) as Record<string, unknown> | null;

      // STEP D: スキップ判定
      if (!existingDir?.manually_overridden && existingDir?.current_phase !== newPhase) {
        // STEP E: 新しい direction を構築して UPDATE
        const phaseOrder = ["hearing", "proposing", "viewing", "applying"];
        const newIdx = phaseOrder.indexOf(newPhase);
        const metaRecord = meta as Record<string, unknown>;

        // 改善1/2/3: viewing フェーズは内覧予定テーブルを参照して細かいサブフェーズを決定
        // suggested_aix_button / viewing_scheduled_at / viewing_phase_detail を動的に設定する
        type ViewingRow = { viewing_date: string; viewing_time: string | null; status: string | null };
        let viewingScheduledAt: string | null = null;
        let viewingPhaseDetail: "today" | "after_viewing" | "scheduling" | "confirmed_future" | null = null;
        let suggAixButton: string;
        let isHot = false;

        if (newPhase === "viewing") {
          // viewing_history を優先取得・存在しなければviewingsにフォールバック（後方互換）
          const { data: historyRaw } = await supabase
            .from("viewing_history")
            .select("scheduled_date, scheduled_time, status")
            .eq("conversation_id", conversationId)
            .order("scheduled_date", { ascending: false })
            .limit(10);
          const allViewings: ViewingRow[] = historyRaw && historyRaw.length > 0
            ? historyRaw.map(h => ({ viewing_date: h.scheduled_date, viewing_time: h.scheduled_time, status: h.status }))
            : await supabase
                .from("viewings")
                .select("viewing_date, viewing_time, status")
                .eq("conversation_id", conversationId)
                .order("viewing_date", { ascending: false })
                .limit(10)
                .then(r => (r.data ?? []) as ViewingRow[]);

          // JST 今日の日付を YYYY-MM-DD で取得（UTC+9 を手動計算）
          const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
          const todayJst = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowJst.getUTCDate()).padStart(2, "0")}`;

          // 最も近い未来・今日の scheduled 内覧（昇順ソートして最初の1件）
          const upcomingViewing = allViewings
            .filter(v => v.status === "scheduled" && v.viewing_date >= todayJst)
            .sort((a, b) => a.viewing_date.localeCompare(b.viewing_date))[0] ?? null;

          // 最も最近の過去内覧（done または scheduled で過去日付・cancelled は除外）
          const pastViewing = allViewings
            .filter(v => v.status === "done" || (v.status !== "cancelled" && v.viewing_date < todayJst))
            .sort((a, b) => b.viewing_date.localeCompare(a.viewing_date))[0] ?? null;

          if (upcomingViewing) {
            // 内覧日確定あり（今日または未来）
            const vDate = upcomingViewing.viewing_date;
            const vTime = upcomingViewing.viewing_time ? String(upcomingViewing.viewing_time).slice(0, 5) : null;
            viewingScheduledAt = vTime ? `${vDate}T${vTime}:00+09:00` : `${vDate}T00:00:00+09:00`;
            if (vDate === todayJst) {
              // 内覧当日 → greeting_viewing（当日挨拶）
              viewingPhaseDetail = "today";
              suggAixButton = "greeting_viewing";
              isHot = true;
            } else {
              // 内覧日確定・未来 → meeting_place（待ち合わせ案内）
              viewingPhaseDetail = "confirmed_future";
              suggAixButton = "meeting_place";
            }
          } else if (pastViewing) {
            // 内覧済み → greeting_viewing（内覧後フォロー）
            const vDate = pastViewing.viewing_date;
            const vTime = pastViewing.viewing_time ? String(pastViewing.viewing_time).slice(0, 5) : null;
            viewingScheduledAt = vTime ? `${vDate}T${vTime}:00+09:00` : `${vDate}T00:00:00+09:00`;
            viewingPhaseDetail = "after_viewing";
            suggAixButton = "greeting_viewing";
          } else {
            // 内覧日未確定 → viewing_invite（日程調整）
            viewingPhaseDetail = "scheduling";
            suggAixButton = "viewing_invite";
          }

          // calendar_events から今日この会話に紐づく内覧予定を確認 → is_hot 補完
          // viewings テーブルで today が検出されなかった場合でも calendar 側に当日予定があれば is_hot = true
          if (!isHot) {
            try {
              const todayStartUTC = new Date(`${todayJst}T00:00:00+09:00`).toISOString();
              const todayEndUTC = new Date(`${todayJst}T23:59:59+09:00`).toISOString();
              const { data: calToday } = await supabase
                .from("calendar_events")
                .select("id")
                .eq("conversation_id", conversationId)
                .eq("event_type", "viewing")
                .gte("start_at", todayStartUTC)
                .lte("start_at", todayEndUTC)
                .limit(1);
              if ((calToday?.length ?? 0) > 0) isHot = true;
            } catch {
              // calendar_events が取得できなくても処理を続行
            }
          }
        } else if (newPhase === "applying") {
          suggAixButton = "application_push";
        } else if (newPhase === "proposing") {
          suggAixButton = "property_send";
        } else {
          suggAixButton = "condition_hearing";
        }

        const newDirection = {
          template_id: bestPattern?.id ?? null,
          pattern_title: bestPattern?.title ?? "デフォルト道筋",
          approach_mode: (newPhase === "applying" || newPhase === "viewing") ? "active" : "watchful",
          direction_summary: String(metaRecord.closing_strategy ?? "申込まで丁寧にリード"),
          current_phase: newPhase,
          phases_plan: phaseOrder.map((ph, i) => ({
            phase: ph,
            label: ["条件ヒアリング", "物件提案", "内覧調整", "申込"][i],
            staff_action: ["希望条件を確認", "条件に合う物件を提案", "内覧日程を調整", "申込書類を案内"][i],
            status: i < newIdx ? "done" : i === newIdx ? "current" : "pending",
          })),
          next_staff_action: (() => {
            const raw = Array.isArray(metaRecord.next_steps)
              ? String((metaRecord.next_steps as string[])[0] ?? "")
              : String(metaRecord.next_steps ?? "");
            const src = raw.trim() || "状況を確認して次の一手を判断";
            if (/申込/.test(src)) return "お客さんの懸念点を確認しながら、申込書類の準備について自然に案内する";
            if (/内覧/.test(src)) return "物件の空き状況や他の問い合わせ状況を伝えながら、内覧日程を提案する";
            if (/物件/.test(src)) return "希望条件に合う物件を絞り込みながら、具体的な物件情報を送る";
            return src;
          })(),
          suggested_aix_button: suggAixButton,
          viewing_scheduled_at: viewingScheduledAt,
          viewing_phase_detail: viewingPhaseDetail,
          is_hot: isHot,
          matched_at: (existingDir?.matched_at as string | undefined) ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        await supabase
          .from("conversations")
          .update({ conversation_direction: newDirection })
          .eq("id", conversationId);
      }
    } catch (dirErr) {
      console.warn("[brain-core] conversation_direction update failed:", conversationId,
        dirErr instanceof Error ? dirErr.message : dirErr);
    }

    try {
      after(() => maybeCreateCheckpoint(conversationId));
    } catch {
      // リクエストコンテキスト外（テスト/スクリプト実行）では after() が使えないためフォールバック
      void maybeCreateCheckpoint(conversationId).catch(() => {});
    }
  }
  return !error;
}
