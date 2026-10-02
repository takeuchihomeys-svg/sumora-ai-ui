// app/lib/claude-model-map.ts
// Claude Sonnet 5 → Sonnet 5.5 の置き換えを「全経路が通る出口（fetch）」の1か所で行う純関数と、送る手順（断りの時に Sonnet 5 へ1回戻す）
//
// 2026-09-29 竹内「Sonnet を Sonnet 5.5 に置き換えたら費用高くなるか。費用も抑えて質が上がるなら置き換える。設計知見と協力して」:
//   "claude-sonnet-5" の文字列は app 以下 39 ファイル・thinking disabled は 79 か所（Haiku・DeepSeek 用も混ざる）。
//   1つずつ書き換えると、温め（brain-warm・prefix-warm・keep-warm）と本物の片方だけ替わってキャッシュが割れる・戻す時にまた39ファイル、になる。
//   → 設計知見「LLM 呼び出しの出口の型」と同じく、出口で1回だけ直す。既定（環境変数なし）は何もしない＝今まで通り Sonnet 5。
//
// 公式（platform.claude.com・9/28 公開）: claude-sonnet-5-5 は Sonnet 5 と同じ単価（入力 $2・5分書き $2.5・1h書き $4・読み $0.20・出力 $10）・同じトークナイザ。
//   Sonnet 5 から壊れる所（そのまま送ると 400）:
//     ① thinking {type:"disabled"} → {type:"between_tools"}（ツール無しの呼び出しなら disabled と同じく本文だけ返る）。
//        between_tools と組める effort は low/medium/high だけ（xhigh/max は 400）・display/budget_tokens/block_binding を付けると 400
//     ② tool_choice の any / tool は 400 → **この呼び出しは置き換えない**（2026-09-29 時点で app 以下に tool_choice は0件。
//        auto＋「このツールを使え」に書き換えると動きが変わるので、出口では替えずに Sonnet 5 のまま送る＝fail-closed）
//     ③ temperature / top_p / top_k は既定以外 400 → 落とす（Sonnet 5 も既定以外は 400 なので、今送っている呼び出しは無い想定）
//   キャッシュはモデルごと: 切り替えた日に前置き（ブレイン 40k 等）を1回ずつ作り直す。**本物と温めは1組で替える**（CACHE_GROUPS）。
//
// 環境変数（両方そろった時だけ動く）:
//   CLAUDE_SONNET_MODEL=claude-sonnet-5-5         … 置き換え先（これ以外の値は無視＝今まで通り）
//   CLAUDE_SONNET55_ACTIONS=customer_summary,final_check_context_check,final_check_revision
//                                                  … 名札（x-sumora-llm-action）で選ぶ。`*` で全部・`final_check_*` で前方一致・`-名前` で外す。
//                                                    名札の無い呼び出し（action=null）は `*` の時だけ（返信生成は system 先頭の「ハードゲート」で reply_generate と見なす）
//   名前を1つ書くと、同じ前置きのキャッシュを分け合う組（本物＋温め）が丸ごと替わる（外す時も組で外れる）。
//
// 置き換えは llm_usage_logs の記録の包みの内側（記録が実際に送ったモデル・thinking を見る順番）で行う: llm-usage-recorder が呼ぶ。
//   （絵文字の片割れ除去 llm-request-sanitize は記録の包みより内側にいて、名札のヘッダはその手前で取り除かれるため、名札で選ぶ置き換えはここに置く）

export const SONNET_BASE_MODEL = "claude-sonnet-5";
export const SONNET_55_MODEL = "claude-sonnet-5-5";
/** 置き換え先として受け付ける値（書き間違い・未知のモデルで 400 を量産しない） */
const SUPPORTED_TARGETS: ReadonlySet<string> = new Set([SONNET_55_MODEL]);

/** llm-alt-provider.ROUTE_MARKERS.reply_generate と同じ文字列（循環 import を避けて写す。テストで一致を固定） */
export const REPLY_GENERATE_SYSTEM_MARKER = "ハードゲート";

export type ClaudeModelEnv = { CLAUDE_SONNET_MODEL?: string; CLAUDE_SONNET55_ACTIONS?: string };

/**
 * 同じ前置き（プロンプトキャッシュ）を分け合う名札の組。片方だけ替えると、温めが古いモデルを温め続けて費用だけかかる／
 * 本物と温めが別のキャッシュを書き合う。組の1つを選ぶ（外す）と組の全部が選ばれる（外れる）。
 */
const CACHE_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  // ブレイン: 毎回の層・全体の層・DeepSeek の取り直し・温め（brain-sweep）は同じ system 2ブロック（brainRequestBase）
  //   2026-10-02: お客様ごとの温め（brain-conv-warm・cache-warm-switch-server）も同じ前置き＋会話専用ブロック＝同じ組
  ["brain_fresh", "brain_full", "brain_fresh_claude", "brain-warm", "brain-conv-warm"],
  // 返信生成（名札なし・system 先頭で判定）と keep-warm（同じ ChatAnthropic の設定で読み直す）
  ["reply_generate", "keep-warm"],
  ["customer_summary", "customer_summary_warm"],
  ["suggest_next_action", "suggest_next_action_warm"],
  ...(["rule_check", "anomaly_scan", "context_check", "revision"] as const).map((p) => [`final_check_${p}`, `final_check_warm_${p}`]),
];

/** 名札 → 同じキャッシュの組（組に無い名前は、`x_warm` → `x`・`x_warm_y` → `x_y` の形なら対にする。それ以外は自分だけ） */
export function cacheGroupOf(name: string): string[] {
  const g = CACHE_GROUPS.find((grp) => grp.includes(name));
  if (g) return [...g];
  const m1 = /^(.+)_warm$/.exec(name);
  if (m1) return [m1[1], name];
  const m2 = /^(.+)_warm_(.+)$/.exec(name);
  if (m2) return [`${m2[1]}_${m2[2]}`, name];
  return [name];
}

export type ActionList = { all: boolean; include: string[]; exclude: string[] };

export function parseActionList(raw: string | undefined | null): ActionList {
  const out: ActionList = { all: false, include: [], exclude: [] };
  for (const t0 of String(raw ?? "").split(",")) {
    const t = t0.trim();
    if (!t) continue;
    if (t === "*") out.all = true;
    else if (t.startsWith("-") && t.length > 1) out.exclude.push(t.slice(1).trim());
    else out.include.push(t);
  }
  return out;
}

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/** 名札なしの呼び出しの名前（返信生成だけ system 先頭で見分ける。他は null） */
export function effectiveActionName(action: string | null, systemHead: string | null): string | null {
  const a = (action ?? "").trim();
  if (a) return a;
  if ((systemHead ?? "").slice(0, 200).includes(REPLY_GENERATE_SYSTEM_MARKER)) return "reply_generate";
  return null;
}

/** この名前（組ごと）を置き換えるか。name=null（名札なし）は `*` の時だけ */
export function isActionSelected(name: string | null, list: ActionList): boolean {
  if (!name) return list.all;
  const group = cacheGroupOf(name);
  if (group.some((n) => list.exclude.some((p) => matchesPattern(n, p)))) return false;
  if (list.all) return true;
  return group.some((n) => list.include.some((p) => matchesPattern(n, p)));
}

export type ClaudeModelMapResult = {
  body: string;
  changed: boolean;
  /** 替えなかった理由・替えた時は "mapped" */
  reason: "not_configured" | "unsupported_target" | "not_json" | "other_model" | "not_selected" | "forced_tool_choice" | "mapped";
  from?: string;
  to?: string;
  /** 写した所（thinking:disabled→between_tools・effort:xhigh→high・drop:temperature 等） */
  edits: string[];
};

function systemHeadOf(system: unknown): string | null {
  if (typeof system === "string") return system.slice(0, 200);
  if (Array.isArray(system)) {
    const first = system.find((b) => b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") as { text: string } | undefined;
    return first ? first.text.slice(0, 200) : null;
  }
  return null;
}

/**
 * 純関数。/v1/messages の JSON 本文を Sonnet 5 → 置き換え先に写す。替えない時は本文を1文字も変えない（キャッシュの先頭一致を壊さない）。
 * 替える時も JSON のキーの並びは元のまま（model の値の差し替え・thinking の中身・不要なキーの削除だけ）。
 */
export function mapClaudeModelRequest(body: string, env: ClaudeModelEnv, action: string | null): ClaudeModelMapResult {
  const target = (env.CLAUDE_SONNET_MODEL ?? "").trim();
  const listRaw = (env.CLAUDE_SONNET55_ACTIONS ?? "").trim();
  const keep = (reason: ClaudeModelMapResult["reason"]): ClaudeModelMapResult => ({ body, changed: false, reason, edits: [] });
  if (!target || target === SONNET_BASE_MODEL || !listRaw) return keep("not_configured");
  if (!SUPPORTED_TARGETS.has(target)) return keep("unsupported_target");
  // 速い判定: 本文に "claude-sonnet-5" が無ければ JSON を読まない
  if (!body.includes(`"${SONNET_BASE_MODEL}"`)) return keep("other_model");
  let j: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return keep("not_json");
    j = parsed as Record<string, unknown>;
  } catch { return keep("not_json"); }
  if (j.model !== SONNET_BASE_MODEL) return keep("other_model");
  const name = effectiveActionName(action, systemHeadOf(j.system));
  if (!isActionSelected(name, parseActionList(listRaw))) return keep("not_selected");
  // ② 強制のツール選択は Sonnet 5.5 で 400。書き換えると動きが変わるので、この呼び出しは Sonnet 5 のまま
  const tc = j.tool_choice as { type?: unknown } | undefined;
  if (tc && typeof tc === "object" && (tc.type === "any" || tc.type === "tool")) return keep("forced_tool_choice");

  const edits: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(j)) {
    if (k === "model") { out.model = target; continue; }
    // ③ サンプリングは既定以外 400 → 落とす（落とす＝既定）
    if (k === "temperature" || k === "top_p" || k === "top_k") { edits.push(`drop:${k}`); continue; }
    if (k === "thinking" && v && typeof v === "object") {
      const th = v as Record<string, unknown>;
      if (th.type === "disabled") {
        // ① disabled は 400 → between_tools（display・budget_tokens・block_binding は付けない）
        out.thinking = { type: "between_tools" };
        edits.push("thinking:disabled→between_tools");
        continue;
      }
    }
    out[k] = v;
  }
  // between_tools と組める effort は low/medium/high だけ（xhigh/max は 400）→ high に下げる
  const th = out.thinking as { type?: unknown } | undefined;
  const oc = out.output_config as Record<string, unknown> | undefined;
  if (th?.type === "between_tools" && oc && typeof oc === "object" && (oc.effort === "xhigh" || oc.effort === "max")) {
    edits.push(`effort:${String(oc.effort)}→high`);
    out.output_config = { ...oc, effort: "high" };
  }
  return { body: JSON.stringify(out), changed: true, reason: "mapped", from: SONNET_BASE_MODEL, to: target, edits };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** 断り（stop_reason=refusal）の JSON 応答か。ストリーミング（SSE）は途中で戻せないので見ない */
export async function isRefusalJsonResponse(res: Response): Promise<boolean> {
  if (!res.ok) return false;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) return false;
  try {
    const j = JSON.parse(await res.clone().text()) as { stop_reason?: unknown };
    return j.stop_reason === "refusal";
  } catch { return false; }
}

/**
 * /v1/messages を送る手順（llm-usage-recorder の2つの包みが使う）:
 *   置き換えの対象なら写した本文で送る → 断り（refusal）の JSON 応答なら元の本文（Sonnet 5）で1回だけ送り直す。
 *   Sonnet 5 は14日で断り0件。Sonnet 5.5 は普通の作業でも断りが出得て、ブレイン等は断りで結果が黙って空になるため、出口で戻す。
 *   send は1回の HTTP（記録の包みでは1行の記録を含む）。env は呼んだ時点の process.env（テストでは差し込む）
 */
export async function sendWithClaudeModelMap(
  send: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  action: string | null,
  env: ClaudeModelEnv = process.env as ClaudeModelEnv,
): Promise<Response> {
  let mapped: ClaudeModelMapResult | null = null;
  try {
    if (typeof init?.body === "string") mapped = mapClaudeModelRequest(init.body, env, action);
  } catch { mapped = null; /* 写しの失敗で送信を止めない（元のまま送る） */ }
  if (!mapped || !mapped.changed) return send(input, init);
  const res = await send(input, { ...init, body: mapped.body });
  // 400（写し漏れの形・未知の制約）は課金されない。お客様の処理を止めないよう Sonnet 5 で1回送り直す（記録には 400 の行が残る＝後から直せる）
  if (res.status === 400) {
    console.warn(JSON.stringify({ tag: "llm:sonnet55-400-fallback", action, edits: mapped.edits, body: (await res.clone().text().catch(() => "")).slice(0, 300) }));
    return send(input, init);
  }
  if (await isRefusalJsonResponse(res)) {
    console.warn(JSON.stringify({ tag: "llm:sonnet55-refusal-fallback", action, from: mapped.to, to: mapped.from }));
    return send(input, init);
  }
  return res;
}
