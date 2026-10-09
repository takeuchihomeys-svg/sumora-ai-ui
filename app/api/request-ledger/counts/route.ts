// GET /api/request-ledger/counts → 会話の一覧のバッジ「確認事項 未対応 N」（会話 ID → 未対応の数）
// 2026-10-08 竹内さん「（一覧のバッジは）それにする。今のお客さんから」:
//   全会話の発言を読むのは重いので、今動いているお客様（申込前・直近14日にお客様の発言がある会話）だけ・発言は直近14日だけ読む
//   （会話画面の帯と同じ buildRequestLedger の14日＝帯と同じ数）。読むだけ（書かない）。60秒はサーバーの記憶を返す。
//   数え方は app/lib/request-ledger.ts の countOpenRequestsByConversation（純関数・テストあり）
import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { countOpenRequestsByConversation } from "@/app/lib/request-ledger";
import { POST_APPLY_STATUSES } from "@/app/lib/brain-attention";
import { STAFF_INTERNAL_CONVERSATION_IDS } from "@/app/lib/test-conversations";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 14;
const CACHE_MS = 60_000;
let cache: { at: number; body: { ok: true; counts: Record<string, number>; conversations: number; messages: number } } | null = null;

type Row = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_MS) return NextResponse.json(cache.body);
  try {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
    // ① 直近14日にお客様の発言がある会話
    const active = new Set<string>();
    for (let off = 0; off < 20_000; off += 1000) {
      const { data, error } = await supabase.from("messages").select("conversation_id").eq("sender", "customer").gte("created_at", since).range(off, off + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<{ conversation_id: string | null }>) if (r.conversation_id) active.add(r.conversation_id);
      if (!data || data.length < 1000) break;
    }
    // ② 申込前だけ（申込以降・スタッフ同士の会話は外す）
    const ids: string[] = [];
    const all = [...active];
    for (let i = 0; i < all.length; i += 200) {
      const { data, error } = await supabase.from("conversations").select("id, status").in("id", all.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const c of (data ?? []) as Array<{ id: string; status: string | null }>) {
        if (POST_APPLY_STATUSES.has(String(c.status ?? "")) || STAFF_INTERNAL_CONVERSATION_IDS.includes(c.id)) continue;
        ids.push(c.id);
      }
    }
    // ③ その会話の直近14日の発言（こちらの送信も＝状態を決める）
    const rows: Row[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      for (let off = 0; off < 50_000; off += 1000) {
        const { data, error } = await supabase.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated")
          .in("conversation_id", ids.slice(i, i + 100)).gte("created_at", since).order("created_at", { ascending: true }).range(off, off + 999);
        if (error) throw new Error(error.message);
        rows.push(...((data ?? []) as Row[]));
        if (!data || data.length < 1000) break;
      }
    }
    const body = { ok: true as const, counts: countOpenRequestsByConversation(rows, Date.now(), { windowDays: WINDOW_DAYS }), conversations: ids.length, messages: rows.length };
    cache = { at: Date.now(), body };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e), counts: {} }, { status: 500 });
  }
}
