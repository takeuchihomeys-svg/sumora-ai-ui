// AIX を送った後の「続きのテンプレ」のおすすめ（2026-10-13 竹内さん・ブレインの使い残し 1）
//
// 旧: /api/recommend-templates が AIX を送るたびに Sonnet（30日 約265回 $4.8・キャッシュなし）で会話を読み直して上位3件を選んでいた。
//   同じ会話はブレインが毎回読んでいて、「AIXボタン後に送るべきテンプレート」（brain-core PHASE_TEMPLATE_HINTS）も知っている（設計知見 P0 9eb6aa9c）。
// 新: ブレインの判断の1項目 after_aix_template（aix を送った直後に続けて送るテンプレの名前）＋ DB の集計
//   （ai_prompts.aix_template_chain_stats＝この AIX の後に一番よく送られたテンプレ・template_chain_transitions＝その次）で並べる。LLM なし。
//   ブレインの判断が送った AIX と違う時（スタッフが別の AIX を押した）はブレインの名前は使わない（その AIX の続きではない）。
// 戻す: BRAIN_TEMPLATE_REC=off（route が旧の Sonnet に戻る）

export type PostAixTemplate = { id: string; label: string; use_count?: number | null; recommend_shown_count?: number | null; recommend_picked_count?: number | null };
export type PostAixBrainMeta = { action?: unknown; after_aix_template?: unknown; next_steps?: unknown } | null | undefined;
export type PostAixRec = { id: string; score: number; reason: string };

type Env = Record<string, string | undefined>;
export function brainTemplateRecEnabled(env: Env = process.env): boolean {
  return (env.BRAIN_TEMPLATE_REC ?? "").trim().toLowerCase() !== "off";
}

/** ブレインの出力の after_aix_template を整える（40字まで・null/空は undefined・括弧の「」と【AIX】の前置きを外す） */
export function sanitizeAfterAixTemplate(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  let t = v.trim().replace(/^【AIX】\s*/, "").replace(/^[「『"]+|[」』"]+$/g, "").trim();
  if (!t || /^(null|none|なし|無し)$/i.test(t)) return undefined;
  if (t.length > 40) t = t.slice(0, 40);
  return t;
}

/** 名前の比べ用（空白・全角半角の括弧の違いをそろえる） */
export function normTemplateLabel(s: string): string {
  return s.replace(/\s+/g, "").replace(/\(/g, "（").replace(/\)/g, "）").toLowerCase();
}

/** ブレインの名前に当たる候補（同じ名前 → 片方がもう片方を含む＝4字以上）。無ければ null */
export function matchTemplateByName(name: string, templates: PostAixTemplate[]): PostAixTemplate | null {
  const n = normTemplateLabel(name);
  if (!n) return null;
  const exact = templates.find((t) => normTemplateLabel(t.label) === n);
  if (exact) return exact;
  if (n.length < 4) return null;
  const part = templates.filter((t) => {
    const l = normTemplateLabel(t.label);
    return l.length >= 4 && (l.includes(n) || n.includes(l));
  });
  // 一番近い長さの物（「申込誘導」で「【退去予定】1件申込誘導」より「【申込誘導】」）
  part.sort((a, b) => Math.abs(normTemplateLabel(a.label).length - n.length) - Math.abs(normTemplateLabel(b.label).length - n.length));
  return part[0] ?? null;
}

/** ブレインの判断のうち、送った AIX と同じ action の物の after_aix_template と next_steps（新しい順に渡す） */
export function brainFollowupFor(actionType: string | null | undefined, metas: PostAixBrainMeta[]): { name: string | null; steps: string[] } {
  if (!actionType) return { name: null, steps: [] };
  for (const m of metas) {
    if (!m || m.action !== actionType) continue;
    const name = sanitizeAfterAixTemplate(m.after_aix_template) ?? null;
    const steps = Array.isArray(m.next_steps) ? (m.next_steps as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (name || steps.length) return { name, steps };
  }
  return { name: null, steps: [] };
}

/**
 * 候補のテンプレを並べる（上位3件）。
 *   ①ブレインの after_aix_template ②ブレインの次の手順の「【AIX】○○」に名前が出ている ③集計: この AIX の後に一番よく送られた物 ④その次によく続く物
 *   ⑤足りなければ同じ小分け（sub_category）・おすすめの採用率・使った回数の順で埋める
 */
export function rankPostAixTemplates(i: {
  actionType: string | null | undefined;
  status?: string | null;
  templates: PostAixTemplate[];
  brainMetas: PostAixBrainMeta[];
  chainRecommended?: Record<string, string> | null;
  chainTransitions?: Record<string, { next: string; count: number }> | null;
  subCategory?: string | null;
  max?: number;
}): PostAixRec[] {
  const max = i.max ?? 3;
  const out: PostAixRec[] = [];
  const has = (id: string) => out.some((r) => r.id === id);
  const push = (t: PostAixTemplate | null | undefined, score: number, reason: string) => {
    if (t && !has(t.id) && out.length < max) out.push({ id: t.id, score, reason });
  };
  const byId = (id: string | null | undefined) => (id ? i.templates.find((t) => t.id === id) ?? null : null);

  const brain = brainFollowupFor(i.actionType, i.brainMetas);
  if (brain.name) push(matchTemplateByName(brain.name, i.templates), 95, `ブレインの判断: この AIX の後は「${brain.name}」`);
  // 次の手順に出ている名前（長い名前から当てる＝短い名前が長い名前の一部に当たるのを避ける）
  const stepsText = normTemplateLabel(brain.steps.join(" "));
  if (stepsText) {
    const named = i.templates
      .filter((t) => normTemplateLabel(t.label).length >= 4 && stepsText.includes(normTemplateLabel(t.label)))
      .sort((a, b) => b.label.length - a.label.length);
    for (const t of named) push(t, 85, "ブレインの次の手順に入っている");
  }
  const rec = i.chainRecommended ?? {};
  const first = i.actionType ? (rec[`${i.status ?? ""}|${i.actionType}`] ?? rec[`*|${i.actionType}`] ?? null) : null;
  const firstT = byId(first);
  push(firstT, 80, "この AIX の後に一番よく送られている（集計）");
  if (firstT) {
    const tr = (i.chainTransitions ?? {})[firstT.id];
    if (tr && tr.count >= 2) push(byId(tr.next), 70, "その次によく続けて送られている（集計）");
  }
  if (out.length < max) {
    const sub = (i.subCategory ?? "").trim();
    const rate = (t: PostAixTemplate) => ((t.recommend_shown_count ?? 0) >= 3 ? (t.recommend_picked_count ?? 0) / (t.recommend_shown_count ?? 1) : -1);
    const rest = i.templates.filter((t) => !has(t.id)).slice().sort((a, b) => {
      const sa = sub && a.label.includes(sub) ? 1 : 0, sb = sub && b.label.includes(sub) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      const ra = rate(a), rb = rate(b);
      if (ra !== rb) return rb - ra;
      return (b.use_count ?? 0) - (a.use_count ?? 0);
    });
    for (const t of rest) {
      if ((t.use_count ?? 0) <= 0 && rate(t) < 0 && !(sub && t.label.includes(sub))) continue; // 実績の無い物で埋めない
      push(t, 50, sub && t.label.includes(sub) ? `【${sub}】の場面` : rate(t) >= 0 ? `おすすめから選ばれた割合 ${Math.round(rate(t) * 100)}%` : `使用 ${t.use_count}回`);
    }
  }
  return out;
}
