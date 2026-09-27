// app/lib/customer-sim-staff-run.ts
// お客様役のスタッフ役を「実際のスタッフの送り方」で動かすための fetch・DB の部分（判定は staff-send-pattern.ts の純関数）。
// 2026-09-27 竹内「AIXにずれがないか確認するためにも実際のスタッフが送ったようになるように／AIXを活用しながらテスト進めていく」
//
//   ・画面の AIX（simAixView）: 会話の判断（suggested_aix_meta）とメッセージを resolveAixButtonView に当てる（画面と同じ関数）
//   ・返信→AIX の返信（draftForReplyFirst）: 下書きがあればそれ、無ければ画面の「下書き作成」と同じ /api/generate-reply（書く呼び方）
//   ・AIX の後の一言（makeFollowup）: 送信後のバナーと同じカテゴリのテンプレ（templates）→ バナーで一番選ばれたテンプレ（template_selection_logs の post_aix）
//     → 画面の TemplateModal と同じ AI 最適化（/api/generate-reply の templateText・aixSourceMessage＝直前の AIX の文。会話の ai_draft は書かない）
//     → 失敗したらテンプレの穴埋め（fillFollowupTemplate）。どちらも無理なら送らない（理由）
//   ・申込フォーマット（appFormatText）: 画面の AixModal.tsx の APP_FORMAT_SECTIONS をそのまま読む
//
// 呼ぶ側: scripts/customer-sim.ts。テスト（純関数の部分）: app/lib/__tests__/staff-send-pattern.test.ts
import { readFileSync, existsSync } from "node:fs";
import { resolveAixButtonView, type AixViewMeta } from "@/app/lib/aix-button-view";
import { draftToSendableText } from "@/app/lib/draft-text";
import { buildShadowDraftBody, type ShadowConv, type ShadowMsg } from "@/app/lib/customer-sim-shadow-run";
import { SHADOW_NO_WRITE_FIELD, parseGenerateReplyStream } from "@/app/lib/customer-sim-shadow";
import {
  readAixView, pickFollowupTemplate, fillFollowupTemplate, parseAppFormatSections, buildAppFormatText, FOLLOWUP_TEMPLATE_CATEGORY,
  type SimAixViewRead, type SimBrainMetaLike, type FollowupTemplate,
} from "@/app/lib/staff-send-pattern";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SbLike = { from: (t: string) => any };

export type SimViewMsg = { sender: string; created_at: string; is_aix_generated?: boolean | null };

/**
 * 画面が出す AIX（resolveAixButtonView → readAixView）。
 *   meta は会話の判断（suggested_aix_meta）。判断の記録（brain_decision_logs）から読み直した判断も同じく meta として渡す
 *   （画面を開いていて判断が消えた番＝source "記録から" を表示に出す）
 */
export function simAixView(meta: Record<string, unknown> | null | undefined, msgs: ReadonlyArray<SimViewMsg>): SimAixViewRead & { source: "会話の判断" | "記録から" | "なし" } {
  const messages = msgs.map((m) => ({ sender: m.sender, rawCreatedAt: m.created_at, isAix: !!m.is_aix_generated }));
  const v = resolveAixButtonView({ meta: (meta ?? null) as AixViewMeta | null, messages, lastSender: msgs[msgs.length - 1]?.sender ?? null });
  const read = readAixView(v, (meta ?? null) as SimBrainMetaLike);
  return { ...read, source: !meta ? "なし" : meta._from === "brain_decision_logs" ? "記録から" : "会話の判断" };
}

/** 読み取りの応答（ストリーム）を全部読む */
async function readAll(res: Response): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let s = "";
  for (;;) { const { done, value } = await reader.read(); if (done) break; s += dec.decode(value, { stream: true }); }
  return s + dec.decode();
}
const stripTrailers = (s: string) => s.replace(/\n?<<<[A-Z_]+:[\s\S]*?(?:>>>|$)/g, "");

/**
 * 返信→AIX の「先の返信」: 下書き（ai_draft）があればそれ。無ければ画面の下書き作成と同じ /api/generate-reply（会話の ai_draft に書く・画面と同じ）。
 *   AIX の番は自動の下書きを作らない（ブレインが AIX）ので、実際のスタッフは手打ちする所＝ここは生成で代える
 */
export async function draftForReplyFirst(base: string, conversationId: string, conv: ShadowConv, msgs: ReadonlyArray<ShadowMsg>, existingDraft: string | null): Promise<{ text: string | null; source: "下書き" | "生成" | "なし"; error?: string }> {
  if (existingDraft) return { text: existingDraft, source: "下書き" };
  const body = buildShadowDraftBody(conversationId, conv, msgs);
  if (!body) return { text: null, source: "なし", error: "最後がお客様の発言でない" };
  delete (body as Record<string, unknown>)[SHADOW_NO_WRITE_FIELD];
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    if (!res.ok) return { text: null, source: "なし", error: `generate-reply HTTP ${res.status}` };
    const { text } = parseGenerateReplyStream(await readAll(res));
    return { text: draftToSendableText(text), source: "生成" };
  } catch (e) {
    return { text: null, source: "なし", error: e instanceof Error ? e.message : String(e) };
  }
}

/** バナーのテンプレ（カテゴリ・送信後のバナーから選ばれた回数） */
export async function loadFollowupTemplate(sb: SbLike, action: string, days = 180): Promise<{ template: FollowupTemplate | null; picks: Record<string, number>; error?: string }> {
  const category = FOLLOWUP_TEMPLATE_CATEGORY[action];
  if (!category) return { template: null, picks: {}, error: `一言のテンプレのカテゴリが無い AIX（${action}）` };
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const [t, l] = await Promise.all([
    sb.from("templates").select("id, label, text, category, requires_image, sort_order").eq("category", category),
    sb.from("template_selection_logs").select("template_id").eq("open_context", "post_aix").eq("aix_action_type", action).gte("created_at", since).limit(5000),
  ]);
  if (t.error) return { template: null, picks: {}, error: `templates: ${t.error.message}` };
  const picks: Record<string, number> = {};
  for (const r of (l.data ?? []) as Array<{ template_id: string | null }>) if (r.template_id) picks[r.template_id] = (picks[r.template_id] ?? 0) + 1;
  return { template: pickFollowupTemplate((t.data ?? []) as Array<{ id: string; label: string; text: string | null; category: string; requires_image?: boolean | null; sort_order?: number | null }>, picks), picks };
}

export type FollowupResult = { text: string | null; templateId: string | null; label: string | null; how: "AI最適化" | "穴埋め" | null; skipped?: string };

/**
 * AIX の後の一言を作る（送らない・送るのは呼ぶ側）。画面の TemplateModal の「AI 最適化」と同じ body（templateText・aixSourceMessage）。
 *   テンプレ最適化モードの generate-reply は会話の ai_draft を書かない（route.ts の書き込みゲート）
 */
export async function makeFollowup(
  sb: SbLike, base: string,
  input: { action: string; aixText: string; conversationId: string; conv: ShadowConv; msgs: ReadonlyArray<ShadowMsg>; propertyLabel: string | null; pickerMode?: string | null },
): Promise<FollowupResult> {
  const { template, error } = await loadFollowupTemplate(sb, input.action);
  if (!template) return { text: null, templateId: null, label: null, how: null, skipped: error ?? "使えるテンプレが無い" };
  const recentMessages = input.msgs.slice(-25).map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.created_at, isAix: !!m.is_aix_generated, imageUrl: m.image_url ?? undefined }));
  let adaptErr = "";
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/generate-reply`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "", state: input.conv.status ?? "proposing", customerName: input.conv.customer_name ?? "", recentMessages, conversationId: input.conversationId,
        templateText: template.text, templateCategory: template.category, templateLabel: template.label, templateFocusPoints: [], noEmoji: false,
        staffMessagedToday: true, aixSourceMessage: input.aixText,
        // 2026-09-27: 画面と同じく選んだテンプレの ID を渡す（同じテンプレのスタッフの実送信を手本に引く）
        templateId: template.id,
        // 画面（TemplateModal）と同じく、直前の AIX のピッカー（新着1件・新規ピックアップ・format 等）を渡す
        ...(input.pickerMode ? { aixPickerMode: input.pickerMode } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.ok) {
      const t = draftToSendableText(stripTrailers(await readAll(res)).trim());
      if (t) return { text: t, templateId: template.id, label: template.label, how: "AI最適化" };
      adaptErr = "最適化の文が空";
    } else adaptErr = `generate-reply HTTP ${res.status}`;
  } catch (e) { adaptErr = e instanceof Error ? e.message : String(e); }
  const filled = fillFollowupTemplate(template.text, { customerName: input.conv.customer_name, propertyLabel: input.propertyLabel });
  if (filled.text) return { text: filled.text, templateId: template.id, label: template.label, how: "穴埋め", skipped: `AI最適化に失敗（${adaptErr}）→ 穴埋め` };
  return { text: null, templateId: template.id, label: template.label, how: null, skipped: `AI最適化に失敗（${adaptErr}）・穴埋めもできない（${"reason" in filled ? filled.reason : "-"}）` };
}

/** 申込フォーマットの本文（画面の AixModal.tsx の固定文をそのまま・単独・緊急連絡先＝申込へ！【AIX】のテンプレで一番多い型） */
export function appFormatText(path = "app/components/AixModal.tsx"): { text: string | null; reason?: string } {
  if (!existsSync(path)) return { text: null, reason: `${path} が無い` };
  const sec = parseAppFormatSections(readFileSync(path, "utf8"));
  if (!sec) return { text: null, reason: "AixModal.tsx の APP_FORMAT_SECTIONS が読めない" };
  return { text: buildAppFormatText(sec, { living: "single", guarantor: "emergency" }) };
}
