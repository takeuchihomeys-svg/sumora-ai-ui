/**
 * 学習統括の Pro まとめ層（2026-11-16）
 *
 * ★ 竹内さん「なんでproが統括になっていなかったのか／画像よむのはflashでまとめるのは統括／
 *   統括はその連携をちゃんとできる構造になっていないのか／質の高い構造」
 * ★ 「足りていない部分等統括判断して土台つくる／proが判断する」
 * ★ 「ちゃんとproが動くように統括の部分の判断ちゃんとproが行えるように細かい部分強化する」:
 *
 *   【役割分担（混ぜない）】
 *     ① flash … 画像を読む（Vision・shot-learn）
 *     ② 決定論 … 関所・完走率・仕組み・verdict（learn-supervisor.ts・壊さない）
 *     ③ Pro   … ①②の材料で**判断する**（足りない土台・次手・質・連携の穴）
 *
 *   ⚠ Pro は verdict / self_check / block / learning_tasks の kind・limit を**変えない**。
 */
import { DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_ENDPOINT } from "./llm-alt-provider";
import type { SupervisorAdvice } from "./learn-supervisor";
import { markVisionProUsed, type VisionProLink } from "./vision-pro-link";
import { atomsFromEvidence, type WeakAtom } from "./weak-auto-atoms";
import type { SupervisorProBrainPull } from "./learn-supervisor-pro-rag";

export const SUPERVISOR_PRO_ACTION = "learn_supervisor_pro";
export const SUPERVISOR_PRO_MODEL_DEFAULT = DEEPSEEK_DEFAULT_MODEL; // deepseek-v4-pro
/** Pro 1回の既定待ち（ms）。60秒だと meet+思考で Abort → usedPro=false になる実測あり */
export const SUPERVISOR_PRO_TIMEOUT_MS_DEFAULT = 180_000;

/** 環境変数 SUPERVISOR_PRO_MODEL → DEEPSEEK_MODEL → deepseek-v4-pro */
export function supervisorProModel(env: Record<string, string | undefined> = process.env): string {
  return (
    (env.SUPERVISOR_PRO_MODEL ?? "").trim() ||
    (env.DEEPSEEK_MODEL ?? "").trim() ||
    SUPERVISOR_PRO_MODEL_DEFAULT
  );
}

/**
 * Pro fetch の待ち上限（ms）。
 * ⚠ 2026-11-16: 旧 60_000 固定だと AbortSignal.timeout → exception:aborted → usedPro=false。
 *   SUPERVISOR_PRO_TIMEOUT_MS で上書き可（下限 60s・上限 300s）。
 */
export function supervisorProTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.SUPERVISOR_PRO_TIMEOUT_MS);
  const n = Number.isFinite(raw) && raw > 0 ? raw : SUPERVISOR_PRO_TIMEOUT_MS_DEFAULT;
  return Math.min(300_000, Math.max(60_000, Math.floor(n)));
}

export type SupervisorProWeakFix = {
  field: string;
  gap: string;
  next: string;
  layer?: string;
  /** なぜ弱いのか（数字に基づく） */
  why?: string;
  /** どうしたら100%に近づくか */
  how?: string;
  /** 仮定（推測は必ず「仮定」と書く） */
  hypothesis?: string;
  /** 100%への残り（例: 62→70 であと8pt） */
  toward100?: string;
};

export type SupervisorProEnrichment = {
  today: string[];
  link_gap: string | null;
  next_line: string | null;
  foundation_gaps: string[];
  build_next: string | null;
  quality_up: string | null;
  /** 弱点原子ごとの細かい改善（Pro判断） */
  weak_fixes: SupervisorProWeakFix[];
  /** 変バグ・人間らしさの細かい直し */
  bug_fixes: string[];
  /** 全体の仮説（なぜまだ100%でないか） */
  why_not_100: string | null;
  /** 100%に近づける全体の道筋 */
  path_to_100: string | null;
};

export type SupervisorProAskResult =
  | { ok: true; enrich: SupervisorProEnrichment; model: string; brainPull: SupervisorProBrainPull | null }
  | { ok: false; why: string; model: string; brainPull: SupervisorProBrainPull | null };

export const SUPERVISOR_PRO_SYSTEM = [
  "あなたは物件検索の学習統括の脳（Pro）です。決定論の関所は既に決まっています。",
  "役目は**判断と仮説→改善**です。画像は flash が読みます。弱点を100%に近づけるために、なぜ弱いのか・どうしたらできるのか・仮定を必ず書く。",
  "入力の JSON（vision_link・weak_atoms・axes・完成度・handoff・meet）を見て判断:",
  "① 今日の結論（数字入り1〜3行）",
  "② 連携の穴（画像→Pro・束→自動・完了→次客を分ける）",
  "③ 次の1手（一番効く1つ）",
  "④ 足りない土台（優先順）",
  "⑤ 土台を作る次手（人/flash/学習/拡張）",
  "⑥ 質が上がったか",
  "⑦ weak_fixes 最大6件。各件に field,gap,next,layer,why（なぜ）,how（どうしたら）,hypothesis（仮定と明記）,toward100（例:62→70であと8）",
  "⑧ bug_fixes 最大4件（変バグ・直押し・直書き・外し区別・完了→次客）",
  "⑨ why_not_100 … なぜまだ100%（再現・完成度）でないか1〜2文",
  "⑩ path_to_100 … 100%に近づける順番（無料の土台→flash→拡張→自動1回→効果確認）",
  "meet（打合せ議題）が付いていたら、その議題を最優先で細分化して答える（無視しない）。",
  "axes.handoff / 完了→次客 がある時は、完走率だけでなく switch_fail・owner_mismatch 等の原子で判断する。",
  "axes.foundation_f* と foundation_audit・F33保管・F34脳材料・F35消す書き込み・F36書き込み関所・F37 RAG引き・linkage を必ず見て、足りない土台の優先順を決める。",
  "あなたは全体の脳として、保管・連携・反映・人間らしさ・steps・指示・設計知見RAG・統括ログ記憶を横断して穴を見逃さない。",
  "抜けが後から出るのを防ぐ: 新しい学習・束の書き込み経路・連携段が増える時は、先に完了線付き土台（F番号）と関所（preserve/safe_to_write）を定義してから通す。後追いの穴塞ぎを常態にしない。",
  "kb_hits は設計知見DBから引いた現行の決まり。矛盾したら段が上（P0→P1）・新しい方に従う。無い物は推測で埋めず『仮定』と書く。",
  "【把握が最重要】today の先頭1行は必ず『把握:』で始め、kb_hitsで何の決まりを見たか・log_memoryで何を継いだか・axesの数字で何が欠けているかを短く言う。把握できないなら次手に『引きを直す』を入れる。",
  "log_memory は直近の統括ログ。把握→改善→手配の連続に使い、同じ穴を忘れない。",
  "next_line / build_next / path_to_100 は『手配』として人が・拡張が・学習が何をどの順でやるかを具体的に書く。",
  "推測は必ず『仮定』と書く。数字のない弱点は作らない。verdict・learning_tasksのkind/limitは変えない。",
  "出力は JSON だけ: {\"today\":[\"…\"],\"link_gap\":\"…\"|null,\"next_line\":\"…\"|null,\"foundation_gaps\":[\"…\"],\"build_next\":\"…\"|null,\"quality_up\":\"…\"|null,\"weak_fixes\":[{\"field\":\"…\",\"gap\":\"…\",\"next\":\"…\",\"layer\":\"flash\",\"why\":\"…\",\"how\":\"…\",\"hypothesis\":\"仮定: …\",\"toward100\":\"…\"}],\"bug_fixes\":[\"…\"],\"why_not_100\":\"…\",\"path_to_100\":\"…\"}",
].join("\n");

/** Cursor／打合せから Pro に渡す追加議題 */
export type SupervisorProMeetOpts = {
  /** 打合せの議題（細分化して答えてもらう） */
  meet?: string[];
  /** 追加のメモ（事実・DB数字など） */
  notes?: string[];
};

/** evidence からラベル部分一致で1行取る */
function evidenceValue(
  evidence: Array<{ label: string; value: string; guessed?: boolean }>,
  re: RegExp,
): string | null {
  const hit = evidence.find((e) => re.test(String(e.label || "")));
  return hit ? String(hit.value || "").slice(0, 220) : null;
}

/**
 * Pro に渡す材料（細かく・個人情報なし）。
 * ⚠ 決定論の evidence をそのまま長く渡すとノイズになるので、判断に必要な軸だけ抜く。
 */
export function buildSupervisorProPayload(
  adv: SupervisorAdvice,
  meetOpts?: SupervisorProMeetOpts | null,
  brainPull?: SupervisorProBrainPull | null,
): Record<string, unknown> {
  const m = adv.meeting || { today: [], agenda: [], questions: [], evidence: [] };
  const ev = m.evidence || [];
  return {
    verdict: adv.verdict,
    headline: adv.headline,
    block: adv.block,
    self_check: adv.self_check,
    score: adv.score,
    /** 設計知見RAG＋統括ログ記憶（真のブレインの引き） */
    kb_hits: (brainPull?.kb_hits || []).slice(0, 6).map((h) => ({
      id8: h.id8,
      title: h.title,
      insight: h.insight,
      priority: h.priority,
      score: h.score,
      tags: h.tags,
    })),
    kb_query: brainPull?.query || null,
    log_memory: (brainPull?.log_memory || []).slice(0, 3),
    /** 軸だけ抜いた数字（Proが細かく判断するための材料） */
    axes: {
      completion: evidenceValue(ev, /自動モード完成度|完成度/),
      reproduce: evidenceValue(ev, /人間らしさの再現|再現（あと/),
      human_like: evidenceValue(ev, /自動モードの人間らしさ/),
      human_nearness: evidenceValue(ev, /人間との差分（近さ・許可線）|差分の未達（許可線）/),
      foundation_audit: evidenceValue(ev, /学習土台点検（F番号）/),
      foundation_f29: evidenceValue(ev, /土台 F29_human_nearness/),
      foundation_f31: evidenceValue(ev, /土台 F31_learn_reflect_station/),
      foundation_f32: evidenceValue(ev, /土台 F32_link_pipeline/),
      foundation_f33: evidenceValue(ev, /土台 F33_learn_db_persist/),
      foundation_f34: evidenceValue(ev, /土台 F34_pro_brain_ready/),
      foundation_f35: evidenceValue(ev, /土台 F35_wipe_write_gate/),
      foundation_f36: evidenceValue(ev, /土台 F36_write_path_gate/),
      foundation_f37: evidenceValue(ev, /土台 F37_pro_rag_brain/),
      foundation_f6: evidenceValue(ev, /土台 F6_auto_after_bundle/),
      pro_rag: evidenceValue(ev, /統括Pro RAG/),
      pro_grasp: evidenceValue(ev, /統括Pro把握/),
      foundation_f28: evidenceValue(ev, /土台 F28_auto_gap_floor/),
      foundation_f18: evidenceValue(ev, /土台 F18_fill_progress_steps/),
      foundation_f27: evidenceValue(ev, /土台 F27_op_path_kind/),
      foundation_f8: evidenceValue(ev, /土台 F8_commands_flow/),
      foundation_f9: evidenceValue(ev, /土台 F9_stalled_signal/),
      foundation_f4: evidenceValue(ev, /土台 F4_hand_cs/),
      linkage: evidenceValue(ev, /学習→自動の連携|連携のボトルネック/),
      vision_link: evidenceValue(ev, /画像学習→統括Pro連携/),
      vision_roles: evidenceValue(ev, /画像学習の役割|学習APIの役割|役割分担/),
      photo_kinds: evidenceValue(ev, /写真から読んだ欄の種類/),
      image_match: evidenceValue(ev, /通常モードの画像×押した位置|画像×押した位置/),
      shot_gaps: evidenceValue(ev, /学習の抜け|通常の読める未学習|未学習/),
      foundation: evidenceValue(ev, /通常録画→完全再現の土台|土台の細分化|質を上げる循環/),
      hand_cs: evidenceValue(ev, /手の形|人間らしさの再現/),
      precision: evidenceValue(ev, /精度|欄×観点/),
      search_order: evidenceValue(ev, /基本条件→検索|検索押し|直接入力|検索の順番/),
      roles: evidenceValue(ev, /学習APIの役割|役割分担/),
      audits: evidenceValue(ev, /実際の検索/),
      /** ★ 完了→次客（完走率と別軸） */
      handoff: evidenceValue(ev, /完了→次客|一連ロック|次客/),
      learn_period: evidenceValue(ev, /学習期間|材料の期間/),
      mechanisms: evidenceValue(ev, /学習の仕組み（統括が使う）/),
    },
    /** Cursor 打合せの議題（あれば最優先） */
    meet: Array.isArray(meetOpts?.meet) ? meetOpts!.meet!.slice(0, 8).map((s) => String(s).slice(0, 200)) : [],
    meet_notes: Array.isArray(meetOpts?.notes) ? meetOpts!.notes!.slice(0, 8).map((s) => String(s).slice(0, 220)) : [],
    /** 細分化した画像→Pro連携（あれば段階ごとに渡す） */
    vision_link: (() => {
      const vpl = (m as { vision_pro_link?: VisionProLink }).vision_pro_link;
      if (!vpl) return null;
      return {
        line: vpl.line,
        bottleneck: vpl.bottleneck,
        bottleneck_n: vpl.bottleneck_n,
        steps: (vpl.steps || []).map((s) => ({
          n: s.n, name: s.name, ok: s.ok, role: s.role, detail: String(s.detail || "").slice(0, 120),
        })),
        counts: vpl.counts,
        roles: vpl.roles,
      };
    })(),
    /** 弱点原子（決定論で細分化済み → Proが優先順を判断） */
    weak_atoms: (() => {
      const atoms: WeakAtom[] = atomsFromEvidence(ev);
      return atoms.slice(0, 12).map((a) => ({
        id: a.id,
        name: a.name,
        score: a.score ?? null,
        need: a.need ?? null,
        layer: a.layer,
        next: a.next.slice(0, 100),
      }));
    })(),
    today: (m.today || []).slice(0, 6),
    agenda: (m.agenda || []).slice(0, 6).map((a) => ({
      topic: a.topic,
      why: String(a.why || "").slice(0, 140),
      decide: String(a.decide || "").slice(0, 140),
    })),
    tasks: (m.learning_tasks || []).slice(0, 8).map((t) => ({
      kind: t.kind,
      what: String(t.what || "").slice(0, 90),
      why: String(t.why || "").slice(0, 120),
      cost: t.cost,
      limit: t.limit ?? null,
    })),
    questions: (m.questions || []).slice(0, 3).map((q) => ({
      q: String(q.q || "").slice(0, 120),
      why: String(q.why || "").slice(0, 100),
    })),
  };
}

/** finish=length で JSON が途中切れでも、取れたキーだけで読む（100%への道を落とさない）。 */
function tryParseProJson(raw: string): Record<string, unknown> | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  // 閉じ `}` が無い途中切れも先頭 `{` から全部使う
  const m = s.match(/\{[\s\S]*\}/);
  const body = m ? m[0] : (s.includes("{") ? s.slice(s.indexOf("{")) : s);
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    // 閉じ括弧を足して再試行（配列・オブジェクトの途中切れ）
    for (const pad of ["]}", "\"}]}", "}}", "\"]}", "null}"]) {
      try {
        return JSON.parse(body + pad) as Record<string, unknown>;
      } catch { /* next */ }
    }
    // キー単位で拾う（最低限 today / path_to_100 / why_not_100）
    const out: Record<string, unknown> = {};
    const todayM = body.match(/"today"\s*:\s*\[([\s\S]*?)\]/);
    if (todayM) {
      const items = [...todayM[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((x) => x[1]);
      if (items.length) out.today = items;
    }
    for (const k of ["link_gap", "next_line", "build_next", "quality_up", "why_not_100", "path_to_100"] as const) {
      const km = body.match(new RegExp(`"${k}"\\s*:\\s*("((?:\\\\.|[^"\\\\])*)"|null)`));
      if (km) out[k] = km[1] === "null" ? null : km[2]?.replace(/\\"/g, '"');
    }
    const gapsM = body.match(/"foundation_gaps"\s*:\s*\[([\s\S]*?)\]/);
    if (gapsM) {
      const items = [...gapsM[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((x) => x[1]);
      if (items.length) out.foundation_gaps = items;
    }
    return Object.keys(out).length ? out : null;
  }
}

export function parseSupervisorPro(text: string): SupervisorProEnrichment | null {
  try {
    const o = tryParseProJson(text);
    if (!o) return null;
    const todayRaw = Array.isArray(o.today) ? o.today : [];
    const today = todayRaw
      .map((x) => String(x ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((s) => s.slice(0, 200));
    const link_gap = o.link_gap == null || String(o.link_gap) === "null"
      ? null
      : String(o.link_gap).replace(/\s+/g, " ").trim().slice(0, 280) || null;
    const next_line = o.next_line == null || String(o.next_line) === "null"
      ? null
      : String(o.next_line).replace(/\s+/g, " ").trim().slice(0, 220) || null;
    const gapsRaw = Array.isArray(o.foundation_gaps) ? o.foundation_gaps : [];
    const foundation_gaps = gapsRaw
      .map((x) => String(x ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((s) => s.slice(0, 180));
    const build_next = o.build_next == null || String(o.build_next) === "null"
      ? null
      : String(o.build_next).replace(/\s+/g, " ").trim().slice(0, 280) || null;
    const quality_up = o.quality_up == null || String(o.quality_up) === "null"
      ? null
      : String(o.quality_up).replace(/\s+/g, " ").trim().slice(0, 220) || null;
    const weakRaw = Array.isArray(o.weak_fixes) ? o.weak_fixes : [];
    const weak_fixes: SupervisorProWeakFix[] = [];
    for (const x of weakRaw) {
      if (!x || typeof x !== "object") continue;
      const r = x as Record<string, unknown>;
      const field = String(r.field ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      const gap = String(r.gap ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const next = String(r.next ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      const layer = String(r.layer ?? "").trim().slice(0, 20) || undefined;
      const why = String(r.why ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || undefined;
      const how = String(r.how ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || undefined;
      let hypothesis = String(r.hypothesis ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || undefined;
      if (hypothesis && !/仮定/.test(hypothesis)) hypothesis = "仮定: " + hypothesis;
      const toward100 = String(r.toward100 ?? "").replace(/\s+/g, " ").trim().slice(0, 100) || undefined;
      if (!field && !next) continue;
      weak_fixes.push({
        field: field || "弱点", gap: gap || "不足", next: next || "細かく直す", layer,
        why, how, hypothesis, toward100,
      });
      if (weak_fixes.length >= 6) break;
    }
    const bugRaw = Array.isArray(o.bug_fixes) ? o.bug_fixes : [];
    const bug_fixes = bugRaw
      .map((x) => String(x ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((s) => s.slice(0, 160));
    const why_not_100 = o.why_not_100 == null || String(o.why_not_100) === "null"
      ? null
      : String(o.why_not_100).replace(/\s+/g, " ").trim().slice(0, 280) || null;
    const path_to_100 = o.path_to_100 == null || String(o.path_to_100) === "null"
      ? null
      : String(o.path_to_100).replace(/\s+/g, " ").trim().slice(0, 280) || null;
    if (!today.length && !link_gap && !next_line && !foundation_gaps.length && !build_next && !weak_fixes.length
      && !why_not_100 && !path_to_100) return null;
    return {
      today, link_gap, next_line, foundation_gaps, build_next, quality_up,
      weak_fixes, bug_fixes, why_not_100, path_to_100,
    };
  } catch {
    return null;
  }
}

const PRO_EV_LABEL = /^(統括Proまとめ|足りない土台（統括Pro判断）|土台を作る次手（統括Pro）|役割分担（画像\/統括）|統括Pro|統括Pro RAG|統括Pro把握|統括Pro手配|弱点の細かい改善（統括Pro）|変バグの細かい直し（統括Pro）|なぜ100%でないか（統括Pro）|100%への道（統括Pro）)$/;
const PRO_AGENDA_TOPIC = /統括Pro/;

/** Pro のまとめを advice に載せる（verdict / self_check / learning_tasks の kind は変えない）。 */
export function mergeSupervisorPro(
  adv: SupervisorAdvice,
  enrich: SupervisorProEnrichment,
  meta?: { model?: string; usedPro?: boolean; brainPull?: SupervisorProBrainPull | null },
): SupervisorAdvice {
  const meeting = { ...(adv.meeting || { today: [], agenda: [], questions: [], evidence: [] }) };
  // 再Enrichでも二重にならないよう、前回の Pro 行を先に落とす
  let baseEvidence = (meeting.evidence || []).filter((e) => !PRO_EV_LABEL.test(String(e.label || "")));
  const baseAgenda = (meeting.agenda || []).filter((a) => !PRO_AGENDA_TOPIC.test(String(a.topic || "")));
  const baseToday = (meeting.today || []).filter((t) => !/^【(結論|連携の穴|次の1手)】/.test(String(t)));

  // 画像flash→Pro 連携の step6 を確定し、根拠行を差し替え
  const prevLink = (meeting as { vision_pro_link?: VisionProLink }).vision_pro_link;
  if (prevLink) {
    const nextLink = markVisionProUsed(prevLink, meta?.usedPro !== false, meta?.model);
    (meeting as { vision_pro_link?: VisionProLink }).vision_pro_link = nextLink;
    baseEvidence = baseEvidence.filter((e) => !/^画像学習→統括Pro連携$/.test(String(e.label || "")));
    baseEvidence.unshift({
      label: "画像学習→統括Pro連携",
      value: nextLink.line,
      guessed: nextLink.bottleneck_n != null,
    });
  }

  const today = [...(enrich.today || [])];
  if (!today.length && enrich.next_line) today.push(enrich.next_line);
  for (const t of baseToday) {
    if (!today.includes(t)) today.push(t);
  }
  meeting.today = today.slice(0, 8);

  const evidence = [...baseEvidence];
  evidence.unshift({
    label: "統括Proまとめ",
    value: [
      enrich.quality_up ? `質: ${enrich.quality_up}` : null,
      enrich.next_line ? `次: ${enrich.next_line}` : null,
      enrich.link_gap ? `連携: ${enrich.link_gap}` : null,
      meta?.model ? `model=${meta.model}` : null,
    ].filter(Boolean).join("／") || "Proまとめあり",
    guessed: false,
  });
  if (enrich.foundation_gaps.length) {
    evidence.unshift({
      label: "足りない土台（統括Pro判断）",
      value: enrich.foundation_gaps.map((g, i) => `${i + 1}.${g}`).join(" → "),
      guessed: false,
    });
  }
  if (enrich.build_next) {
    evidence.unshift({
      label: "土台を作る次手（統括Pro）",
      value: enrich.build_next,
      guessed: false,
    });
  }
  if (enrich.why_not_100) {
    evidence.unshift({
      label: "なぜ100%でないか（統括Pro）",
      value: enrich.why_not_100,
      guessed: /仮定/.test(enrich.why_not_100),
    });
  }
  if (enrich.path_to_100) {
    evidence.unshift({
      label: "100%への道（統括Pro）",
      value: enrich.path_to_100,
      guessed: false,
    });
  }
  if (enrich.weak_fixes.length) {
    evidence.unshift({
      label: "弱点の細かい改善（統括Pro）",
      value: enrich.weak_fixes
        .map((f, i) => {
          const bits = [
            `${f.field}:${f.gap}→${f.next}`,
            f.why ? `なぜ:${f.why}` : null,
            f.how ? `どう:${f.how}` : null,
            f.hypothesis || null,
            f.toward100 ? `100%:${f.toward100}` : null,
            f.layer ? `(${f.layer})` : null,
          ].filter(Boolean);
          return `${i + 1}.` + bits.join("｜");
        })
        .join(" ／ "),
      guessed: enrich.weak_fixes.some((f) => /仮定/.test(String(f.hypothesis || ""))),
    });
  }
  if (enrich.bug_fixes.length) {
    evidence.unshift({
      label: "変バグの細かい直し（統括Pro）",
      value: enrich.bug_fixes.map((b, i) => `${i + 1}.${b}`).join(" ／ "),
      guessed: false,
    });
  }
  evidence.unshift({
    label: "役割分担（画像/統括）",
    value: "画像読み=flash／統括まとめ=Pro／関所・verdict=決定論。混ぜない",
    guessed: false,
  });
  if (meta?.brainPull) {
    const bp = meta.brainPull;
    evidence.unshift({
      label: "統括Pro RAG",
      value: bp.line + (bp.kb_hits.length
        ? "／" + bp.kb_hits.slice(0, 4).map((h) => `${h.id8}:${h.title.slice(0, 28)}`).join("・")
        : ""),
      guessed: !bp.ok,
    });
    /** ★ 把握の正本: 引いた決まりの要旨＋ログ記憶を人が読める形で残す（題だけだと把握できない） */
    const graspBits: string[] = [];
    if (bp.kb_hits.length) {
      graspBits.push(
        "知見" + bp.kb_hits.slice(0, 3).map((h) =>
          `${h.id8}「${h.title.slice(0, 36)}」:${h.insight.slice(0, 70)}`,
        ).join("｜"),
      );
    } else {
      graspBits.push("知見0件（引き失敗または空）");
    }
    if (bp.log_memory.length) {
      graspBits.push(
        "ログ" + bp.log_memory.slice(0, 2).map((l) =>
          `${String(l.at).slice(0, 16)}:${l.today.slice(0, 50)}`,
        ).join("｜"),
      );
    } else {
      graspBits.push("ログ記憶0");
    }
    if (bp.query) graspBits.push("問い:" + bp.query.slice(0, 80));
    evidence.unshift({
      label: "統括Pro把握",
      value: graspBits.join(" ／ ").slice(0, 420),
      guessed: !bp.ok,
    });
  }
  {
    const arrange = [enrich.next_line, enrich.build_next, enrich.path_to_100].filter(Boolean).join(" → ");
    if (arrange) {
      evidence.unshift({
        label: "統括Pro手配",
        value: arrange.slice(0, 280),
        guessed: false,
      });
    }
  }
  meeting.evidence = evidence.slice(0, 48);

  const agendaHead: Array<{ priority: number; topic: string; why: string; decide: string }> = [];
  if (enrich.link_gap) {
    agendaHead.push({
      priority: 0,
      topic: "連携の穴（統括Pro）",
      why: enrich.link_gap,
      decide: enrich.next_line || "画像flash→材料→Proまとめ→課題の順で穴を塞ぐ",
    });
  }
  if (enrich.foundation_gaps.length || enrich.build_next) {
    agendaHead.push({
      priority: 0,
      topic: "足りない土台をそろえる（統括Pro判断）",
      why: enrich.foundation_gaps.join("／") || "土台不足",
      decide: enrich.build_next || "通常録画から足りない土台を作る",
    });
  }
  for (const f of enrich.weak_fixes.slice(0, 3)) {
    agendaHead.push({
      priority: 0,
      topic: `弱点細分化（統括Pro）: ${f.field}`,
      why: [f.gap, f.why ? `なぜ:${f.why}` : null, f.hypothesis || null].filter(Boolean).join("／"),
      decide: [f.how || f.next, f.toward100 ? `100%へ:${f.toward100}` : null, f.layer ? `層=${f.layer}` : null]
        .filter(Boolean).join("／"),
    });
  }
  if (enrich.path_to_100 || enrich.next_line || enrich.build_next) {
    agendaHead.push({
      priority: 0,
      topic: "手配（統括Pro）: 把握→改善→実行の順",
      why: enrich.why_not_100 || enrich.link_gap || "抜けを塞ぎ学習を進める",
      decide: [enrich.next_line, enrich.build_next, enrich.path_to_100].filter(Boolean).join(" → "),
    });
  }
  if (enrich.path_to_100) {
    agendaHead.push({
      priority: 0,
      topic: "100%へ近づける道（統括Pro）",
      why: enrich.why_not_100 || "再現・完成度が100%未満",
      decide: enrich.path_to_100,
    });
  }
  if (enrich.bug_fixes.length) {
    agendaHead.push({
      priority: 0,
      topic: "変バグを細かく直す（統括Pro）",
      why: enrich.bug_fixes.join("／"),
      decide: "直押し・直書き・外し区別を人間の動きに揃える（拡張の細かい直し）",
    });
  }
  meeting.agenda = [...agendaHead, ...baseAgenda].slice(0, 14);

  // photo_learn 課題の why に Pro の弱点名指しを足す（kind/limit は変えない）
  if (enrich.weak_fixes.length && Array.isArray(meeting.learning_tasks)) {
    meeting.learning_tasks = meeting.learning_tasks.map((t) => {
      if (!t || t.kind !== "photo_learn") return t;
      const flashFixes = enrich.weak_fixes.filter((f) => !f.layer || f.layer === "flash").slice(0, 4);
      if (!flashFixes.length) return t;
      const tip = flashFixes.map((f) => f.field).join("・");
      if (/統括Pro弱点/.test(t.why)) return t;
      return { ...t, why: `${t.why}／統括Pro弱点: ${tip}` };
    });
  }
  return { ...adv, meeting };
}

async function callProOnce(
  adv: SupervisorAdvice,
  model: string,
  key: string,
  maxTokens: number,
  meetOpts?: SupervisorProMeetOpts | null,
  timeoutMs: number = SUPERVISOR_PRO_TIMEOUT_MS_DEFAULT,
  brainPull?: SupervisorProBrainPull | null,
): Promise<{ text: string; finish: string; status: number }> {
  const hasMeet = !!(meetOpts?.meet && meetOpts.meet.length);
  const hasKb = !!(brainPull?.kb_hits && brainPull.kb_hits.length);
  const lead = [
    hasMeet
      ? "【打合せ】次の meet 議題を最優先で細分化して判断してください。材料の axes/handoff/weak_atoms/kb_hits と突き合わせて答える。"
      : "次の統括材料を細かく判断してください。足りない土台と次手・手配を優先して。",
    hasKb
      ? "【RAG】kb_hits は設計知見から引いた現行の決まり。矛盾したら段が上・新しい方。無い物は仮定と書く。"
      : "【RAG】kb_hits が空。設計知見を引く経路を次手に含める。",
  ].join("\n") + "\n";
  const r = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "x-sumora-action": SUPERVISOR_PRO_ACTION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.2,
      // ⚠ 思考が max_tokens を食って本文0字になるのを防ぐ（実測 finish=length）
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: SUPERVISOR_PRO_SYSTEM },
        {
          role: "user",
          content: lead + JSON.stringify(buildSupervisorProPayload(adv, meetOpts, brainPull)),
        },
      ],
    }),
  });
  if (!r.ok) {
    await r.text().catch(() => "");
    return { text: "", finish: `http_${r.status}`, status: r.status };
  }
  const d = await r.json() as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
  };
  const text = String(d.choices?.[0]?.message?.content ?? "").trim();
  const finish = String(d.choices?.[0]?.finish_reason ?? "");
  return { text, finish, status: r.status };
}

/**
 * DeepSeek Pro に聞く。失敗理由を返す（握りつぶさない＝Proが動いているか分かる）。
 */
export async function askSupervisorPro(
  adv: SupervisorAdvice,
  env: Record<string, string | undefined> = process.env,
  meetOpts?: SupervisorProMeetOpts | null,
): Promise<SupervisorProAskResult> {
  const model = supervisorProModel(env);
  if ((env.SUPERVISOR_PRO ?? "on").toLowerCase() === "off") {
    return { ok: false, why: "SUPERVISOR_PRO=off", model, brainPull: null };
  }
  const key = (env.LLM_ALT_DEEPSEEK_KEY || env.DEEPSEEK_API_KEY || "").trim();
  if (!key) return { ok: false, why: "no_api_key", model, brainPull: null };

  /** ★ 2026-11-17: 判断前に設計知見RAG＋統括ログを引く（真のブレイン） */
  let brainPull: SupervisorProBrainPull | null = null;
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const url = (env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
    const sk = (env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
    if (url && sk) {
      const { fetchSupervisorProBrainPull } = await import("./learn-supervisor-pro-rag");
      brainPull = await fetchSupervisorProBrainPull(createClient(url, sk), adv, meetOpts);
    } else {
      brainPull = {
        query: "",
        kb_hits: [],
        log_memory: [],
        line: "統括Pro RAGスキップ（Supabase鍵なし）",
        ok: false,
        why: "no_supabase",
      };
    }
  } catch (e) {
    brainPull = {
      query: "",
      kb_hits: [],
      log_memory: [],
      line: "統括Pro RAG失敗: " + String((e as Error)?.message || e).slice(0, 80),
      ok: false,
      why: String((e as Error)?.message || e).slice(0, 100),
    };
  }

  // ★ 2026-11-16: why/how/hypothesis 追加後に finish=length で JSON 途中切れ→parse_fail が再発。
  //   既定 4000・失敗時は増やして再試行（空本文だけでなく parse_fail も）。
  // ★ 2026-11-16: Abort 60s が Pro 未使用の主因 → 既定 180s＋abort 時は1回だけ再試行。
  const max1 = Math.max(2000, Number(env.SUPERVISOR_PRO_MAX_TOKENS) || 4000);
  const timeoutMs = supervisorProTimeoutMs(env);
  const runOnce = (tok: number) => callProOnce(adv, model, key, tok, meetOpts, timeoutMs, brainPull);
  try {
    let hit = await runOnce(max1);
    let enrich = hit.text ? parseSupervisorPro(hit.text) : null;
    // 空本文 or 途中切れ JSON → トークン倍で1回だけ再試行（HTTP失敗は増やさない）
    if ((!hit.text || !enrich) && hit.status < 400) {
      hit = await runOnce(Math.min(8000, Math.max(max1 * 2, 6000)));
      enrich = hit.text ? parseSupervisorPro(hit.text) : null;
    }
    if (hit.status >= 400) {
      return { ok: false, why: `deepseek_http_${hit.status}:${hit.finish}`, model, brainPull };
    }
    if (!hit.text) {
      return { ok: false, why: `empty_content(finish=${hit.finish || "?"})`, model, brainPull };
    }
    if (!enrich) {
      return { ok: false, why: "parse_fail:" + hit.text.slice(0, 80), model, brainPull };
    }
    return { ok: true, enrich, model, brainPull };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    // Abort/timeout は一時揺れが多い → 同じ上限でもう1回だけ（無限に伸ばさない）
    if (/aborted|timeout|TimeoutError/i.test(msg)) {
      try {
        const hit2 = await runOnce(Math.min(8000, Math.max(max1 * 2, 6000)));
        const enrich2 = hit2.text ? parseSupervisorPro(hit2.text) : null;
        if (hit2.status >= 400) {
          return { ok: false, why: `deepseek_http_${hit2.status}:${hit2.finish}(after_abort_retry)`, model, brainPull };
        }
        if (enrich2) return { ok: true, enrich: enrich2, model, brainPull };
        if (!hit2.text) {
          return { ok: false, why: `empty_content(finish=${hit2.finish || "?"};after_abort_retry)`, model, brainPull };
        }
        return { ok: false, why: "parse_fail(after_abort_retry):" + hit2.text.slice(0, 80), model, brainPull };
      } catch (e2) {
        return {
          ok: false,
          why: `exception:${msg.slice(0, 80)}|retry:${String((e2 as Error)?.message || e2).slice(0, 60)}|timeout_ms=${timeoutMs}`,
          model,
          brainPull,
        };
      }
    }
    return { ok: false, why: "exception:" + msg.slice(0, 120), model, brainPull };
  }
}

/** 決定論の advice を Pro で判断。失敗時は元のまま＋why。meetOpts で Cursor 打合せ議題を渡せる */
export async function enrichSupervisorWithPro(
  adv: SupervisorAdvice,
  env: Record<string, string | undefined> = process.env,
  meetOpts?: SupervisorProMeetOpts | null,
): Promise<{ advice: SupervisorAdvice; usedPro: boolean; model: string | null; why: string | null }> {
  const got = await askSupervisorPro(adv, env, meetOpts);
  if (!got.ok) {
    // 失敗も根拠に残す（Proが動いていないのを隠さない）＋画像連携 step6 を✗に
    const meeting = { ...(adv.meeting || { today: [], agenda: [], questions: [], evidence: [] }) };
    const prevLink = (meeting as { vision_pro_link?: VisionProLink }).vision_pro_link;
    if (prevLink) {
      const nextLink = markVisionProUsed(prevLink, false, got.model);
      (meeting as { vision_pro_link?: VisionProLink }).vision_pro_link = nextLink;
      meeting.evidence = (meeting.evidence || [])
        .filter((e) => !/^画像学習→統括Pro連携$/.test(String(e.label || "")));
      meeting.evidence.unshift({
        label: "画像学習→統括Pro連携",
        value: nextLink.line,
        guessed: true,
      });
    }
    const evidence = [...(meeting.evidence || [])];
    if (got.brainPull) {
      evidence.unshift({
        label: "統括Pro RAG",
        value: got.brainPull.line,
        guessed: !got.brainPull.ok,
      });
    }
    evidence.unshift({
      label: "統括Pro",
      value: `未使用（${got.why}）／model=${got.model} → 決定論のみ`,
      guessed: false,
    });
    meeting.evidence = evidence.slice(0, 44);
    return { advice: { ...adv, meeting }, usedPro: false, model: got.model, why: got.why };
  }
  return {
    advice: mergeSupervisorPro(adv, got.enrich, {
      model: got.model,
      usedPro: true,
      brainPull: got.brainPull,
    }),
    usedPro: true,
    model: got.model,
    why: null,
  };
}
