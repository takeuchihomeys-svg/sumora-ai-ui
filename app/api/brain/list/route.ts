import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { BRAIN_SKIP_STATUSES, URGENT_WINDOW_MS, type SuggestedAixMeta } from "@/app/lib/brain-core";

// ── brain/list: 純粋な read エンドポイント ──────────────────────────────────
// FIX(Fable5 #2): 以前はこの GET の中で最大30会話ぶんの Haiku 分析を並列実行しており、
// ダッシュボードのコールドロードが Haiku レイテンシに縛られていた。
// 分析は line-webhook（顧客メッセージ受信 = meta を消すのと同じイベント）と
// cron/brain-sweep（バックストップ）に移設。ここは DB を読むだけ（サブ秒応答）。
// 分析ロジック本体は app/lib/brain-core.ts（single writer）。
//
// 2セクション構成:
//   Section A（既存）: last_sender='customer' — 顧客から返信が来ていてスタッフのターン
//   Section B（追客）: last_sender='staff' AND 2日以上沈黙 — スタッフ送信後に顧客が
//     返信していない会話（沈黙顧客）。priority_score で優先順位付けして A の後ろに付ける。
// Section A の並び（urgent 先頭 → updated_at DESC）は従来通り変更しない。

export const maxDuration = 30;

// Section B（追客）対象: スタッフ最終送信からこの時間以上沈黙している会話
const FOLLOW_UP_SILENCE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

type BrainConversation = {
  id: string;
  customer_name: string | null;
  status: string | null;
  updated_at: string;
  last_message: string | null;
  suggested_aix_meta: SuggestedAixMeta;
  ai_draft: string | null;
  property_customer_id: string | null;
  brain_analyzed_at: string | null;
  is_urgent: boolean;
  is_hot: boolean;
  is_flagged: boolean;
  // 優先度スコア（LLM不要・集計のみ）: 経過日数×ステータス重み + hot/flag/urgent ボーナス
  priority_score: number;
  // true = Section B（スタッフ送信後に顧客が沈黙している追客対象）
  follow_up_section: boolean;
  // 最終メッセージ（updated_at）からの経過日数
  days_since_last_message: number;
};

type ConversationRow = {
  id: string;
  customer_name: string | null;
  status: string | null;
  updated_at: string;
  last_message: string | null;
  suggested_aix_meta: SuggestedAixMeta;
  ai_draft: string | null;
  property_customer_id: string | null;
  brain_analyzed_at: string | null;
  is_hot: boolean | null;
  is_flagged: boolean | null;
};

const SELECT_COLUMNS =
  "id, customer_name, status, updated_at, last_message, suggested_aix_meta, ai_draft, property_customer_id, brain_analyzed_at, is_hot, is_flagged";

// ステータス重み: 成約に近い段階ほど1日あたりの沈黙コストが高い
function statusWeight(status: string | null): number {
  if (!status) return 0.5;
  if (status === "applying" || status.includes("申込")) return 3.0;
  if (status === "viewing" || status.includes("内覧")) return 2.0;
  if (status === "inquiry" || status.includes("問合")) return 1.0;
  return 0.5;
}

function toBrainConversation(c: ConversationRow, now: number, followUpSection: boolean): BrainConversation {
  const isUrgent = now - new Date(c.updated_at).getTime() <= URGENT_WINDOW_MS;
  const isHot = c.is_hot === true;
  const isFlagged = c.is_flagged === true;
  const daysSinceLastMessage = Math.max(
    0,
    Math.floor((now - new Date(c.updated_at).getTime()) / 86_400_000)
  );
  const priorityScore =
    daysSinceLastMessage * statusWeight(c.status) +
    (isHot ? 20 : 0) +
    (isFlagged ? 15 : 0) +
    (isUrgent ? 10 : 0);
  return {
    id: c.id,
    customer_name: c.customer_name,
    status: c.status,
    updated_at: c.updated_at,
    last_message: c.last_message ?? null,
    suggested_aix_meta: c.suggested_aix_meta ?? null,
    ai_draft: c.ai_draft ?? null,
    property_customer_id: c.property_customer_id ?? null,
    brain_analyzed_at: c.brain_analyzed_at ?? null,
    is_urgent: isUrgent,
    is_hot: isHot,
    is_flagged: isFlagged,
    priority_score: priorityScore,
    follow_up_section: followUpSection,
    days_since_last_message: daysSinceLastMessage,
  };
}

export async function GET(_req: NextRequest) {
  const now = Date.now();
  const followUpCutoffIso = new Date(now - FOLLOW_UP_SILENCE_MS).toISOString();

  // 共通の status フィルタ
  // B7(Fable5): 旧 .not("status","in",...) は NULL status の行を除外していた（NOT IN の NULL セマンティクス）
  const statusFilter = `status.is.null,status.not.in.(${BRAIN_SKIP_STATUSES.join(",")})`;

  // Section A（既存・変更なし）: 顧客のターンの会話
  // Section B（新規）: スタッフ送信後 2日以上沈黙している会話（追客対象）
  const [sectionAResult, sectionBResult] = await Promise.all([
    supabase
      .from("conversations")
      .select(SELECT_COLUMNS)
      .eq("last_sender", "customer")
      .or(statusFilter)
      .order("updated_at", { ascending: false })
      // B9(Fable5): 無制限クエリは PostgREST の max-rows（デフォルト1000行）で無言切り捨てされる。
      // updated_at 降順のため limit 200 で切れるのは最も古い（=優先度最低の）会話のみ
      .limit(200),
    supabase
      .from("conversations")
      .select(SELECT_COLUMNS)
      .eq("last_sender", "staff")
      .or(statusFilter)
      .lt("updated_at", followUpCutoffIso)
      // 追客は沈黙が長い＝経過日数×重みでスコアが高い会話ほど重要。
      // limit で切れるのが「沈黙の浅い（=スコア低い）」側になるよう昇順で取得する
      .order("updated_at", { ascending: true })
      .limit(200),
  ]);

  if (sectionAResult.error) {
    return NextResponse.json({ error: sectionAResult.error.message }, { status: 500 });
  }
  if (sectionBResult.error) {
    return NextResponse.json({ error: sectionBResult.error.message }, { status: 500 });
  }

  const rowsA = (sectionAResult.data ?? []) as ConversationRow[];
  const rowsB = (sectionBResult.data ?? []) as ConversationRow[];

  // Section A: urgent（最終顧客メッセージ ≤ 2h）を先頭に、各群内は updated_at DESC のまま
  //（従来動作を維持 — priority_score は付与するがソートには使わない）
  const resultA = rowsA.map((c) => toBrainConversation(c, now, false));
  resultA.sort((a, b) => {
    if (a.is_urgent === b.is_urgent) return 0;
    return a.is_urgent ? -1 : 1;
  });

  // Section B: priority_score DESC（同点は沈黙が長い順 = updated_at ASC）
  const resultB = rowsB.map((c) => toBrainConversation(c, now, true));
  resultB.sort((a, b) => {
    if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;
    return new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
  });

  // Section A（従来通り先頭）→ Section B（追客リスト）の順で返却
  return NextResponse.json([...resultA, ...resultB]);
}
