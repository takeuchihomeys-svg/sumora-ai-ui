import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const MODEL = "claude-haiku-4-5-20251001";

// AIX後続テンプレートのAI候補自動生成バッチ
//
// 過去14日間の messages.is_aix_generated=true（AIX生成文のスタッフ送信）を起点に、
// その直後15分以内に送られた非AIXスタッフ送信（=2通目・後続テンプレ）を抽出し、
// Claude Haiku で「テンプレとして再利用可能か」を判定して
// ai_template_candidates に候補として追加する。
//
// ※ 設計当初は「成功会話（closed_won / success_pattern_at）のみ」を対象とする案だったが、
//    実測で86ペア中0件が成功会話に該当したため、全ペアを対象にし
//    Haiku判定を品質ゲートとして使う方式に変更（2026-07-04 DB実測に基づく）。

// AIXアクション → テンプレートカテゴリ変換
// ※ app/api/ai-template-candidates/route.ts の ACTION_TO_CATEGORY と一致させること
//   （値は TemplateModal.tsx の実カテゴリ名）
const ACTION_TO_CATEGORY: Record<string, string> = {
  property_send: "物件送る【AIX】",
  property_recommendation: "物件オススメ【AIX】",
  property_check_result: "物件確認した【AIX】",
  viewing_invite: "内覧へ！【AIX】",
  application_push: "申込へ！【AIX】",
  meeting_place: "内覧【AIX】",
  condition_hearing: "ヒアリング【AIX】",
  estimate_sheet: "見積書送る【AIX】",
  greeting_viewing: "内覧【AIX】",
};

const ACTION_LABEL: Record<string, string> = {
  property_send: "物件送る",
  property_recommendation: "物件オススメ",
  property_check_result: "物件確認結果",
  viewing_invite: "内覧誘導",
  application_push: "申込誘導",
  meeting_place: "待ち合わせ案内",
  condition_hearing: "条件ヒアリング",
  estimate_sheet: "見積書送付",
  greeting_viewing: "内覧挨拶",
};

const LOOKBACK_DAYS = 14;
const FOLLOWUP_WINDOW_MS = 15 * 60 * 1000; // AIX送信から15分以内
const LOG_MATCH_WINDOW_MS = 10 * 60 * 1000; // aix_usage_logs との突合許容ズレ
const MIN_FOLLOWUP_LEN = 20;
const MAX_JUDGE_PER_RUN = 12; // Haiku判定に回す最大件数（コスト制御）
const MAX_INSERT_PER_RUN = 5; // 1回の実行で追加する候補の上限
const MAX_GENERATE_PER_RUN = 2; // 後続例ゼロのアクション向けAI生成の上限

type Msg = { id: string; conversation_id: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

function dedupeKey(category: string, text: string): string {
  return `${category}::${text.trim().slice(0, 50)}`;
}

function stripCodeFence(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

async function run() {
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
      .select("conversation_id, aix_type, created_at")
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

  // 3. AIX送信ごとに「直後15分以内の非AIXスタッフ送信」を後続候補として抽出し、
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

    // aix_type: 同一会話で created_at が最も近いログ（±10分）
    let bestType: string | null = null;
    let bestDiff = Infinity;
    for (const log of logs ?? []) {
      if (log.conversation_id !== aix.conversation_id) continue;
      const diff = Math.abs(new Date(log.created_at as string).getTime() - aixAt);
      if (diff < bestDiff && diff < LOG_MATCH_WINDOW_MS) {
        bestDiff = diff;
        bestType = log.aix_type as string;
      }
    }
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
    supabase.from("ai_template_candidates").select("category, template_text").limit(1000),
    supabase.from("templates").select("category, text").like("category", "%【AIX】%").limit(500),
  ]);

  const seen = new Set<string>();
  for (const c of existingCands ?? []) seen.add(dedupeKey(c.category as string, c.template_text as string));
  for (const t of existingTemplates ?? []) seen.add(dedupeKey(t.category as string, (t.text as string) ?? ""));

  const fresh: Pair[] = [];
  for (const p of pairs) {
    const key = dedupeKey(ACTION_TO_CATEGORY[p.aixType], p.followText);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(p);
    if (fresh.length >= MAX_JUDGE_PER_RUN) break;
  }

  // 5. Haiku で「テンプレとして再利用可能か」を一括判定 + タイトル付与
  let saved = 0;
  let judged = 0;
  const savedItems: Array<{ category: string; title: string }> = [];

  if (fresh.length > 0) {
    judged = fresh.length;
    const listText = fresh
      .map((p, i) => `【${i}】アクション: ${ACTION_LABEL[p.aixType] ?? p.aixType}\nAIX文(冒頭): ${p.aixText.replace(/\n/g, " ").slice(0, 120)}\n後続文:\n${p.followText}`)
      .join("\n\n---\n\n");

    try {
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: `不動産賃貸仲介のLINE接客で、AIが生成した1通目（AIX文）の直後にスタッフが手動で送った「後続文」の一覧です。
それぞれについて、他のお客様にもそのまま使い回せる「テンプレート」として登録する価値があるか判定してください。

判定基準:
- useful=true: 汎用的な案内・誘導・締め文など、顧客や物件を入れ替えても使える文
- useful=false: 特定の物件名・顧客名・日付・URL・個別事情に強く依存していて使い回せない文

usefulなものには12文字以内の日本語タイトルを付けてください。

${listText}

以下のJSON配列のみを出力（説明文・コードフェンス不要）:
[{"index": 0, "useful": true, "title": "内覧誘導の締め"}, ...]`,
        }],
      });

      const raw = res.content[0]?.type === "text" ? res.content[0].text : "[]";
      const parsed = JSON.parse(stripCodeFence(raw)) as Array<{ index: number; useful: boolean; title?: string }>;

      for (const j of parsed) {
        if (!j.useful) continue;
        if (saved >= MAX_INSERT_PER_RUN) break;
        const p = fresh[j.index];
        if (!p) continue;

        const category = ACTION_TO_CATEGORY[p.aixType];
        const title = `${(j.title?.trim() || ACTION_LABEL[p.aixType] || p.aixType).slice(0, 20)}（後続）`;

        const { error: insErr } = await supabase.from("ai_template_candidates").insert({
          action_type: p.aixType,
          category,
          suggested_title: title,
          template_text: p.followText,
          conversation_id: p.conversationId,
        });
        if (insErr) {
          console.error("[auto-template-candidates] insert error:", insErr.message);
          continue;
        }
        saved++;
        savedItems.push({ category, title });
      }
    } catch (e) {
      console.error("[auto-template-candidates] judge error:", e);
    }
  }

  // 6. 後続例が1件も見つからなかったアクション向けに、Haikuで「続きの文」を生成
  //    （窓内でそのアクションのAIX送信が3回以上あり、かつ後続候補も既存候補も無い場合のみ）
  let generated = 0;
  try {
    const typeCounts = new Map<string, { count: number; samples: string[] }>();
    for (const aix of aixMsgs as Msg[]) {
      const aixAt = new Date(aix.created_at).getTime();
      let bestType: string | null = null;
      let bestDiff = Infinity;
      for (const log of logs ?? []) {
        if (log.conversation_id !== aix.conversation_id) continue;
        const diff = Math.abs(new Date(log.created_at as string).getTime() - aixAt);
        if (diff < bestDiff && diff < LOG_MATCH_WINDOW_MS) {
          bestDiff = diff;
          bestType = log.aix_type as string;
        }
      }
      if (!bestType || !ACTION_TO_CATEGORY[bestType]) continue;
      const entry = typeCounts.get(bestType) ?? { count: 0, samples: [] };
      entry.count++;
      if (entry.samples.length < 3 && aix.text) entry.samples.push(aix.text.slice(0, 200));
      typeCounts.set(bestType, entry);
    }

    const typesWithFollowups = new Set(pairs.map((p) => p.aixType));
    const pendingByCategory = new Set((existingCands ?? []).map((c) => c.category as string));

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

  console.log(`[auto-template-candidates] done: pairs=${pairs.length} judged=${judged} saved=${saved} generated=${generated}`);
  return NextResponse.json({ ok: true, pairs: pairs.length, judged, saved, generated, savedItems });
}

// GET: Vercel cron から（CRON_SECRET が設定されていれば Bearer 認証）
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }
  return run();
}

// POST: 手動実行
export async function POST() {
  return run();
}
