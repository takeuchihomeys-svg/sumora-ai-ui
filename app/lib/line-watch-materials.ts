// app/lib/line-watch-materials.ts
// 見張り（line_watch_turns）に「その番に渡った材料の要約」と「出さなかった下書き」を残すための純関数（DB に触らない）。
//
// 2026-10-08 竹内「大丈夫」（返信の質 8巡目・記録）:
//   見張りは「AI の案 × スタッフの送信」を比べるが、外れた時に「材料が届いていなかったのか」（絶対的な考え方の外れの原因①）を
//   後から確かめる手掛かりが行に無かった（Vercel のログは数日で消える）。ブレイン（brain:blocks・brain:rag）と
//   返信（gen:scene・step2-spec・返信の材料の大きさ）がすでにログに出している JSON から、小さな要約（材料名→件数/文字数・
//   エラー・時間切れ）を作って行の materials 列に残す。
//   下書きの欄: 画面の印 __SHOWN__ は 10/07 にトリガーで控えなくなった（本番で確認: 10/07 以降 0行）。
//   残る「下書きが行に無い」経路は、生成したが出さなかった下書き（直前に送った文とほぼ同じ＝__SHOWN__ で保存・返信でない文＝保存しない）
//   → materials.suppressed に本文（2,000字まで）と理由を残す。
// 戻す: LINE_WATCH_MATERIALS=off

export type WatchSource = "brain" | "reply" | "suppressed";
export type QueryStat = { n?: number | null; chars?: number | null; err?: string | null; timeout?: boolean };
export type MaterialSummary = Record<string, unknown>;

export function lineWatchMaterialsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LINE_WATCH_MATERIALS ?? "").toLowerCase() !== "off";
}

/** エラーの文が時間切れか（Postgres の statement timeout・fetch の中断・自前の時間切れ） */
export function isTimeoutError(msg: string | null | undefined): boolean {
  return /time\s*out|timed\s*out|timeout|canceling statement|aborted|AbortError|ETIMEDOUT|57014/i.test(String(msg ?? ""));
}

const short = (s: unknown, n = 120): string | null => (s == null ? null : String(s).slice(0, n));

function queryStat(v: unknown): QueryStat | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const err = short(o.err ?? o.error, 120);
  const st: QueryStat = {};
  if (typeof o.n === "number") st.n = o.n;
  if (err) { st.err = err; if (isTimeoutError(err)) st.timeout = true; }
  return st;
}

/** 0でない文字数だけ（どの材料が届いたか）と、空だった材料の名前 */
function nonZero(chars: unknown): { chars: Record<string, number>; empty: string[] } {
  const out: Record<string, number> = {}; const empty: string[] = [];
  if (chars && typeof chars === "object") {
    for (const [k, v] of Object.entries(chars as Record<string, unknown>)) {
      if (typeof v !== "number") continue;
      if (v > 0) out[k] = v; else empty.push(k);
    }
  }
  return { chars: out, empty };
}

/**
 * ログの JSON（tag 付き）→ 見張りに残す要約。知らない tag は null（残さない）。
 * 返り値の key は materials.<source>.<key> に入る。
 */
export function summarizeMaterialLog(obj: unknown): { source: WatchSource; key: string; summary: MaterialSummary } | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  switch (o.tag) {
    case "brain:blocks": {
      const { chars, empty } = nonZero(o.chars);
      return { source: "brain", key: "blocks", summary: { mode: short(o.mode, 30), layer: short(o.layer, 20), userTotal: typeof o.userTotal === "number" ? o.userTotal : null, chars, empty, customerStage: short(o.customerStage, 40), brainScene: short(o.brainScene, 40) } };
    }
    case "brain:rag": {
      if (o.error) return { source: "brain", key: "rag", summary: { err: short(o.error), timeout: isTimeoutError(String(o.error)) } };
      return { source: "brain", key: "rag", summary: { knowledge: queryStat(o.knowledge), winning: queryStat(o.winning), templates: queryStat(o.templates) } };
    }
    case "brain:parallel-search":
      return { source: "brain", key: "parallel", summary: { scene: short(o.scene, 40), on: o.on ?? null } };
    case "gen:scene":
      return { source: "reply", key: "scene", summary: { scene: short(o.scene, 40), materials: short(o.materials, 10) } };
    case "step2-spec": {
      const s = (o.spec ?? {}) as Record<string, unknown>;
      return { source: "reply", key: "spec", summary: { tier: short(o.tier, 10), knowledgeLimit: typeof s.knowledgeLimit === "number" ? s.knowledgeLimit : null, filterTopics: Array.isArray(s.filterTopics) ? (s.filterTopics as unknown[]).slice(0, 8).map((x) => short(x, 30)) : null } };
    }
    default:
      return null;
  }
}

/**
 * 返信の材料（取ってきた物）の大きさ: 文字列は文字数・配列は件数・それ以外は null。空だった材料の名前も返す。
 * 取得の失敗は各 fetch が "" を返す作りなので「空」として見える（エラーの文は残らない）。
 */
export function replyMaterialSizes(inputs: Record<string, unknown>, meta: Record<string, unknown> = {}): MaterialSummary {
  const sizes: Record<string, number> = {}; const empty: string[] = [];
  for (const [k, v] of Object.entries(inputs)) {
    const n = typeof v === "string" ? v.length : Array.isArray(v) ? v.length : typeof v === "number" ? v : null;
    if (n == null) continue;
    if (n > 0) sizes[k] = n; else empty.push(k);
  }
  return { ...meta, sizes, empty };
}

const MAX_JSON = 6000;
const MAX_DRAFT = 2000;

/** 出さなかった下書き（本文と理由） */
export function suppressedDraftSummary(text: string, reason: string): MaterialSummary {
  return { reason: short(reason, 60), text: String(text ?? "").slice(0, MAX_DRAFT), chars: String(text ?? "").length };
}

/** 前の materials に source.key を足す（同じ key は新しい物で置き換え・at を付ける）。大きすぎる時は古い key から落とす */
export function mergeWatchMaterials(prev: unknown, add: ReadonlyArray<{ source: WatchSource; key: string; summary: MaterialSummary; at: string }>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (prev && typeof prev === "object" && !Array.isArray(prev)) {
    for (const [s, v] of Object.entries(prev as Record<string, unknown>)) if (v && typeof v === "object" && !Array.isArray(v)) out[s] = { ...(v as Record<string, unknown>) };
  }
  for (const a of add) {
    out[a.source] ??= {};
    out[a.source][a.key] = { ...a.summary, at: a.at };
  }
  // 大きさの上限（トリガーの控えと同じく小さく）: 超えたら下書き本文を縮め、それでも超えたら chars の細目を落とす
  let json = JSON.stringify(out);
  if (json.length > MAX_JSON && out.suppressed) {
    for (const v of Object.values(out.suppressed)) if (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string") (v as { text: string }).text = (v as { text: string }).text.slice(0, 600);
    json = JSON.stringify(out);
  }
  if (json.length > MAX_JSON && out.brain?.blocks && typeof out.brain.blocks === "object") {
    delete (out.brain.blocks as Record<string, unknown>).chars;
  }
  return out;
}

/**
 * 今開いている番の鍵（トリガー capture_line_watch_turn と同じ決め方）:
 *   最後のスタッフ（customer 以外）の発言より後のお客様の発言のうち一番古い物の時刻。無ければ null（番が開いていない）
 */
export function openTurnKey(msgs: ReadonlyArray<{ sender: string; created_at: string }>): string | null {
  let lastStaff = -Infinity;
  for (const m of msgs) if (m.sender !== "customer") lastStaff = Math.max(lastStaff, Date.parse(m.created_at));
  let first: { t: number; iso: string } | null = null;
  for (const m of msgs) {
    if (m.sender !== "customer") continue;
    const t = Date.parse(m.created_at);
    if (!(t > lastStaff)) continue;
    if (!first || t < first.t) first = { t, iso: m.created_at };
  }
  return first?.iso ?? null;
}
