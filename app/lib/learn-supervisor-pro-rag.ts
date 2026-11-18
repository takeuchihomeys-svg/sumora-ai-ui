/**
 * 統括Proの学習・決まりの引き（RAG）（2026-11-17）
 *
 *   実測: system_design_thinking は現行2390+・埋め込みほぼ全件あるのに、
 *   Pro は axes だけで判断し設計知見を一度も引いていなかった。
 *   → 最善の引き＝現状の抜け＋打合せ議題＋連携穴で自然文クエリを作り searchKb。
 *   → 統括ログの直近も短く継ぎ、把握→改善→手配の連続にする。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SupervisorAdvice } from "./learn-supervisor";
import type { RagRow, Scored } from "./design-knowledge-rag";
import { LEARN_PERIODS, sinceIso } from "./learn-periods";

/** meet は Pro 側と同形（循環 import を避ける） */
export type ProMeetOpts = { meet?: string[]; notes?: string[] };

export type ProKbHit = {
  id8: string;
  title: string;
  insight: string;
  priority: number | null;
  score: number;
  tags: string[];
};

export type ProLogMemory = {
  at: string;
  today: string;
  next: string | null;
};

export type SupervisorProBrainPull = {
  query: string;
  kb_hits: ProKbHit[];
  log_memory: ProLogMemory[];
  line: string;
  ok: boolean;
  why: string | null;
};

/** 問いを材料から組む（推測で埋めない・数字と題だけ） */
export function buildProRagQuery(
  adv: SupervisorAdvice,
  meetOpts?: ProMeetOpts | null,
): string {
  const m = adv.meeting || { today: [], agenda: [], evidence: [], questions: [] };
  const ev = m.evidence || [];
  const parts: string[] = ["物件検索", "学習", "統括Pro", "束", "連携", "保管"];
  for (const meet of (meetOpts?.meet || []).slice(0, 3)) {
    const s = String(meet || "").trim();
    if (s) parts.push(s.slice(0, 80));
  }
  for (const note of (meetOpts?.notes || []).slice(0, 2)) {
    const s = String(note || "").trim();
    if (s) parts.push(s.slice(0, 60));
  }
  const fa = ev.find((e) => /学習土台点検|足りない土台/.test(String(e.label || "")));
  if (fa?.value) parts.push(String(fa.value).slice(0, 120));
  const link = ev.find((e) => /連携|F32_link/.test(String(e.label || "")));
  if (link?.value) parts.push(String(link.value).slice(0, 80));
  const wipe = ev.find((e) => /F35|F36|消失|保管|solid|画面位置/.test(String(e.label || "") + String(e.value || "")));
  if (wipe?.value) parts.push(String(wipe.value).slice(0, 60));
  /** ★ 2026-11-18: 細かい材料も問いへ（引き漏れ防止） */
  for (const re of [
    /原因→改善の再学習|人間のように原因/,
    /改善する仕組みの構築|統括Proの志向/,
    /物件取得・送付済みの把握/,
    /統括Pro思考骨格|画像学習はちゃんと/,
    /設計知見↔統括Pro|設計知見と統括/,
  ]) {
    const hit = ev.find((e) => re.test(String(e.label || "")));
    if (hit?.value) parts.push(String(hit.label) + " " + String(hit.value).slice(0, 50));
  }
  for (const a of (m.agenda || []).slice(0, 2)) {
    if (a?.topic) parts.push(String(a.topic).slice(0, 40));
  }
  if (adv.headline) parts.push(String(adv.headline).slice(0, 40));
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 400);
}

export async function fetchSupervisorProBrainPull(
  sb: SupabaseClient,
  adv: SupervisorAdvice,
  meetOpts?: ProMeetOpts | null,
): Promise<SupervisorProBrainPull> {
  const query = buildProRagQuery(adv, meetOpts);
  const empty: SupervisorProBrainPull = {
    query,
    kb_hits: [],
    log_memory: [],
    line: "統括Pro RAG 0件",
    ok: false,
    why: null,
  };
  try {
    const { searchKb } = await import("./design-knowledge-rag-server");
    const { hybridRank } = await import("./design-knowledge-rag");
    const fallbackQ = [
      "リアプロ 画面把握 スクロール定着 駅外し",
      "Chrome拡張 外してから入れる 沿線 駅",
      "分析強化の原則 統括Pro 土台",
      ...(meetOpts?.meet || []).slice(0, 2).map((m) => String(m).slice(0, 40)),
    ].join(" ").slice(0, 200);
    const rankQ = `${fallbackQ} ${query}`.slice(0, 280);

    /**
     * ★ 2026-11-17 営業時間・全件 loadRagRows が statement timeout → kb_hits空で把握崩壊。
     *   Pro はまず軽量 keyword（上限200・埋め込みRPC無し）→ 0件の時だけ hybrid を短時間試す。
     */
    let scored: Scored[] = [];
    let ragPath = "none";

    const pullLite = async (): Promise<RagRow[]> => {
      const orParts = [
        "tags.cs.{Chrome拡張}",
        "tags.cs.{分析強化の原則}",
        "tags.cs.{統括Pro}",
        "tags.cs.{RAG}",
        "title.ilike.%画面把握%",
        "title.ilike.%スクロール%",
        "title.ilike.%駅外し%",
        "title.ilike.%統括Pro%",
        "title.ilike.%打合せ全議題%",
        "title.ilike.%外してから入れる%",
        "title.ilike.%原因%",
        "title.ilike.%再学習%",
        "title.ilike.%改善する仕組み%",
        "title.ilike.%画面位置%",
        "title.ilike.%消す書き込み%",
        "title.ilike.%photo_learn%",
        "title.ilike.%設計知見%",
      ];
      const { data: lite, error: liteErr } = await sb
        .from("system_design_thinking")
        .select("id, title, insight, rationale, context, tags, is_current, created_at, priority")
        .eq("is_current", true)
        .or(orParts.join(","))
        .order("created_at", { ascending: false })
        .limit(200);
      if (!liteErr && lite?.length) return lite as RagRow[];
      const { data: recent } = await sb
        .from("system_design_thinking")
        .select("id, title, insight, rationale, context, tags, is_current, created_at, priority")
        .eq("is_current", true)
        .order("created_at", { ascending: false })
        .limit(200);
      return (recent || []) as RagRow[];
    };

    try {
      const rows = await pullLite();
      scored = hybridRank(rows, new Map(), rankQ, {
        nowIso: new Date().toISOString(),
        mode: "keyword",
      }).slice(0, 6);
      ragPath = rows.length ? "keyword_lite" : "keyword_empty";
    } catch (eLite) {
      ragPath = "lite_fail:" + String((eLite as Error)?.message || eLite).slice(0, 40);
      scored = [];
    }

    if (!scored.length) {
      try {
        scored = await Promise.race([
          searchKb(sb, fallbackQ, { k: 6, mode: "hybrid" }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("pro_rag_hybrid_timeout")), 8_000),
          ),
        ]);
        if (scored.length) ragPath = "hybrid_fallback";
      } catch (eHy) {
        ragPath = ragPath + "|hybrid_fail:" + String((eHy as Error)?.message || eHy).slice(0, 36);
        scored = [];
      }
    }
    const prefer = (tags: string[] | null | undefined) => {
      const t = tags || [];
      return t.includes("Chrome拡張") || t.includes("ブレイン") || t.includes("分析強化の原則") || t.includes("統括");
    };
    const sorted = [...scored].sort((a, b) => {
      const ap = prefer(a.row.tags as string[]) ? 1 : 0;
      const bp = prefer(b.row.tags as string[]) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return (b.score || 0) - (a.score || 0);
    });
    const kb_hits: ProKbHit[] = sorted.slice(0, 6).map((s) => ({
      id8: String(s.row.id || "").slice(0, 8),
      title: String(s.row.title || "").slice(0, 80),
      // ★ 把握用に要旨を厚めに（題だけだと何の決まりか分からない）
      insight: String(s.row.insight || "").slice(0, 260),
      priority: typeof s.priority === "number" ? s.priority : (typeof (s.row as { priority?: number }).priority === "number" ? (s.row as { priority?: number }).priority! : null),
      score: Math.round((s.score || 0) * 100) / 100,
      tags: Array.isArray(s.row.tags) ? (s.row.tags as string[]).slice(0, 5) : [],
    }));

    const log_memory: ProLogMemory[] = [];
    /** logMemoryMs（既定2日）— 把握用。historyMs より狭く Pro が直近の統括を継ぐ */
    const since = sinceIso(LEARN_PERIODS.logMemoryMs);
    // ★ 列は advice ではなく meeting（実測: advice does not exist）
    const { data: logs } = await sb
      .from("learn_supervisor_log")
      .select("created_at,meeting,headline,verdict")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(8);
    for (const row of logs || []) {
      const meeting = row.meeting as {
        today?: string[];
        evidence?: Array<{ label?: string; value?: string }>;
      } | null;
      const today0 = meeting?.today?.[0] || (row.headline ? String(row.headline) : null);
      if (!today0) continue;
      const nextEv = (meeting?.evidence || []).find((e) =>
        /統括Proまとめ|統括Pro手配|土台を作る次手|次:/.test(String(e.label || "") + String(e.value || "")),
      );
      log_memory.push({
        at: String(row.created_at || ""),
        today: String(today0).slice(0, 120),
        next: nextEv ? String(nextEv.value || "").slice(0, 100) : null,
      });
      if (log_memory.length >= 3) break;
    }

    const ok = kb_hits.length >= 1;
    const line = ok
      ? `統括Pro RAG ${kb_hits.length}件（${kb_hits.map((h) => h.id8).join("・")}）／経路=${ragPath}／ログ記憶${log_memory.length}`
      : `統括Pro RAG 0件（query=${query.slice(0, 60)}／経路=${ragPath}）／ログ記憶${log_memory.length}`;
    return { query, kb_hits, log_memory, line, ok, why: ok ? null : "kb_hits_empty" };
  } catch (e) {
    return {
      ...empty,
      why: String((e as Error)?.message || e).slice(0, 120),
      line: `統括Pro RAG失敗: ${String((e as Error)?.message || e).slice(0, 80)}`,
    };
  }
}
