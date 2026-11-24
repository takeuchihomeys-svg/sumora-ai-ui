// app/lib/provider-profile.ts — 相手（claude・openai・deepseek）× 係ごとの使い方の表（純関数・DB なし）
//
// 2026-11-24 作業員L（台帳 #670 の子・竹内さん 11/24「試験のところ GPT の性質に合わせるようにするよう徹底する仕組みを作って行う」・統括役の仕様）
//   その場ごとの工夫にせず、要求の形・考える深さ・出力の形・キャッシュ・待ち時間・言い添え・長さの目安を、版の名前つきで1か所に置く。
//   OpenAI を呼ぶ所は、試験も本番も全部 profileFor → openaiRequestOf を通してから送る（通っていない所が無い事は app/lib/__tests__/provider-profile.test.ts が探す）。
//   版を上げる時は表に新しい行を足し、試験で前の版より悪化0なら既定の版を替える（OPENAI_PROFILE_<係>=<版> で試験だけ替える）。
//   DeepSeek の行は今の使い方をそのまま書いた物（動きは変えない・llm-alt-provider の toOpenAIBody と readBusyGuard の既定と同じ値）。

type Env = Record<string, string | undefined>;

export type ProfileProvider = "claude" | "openai" | "deepseek";
export type ProfileRole = "brain" | "conductor" | "writer" | "final_check" | "judge" | "light";
export type ProviderProfile = {
  /** 版の名前（答案・結果・記録に残す） */
  version: string;
  provider: ProfileProvider;
  role: ProfileRole;
  request: {
    /** 出力の上限の欄の名前 */
    tokenField: "max_tokens" | "max_completion_tokens";
    /** 呼び出し側の max_tokens に掛ける数（思考の分）と下限 */
    maxTokensFactor: number;
    minMaxTokens: number;
    /** temperature を送るか（GPT の考えるモデルは送らない） */
    temperature: boolean;
  };
  /** 考える深さ（null＝相手の既定）。DeepSeek は思考を切る（disabled） */
  reasoning: { effort: "low" | "medium" | "high" | null; deepseekThinking?: "disabled" };
  /** 出力の形: none＝指示文のまま／json_object＝JSON モード（欄の言い添え keys があれば足す）／json_schema_strict＝欄を必須に（まだ使わない・案） */
  output: { json: "none" | "json_object" | "json_schema_strict"; keys?: readonly string[] };
  /** キャッシュ: prompt_cache_key を係ごとに・言い添えは system の最後（先頭の並びを変えない）・手本を前に固定（案・まだ false） */
  cache: { promptCacheKey: boolean; notesAtEnd: true; examplesFirst: boolean };
  /** 待ち時間（null＝出口の既定 15秒／60秒のまま） */
  timeouts: { firstTokenMs: number | null; totalMs: number | null };
  /** 言い添えの名前（PROFILE_NOTES のどれか） */
  notes: readonly ProfileNoteName[];
};

export type ProfileNoteName = "gpt_note" | "len_hint";

/** ブレインの出力の主な欄（11/24 の試験で DeepSeek・Sol がほぼ全部の答案で返した欄） */
export const PROFILE_BRAIN_KEYS: readonly string[] = ["reply_mode", "action", "aix", "check_pattern", "reply_direction", "key_topics", "avoid_topics", "customer_questions", "next_steps", "turn_contract", "reason"];

/**
 * 言い添えの本文（名前ごと）。11/24 の書き手の比べ（同じ8問）で Luna・Sol は竹内さんの文の 0.74〜0.80倍に短く切り、
 *   謝りを「全然大丈夫です」で受けた（q032・竹内さんの決まり KB 317c7a7c: 要望を言い直して謝った時は送ってくれた事への感謝で受ける）。
 *   長さの目安: 竹内さんの返信（試験の問題の竹内さんの文 221通・返信／2段が正解の番）は 77字（下から25%）〜120字（中央）〜199字（上から25%）
 */
export const PROFILE_NOTES: Readonly<Record<ProfileNoteName, string>> = {
  gpt_note: [
    "【書き方の補い】",
    "① 文の長さは、手本の文や前にこちらが送った通と同じくらいにする。短くまとめすぎない（受け止め・お答え・お礼・次の一手を省かない）。",
    "② お客様が要望を言い直して謝った時・恐縮している時は「全然大丈夫です」で受けない。「とんでもございません😊！！」か、送って頂いた事・ご連絡頂いた事へのお礼で受ける。",
  ].join("\n"),
  len_hint: "【長さの目安】竹内さんの返信は1通 およそ80〜200字（真ん中は120字ほど）。お客様の通が長い・答える事が多い時は長めに、短いお礼への返しは短くてよい。",
};

const OPENAI_REQ = { tokenField: "max_completion_tokens", maxTokensFactor: 2, minMaxTokens: 4096, temperature: false } as const;
const DEEPSEEK_REQ = { tokenField: "max_tokens", maxTokensFactor: 1, minMaxTokens: 0, temperature: true } as const;
const OPENAI_CACHE = { promptCacheKey: true, notesAtEnd: true, examplesFirst: false } as const;
const DEEPSEEK_CACHE = { promptCacheKey: false, notesAtEnd: true, examplesFirst: false } as const;
const NO_TIMEOUT = { firstTokenMs: null, totalMs: null } as const;

/** 表（版の名前は 係-版）。同じ相手×係に複数の版がある時は DEFAULT_VERSIONS が既定 */
export const PROVIDER_PROFILES: readonly ProviderProfile[] = [
  // ── OpenAI（11/24 の試験の形をそのまま v1 に）──
  { version: "openai-brain-v1", provider: "openai", role: "brain", request: OPENAI_REQ, reasoning: { effort: null }, output: { json: "none" }, cache: OPENAI_CACHE, timeouts: NO_TIMEOUT, notes: [] },
  { version: "openai-brain-v1-keys", provider: "openai", role: "brain", request: OPENAI_REQ, reasoning: { effort: null }, output: { json: "json_object", keys: PROFILE_BRAIN_KEYS }, cache: OPENAI_CACHE, timeouts: NO_TIMEOUT, notes: [] },
  { version: "openai-writer-v1", provider: "openai", role: "writer", request: OPENAI_REQ, reasoning: { effort: "low" }, output: { json: "none" }, cache: OPENAI_CACHE, timeouts: { firstTokenMs: 45_000, totalMs: 120_000 }, notes: [] },
  { version: "openai-writer-v1-note", provider: "openai", role: "writer", request: OPENAI_REQ, reasoning: { effort: "low" }, output: { json: "none" }, cache: OPENAI_CACHE, timeouts: { firstTokenMs: 45_000, totalMs: 120_000 }, notes: ["gpt_note"] },
  { version: "openai-writer-v1-note-len", provider: "openai", role: "writer", request: OPENAI_REQ, reasoning: { effort: "low" }, output: { json: "none" }, cache: OPENAI_CACHE, timeouts: { firstTokenMs: 45_000, totalMs: 120_000 }, notes: ["gpt_note", "len_hint"] },
  { version: "openai-conductor-v1", provider: "openai", role: "conductor", request: OPENAI_REQ, reasoning: { effort: "low" }, output: { json: "none" }, cache: OPENAI_CACHE, timeouts: NO_TIMEOUT, notes: [] },
  { version: "openai-final_check-v1", provider: "openai", role: "final_check", request: OPENAI_REQ, reasoning: { effort: "low" }, output: { json: "none" }, cache: OPENAI_CACHE, timeouts: NO_TIMEOUT, notes: [] },
  { version: "openai-light-v1", provider: "openai", role: "light", request: OPENAI_REQ, reasoning: { effort: "low" }, output: { json: "none" }, cache: OPENAI_CACHE, timeouts: NO_TIMEOUT, notes: [] },
  // 今ある直の呼び出し（ai-search の gpt-4o-mini・knowledge-utils の画像の読み取り）は、送っていた形のまま（動きを変えない版）
  { version: "openai-legacy-direct-v1", provider: "openai", role: "light", request: { tokenField: "max_tokens", maxTokensFactor: 1, minMaxTokens: 0, temperature: true }, reasoning: { effort: null }, output: { json: "none" }, cache: { promptCacheKey: false, notesAtEnd: true, examplesFirst: false }, timeouts: NO_TIMEOUT, notes: [] },
  // ── DeepSeek（今の使い方をそのまま・動きは変えない）──
  ...(["brain", "conductor", "writer", "final_check", "judge", "light"] as const).map((role): ProviderProfile => ({
    version: `deepseek-${role}-v1`, provider: "deepseek", role, request: DEEPSEEK_REQ, reasoning: { effort: null, deepseekThinking: "disabled" },
    output: { json: role === "judge" ? "json_object" : "none" }, cache: DEEPSEEK_CACHE, timeouts: { firstTokenMs: 15_000, totalMs: 60_000 }, notes: [],
  })),
];

export const DEFAULT_VERSIONS: Readonly<Record<string, string>> = {
  "openai:brain": "openai-brain-v1", "openai:writer": "openai-writer-v1", "openai:conductor": "openai-conductor-v1",
  "openai:final_check": "openai-final_check-v1", "openai:light": "openai-light-v1", "openai:judge": "openai-light-v1",
  "deepseek:brain": "deepseek-brain-v1", "deepseek:conductor": "deepseek-conductor-v1", "deepseek:writer": "deepseek-writer-v1",
  "deepseek:final_check": "deepseek-final_check-v1", "deepseek:judge": "deepseek-judge-v1", "deepseek:light": "deepseek-light-v1",
};

/** 名札 → 係（表の係）。表に無い名札は light */
export function profileRoleOf(routeName: string | null | undefined): ProfileRole {
  const n = String(routeName ?? "").trim();
  if (n === "brain" || n.startsWith("brain_")) return "brain";
  if (n.startsWith("conductor_")) return "conductor";
  if (n === "reply_generate" || n === "reply_generate_flash") return "writer";
  if (n.startsWith("final_check")) return "final_check";
  if (n.startsWith("judge") || n === "brain-exam-judge") return "judge";
  return "light";
}

export function profileByVersion(version: string | null | undefined): ProviderProfile | null {
  const v = String(version ?? "").trim();
  return v ? PROVIDER_PROFILES.find((p) => p.version === v) ?? null : null;
}

/**
 * 相手×名札の版（試験だけの替え: OPENAI_PROFILE_<係>=<版>。旧の試験の印 EXAM_WRITER_GPT_NOTE・EXAM_WRITER_LEN_HINT・EXAM_BRAIN_JSON_KEYS も版に読み替える）。
 *   知らない版を名指しした時は null（呼ぶ側は送らない・積む前の関所は積まない）
 */
export function profileFor(provider: ProfileProvider, routeName: string | null | undefined, env: Env = typeof process !== "undefined" ? process.env : {}): ProviderProfile | null {
  const role = profileRoleOf(routeName);
  const named = String(env[`OPENAI_PROFILE_${role.toUpperCase()}`] ?? "").trim();
  if (provider === "openai" && named) return profileByVersion(named);
  if (provider === "openai" && role === "writer") {
    const on = (k: string) => String(env[k] ?? "").trim().toLowerCase() === "on";
    if (on("EXAM_WRITER_GPT_NOTE") && on("EXAM_WRITER_LEN_HINT")) return profileByVersion("openai-writer-v1-note-len");
    if (on("EXAM_WRITER_GPT_NOTE")) return profileByVersion("openai-writer-v1-note");
  }
  if (provider === "openai" && role === "brain" && String(env.EXAM_BRAIN_JSON_KEYS ?? "").trim().toLowerCase() === "on") return profileByVersion("openai-brain-v1-keys");
  return profileByVersion(DEFAULT_VERSIONS[`${provider}:${role}`]);
}

/** 言い添えの本文（名前の順・無ければ null） */
export function profileNotesText(p: ProviderProfile): string | null {
  return p.notes.length ? p.notes.map((n) => PROFILE_NOTES[n]).join("\n") : null;
}

export type OpenAIRequestParts = {
  version: string;
  maxField: "max_tokens" | "max_completion_tokens";
  maxTokens: number | null;
  sendTemperature: boolean;
  reasoningEffort: string | null;
  promptCacheKey: string | null;
  jsonObject: boolean;
  keysNote: string | null;
  notes: string | null;
  firstTokenMs: number | null;
  totalMs: number | null;
};
/**
 * 表の行 → OpenAI の要求の部品（純関数）。考える深さは env（EXAM_*_REASONING・OPENAI_REASONING_EFFORT）が表より先（試験で深さを並べるため）
 */
export function openaiRequestOf(p: ProviderProfile, o: { routeName: string | null; maxTokens?: number | null; env?: Env }): OpenAIRequestParts {
  const env = o.env ?? (typeof process !== "undefined" ? process.env : {});
  const role = p.role;
  const envEffort = (role === "writer" ? env.EXAM_WRITER_REASONING ?? env.EXAM_BRAIN_REASONING : role === "brain" ? env.EXAM_BRAIN_REASONING : undefined)?.trim() || (env.OPENAI_REASONING_EFFORT ?? "").trim() || null;
  const mt = typeof o.maxTokens === "number" ? o.maxTokens : null;
  return {
    version: p.version,
    maxField: p.request.tokenField,
    maxTokens: mt == null && !p.request.minMaxTokens ? null : Math.max(mt ?? p.request.minMaxTokens, p.request.minMaxTokens) * p.request.maxTokensFactor,
    sendTemperature: p.request.temperature,
    reasoningEffort: envEffort ?? p.reasoning.effort,
    promptCacheKey: p.cache.promptCacheKey && o.routeName ? `sumora-${o.routeName}` : null,
    jsonObject: p.output.json === "json_object",
    keysNote: p.output.json === "json_object" && p.output.keys?.length ? `\n\n【出力の形（必須）】JSON オブジェクトを1つだけ出す。次の欄を全部入れる（分からない欄も空の値で入れる・欄を省かない）: ${p.output.keys.join(", ")}` : null,
    notes: profileNotesText(p),
    firstTokenMs: p.timeouts.firstTokenMs,
    totalMs: p.timeouts.totalMs,
  };
}

/** 試験の答案・結果に残す版（相手が openai の時だけ・係ごと） */
export function examProfileVersions(env: Env): { brain: string | null; writer: string | null; unknown: string[] } {
  const unknown: string[] = [];
  const pick = (provEnv: string, route: string) => {
    if (String(env[provEnv] ?? "").trim().toLowerCase() !== "openai") return null;
    const p = profileFor("openai", route, env);
    if (!p) { unknown.push(String(env[`OPENAI_PROFILE_${profileRoleOf(route).toUpperCase()}`] ?? route)); return null; }
    return p.version;
  };
  return { brain: pick("EXAM_BRAIN_PROVIDER", "brain_fresh"), writer: pick("EXAM_WRITER_PROVIDER", "reply_generate"), unknown };
}

/**
 * 表を通した印（今ある直の呼び出し・ai-search と knowledge-utils の画像の読み取り）。送る形は変えず、版を返す（ログに残す）。
 *   知らない版は投げる（表に無い使い方で OpenAI に送らない）
 */
export function openaiProfileGate(version: string): ProviderProfile {
  const p = profileByVersion(version);
  if (!p || p.provider !== "openai") throw new Error(`OpenAI の使い方の表に無い版: ${version}`);
  return p;
}
