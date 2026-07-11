import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, timeout: 30_000 });
const MODEL = "claude-haiku-4-5-20251001";

// AIX後続テンプレートのAI候補自動生成バッチ
//
// 過去14日間の messages.is_aix_generated=true（AIX生成文のスタッフ送信）を起点に、
// その直後30分以内に送られた非AIXスタッフ送信（=2通目・後続テンプレ）を抽出し、
// Claude Haiku で固有情報（物件名・住所・日付・顧客名等）を汎用プレースホルダーに
// 「変換」して ai_template_candidates に候補として追加する。
//
// ※ 設計当初は「成功会話（closed_won / success_pattern_at）のみ」を対象とする案だったが、
//    実測で86ペア中0件が成功会話に該当したため、全ペアを対象に変更（2026-07-04 DB実測）。
// ※ 当初は Haiku に「使えるか判定」させていたが、実際のLINE文は物件名・日付を含むため
//    ほぼ全て「固有情報あり→使えない」と落とされ、86ペア中2件しか候補にならなかった
//    （スループット2.3%）。「判定」→「変換」方式に変更（2026-07-04）。

// AIXアクション → テンプレートカテゴリ変換
// ※ app/api/ai-template-candidates/route.ts の ACTION_TO_CATEGORY と一致させること
//   （値は TemplateModal.tsx の実カテゴリ名）
const ACTION_TO_CATEGORY: Record<string, string> = {
  property_send: "物件ピックアップした【AIX】",
  property_recommendation: "物件オススメ【AIX】",
  property_check_result: "物件確認した【AIX】",
  viewing_invite: "内覧へ！【AIX】",
  application_push: "申込へ！【AIX】",
  meeting_place: "内覧【AIX】",
  condition_hearing: "ヒアリング【AIX】",
  estimate_sheet: "見積書送る【AIX】",
  greeting_viewing: "内覧【AIX】",
  followup_revive: "追客【AIX】",
  acknowledge_check: "確認します【AIX】",
};

const ACTION_LABEL: Record<string, string> = {
  property_send: "物件ピックアップした",
  property_recommendation: "物件オススメ",
  property_check_result: "物件確認結果",
  viewing_invite: "内覧誘導",
  application_push: "申込誘導",
  meeting_place: "待ち合わせ案内",
  condition_hearing: "条件ヒアリング",
  estimate_sheet: "見積書送付",
  greeting_viewing: "内覧挨拶",
  followup_revive: "追客メッセージ",
  acknowledge_check: "確認します",
};

const LOOKBACK_DAYS = 14;
const FOLLOWUP_WINDOW_MS = 30 * 60 * 1000; // AIX送信から30分以内（15分では短すぎてキャプチャ率が低かったため拡張）
const LOG_MATCH_WINDOW_MS = 10 * 60 * 1000; // aix_usage_logs との突合許容ズレ（sent_at無し旧レコード用フォールバック）
// P4: sent_at ベース厳密マッチ（LINE送信タイムラグを考慮して sent_at の30秒前〜5分後を許容）
const SENT_AT_BEFORE_MS = 30 * 1000;
const SENT_AT_AFTER_MS = 5 * 60 * 1000;
const MIN_FOLLOWUP_LEN = 20;
const MAX_CONVERT_PER_RUN = 30; // Haiku変換に回す最大件数（並列呼び出し・コスト制御）
const MAX_INSERT_PER_RUN = 30; // 1回の実行で追加する候補の上限
// Haiku架空生成は廃止 - 実データがある場合のみ候補化する（P3: 2026-07-11）
// const MAX_GENERATE_PER_RUN = 2; // 後続例ゼロのアクション向けAI生成の上限
// P3: 同一アクション・類似後続パターンが2回以上観測された場合のみ候補化（単発ノイズ排除）
const MIN_SIMILAR_COUNT = 2;
const SIMILARITY_THRESHOLD = 0.6;

// Haiku 変換用システムプロンプト（判定ではなく「汎用テンプレへの変換」を依頼する）
const CONVERT_SYSTEM_PROMPT = `あなたは不動産賃貸仲介LINEテンプレートの編集者です。
スタッフが実際にお客様へ送った文を、他のお客様にもそのまま使い回せる汎用テンプレートに変換します。

## 変換ルール
1. 固有の物件名 → 「〇〇物件」または「ご紹介の物件」
2. 固有の住所・駅名 → 「〇〇駅付近」または「ご紹介のエリア」
3. 日時 → 「〇月〇日」または「近日中」
4. 顧客名 → 「アカウント名さん」（既にプレースホルダーの場合はそのまま）
5. 担当者名 → 削除または「担当」に変換
6. 金額の具体的な数字 → 「〇万円」
7. 個別URL → 削除（削除しても文が成立する場合のみ）

文のトーン・絵文字・改行・言い回しは極力そのまま残すこと。

## スキップ条件（変換しても意味をなさない場合のみ skip=true）
- 固有情報を除くと文が成立しない（例：「はい、〇〇物件は空室です」だけになる）
- 挨拶だけで内容がない（例：「よろしくお願いします！！」のみ）
- 既存テンプレートと重複・類似している

## 出力形式（JSONのみ・説明文・コードフェンス不要）
{"converted": "変換後の汎用テンプレ文", "title": "12文字以内の日本語タイトル", "skip": false, "skip_reason": null}
skip=true の場合:
{"converted": null, "title": null, "skip": true, "skip_reason": "理由"}`;

type Msg = { id: string; conversation_id: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type UsageLog = { conversation_id: string; aix_type: string; created_at: string; sent_at: string | null };

// AIXメッセージ（created_at=aixAt）に対応する aix_usage_logs レコードの aix_type を特定する。
// P4: sent_at があるログは厳密マッチ（message.created_at が sent_at-30秒〜sent_at+5分）を優先し、
//     sent_at 無しの旧ログのみ ±10分ヒューリスティックでフォールバック。
function matchAixType(logs: UsageLog[], conversationId: string, aixAt: number): string | null {
  let bestType: string | null = null;
  let bestDiff = Infinity;
  let bestIsExact = false;
  for (const log of logs) {
    if (log.conversation_id !== conversationId) continue;
    if (log.sent_at) {
      const delta = aixAt - new Date(log.sent_at).getTime();
      if (delta >= -SENT_AT_BEFORE_MS && delta <= SENT_AT_AFTER_MS) {
        const diff = Math.abs(delta);
        if (!bestIsExact || diff < bestDiff) {
          bestIsExact = true;
          bestDiff = diff;
          bestType = log.aix_type;
        }
      }
    } else if (!bestIsExact) {
      const diff = Math.abs(new Date(log.created_at).getTime() - aixAt);
      if (diff < bestDiff && diff < LOG_MATCH_WINDOW_MS) {
        bestDiff = diff;
        bestType = log.aix_type;
      }
    }
  }
  return bestType;
}

function dedupeKey(category: string, text: string): string {
  return `${category}::${text.trim().slice(0, 50)}`;
}

// P3: 文字bigramのDice係数による簡易テキスト類似度（0〜1）
// analyze-template-modifications/route.ts の textSimilarity と同一ロジック
function textSimilarity(a: string, b: string): number {
  const na = a.replace(/\s+/g, "");
  const nb = b.replace(/\s+/g, "");
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigrams(na);
  const mb = bigrams(nb);
  let overlap = 0;
  for (const [g, ca] of ma) overlap += Math.min(ca, mb.get(g) ?? 0);
  return (2 * overlap) / (na.length - 1 + nb.length - 1);
}

function stripCodeFence(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

async function run() {
  const runLogId = await startCronLog("auto-template-candidates");
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // 1. 過去14日のAIX生成スタッフ送信を取得
  const { data: aixMsgs, error: aixErr } = await supabase
    .from("messages")
    .select("id, conversation_id, text, created_at, is_aix_generated")
    .eq("is_aix_generated", true)
    .eq("sender", "staff")
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(500);

  if (aixErr) return NextResponse.json({ ok: false, error: aixErr.message }, { status: 500 });
  if (!aixMsgs?.length) return NextResponse.json({ ok: true, saved: 0, message: "no AIX messages in window" });

  const convIds = [...new Set(aixMsgs.map((m) => m.conversation_id as string))];

  // 2. 対象会話のスタッフ送信（後続候補）と aix_usage_logs をまとめて取得
  const [{ data: staffMsgs, error: staffErr }, { data: logs, error: logErr }] = await Promise.all([
    supabase
      .from("messages")
      .select("id, conversation_id, text, created_at, is_aix_generated")
      .in("conversation_id", convIds)
      .eq("sender", "staff")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(3000),
    supabase
      .from("aix_usage_logs")
      .select("conversation_id, aix_type, created_at, sent_at")
      .in("conversation_id", convIds)
      .gte("created_at", since)
      .limit(1000),
  ]);

  if (staffErr) return NextResponse.json({ ok: false, error: staffErr.message }, { status: 500 });
  if (logErr) return NextResponse.json({ ok: false, error: logErr.message }, { status: 500 });

  const msgsByConv = new Map<string, Msg[]>();
  for (const m of (staffMsgs ?? []) as Msg[]) {
    const arr = msgsByConv.get(m.conversation_id) ?? [];
    arr.push(m);
    msgsByConv.set(m.conversation_id, arr);
  }

  // 3. AIX送信ごとに「直後30分以内の非AIXスタッフ送信」を後続候補として抽出し、
  //    aix_usage_logs の最近接レコードから aix_type を付与
  type Pair = { aixType: string; aixText: string; followText: string; conversationId: string };
  const pairs: Pair[] = [];

  for (const aix of aixMsgs as Msg[]) {
    const aixAt = new Date(aix.created_at).getTime();
    const convMsgs = msgsByConv.get(aix.conversation_id as string) ?? [];

    const follow = convMsgs.find((m) => {
      const t = new Date(m.created_at).getTime();
      return (
        !m.is_aix_generated &&
        t > aixAt &&
        t <= aixAt + FOLLOWUP_WINDOW_MS &&
        (m.text?.trim().length ?? 0) > MIN_FOLLOWUP_LEN
      );
    });
    if (!follow?.text) continue;

    // aix_type: P4 sent_at 厳密マッチ（旧レコードは ±10分フォールバック）
    const bestType = matchAixType((logs ?? []) as UsageLog[], aix.conversation_id as string, aixAt);
    if (!bestType || !ACTION_TO_CATEGORY[bestType]) continue;

    pairs.push({
      aixType: bestType,
      aixText: (aix.text ?? "").slice(0, 200),
      followText: follow.text.trim(),
      conversationId: aix.conversation_id as string,
    });
  }

  // 4. 重複除去：既存候補（採用済み・却下済み含む）＋既存テンプレ＋今回実行内
  const [{ data: existingCands }, { data: existingTemplates }] = await Promise.all([
    supabase.from("ai_template_candidates").select("category, template_text, is_dismissed, is_adopted").limit(1000),
    supabase.from("templates").select("category, text").like("category", "%【AIX】%").limit(500),
  ]);

  // `seen` = 変換後テキストのdedup（DBレコード + バッチ内変換後）
  const seen = new Set<string>();
  for (const c of existingCands ?? []) seen.add(dedupeKey(c.category as string, c.template_text as string));
  for (const t of existingTemplates ?? []) seen.add(dedupeKey(t.category as string, (t.text as string) ?? ""));

  // F2: `seenPre` = 変換前テキストのバッチ内dedup。seen と混在させると pre/post キーが衝突する
  const seenPre = new Set<string>();
  const fresh: Pair[] = [];
  for (const p of pairs) {
    const preKey = dedupeKey(ACTION_TO_CATEGORY[p.aixType], p.followText);
    if (seenPre.has(preKey)) continue;
    seenPre.add(preKey);
    // P3閾値: 同一アクション・類似パターン（bigram Dice >= 0.6）が2回以上ある場合のみ候補化
    //（自分自身を含むカウントのため、他に最低1件の類似後続が必要 = 単発の後続文は候補化しない）
    const similarCount = pairs.filter(
      (q) => q.aixType === p.aixType && textSimilarity(q.followText, p.followText) >= SIMILARITY_THRESHOLD
    ).length;
    if (similarCount < MIN_SIMILAR_COUNT) continue; // 1回だけの場合はスキップ
    fresh.push(p);
    // C04: 変換上限を保存上限に揃える（MAX_CONVERT_PER_RUN=30 に対し MAX_INSERT_PER_RUN=10 で
    //      20件分の Haiku 呼び出しが無駄になるため）
    if (fresh.length >= MAX_INSERT_PER_RUN) break;
  }

  // 5. Haiku で固有情報を汎用プレースホルダーに「変換」（並列呼び出し）
  //    変換不能で意味をなさない文のみスキップ。既存テンプレ一覧を渡して重複・類似もスキップ。
  let saved = 0;
  let converted = 0;
  let skipped = 0;
  const savedItems: Array<{ category: string; title: string }> = [];

  if (fresh.length > 0) {
    // カテゴリ別の既存テンプレ一覧（重複・類似スキップ判定用にプロンプトへ渡す）
    const templatesByCategory = new Map<string, string[]>();
    for (const t of existingTemplates ?? []) {
      const cat = t.category as string;
      const arr = templatesByCategory.get(cat) ?? [];
      if (arr.length < 10) arr.push(((t.text as string) ?? "").replace(/\n/g, " ").slice(0, 50));
      templatesByCategory.set(cat, arr);
    }

    type ConvertResult = { converted: string | null; title?: string | null; skip: boolean; skip_reason?: string | null };

    const results = await Promise.allSettled(
      fresh.map(async (p): Promise<ConvertResult> => {
        const existing = templatesByCategory.get(ACTION_TO_CATEGORY[p.aixType]) ?? [];
        const res = await client.messages.create({
          model: MODEL,
          max_tokens: 800,
          system: CONVERT_SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: `アクション: ${ACTION_LABEL[p.aixType] ?? p.aixType}
AIX文（1通目・冒頭）: ${p.aixText.replace(/\n/g, " ").slice(0, 120)}

変換対象の後続文:
${p.followText}

既存テンプレート（重複・類似する場合は skip=true にすること）:
${existing.length > 0 ? existing.map((t) => `- ${t}`).join("\n") : "（なし）"}`,
          }],
        });
        const raw = res.content[0]?.type === "text" ? res.content[0].text : "{}";
        return JSON.parse(stripCodeFence(raw)) as ConvertResult;
      })
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const p = fresh[i];
      if (r.status !== "fulfilled") {
        console.error("[auto-template-candidates] convert error:", r.reason);
        continue;
      }
      if (r.value.skip || !r.value.converted?.trim()) {
        skipped++;
        continue;
      }
      converted++;
      if (saved >= MAX_INSERT_PER_RUN) continue;

      const category = ACTION_TO_CATEGORY[p.aixType];
      const templateText = r.value.converted.trim();

      // 変換後テキストでも重複チェック（変換前キーとは別物になるため）
      const key = dedupeKey(category, templateText);
      if (seen.has(key)) continue;
      seen.add(key);

      const title = `${(r.value.title?.trim() || ACTION_LABEL[p.aixType] || p.aixType).slice(0, 20)}（後続）`;

      const { error: insErr } = await supabase.from("ai_template_candidates").insert({
        action_type: p.aixType,
        category,
        suggested_title: title,
        template_text: templateText,
        conversation_id: p.conversationId,
        source: "auto",
      });
      if (insErr) {
        console.error("[auto-template-candidates] insert error:", insErr.message);
        continue;
      }
      saved++;
      savedItems.push({ category, title });
    }
  }

  // 6. 後続例が1件も見つからなかったアクション向けのHaiku「続きの文」生成
  // Haiku架空生成は廃止 - 実データがある場合のみ候補化する（P3: 2026-07-11）
  // データの裏付けがないゼロベース生成は却下率が高くノイズになるため無効化（削除ではなくコメントアウトで保持）
  const generated = 0;
  /*
  try {
    const typeCounts = new Map<string, { count: number; samples: string[] }>();
    for (const aix of aixMsgs as Msg[]) {
      const aixAt = new Date(aix.created_at).getTime();
      const bestType = matchAixType((logs ?? []) as UsageLog[], aix.conversation_id as string, aixAt);
      if (!bestType || !ACTION_TO_CATEGORY[bestType]) continue;
      const entry = typeCounts.get(bestType) ?? { count: 0, samples: [] };
      entry.count++;
      if (entry.samples.length < 3 && aix.text) entry.samples.push(aix.text.slice(0, 200));
      typeCounts.set(bestType, entry);
    }

    const typesWithFollowups = new Set(pairs.map((p) => p.aixType));
    const pendingByCategory = new Set(
      (existingCands ?? [])
        .filter((c) => !c.is_dismissed && !c.is_adopted)
        .map((c) => c.category as string)
    );

    for (const [actionType, entry] of typeCounts) {
      if (generated >= MAX_GENERATE_PER_RUN) break;
      if (entry.count < 3) continue;
      if (typesWithFollowups.has(actionType)) continue;
      const category = ACTION_TO_CATEGORY[actionType];
      if (pendingByCategory.has(category)) continue;

      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 500,
        messages: [{
          role: "user",
          content: `不動産賃貸仲介のLINE接客で、以下のようなAI生成文（${ACTION_LABEL[actionType] ?? actionType}）を送った直後に続けて送る「2通目の後続メッセージ」を1つ作成してください。

AIX文の例:
${entry.samples.map((s) => `- ${s.replace(/\n/g, " ")}`).join("\n")}

条件:
- 汎用テンプレート（特定の物件名・顧客名・日付を入れない）
- 丁寧でフレンドリーな口調（「〜です！！」「😊」など既存文のトーンに合わせる）
- 3〜5文程度

以下のJSONのみを出力（説明文・コードフェンス不要）:
{"title": "12文字以内のタイトル", "text": "後続メッセージ本文"}`,
        }],
      });

      const raw = res.content[0]?.type === "text" ? res.content[0].text : "{}";
      const gen = JSON.parse(stripCodeFence(raw)) as { title?: string; text?: string };
      if (!gen.text?.trim()) continue;

      const key = dedupeKey(category, gen.text);
      if (seen.has(key)) continue;
      seen.add(key);

      const { error: insErr } = await supabase.from("ai_template_candidates").insert({
        action_type: actionType,
        category,
        suggested_title: `${(gen.title?.trim() || ACTION_LABEL[actionType] || actionType).slice(0, 20)}（AI生成・後続）`,
        template_text: gen.text.trim(),
        conversation_id: null,
        source: "auto",
      });
      if (insErr) {
        console.error("[auto-template-candidates] gen insert error:", insErr.message);
        continue;
      }
      generated++;
    }
  } catch (e) {
    console.error("[auto-template-candidates] generate error:", e);
  }
  */

  console.log(`[auto-template-candidates] done: pairs=${pairs.length} sent=${fresh.length} converted=${converted} skipped=${skipped} saved=${saved} generated=${generated}`);
  await finishCronLog(runLogId, true, { pairs: pairs.length, sent: fresh.length, converted, skipped, saved, generated });
  return NextResponse.json({ ok: true, pairs: pairs.length, sent: fresh.length, converted, skipped, saved, generated, savedItems });
}

// GET: Vercel cron から（CRON_SECRET が設定されていれば Bearer 認証）
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    // CRON_SECRET 未設定時も全拒否（fail-closed）
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return run();
}

// POST: 手動実行
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    // CRON_SECRET 未設定時も全拒否（fail-closed）
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return run();
}
