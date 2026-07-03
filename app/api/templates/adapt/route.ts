import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "") });

export async function POST(req: NextRequest) {
  const {
    templateText,
    customerName,
    conversationState,
    recentMessages,
    customerConditions,
    noEmoji,
    soloEntry,
    pendingScheduledMessages,
    vacatingDate,
    staffMessagedToday,
  } = await req.json() as {
    templateText: string;
    customerName?: string;
    conversationState?: string;
    recentMessages?: Array<{ sender: string; text: string; imageUrl?: string }>;
    customerConditions?: string;
    noEmoji?: boolean;
    soloEntry?: boolean;
    pendingScheduledMessages?: Array<{ text: string | null }>;
    vacatingDate?: { month: number; day: number } | null;
    staffMessagedToday?: boolean;
  };

  if (!templateText) {
    return NextResponse.json({ ok: false, error: "templateText is required" }, { status: 400 });
  }

  // 退去予定日・内覧可能日を前処理でテンプレートに埋め込む
  // ◯(U+25EF)・○(U+25CB)・〇(U+3007) の3種を統一して扱う
  const lastDayOf = (m: number) => new Date(new Date().getFullYear(), m, 0).getDate();
  let processedTemplateText = templateText;
  const C = '[◯○〇]'; // 丸文字クラス（DBは◯多用）

  // 退去日・内覧可能日を計算
  let vacStr: string | null = null;
  let viewStr: string | null = null;
  if (vacatingDate) {
    const last = lastDayOf(vacatingDate.month);
    const vacDay = Math.min(vacatingDate.day, last);
    vacStr = `${vacatingDate.month}月${vacDay}日`;
    // 内覧可能日 = 退去日 + 1日（月をまたぐ場合も対応）
    let vm = vacatingDate.month;
    let vd = vacDay + 1;
    if (vd > lastDayOf(vm)) { vd = 1; vm = vm === 12 ? 1 : vm + 1; }
    viewStr = `${vm}月${vd}日`;
  }

  // パターン優先順: 複合パターン（両日付）を先に処理してから単体パターンへ
  // 1) 〇月〇日退去の為〇月〇日以降ご内覧可能
  processedTemplateText = processedTemplateText.replace(
    new RegExp(`${C}+月${C}+日退去の為${C}+月${C}+日以降ご内覧可能`, 'g'),
    vacStr && viewStr ? `${vacStr}退去の為${viewStr}以降ご内覧可能` : '退去の為内覧可能日以降ご内覧可能'
  );
  // 2) 〇月〇退去予定の為〇月〇日以降ご内覧可能（「日」なしバリアント）
  processedTemplateText = processedTemplateText.replace(
    new RegExp(`${C}+月${C}+退去予定の為${C}+月${C}+日以降ご内覧可能`, 'g'),
    vacStr && viewStr ? `${vacStr}退去予定の為${viewStr}以降ご内覧可能` : '退去予定の為内覧可能日以降ご内覧可能'
  );
  // 3) 〇月〇日以降ご内覧可能（単体・上のパターン未処理の残り）
  processedTemplateText = processedTemplateText.replace(
    new RegExp(`${C}+月${C}+日以降ご内覧可能`, 'g'),
    viewStr ? `${viewStr}以降ご内覧可能` : '内覧可能日以降ご内覧可能'
  );
  // 4) 〇月〇日退去予定（単体）
  processedTemplateText = processedTemplateText.replace(
    new RegExp(`${C}+月${C}+日退去予定`, 'g'),
    vacStr ? `${vacStr}退去予定` : '退去予定'
  );

  // 挨拶をルールに従って前処理で差し替える
  const GREETING_RE = /お世話になっております！！?|お待たせ致しました！！?|夜分遅くに失礼致します！！?/g;
  if (GREETING_RE.test(processedTemplateText)) {
    const jstHour = (new Date().getUTCHours() + 9) % 24;
    const correctGreeting = staffMessagedToday
      ? (jstHour >= 21 ? "夜分遅くに失礼致します！！" : "お待たせ致しました！！")
      : "お世話になっております！！";
    processedTemplateText = processedTemplateText.replace(
      /お世話になっております！！?|お待たせ致しました！！?|夜分遅くに失礼致します！！?/g,
      correctGreeting,
    );
  }

  // DBからテンプレート追加ルールを取得
  const { data: dbRule } = await supabase
    .from("ai_prompts")
    .select("content")
    .eq("key", "template_adapt_rules")
    .single();
  const extraRules = dbRule?.content ?? "";

  const history = (recentMessages || [])
    .slice(-15)
    .map((m) => {
      const who = m.sender === "customer" ? "お客様" : "スモラ";
      if (m.text === "[画像]" || m.text === "[動画]") return `${who}: 【画像・資料を送付】`;
      if (!m.text) return null;
      return `${who}: ${m.text}`;
    })
    .filter(Boolean)
    .join("\n");

  const STATE_LABEL: Record<string, string> = {
    first_reply: "初回応対", condition_hearing: "条件ヒアリング",
    property_search: "物件探し中", property_recommendation: "物件提案中",
    viewing: "内覧調整", estimate_request: "見積依頼",
    availability_check: "空室確認", application: "申込中",
    screening: "審査中", contract: "契約中", closed_won: "成約済み",
  };
  const stateLabel = STATE_LABEL[conversationState || ""] || conversationState || "不明";

  const conditionsSection = customerConditions
    ? `\n【お客様の希望条件（DB登録済み）】\n${customerConditions}\n`
    : "";

  // 予約送信待ちのAIX生成文（物件情報の最優先ソース）
  const pendingSection = (pendingScheduledMessages ?? [])
    .map((m) => m.text ?? "")
    .filter(Boolean)
    .join("\n\n---\n\n");

  // 直近のお客様メッセージを抽出（最新3件）
  const recentCustomerRequests = (recentMessages || [])
    .filter(m => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .slice(-3)
    .map(m => m.text)
    .join(" / ");

  const prompt = `あなたはスモラ（賃貸仲介サービス）のLINE営業担当です。
以下のテンプレートは「構成のひな型」です。お客様情報・会話履歴をもとに、このお客様・この物件に合った文章に仕上げてください。

━━━━━━━━━━━━━━━━━━━━
【絶対ルール — 構造を壊さない】
━━━━━━━━━━━━━━━━━━━━
・テンプレートの段落数・文章の大きな流れを変えない
・新しい段落・まったく新しい話題を追加しない

━━━━━━━━━━━━━━━━━━━━
【やること① — プレースホルダーを実際の値に置き換える】
━━━━━━━━━━━━━━━━━━━━
・「アカウント名」→ 「${customerName || "〇〇"}さん」
・「マンション名」「物件名」「〇〇マンション」などの物件名プレースホルダー → 会話・予約送信から読み取った実際の物件名
・「○月○日」「〇〇円」「〇〇分」などの数値プレースホルダー → 実際の値
・「〇〇」「○○」→ 文脈に合った具体的な内容
・情報が会話履歴にない場合は「〇〇」のまま残す（でたらめな値を入れない）

━━━━━━━━━━━━━━━━━━━━
【やること② — テンプレートに含まれる固有名詞を今回の物件に合わせる】
━━━━━━━━━━━━━━━━━━━━
テンプレートに特定の物件名（例:「Sierra深江南」「エグゼ〜」など）が入っている場合：
→ 会話履歴・予約送信から読み取った「今回の物件名」に必ず置き換える。
→ 今回の物件名が不明な場合は「〇〇」に置き換える（前の物件名をそのまま残してはいけない）

━━━━━━━━━━━━━━━━━━━━
【やること③ — 曖昧な訴求をお客様に合った内容に書き換える】
━━━━━━━━━━━━━━━━━━━━
・「条件が良いお部屋」→ 物件の具体的な強み（家賃・間取り・設備など）に書き換える
・「オススメポイント」「特にオススメの理由」→ 物件の具体的な強みに書き換える
・「ご上限に近い家賃」「ご予算内」→ 実際の家賃金額に書き換える

━━━━━━━━━━━━━━━━━━━━
【★重要★ 条件付き省略ルール】
━━━━━━━━━━━━━━━━━━━━
お客様が「希望エリア」「希望駅」「徒歩分数」を一切指定していない場合：
→ テンプレート内の「〇〇線〜駅」「徒歩〇分」「電車〇本」「〇〇まで〇分」などの駅・路線・アクセス情報を含む行や文を完全に省略する。
→ テンプレートに駅情報が書いてあっても、お客様が求めていないなら入れない。

━━━━━━━━━━━━━━━━━━━━
【スモラ品質ルール】
━━━━━━━━━━━━━━━━━━━━
・感嘆符は「！！」（全角2つ）のみ使用。「!」「！」1つは絶対禁止
${noEmoji ? "・絵文字は一切使用しない（テンプレートに絵文字があっても全て削除）" : "・使える絵文字: 😊 😌 🙇‍♀️ 🌟 ✨（1〜2個まで。テンプレートに絵文字がなければ追加不要）"}
・お客様名は「${customerName || "〇〇"}さん」と完全な名前で呼ぶ
・間取りの広さを書く順番: LDK→洋室の順（例: 「LDK8帖の洋室3.4帖」）。洋室から書き始めるのは絶対禁止

━━━━━━━━━━━━━━━━━━━━
【絶対禁止事項】
━━━━━━━━━━━━━━━━━━━━
・設備（Wi-Fi・エアコン等）を「月額○円お得」のような金額換算で表現しない
・「申し訳ございません」「失礼いたしました」などの謝罪表現
・テンプレートにない全く新しい段落・話題を追加しない
・前回の物件名・架空の駅名・でたらめな数値を入れない
・「アカウント名」の直前・直後に語句を付け加えない。「〇〇さんがご満足頂く」→「Sさんがご満足頂く」のように単純置換のみ。「オススメできるSさん」「よりSさん」のように前後に言葉を追加するのは絶対禁止

━━━━━━━━━━━━━━━━━━━━
【禁止ワード・表現リスト — 必ず守ること】
━━━━━━━━━━━━━━━━━━━━
× 「スモラ」という会社名 → 必ず「弊社」を使う
× 「コスパが高い」「コスパ最高」「コスパ良い」等コスパ表現 → 「好条件」「お値打ちな条件」に変える
× 「共益費込み」「共益費込」→ 「家賃管理費込」を使う
× 「すぐに」「今すぐ」→ 「出来次第」「本日中に」を使う
× 「即入居可能」→ 会話・物件資料に明記されていない場合は絶対に書かない
× 「〇〇エリアから」「〇〇エリアを中心に」→ 「〇〇周辺全域」に変える
× 「承りました」「ご確認のほど」「確認中です」→ 使わない
× 「〇〇とのことですね」「〇〇をご希望ですね」（オウム返し）→ 使わない
× 「スモラにてお取り扱い可能か確認」→ 「募集状況確認させていただきます！！」を使う
× 「ご共有頂き」→ お客様に対しては「お送り頂き」を使う
× 「緊急連絡先設定可」→ 「緊急連絡先でご入居可能」を使う
× 「仲介手数料を割引」→ 割引するのは「初期費用」全体。正しい表現：「初期費用を最大限割引させていただきます」
× 「少々お待ちください」→ 使わない
× 「まず〜、次に〜」（列挙構成）→ 使わない
× 「**テキスト**」のようなマークダウン太字 → LINEはマークダウン非対応のため「**」がそのまま表示される。絶対に使わない
× 「〇〇さんはい！！」「〇〇さんかしこまりました！！」 → 冒頭が「はい！！」「かしこまりました！！」の場合は名前を置かない

━━━━━━━━━━━━━━━━━━━━
【不動産専門知識ルール — 誤ると致命的】
━━━━━━━━━━━━━━━━━━━━
【敷金・礼金・管理費の正しい理解】
・敷金は退去時に返還される預かり金 → 「敷金なしで初期費用が安い」は絶対禁止（敷金は戻ってくるため初期費用削減にはならない）
・礼金は返還されない費用 → 礼金なしのみ初期費用削減として訴求可
・敷金・礼金が両方0円の場合のみ「敷金礼金なし」と書ける。片方でも金額があれば「敷金礼金なし」は絶対禁止
・管理費は月額費用であり初期費用ではない → 「管理費なしで初期費用を抑えられる」は絶対禁止
・「敷金・礼金なし・管理費なし」を並べて初期費用の安さを表現しない

【連帯保証人と緊急連絡先の違い — 混同厳禁】
・連帯保証人: 家賃不払い時に支払い義務が発生する法的責任あり。実印+印鑑証明書が必要
・緊急連絡先: 万が一の際に電話が入るだけ。支払い義務は一切なし
→ この2つを混同・取り違えないこと

【号室番号の表記ルール】
・日本の号室は0から始まらない。「0906号室」等の先頭ゼロは必ず除去すること
× 0906号室 → ○ 906号室 / × 0102号室 → ○ 102号室 / × 0806号室 → ○ 806号室

━━━━━━━━━━━━━━━━━━━━
【情報の優先順位】
━━━━━━━━━━━━━━━━━━━━
① 予約送信待ちのAIXメッセージ（物件名・家賃・間取り・オススメポイントを最優先で読む）
② 会話履歴に出てきた物件の具体情報
③ お客様の希望条件（DB）に記載のこだわり・条件を反映
④ 見つからない場合はそのまま or 「〇〇」のまま残す

━━━━━━━━━━━━━━━━━━━━
【お客様情報】
━━━━━━━━━━━━━━━━━━━━
・名前: ${customerName || "不明"}
・現在のフェーズ: ${stateLabel}
${conditionsSection}
${pendingSection ? `━━━━━━━━━━━━━━━━━━━━
【🔑 予約送信待ちのAIXメッセージ（物件名・家賃・オススメポイントはここから読む）】
━━━━━━━━━━━━━━━━━━━━
${pendingSection}

` : ""}【お客様の直近の発言】
${recentCustomerRequests || "なし"}

【直近の会話履歴（予約送信がある場合は補助情報として参照）】
${history || "なし"}

━━━━━━━━━━━━━━━━━━━━
【置き換えるテンプレート】
━━━━━━━━━━━━━━━━━━━━
${processedTemplateText}

━━━━━━━━━━━━━━━━━━━━
${extraRules ? `${extraRules}\n\n━━━━━━━━━━━━━━━━━━━━\n` : ""}${soloEntry ? `【1人入居モード — 厳守】以下のキーワードを含む行はすべて出力しない（完全に削除）：同居人・配偶者・同居者・家族構成・入居人数・お子様・子ども・子供・同居・ご家族\n\n━━━━━━━━━━━━━━━━━━━━\n` : ""}出力は置き換え後のテキストのみ。説明・前置き・補足コメントは一切書かない。`;

  try {
    const msg = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    let adapted = msg.content[0].type === "text" ? msg.content[0].text.trim() : templateText;
    // 号室の先頭ゼロを除去（日本の号室は0始まりにならない: 0906→906）
    adapted = adapted.replace(/(?<!\d)0+(\d+)号室/g, "$1号室");
    return NextResponse.json({ ok: true, adapted });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI最適化エラー";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
