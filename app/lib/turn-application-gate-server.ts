// app/lib/turn-application-gate-server.ts — turn-application-gate.ts の記録を1会話ずつ引く（サーバーの鍵・スクリプト用）
//   全部 conversation_id の index のある列で limit 1〜300（会話の全部は読まない）。読めなければ unreadable（呼ぶ側は外す）。
//   書類の印の通は takeuchi-compose-examples-server の cutOf と同じ（DOC_CANDIDATE_OR で絞って applicationMaterialReason・本人確認・個人の書類）。
import { applicationMaterialReason } from "./test-pii-guard";
import { isIdDocument } from "./id-document-guard";
import { isPersonalDocument } from "./personal-document-guard";
import { isFilledApplicationForm, APPLICATION_FORM_PREFILTER } from "./post-apply";
import { DOC_CANDIDATE_OR } from "./second-takeuchi-data-server";
import type { TurnApplicationRecords } from "./turn-application-gate";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = { from: (table: string) => any };
type Res = { data: unknown; error: { message: string } | null };

export async function loadTurnApplicationRecords(sb: Sb, conversationId: string): Promise<TurnApplicationRecords> {
  try {
    const one = (q: unknown) => q as Promise<Res>;
    const [conv, pushA, pushD, idA, idD, form, docs, deal, oe] = await Promise.all([
      one(sb.from("conversations").select("status, is_post_apply, status_manual_back_at, deepseek_cutoff_at").eq("id", conversationId).maybeSingle()),
      one(sb.from("aix_usage_logs").select("created_at").eq("conversation_id", conversationId).eq("aix_type", "application_push").order("created_at", { ascending: true }).limit(1)),
      one(sb.from("aix_usage_logs").select("created_at").eq("conversation_id", conversationId).eq("aix_type", "application_push").order("created_at", { ascending: false }).limit(1)),
      one(sb.from("messages").select("created_at").eq("conversation_id", conversationId).eq("sender", "customer").in("image_type", ["id_document", "income_document"]).order("created_at", { ascending: true }).limit(1)),
      one(sb.from("messages").select("created_at").eq("conversation_id", conversationId).eq("sender", "customer").in("image_type", ["id_document", "income_document"]).order("created_at", { ascending: false }).limit(1)),
      one(sb.from("messages").select("created_at, text").eq("conversation_id", conversationId).eq("sender", "customer").or(APPLICATION_FORM_PREFILTER).order("created_at", { ascending: true }).limit(100)),
      one(sb.from("messages").select("created_at, text, image_type").eq("conversation_id", conversationId).or(DOC_CANDIDATE_OR).order("created_at", { ascending: true }).limit(300)),
      one(sb.from("deal_outcomes").select("applied_at").eq("conversation_id", conversationId).not("applied_at", "is", null)),
      one(sb.from("outcome_events").select("at").eq("conversation_id", conversationId).in("kind", ["applied", "won"]).order("at", { ascending: true }).limit(50)),
    ]);
    for (const r of [conv, pushA, pushD, idA, idD, form, docs, deal, oe]) if (r.error) return { status: null, isPostApply: false, records: [], backAt: null, unreadable: true };
    const at0 = (r: Res) => (((r.data ?? []) as Array<{ created_at?: string }>)[0]?.created_at ?? null);
    const fl = (ts: Array<string | null | undefined>) => { const s = ts.filter((x): x is string => !!x).sort(); return { first: s[0] ?? null, last: s[s.length - 1] ?? null }; };
    const forms = ((form.data ?? []) as Array<{ created_at: string; text: string | null }>).filter((m) => isFilledApplicationForm(m.text)).map((m) => m.created_at);
    const docAts = ((docs.data ?? []) as Array<{ created_at: string; text: string | null; image_type: string | null }>)
      .filter((m) => applicationMaterialReason(m.text) || isIdDocument(m.image_type, m.text) || isPersonalDocument(m.image_type, m.text)).map((m) => m.created_at);
    // 300通で切れた時は最後の印が分からない＝最後を今にする（戻した後の番として残さない側へ倒す）
    if (((docs.data ?? []) as unknown[]).length >= 300 || ((form.data ?? []) as unknown[]).length >= 100) docAts.push(new Date().toISOString());
    const row = (conv.data ?? null) as { status?: string | null; is_post_apply?: boolean | null; status_manual_back_at?: string | null; deepseek_cutoff_at?: string | null } | null;
    const backs = [row?.status_manual_back_at, row?.deepseek_cutoff_at].filter((x): x is string => !!x).sort();
    return {
      status: row?.status ?? null,
      isPostApply: row?.is_post_apply === true,
      records: [
        { kind: "申込へ押下", first: at0(pushA), last: at0(pushD) },
        { kind: "証明書類", first: at0(idA), last: at0(idD) },
        { kind: "記入済みフォーム", ...fl(forms) },
        { kind: "書類の印の通", ...fl(docAts) },
        { kind: "申込（成約の記録）", ...fl(((deal.data ?? []) as Array<{ applied_at: string | null }>).map((d) => d.applied_at)) },
        { kind: "申込・成約の出来事", ...fl(((oe.data ?? []) as Array<{ at: string | null }>).map((e) => e.at)) },
      ],
      backAt: backs[backs.length - 1] ?? null,
      unreadable: false,
    };
  } catch {
    return { status: null, isPostApply: false, records: [], backAt: null, unreadable: true };
  }
}
