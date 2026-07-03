import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { normalizeStatus } from "@/app/lib/status-normalize";

const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
const HAIKU = "claude-haiku-4-5-20251001";

// 昇格可能な次ステータス（現在→次）
const NEXT_STATUS: Record<string, { key: string; label: string }> = {
  hearing:   { key: "proposing", label: "物件提案中" },
  proposing: { key: "applying",  label: "申込・審査中" },
};

// 提案しないステータス
const SKIP = new Set(["applying", "closed_won", "closed_lost", "lost"]);

export async function POST(req: NextRequest) {
  const { conversation_id } = await req.json() as { conversation_id: string };
  if (!conversation_id) return NextResponse.json({ suggested: null });

  const [{ data: conv }, { data: messages }] = await Promise.all([
    supabase.from("conversations")
      .select("status, last_sender, customer_name")
      .eq("id", conversation_id)
      .single(),
    supabase.from("messages")
      .select("sender, text, created_at")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (!conv || !messages?.length) return NextResponse.json({ suggested: null });

  const rawStatus = (conv.status as string) ?? "hearing";

  // 旧ステータスキーを正規化（共通モジュールを使用）
  const currentStatus = normalizeStatus(rawStatus);

  // ---- キーワード即時検知（Haiku不要・B-3-②）----
  const msgsAsc = [...messages].reverse(); // 古い順
  const lastCustomerMsg = ((msgsAsc.filter((m) => m.sender === "customer").at(-1)?.text as string) ?? "");
  const recentStaffMsgs = msgsAsc.filter((m) => m.sender === "staff").slice(-5).map((m) => (m.text as string) ?? "");

  // ① 失注検知（顧客発言・クローズ済み以外の全ステータスで発火）
  if (!["closed_lost", "closed_won"].includes(currentStatus) && conv.last_sender === "customer") {
    const LOST_KEYWORDS = [
      "他で決まり", "他に決まり", "他社で決め", "他の不動産", "別の不動産",
      "キャンセルします", "キャンセルさせて", "キャンセルでお願い", "キャンセルで",
      "やめます", "やめときます", "やめておきます", "見送ります", "見送らせて",
    ];
    // 「決まりました」単体は文脈次第（内覧日程が決まった等）なので、
    // 他社/別を示す語を伴う場合のみ失注扱い
    const decidedElsewhere =
      /決まりました|決めました/.test(lastCustomerMsg) &&
      /他|別|よそ/.test(lastCustomerMsg) &&
      !/内覧|見学|日程|時間|入居日|申込|審査/.test(lastCustomerMsg);
    if (LOST_KEYWORDS.some((kw) => lastCustomerMsg.includes(kw)) || decidedElsewhere) {
      return NextResponse.json({
        suggested: { status: "closed_lost", label: "失注", reason: "失注の可能性", current: currentStatus },
      });
    }
  }

  // ② 内覧完了検知（スタッフ発言・proposing のみ → applying へ）
  if (currentStatus === "proposing") {
    const VIEWING_DONE_KEYWORDS = [
      "お越しいただき", "お越し頂き", "ご来場", "ご来店いただき", "ご来店頂き",
      "ご案内させて頂き", "ご案内させていただき", "ご案内いたしました",
    ];
    if (recentStaffMsgs.some((t) => VIEWING_DONE_KEYWORDS.some((kw) => t.includes(kw)))) {
      return NextResponse.json({
        suggested: { status: "applying", label: "申込・審査中", reason: "内覧完了", current: currentStatus },
      });
    }

    // ③ 申込完了検知（申込書・審査・書類のキーワードが続く流れ → applying へ）
    const APPLY_KEYWORDS = ["申込書", "審査", "必要書類", "ご記入", "身分証"];
    const applyMsgCount = msgsAsc.filter((m) =>
      APPLY_KEYWORDS.some((kw) => (((m.text as string) ?? "")).includes(kw))
    ).length;
    if (applyMsgCount >= 2) {
      return NextResponse.json({
        suggested: { status: "applying", label: "申込・審査中", reason: "申込手続き検知", current: currentStatus },
      });
    }
  }

  if (SKIP.has(currentStatus)) return NextResponse.json({ suggested: null });
  const next = NEXT_STATUS[currentStatus];
  if (!next) return NextResponse.json({ suggested: null });

  // スタッフが最後に送信した場合は提案しない（お客様の反応待ち）
  if (conv.last_sender === "staff") return NextResponse.json({ suggested: null });

  const chatLog = [...messages].reverse()
    .map((m) => `${m.sender === "customer" ? "お客様" : "スタッフ"}: ${(m.text as string) ?? ""}`)
    .join("\n");

  const STATUS_CRITERIA: Record<string, string> = {
    hearing: `現在「初回対応」。以下の会話を見て、お客様の条件が揃い物件提案を開始できる状態かを判断してください。
判断基準: エリア・家賃・間取りなどの条件が明確になっている / 物件を見たいという意思表示がある`,
    proposing: `現在「物件提案中」。以下の会話を見て、お客様が申込・審査に進める状態かを判断してください。
判断基準: 特定の物件に強い興味を示している / 申込や審査について前向きな発言がある / 見積書を確認した`,
  };

  const prompt = `${STATUS_CRITERIA[currentStatus]}

【最近の会話（新しい順）】
${chatLog}

上記の会話を見て、ステータスを「${next.label}」に変更すべきか判断してください。
以下のJSON形式のみで返してください（説明不要）:
{"should_upgrade": true/false, "reason": "判断理由（10文字以内の日本語）"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU,
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) return NextResponse.json({ suggested: null });

  const data = await res.json() as { content?: Array<{ text: string }> };
  const raw = (data.content?.[0]?.text ?? "").replace(/```json?\s*/gi, "").replace(/```/g, "").trim();

  try {
    const parsed = JSON.parse(raw) as { should_upgrade: boolean; reason: string };
    if (!parsed.should_upgrade) return NextResponse.json({ suggested: null });
    return NextResponse.json({
      suggested: {
        status: next.key,
        label: next.label,
        reason: parsed.reason,
        current: currentStatus,
      },
    });
  } catch {
    return NextResponse.json({ suggested: null });
  }
}
