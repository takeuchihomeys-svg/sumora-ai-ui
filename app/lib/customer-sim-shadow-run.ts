// app/lib/customer-sim-shadow-run.ts
// お客様役の「影の道」を作る（fetch だけ・DB は持たない）。判定は customer-sim-shadow.ts（純関数）。
// 2026-09-27 竹内「返信もAIXも仮定して送る形でズレなくしていく」
//
// 守ること:
//   ・影は送らない。send-line-message・log-aix-usage・mark_sent・messages への記録は呼ばない
//   ・影の下書きは generate-reply が「書かない呼び方」（body.shadowNoWrite・テスト用の会話だけ）を持つ時だけ作る
//     （持たない generate-reply に投げると ai_draft が書き換わる＝作らない。generateReplyAcceptsShadow で確かめる）
//   ・影の AIX は /api/aix/action（生成だけ。送った記録は作らない。書くのは aix_generate_log と生成の使用記録＝YUMA は学習に入らない）
//   ・画像を読む AIX（見積書・物件確認した・物件ピックアップ/オススメ）は既定で作らない（Vision は Claude のまま＝費用。withImages で作る）
//   ・呼ぶ先は手元の開発サーバ（LLM_TEST_MODE=deepseek-all）を既定にする。本番の入口では影を作らない（呼ぶ側が --shadow の時だけ呼ぶ）
//
// 呼ぶ側: scripts/customer-sim.ts（--shadow）。テスト: app/lib/__tests__/customer-sim-shadow.test.ts（純関数の部分）
import { MSG_SEP } from "@/app/lib/reply-context";
import { SIM_TEXT_ONLY_AIX } from "@/app/lib/customer-sim";
import { pickSimMaterial, buildMeetingPlaceText, alignEstimateText, type SimAixMaterial, type SimMaterialPool } from "@/app/lib/customer-sim-material";
import {
  SHADOW_NO_WRITE_FIELD, parseGenerateReplyStream, shadowAixCandidates, judgeShadowTurn,
  type ShadowCandidate, type ShadowFinding, type ShadowMetaLike,
} from "@/app/lib/customer-sim-shadow";

export type ShadowMsg = { sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null; image_url?: string | null };
export type ShadowConv = { account: string | null; customer_name: string | null; status: string | null };

export type ShadowDeps = {
  /** 影を作る入口（既定は手元の開発サーバ） */
  base: string;
  conversationId: string;
  fetchImpl?: typeof fetch;
  /** 画像を読む AIX も影で作るか（既定 false） */
  withImages?: boolean;
  /** generate-reply が「書かない呼び方」を持つか（generateReplyAcceptsShadow の結果） */
  draftAccepted: boolean;
};

/** generate-reply の本体（route.ts の文字列）が書かない呼び方を読むか（手元のファイルで確かめる・手元の開発サーバ用） */
export function generateReplyAcceptsShadow(routeSource: string | null | undefined): boolean {
  const s = String(routeSource ?? "");
  return s.includes("SHADOW_NO_WRITE_FIELD") && /const persist = !shadowNoWrite/.test(s);
}

/** 影を作る入口は手元だけ（本番の入口 https://… では作らない） */
export function isLocalBase(base: string): boolean {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?$/.test(String(base ?? "").trim());
}

/** 画面（page.tsx generateReply）と同じ形の body（影の欄だけ足す） */
export function buildShadowDraftBody(conversationId: string, conv: ShadowConv, msgs: ReadonlyArray<ShadowMsg>): Record<string, unknown> | null {
  const units: string[] = [];
  for (let i = msgs.length - 1; i >= 0 && msgs[i].sender === "customer"; i--) {
    const t = String(msgs[i].text ?? "").trim();
    if (t) units.unshift(t);
  }
  if (units.length === 0) return null;
  const last = msgs.slice(-25);
  const lastStaff = !last.some((m) => m.sender === "staff") ? [...msgs].reverse().find((m) => m.sender === "staff") : undefined;
  const finalMsgs = lastStaff ? [lastStaff, ...last] : last;
  return {
    message: units.join(MSG_SEP),
    customerMessages: units,
    state: conv.status ?? "proposing",
    conversationId,
    customerName: conv.customer_name ?? "",
    hasViewed: false,
    activeTaskTypes: [],
    recentMessages: finalMsgs.map((m) => ({ sender: m.sender, text: m.text ?? "", imageUrl: m.image_url ?? undefined, createdAt: m.created_at, isAix: !!m.is_aix_generated })),
    [SHADOW_NO_WRITE_FIELD]: true,
  };
}

/** 影の下書き（送らない・書かない）。書かない呼び方が無い時は作らない */
export async function generateShadowDraft(deps: ShadowDeps, conv: ShadowConv, msgs: ReadonlyArray<ShadowMsg>): Promise<{ text: string | null; skipped?: string; error?: string }> {
  if (!deps.draftAccepted) return { text: null, skipped: "generate-reply に書かない呼び方（shadowNoWrite）がまだ無い＝作らない（作ると下書き欄が書き換わる）" };
  if (!isLocalBase(deps.base)) return { text: null, skipped: "影は手元の開発サーバでだけ作る" };
  const body = buildShadowDraftBody(deps.conversationId, conv, msgs);
  if (!body) return { text: null, skipped: "最後がお客様の発言でない" };
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${deps.base.replace(/\/$/, "")}/api/generate-reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
    });
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const j = await res.json().catch(() => null) as { skipped?: boolean; reason?: string; error?: string } | null;
      return { text: null, ...(j?.skipped ? { skipped: `生成しない場面（${j.reason ?? "skipped"}）` } : { error: j?.error ?? `HTTP ${res.status}` }) };
    }
    if (!res.ok) return { text: null, error: `HTTP ${res.status}` };
    const p = parseGenerateReplyStream(await res.text());
    return { text: p.text || null };
  } catch (e) {
    return { text: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 画面（AixModal）と同じ /api/aix/action の引数（材料つき）。scripts/customer-sim.ts sendWithMaterial と同じ形 */
export function aixRequestForMaterial(action: string, material: SimAixMaterial, sentPropertyCount: number): { checkPattern: string | null; extra: Record<string, unknown>; conversationMatch: boolean; needsImage: boolean; fixedText?: string } {
  switch (material.kind) {
    case "estimate":
      return { checkPattern: null, extra: { image_url: material.imageUrl }, conversationMatch: false, needsImage: true };
    case "check_result":
      return {
        checkPattern: "available", conversationMatch: true, needsImage: !!material.imageUrl,
        extra: {
          property_count: 1, sent_property_count: Math.max(1, sentPropertyCount), staff_note: "", prop_statuses: ["available"], property_names: [material.propertyName],
          property_vacancy_dates: [""], estimate_image_urls: [null], all_properties_available: true,
          ...(material.imageUrl ? { image_url: material.imageUrl, image_urls: [material.imageUrl] } : {}),
        },
      };
    case "pickups": {
      const urls = material.items.map((p) => p.imageUrl).filter((u): u is string => !!u);
      return action === "property_recommendation"
        ? { checkPattern: null, extra: { image_url: urls[0] }, conversationMatch: false, needsImage: true }
        : { checkPattern: null, extra: { image_urls: urls, pickup_ids: material.items.map((p) => p.id), send_mode: "normal" }, conversationMatch: true, needsImage: true };
    }
    case "viewing_slots":
      return {
        checkPattern: null, conversationMatch: true, needsImage: false,
        extra: { calendar_info: material.slots.map((s) => `${s.label} ${s.start}${s.end ? `〜${s.end}` : ""}`).join("\n"), ...(material.propertyName ? { property_name: material.propertyName } : {}) },
      };
    case "meeting":
      return { checkPattern: null, extra: {}, conversationMatch: false, needsImage: false, fixedText: buildMeetingPlaceText(material) };
  }
}

export type ShadowAixResult = { action: string; checkPattern: string | null; source: ShadowCandidate["source"]; text: string | null; coverLetter?: string | null; skipped?: string; error?: string };

/** 影の AIX を1つ作る（送らない） */
export async function generateShadowAix(deps: ShadowDeps, conv: ShadowConv, msgs: ReadonlyArray<ShadowMsg>, cand: ShadowCandidate, pool: SimMaterialPool | null, sentPropertyCount: number): Promise<ShadowAixResult> {
  const base: ShadowAixResult = { action: cand.action, checkPattern: cand.checkPattern, source: cand.source, text: null };
  if (!isLocalBase(deps.base)) return { ...base, skipped: "影は手元の開発サーバでだけ作る" };
  let checkPattern = cand.checkPattern, extra: Record<string, unknown> = {}, conversationMatch = true;
  let material: SimAixMaterial | null = null;
  if (!SIM_TEXT_ONLY_AIX.has(cand.action)) {
    if (!pool) return { ...base, skipped: "材料の候補が無い" };
    const pick = pickSimMaterial(cand.action, cand.checkPattern, pool);
    if (!pick.ok) return { ...base, skipped: pick.reason };
    material = pick.material;
    const r = aixRequestForMaterial(cand.action, material, sentPropertyCount);
    if (r.fixedText) return { ...base, text: r.fixedText };
    if (r.needsImage && !deps.withImages) return { ...base, skipped: "画像を読む AIX（既定では作らない・--shadow-images で作る）" };
    checkPattern = r.checkPattern ?? checkPattern; extra = r.extra; conversationMatch = r.conversationMatch;
  }
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${deps.base.replace(/\/$/, "")}/api/aix/action`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: cand.action, account: conv.account ?? "sumora", conversation_id: deps.conversationId, customer_name: conv.customer_name ?? "",
        ...(conversationMatch ? { conversation_match: true } : {}), ...(checkPattern ? { check_pattern: checkPattern } : {}),
        recent_messages: msgs.slice(-20).map((m) => ({ sender: m.sender, text: m.text ?? "", rawCreatedAt: m.created_at, isAix: !!m.is_aix_generated, imageUrl: m.image_url ?? undefined })),
        ...extra,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const j = await res.json().catch(() => ({})) as { message_text?: string; coverLetter?: string; error?: string };
    if (!res.ok) return { ...base, error: `HTTP ${res.status} ${j.error ?? ""}`.trim() };
    let text = (j.message_text ?? "").trim() || null;
    if (text && material?.kind === "estimate") text = alignEstimateText(text, material)?.text ?? null;
    return { ...base, checkPattern, text, coverLetter: j.coverLetter ?? null };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

export type ShadowTurnResult = {
  chosen: "aix" | "draft";
  /** AIX の番の影の下書き */
  draft?: string | null;
  draftSkipped?: string | null;
  draftError?: string | null;
  /** 下書きの番の影の AIX（AIX の番は並べた AIX の影） */
  candidates: ShadowAixResult[];
  findings: ShadowFinding[];
};

/**
 * 1往復の影を作って突き合わせる（送る前に呼ぶ＝ブレインが見たのと同じ会話で作る）。
 *   chosen=aix: 影の下書き＋並べた AIX の影／chosen=draft: 影の候補 AIX。判定は judgeShadowTurn（AIX の後の一言は送った後に呼ぶ側が足す）
 */
export async function runShadowTurn(deps: ShadowDeps, input: {
  chosen: "aix" | "draft";
  meta: ShadowMetaLike;
  aix?: { action: string; checkPattern: string | null } | null;
  /** 下書きの番に送る下書き */
  draftText?: string | null;
  conv: ShadowConv;
  msgs: ReadonlyArray<ShadowMsg>;
  pool: SimMaterialPool | null;
  sentPropertyCount: number;
  focusSentByUs?: boolean | null;
  /** 影の AIX を作る数の上限（既定 2） */
  maxAix?: number;
}): Promise<ShadowTurnResult> {
  const candidates = shadowAixCandidates(input.meta, input.chosen === "aix" ? input.aix ?? null : null);
  const out: ShadowTurnResult = { chosen: input.chosen, candidates: [], findings: [] };
  if (input.chosen === "aix") {
    const d = await generateShadowDraft(deps, input.conv, input.msgs);
    out.draft = d.text; out.draftSkipped = d.skipped ?? null; out.draftError = d.error ?? null;
  }
  for (const c of candidates.slice(0, input.maxAix ?? 2)) {
    out.candidates.push(await generateShadowAix(deps, input.conv, input.msgs, c, input.pool, input.sentPropertyCount));
  }
  out.findings = input.chosen === "aix" && input.aix
    ? judgeShadowTurn({ chosen: "aix", aix: { ...input.aix, text: null }, draftText: out.draft ?? null, focusSentByUs: input.focusSentByUs })
    : judgeShadowTurn({ chosen: "draft", candidates, draftText: input.draftText ?? null, focusSentByUs: input.focusSentByUs });
  return out;
}
