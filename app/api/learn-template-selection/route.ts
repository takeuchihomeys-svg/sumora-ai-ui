// POST /api/learn-template-selection
// テンプレート選択ログを記録する。2フェーズで使用：
//   phase=select: テンプレート選択時に即時記録
//   phase=sent:   送信時に最終テキストと修正有無を更新

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      phase: "select" | "sent" | "shown";
      // select フェーズ
      log_id?: string;
      conversation_id?: string;
      conversation_status?: string;
      template_id?: string;
      template_category?: string;
      recommended_rank?: number | null;
      was_recommended?: boolean;
      was_adapted?: boolean;
      original_text?: string;
      adapted_text?: string;
      aix_action_type?: string;
      // AIX→テンプレート全チェーン学習: どのバナー/フローから開いたか・どのピッカーサブモードだったか
      open_context?: string;
      picker_mode?: string;
      // sent フェーズ
      final_sent_text?: string;
      was_modified_after_adapt?: boolean;
      // shown フェーズ
      template_ids?: string[];
    };

    // おすすめとして提示したテンプレのshown_countを一括インクリメント
    if (body.phase === "shown") {
      if (!Array.isArray(body.template_ids) || body.template_ids.length === 0) {
        return NextResponse.json({ ok: false, error: "template_ids required" });
      }
      await supabase.rpc("increment_template_recommend_shown", { p_ids: body.template_ids });
      return NextResponse.json({ ok: true });
    }

    if (body.phase === "select") {
      const { data, error } = await supabase
        .from("template_selection_logs")
        .insert({
          conversation_id: body.conversation_id ?? null,
          conversation_status: body.conversation_status ?? null,
          template_id: body.template_id ?? null,
          template_category: body.template_category ?? null,
          recommended_rank: body.recommended_rank ?? null,
          was_recommended: body.was_recommended ?? false,
          was_adapted: body.was_adapted ?? false,
          original_text: (body.original_text ?? "").slice(0, 2000),
          adapted_text: body.adapted_text ? body.adapted_text.slice(0, 2000) : null,
          aix_action_type: body.aix_action_type ?? null,
          open_context: body.open_context ?? null,
          picker_mode: body.picker_mode ?? null,
        })
        .select("id")
        .single();

      if (error) {
        console.error("[learn-template-selection] insert error:", error);
        return NextResponse.json({ ok: false, error: error.message });
      }
      // おすすめから選んだ場合: picked_countをインクリメント（採用率の分子）
      if (body.was_recommended && body.template_id) {
        void supabase.rpc("increment_template_recommend_picked", { p_id: body.template_id });
      }
      return NextResponse.json({ ok: true, log_id: data?.id });

    } else if (body.phase === "sent") {
      if (!body.log_id && !body.conversation_id) {
        return NextResponse.json({ ok: false, error: "log_id or conversation_id required for sent phase" });
      }
      // CRIT-01修正: log_id が未確定（PENDING）の場合は conversation_id で直近レコードを特定して更新
      let targetLogId = body.log_id;
      if (!targetLogId && body.conversation_id) {
        const { data: recent } = await supabase
          .from("template_selection_logs")
          .select("id")
          .eq("conversation_id", body.conversation_id)
          .is("final_sent_text", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        targetLogId = recent?.id as string | undefined;
      }
      if (!targetLogId) {
        return NextResponse.json({ ok: false, error: "no matching log found" });
      }
      const { error } = await supabase
        .from("template_selection_logs")
        .update({
          final_sent_text: (body.final_sent_text ?? "").slice(0, 2000),
          was_modified_after_adapt: body.was_modified_after_adapt ?? false,
        })
        .eq("id", targetLogId);

      if (error) {
        console.error("[learn-template-selection] update error:", error);
        return NextResponse.json({ ok: false, error: error.message });
      }
      return NextResponse.json({ ok: true });

    } else {
      return NextResponse.json({ ok: false, error: "invalid phase" }, { status: 400 });
    }
  } catch (e) {
    console.error("[learn-template-selection] error:", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
