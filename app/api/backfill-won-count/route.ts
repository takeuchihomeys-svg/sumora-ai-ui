import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";

// ── won_count バックフィル（ワンショットAPI）────────────────────────────────
// 背景: analyze-applying の countTemplateWins() は learnFromConversation の学習成功時
// （learned_at 更新の直前）にのみ実行される。won_count 機能デプロイ前に closed_won
// 会話の learned_at がすべて書き込み済みのため、冪等ガードにより既存成約会話では
// 二度と実行されない。このAPIで既存の closed_won / contract 会話を遡って集計する。
//
// マッチロジックは analyze-applying/route.ts の countTemplateWins() と完全に同一:
//   - 正規化: 空白・改行を全除去した文字列同士で比較
//   - 対象: sender !== "customer" かつ is_aix_generated !== true のスタッフ自発送信
//     （正規化後30文字以上のもののみ）
//   - 判定1) 完全マッチ: テンプレ正規化本文の先頭30文字がスタッフ送信文に含まれる
//   - 判定2) 部分一致: テンプレ本文の連続50文字（10文字刻みの窓）が含まれる
//   - カウント単位: 1会話×1テンプレート = 最大 +1（複数メッセージにマッチしても1回）
//
// 冪等性・安全設計:
//   - learned_at は一切変更しない（analyze-applying の冪等ガードを維持）
//   - デフォルトでは learned_at IS NOT NULL の会話のみ対象。learned_at NULL の会話は
//     今後 analyze-applying の通常フローで countTemplateWins が実行されるため、
//     ここで数えると二重カウントになる（?include_unlearned=1 で強制包含可）
//   - このAPI自体はワンショット前提で再実行ガードを持たないため、いずれかの
//     テンプレートに won_count > 0 が既にある場合は実行を拒否する（?force=1 で解除）
//   - ?dry_run=1 で won_count を更新せずマッチ結果のみ返す
//
// 起動: 手動 POST のみ。
//   Authorization: Bearer ${CRON_SECRET} または Bearer ${INTERNAL_API_SECRET}

export const maxDuration = 300;

const TARGET_STATUSES = ["closed_won", "contract"];

function checkAuth(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (cronSecret && auth === `Bearer ${cronSecret}`) return null;
  return requireInternalAuth(req);
}

// analyze-applying/route.ts の normalizeForTemplateMatch と同一実装
function normalizeForTemplateMatch(s: string): string {
  return (s || "").replace(/\s+/g, "");
}

type TemplateRow = {
  id: string;
  label: string | null;
  text: string | null;
  won_count: number | null;
};

// analyze-applying の countTemplateWins() と同一のマッチ判定。
// 更新は行わず、この会話でマッチしたテンプレート id の集合を返す（1会話×1テンプレ=最大1）。
function matchTemplatesForConversation(
  staffSends: string[],
  templates: TemplateRow[]
): string[] {
  const matchedIds: string[] = [];
  for (const tmpl of templates) {
    const norm = normalizeForTemplateMatch(tmpl.text ?? "");
    if (norm.length < 30) continue; // 短すぎるテンプレは誤マッチ源になるため対象外

    // 1) 完全マッチ: テンプレ本文の先頭30文字がスタッフ送信文に含まれる
    const head = norm.slice(0, 30);
    let matched = staffSends.some((s) => s.includes(head));

    // 2) 部分一致: テンプレ本文の連続50文字がスタッフ送信文に含まれる（10文字刻みでスライド）
    if (!matched && norm.length >= 50) {
      outer:
      for (const s of staffSends) {
        for (let i = 0; i + 50 <= norm.length; i += 10) {
          if (s.includes(norm.slice(i, i + 50))) { matched = true; break outer; }
        }
      }
    }
    if (matched) matchedIds.push(tmpl.id);
  }
  return matchedIds;
}

export async function POST(req: NextRequest) {
  const authErr = checkAuth(req);
  if (authErr) return authErr;

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const force = url.searchParams.get("force") === "1";
  const includeUnlearned = url.searchParams.get("include_unlearned") === "1";

  // 1. 全テンプレート取得
  const { data: tmplRows, error: tmplErr } = await supabase
    .from("templates")
    .select("id, label, text, won_count");
  if (tmplErr) {
    return NextResponse.json({ error: `templates取得失敗: ${tmplErr.message}` }, { status: 500 });
  }
  const templates = (tmplRows ?? []) as TemplateRow[];

  // 再実行ガード: 既に won_count > 0 のテンプレートがある = バックフィル済み or 通常フローで
  // 集計開始済みの可能性が高い。二重カウント防止のため force なしでは拒否する。
  const alreadyCounted = templates.filter((t) => (t.won_count ?? 0) > 0);
  if (alreadyCounted.length > 0 && !force && !dryRun) {
    return NextResponse.json({
      error: "won_count > 0 のテンプレートが既に存在します。二重カウント防止のため中断しました。再実行する場合は ?force=1 を付けてください。",
      already_counted: alreadyCounted.map((t) => ({ id: t.id, label: t.label, won_count: t.won_count })),
    }, { status: 409 });
  }

  // 2. 対象会話取得（closed_won / contract 全件。learned_at は変更しない）
  const { data: convRows, error: convErr } = await supabase
    .from("conversations")
    .select("id, customer_name, status, learned_at")
    .in("status", TARGET_STATUSES)
    .order("updated_at", { ascending: false });
  if (convErr) {
    return NextResponse.json({ error: `conversations取得失敗: ${convErr.message}` }, { status: 500 });
  }
  const convs = (convRows ?? []) as Array<{
    id: string; customer_name: string | null; status: string; learned_at: string | null;
  }>;

  // learned_at NULL の会話は通常フロー（analyze-applying）で今後 countTemplateWins が
  // 走るため、デフォルトでは除外して二重カウントを防ぐ
  const targets = includeUnlearned ? convs : convs.filter((c) => c.learned_at !== null);
  const skippedUnlearned = includeUnlearned ? [] : convs.filter((c) => c.learned_at === null);

  // 3. 会話ごとにスタッフ自発送信を取得してマッチング → テンプレ別増分を集計
  const incrementByTemplate = new Map<string, number>(); // template_id -> +件数
  const perConversation: Array<{
    conversation_id: string;
    customer_name: string | null;
    status: string;
    matched_templates: Array<{ id: string; label: string | null }>;
    staff_send_count: number;
    error?: string;
  }> = [];

  for (const conv of targets) {
    const { data: msgRows, error: msgErr } = await supabase
      .from("messages")
      .select("sender, text, is_aix_generated")
      .eq("conversation_id", conv.id)
      .neq("text", "[画像]")
      .neq("text", "[動画]")
      .not("text", "is", null)
      .order("created_at", { ascending: true });
    if (msgErr) {
      perConversation.push({
        conversation_id: conv.id, customer_name: conv.customer_name, status: conv.status,
        matched_templates: [], staff_send_count: 0, error: `messages取得失敗: ${msgErr.message}`,
      });
      continue;
    }
    const msgs = (msgRows ?? []) as Array<{ sender: string; text: string; is_aix_generated: boolean | null }>;

    // countTemplateWins と同一の候補抽出:
    // 顧客以外（=スタッフ）かつ AIX自動送信でないメッセージを正規化し、30文字以上のみ
    const staffSends = msgs
      .filter((m) => m.sender !== "customer" && m.is_aix_generated !== true)
      .map((m) => normalizeForTemplateMatch(m.text))
      .filter((t) => t.length >= 30);

    const matchedIds = staffSends.length === 0 ? [] : matchTemplatesForConversation(staffSends, templates);
    for (const id of matchedIds) {
      incrementByTemplate.set(id, (incrementByTemplate.get(id) ?? 0) + 1);
    }
    perConversation.push({
      conversation_id: conv.id,
      customer_name: conv.customer_name,
      status: conv.status,
      matched_templates: matchedIds.map((id) => {
        const t = templates.find((tt) => tt.id === id);
        return { id, label: t?.label ?? null };
      }),
      staff_send_count: staffSends.length,
    });
  }

  // 4. won_count を INCREMENT（won_count + マッチ数。SET上書きではない）
  const updated: Array<{
    id: string; label: string | null; won_count_before: number; increment: number; won_count_after: number; error?: string;
  }> = [];
  for (const [tmplId, inc] of incrementByTemplate) {
    const tmpl = templates.find((t) => t.id === tmplId);
    const before = tmpl?.won_count ?? 0;
    const after = before + inc;
    if (!dryRun) {
      const { error: updErr } = await supabase
        .from("templates")
        .update({ won_count: after })
        .eq("id", tmplId);
      if (updErr) {
        console.warn(`[backfill-won-count] won_count更新失敗 (template=${tmpl?.label}):`, updErr.message);
        updated.push({ id: tmplId, label: tmpl?.label ?? null, won_count_before: before, increment: inc, won_count_after: before, error: updErr.message });
        continue;
      }
      console.log(`[backfill-won-count] won_count +${inc}: 「${tmpl?.label}」`);
    }
    updated.push({ id: tmplId, label: tmpl?.label ?? null, won_count_before: before, increment: inc, won_count_after: after });
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    conversations_total: convs.length,
    conversations_processed: targets.length,
    conversations_skipped_unlearned: skippedUnlearned.map((c) => ({
      id: c.id, customer_name: c.customer_name,
      note: "learned_at IS NULL: 通常フロー（analyze-applying）で集計されるため除外。含めるには ?include_unlearned=1",
    })),
    conversations_matched: perConversation.filter((c) => c.matched_templates.length > 0).length,
    templates_updated: updated,
    per_conversation: perConversation,
  });
}
