// app/lib/customer-sim.ts
// お客様役（テスト・YUMA 専用）の純関数: 筋書き・DeepSeek への前置きと入力・返事の読み取り・段の進め方・往復の検査。
// 2026-09-27 竹内「YUMA で自動的に YUMA から自動返信が来て、返信を繰り返せたら理想」。
//   入口: app/api/test/customer-sim/route.ts（鍵は customer-sim-guard.ts）／実行: scripts/customer-sim.ts
//   DB・fetch は持たない（customer-sim-server.ts が持つ）。テスト: app/lib/__tests__/customer-sim.test.ts
import scenariosJson from "@/app/lib/customer-sim-scenarios.json";
import { isMetaNarrationLine, isWorkNoteLine, isNotACustomerReply } from "@/app/lib/meta-narration";
import { STAFF_PICKUP_DECL_RE, STAFF_PROPERTIES_DONE_RE } from "@/app/lib/reply-context";
import { pickSimMaterial, type SimAixMaterial, type SimMaterialPool } from "@/app/lib/customer-sim-material";
import type { ShadowKind } from "@/app/lib/customer-sim-shadow";

// ─── 筋書き ───

export type SimStep = {
  /** この段でお客様が言うこと（目的） */
  goal: string;
  /** DeepSeek を呼ばずにそのまま送る文 */
  fixed?: string;
  /** この段に留まってよい回数（既定 1）。目的に届かない返事の時は同じ段で聞き直す・待つ */
  max_turns?: number;
  /** 状況の取り違えの検査: ブレインの checkpoint_stage がこれであるべき（書かない段は見ない） */
  expect_stage?: string;
};
export type SimPersona = { label: string; tone: string; facts: string };
export type SimScenario = { id: string; title: string; persona: SimPersona; steps: SimStep[] };

const SCENARIOS: SimScenario[] = (scenariosJson as { scenarios: SimScenario[] }).scenarios;

export function listScenarios(): SimScenario[] { return SCENARIOS; }
export function getScenario(id: string | null | undefined): SimScenario | null {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}

/** 筋書きの形を確かめる（テストと入口で使う）。問題の一覧を返す（空＝良い） */
export function validateScenarios(list: ReadonlyArray<SimScenario> = SCENARIOS): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const s of list) {
    if (!s.id || !/^[a-z0-9_]+$/.test(s.id)) errs.push(`id が不正: ${s.id}`);
    if (ids.has(s.id)) errs.push(`id が重複: ${s.id}`);
    ids.add(s.id);
    if (!s.persona?.label || !s.persona?.tone) errs.push(`${s.id}: persona が足りない`);
    if (!Array.isArray(s.steps) || s.steps.length === 0) errs.push(`${s.id}: steps が空`);
    (s.steps ?? []).forEach((st, i) => {
      if (!st.goal?.trim()) errs.push(`${s.id}[${i}]: goal が空`);
      if (st.max_turns !== undefined && (!Number.isInteger(st.max_turns) || st.max_turns < 1 || st.max_turns > 5)) errs.push(`${s.id}[${i}]: max_turns は 1〜5`);
      if (st.fixed !== undefined && !st.fixed.trim()) errs.push(`${s.id}[${i}]: fixed が空`);
    });
  }
  return errs;
}

// ─── 段の進め方 ───

export type SimCursor = { stepIndex: number; turnsOnStep: number };

/**
 * お客様の1通を送った後の位置（純関数）。
 *   目的に届いた（goalReached）か、その段の回数（max_turns・既定1）を使い切ったら次の段へ。
 *   finished=true は筋書きの最後の段を終えた。
 */
export function advanceCursor(scenario: SimScenario, cur: SimCursor, goalReached: boolean): SimCursor & { finished: boolean } {
  const step = scenario.steps[cur.stepIndex];
  if (!step) return { stepIndex: cur.stepIndex, turnsOnStep: 0, finished: true };
  const used = cur.turnsOnStep + 1;
  const max = step.max_turns ?? 1;
  if (goalReached || used >= max || step.fixed) {
    const next = cur.stepIndex + 1;
    return { stepIndex: next, turnsOnStep: 0, finished: next >= scenario.steps.length };
  }
  return { stepIndex: cur.stepIndex, turnsOnStep: used, finished: false };
}

// ─── DeepSeek への前置き（固定）と入力（動く部分） ───

/**
 * 固定の前置き（毎回一字一句同じ＝DeepSeek の前置きキャッシュが当たる）。動く物（筋書き・会話）は user に入れる。
 */
export const CUSTOMER_SIM_SYSTEM = [
  "あなたは大阪で賃貸の部屋を探しているお客様役です。不動産会社（スモラ）の担当者と LINE でやり取りしています。",
  "これは社内のテスト用の会話です。あなたの返事はテスト用の LINE の会話に入り、担当者側の AI の返事を確かめるのに使われます。",
  "",
  "【書き方】",
  "- 実際のお客様の LINE の言い方に近く、短く（1通は1〜2文・長くても80字くらい）。敬語の丁寧さ・絵文字は人物像の tone に合わせる",
  "- 箇条書き・見出し・かぎかっこでの引用・「お客様:」のような名札は書かない。地の文（〜と伝える、等）も書かない",
  "- 担当者の最後の送信（本文・物件・見積書）に自然に反応する。届いていない物（物件・見積書・日程）を届いたことにしない",
  "- 段の目的に沿って1歩だけ進める。目的の物がまだ届いていない時は、待っている・いつ頃か、を軽く聞く（催促しすぎない）",
  "- 名前・電話番号・住所・勤務先の社名などの個人情報は、聞かれた時だけ・必ず架空で答える（実在の人・会社の名前は使わない）",
  "- 担当者の文に AI の作業メモや社内向けの文が混ざっていたら、実際のお客様と同じく戸惑った反応をしてよい",
  "",
  "【出力】JSON だけを1つ返す（前後に文字を付けない）:",
  "{\"text\": \"お客様の返事（LINE にそのまま出す文）\", \"goal_reached\": true または false}",
  "goal_reached は、この返事で段の目的を言えた時 true（目的の物がまだ届いておらず待つ・聞き直す返事なら false）。",
].join("\n");

export type SimHistoryItem = {
  sender: "customer" | "staff" | string;
  text: string | null;
  isAix?: boolean | null;
  hasImage?: boolean;
  createdAt?: string | null;
};

/** 会話を DeepSeek に渡す形（新しい方から max 通・古→新） */
export function formatHistoryForSim(history: ReadonlyArray<SimHistoryItem>, max = 14): string {
  const rows = history.slice(-max).map((m) => {
    const who = m.sender === "customer" ? "あなた" : "担当者";
    let t = String(m.text ?? "").trim();
    if (!t || t === "[画像]") t = m.hasImage ? "［画像を送った（物件の資料・見積書など）］" : "［画像］";
    else if (t.startsWith("[画像]")) t = `［画像］${t.slice(4, 120)}`;
    return `${who}: ${t.slice(0, 600)}`;
  });
  return rows.length ? rows.join("\n") : "（まだやり取りなし）";
}

export function buildCustomerSimUser(input: {
  scenario: SimScenario;
  cursor: SimCursor;
  history: ReadonlyArray<SimHistoryItem>;
  /** 担当者から届いた物件の名前（直近） */
  sentPropertyNames?: ReadonlyArray<string>;
  /** 見積書が届いているか（送った事実の台帳から） */
  estimateSent?: boolean;
  /** 今の日時（JST の表示） */
  nowLabel?: string;
}): string {
  const { scenario, cursor } = input;
  const step = scenario.steps[cursor.stepIndex];
  const props = (input.sentPropertyNames ?? []).filter(Boolean).slice(0, 8);
  return [
    `【人物像】${scenario.persona.label}`,
    `【言い方】${scenario.persona.tone}`,
    `【あなたの事情（架空）】${scenario.persona.facts}`,
    `【筋書き】${scenario.title}（${cursor.stepIndex + 1}/${scenario.steps.length} 段目${cursor.turnsOnStep > 0 ? `・この段の${cursor.turnsOnStep + 1}回目` : ""}）`,
    `【この段の目的】${step?.goal ?? "（筋書きは終わり。短くお礼を言う）"}`,
    input.nowLabel ? `【今】${input.nowLabel}` : "",
    `【担当者から届いた物件】${props.length ? props.join("／") : "まだ無い"}`,
    `【見積書】${input.estimateSent ? "届いている" : "まだ届いていない"}`,
    "",
    "【これまでの会話（古い→新しい）】",
    formatHistoryForSim(input.history),
    "",
    "次のあなた（お客様）の返事を JSON で。",
  ].filter((l) => l !== "").join("\n");
}

// ─── 返事の読み取り ───

/** お客様の文の後始末（名札・かぎかっこ・長すぎ）。空になれば null */
export function sanitizeCustomerText(raw: string | null | undefined): string | null {
  let t = String(raw ?? "").replace(/\r/g, "").trim();
  t = t.replace(/^(?:お客様|あなた|客|顧客)\s*[:：]\s*/, "");
  if (/^「[^」]*」$/.test(t)) t = t.slice(1, -1);
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  if (!t) return null;
  if (t.length > 300) t = t.slice(0, 300);
  return t;
}

/** DeepSeek の返事（JSON）を読む。読めなければ null */
export function parseCustomerSimReply(raw: string | null | undefined): { text: string; goalReached: boolean } | null {
  const s = String(raw ?? "");
  const body = s.match(/\{[\s\S]*\}/)?.[0];
  if (!body) return null;
  try {
    const j = JSON.parse(body) as { text?: unknown; goal_reached?: unknown };
    const text = sanitizeCustomerText(typeof j.text === "string" ? j.text : null);
    if (!text) return null;
    return { text, goalReached: j.goal_reached === true };
  } catch {
    return null;
  }
}

// ─── 往復の検査（お待たせ・作業メモ・創作・約束の言い直し・状況の取り違え） ───

export type SimAuditInput = {
  /** こちらが実際に送った文（無ければ送っていない） */
  sentText: string | null;
  /** 送る前の会話（古→新・この送信を含まない） */
  historyBefore: ReadonlyArray<SimHistoryItem>;
  /** ブレインの checkpoint_stage（判断の後） */
  brainStage?: string | null;
  /** 筋書きのその段の expect_stage */
  expectStage?: string | null;
  /** トークの上の表示のずれ（customer-state の conflicts の数） */
  stateConflicts?: number;
  /** 根拠の追加材料（送った物件名・見積の金額など、会話以外で知っている事実の文字列） */
  groundingExtra?: ReadonlyArray<string>;
  /**
   * 材料の要る AIX を送った時: 使った材料の事実のうち、送った文に入っているべき物（物件名・金額・日付・時刻）。
   * 1つも入っていなければ「材料の取りこぼし」（材料を渡したのに文に出ていない＝別の物件・金額で書いた疑い）
   */
  materialMustShow?: ReadonlyArray<string>;
};

export type SimAuditFinding = { kind: "waited" | "work_note" | "invented" | "repeat_promise" | "stage_mismatch" | "state_conflict" | "material_missing" | ShadowKind; detail: string };

const KIND_JA: Record<SimAuditFinding["kind"], string> = {
  waited: "お待たせ",
  work_note: "作業メモ",
  invented: "創作の疑い",
  repeat_promise: "約束の言い直し",
  stage_mismatch: "状況の取り違え（段階）",
  state_conflict: "状況の取り違え（表示のずれ）",
  material_missing: "材料の取りこぼし",
  // 影の道（customer-sim-shadow.ts judgeShadowTurn・--shadow の時だけ出る）
  draft_conflicts_aix: "影: 下書きが AIX と別の道",
  draft_does_aix_job: "影: 下書きが AIX の送る物を書いた",
  aix_followup_missing: "影: AIX の後の一言が無い",
  aix_scene_skipped: "影: 決まりでは AIX の場面",
};
export function simAuditKindJa(k: SimAuditFinding["kind"]): string { return KIND_JA[k]; }

/** 金額・日付・時刻・号室など「根拠が要る」数字の語を拾う */
function concreteTokens(text: string): string[] {
  const out = new Set<string>();
  const res = [
    /[0-9０-９][0-9０-９,，.]*\s*(?:万円|万|円)/g,
    /[0-9０-９]{1,2}\s*[\/／月]\s*[0-9０-９]{1,2}\s*日?/g,
    /[0-9０-９]{1,2}\s*[:：時]\s*[0-9０-９]{0,2}\s*分?/g,
    /[0-9０-９]{2,4}\s*号室/g,
  ];
  for (const re of res) for (const m of text.matchAll(re)) out.add(m[0].replace(/\s+/g, ""));
  return [...out];
}
const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[，]/g, ",").replace(/[／]/g, "/").replace(/[：]/g, ":");

/**
 * 1往復の検査（純関数・決定論）。LLM は使わない＝件数で見る目安。
 *   創作の疑い: 送った文の金額・日付・時刻・号室が、それまでの会話と追加材料のどこにも無い（数字の部分で照合）
 *   約束の言い直し: 物件を探す宣言が、前の宣言の後に物件を送らないまま（STAFF_PROPERTIES_DONE_RE が間に無い）もう一度出た
 */
export function auditSimTurn(input: SimAuditInput): SimAuditFinding[] {
  const f: SimAuditFinding[] = [];
  const sent = String(input.sentText ?? "").trim();
  if (sent) {
    if (/お待たせ/.test(sent)) f.push({ kind: "waited", detail: sent.match(/[^\n。]*お待たせ[^\n。]*/)?.[0] ?? "お待たせ" });
    const noteLines = sent.split("\n").map((l) => l.trim()).filter((l) => l && (isWorkNoteLine(l) || isMetaNarrationLine(l)));
    if (noteLines.length > 0 || isNotACustomerReply(sent)) f.push({ kind: "work_note", detail: (noteLines[0] ?? sent).slice(0, 80) });

    const ground = toHalf([
      ...input.historyBefore.map((m) => String(m.text ?? "")),
      ...(input.groundingExtra ?? []),
    ].join("\n")).replace(/\s+/g, "");
    const invented = concreteTokens(sent).filter((tok) => {
      const num = toHalf(tok).match(/[0-9][0-9,.]*/)?.[0] ?? "";
      return num !== "" && !ground.includes(toHalf(tok)) && !ground.includes(num);
    });
    if (invented.length > 0) f.push({ kind: "invented", detail: `会話に無い数字: ${invented.slice(0, 4).join("・")}` });

    if (STAFF_PICKUP_DECL_RE.test(sent)) {
      // 前のこちらの送信を新しい方から見て、物件を送った（DONE）より先に宣言が見つかれば言い直し
      const staff = input.historyBefore.filter((m) => m.sender === "staff").map((m) => String(m.text ?? ""));
      for (let i = staff.length - 1; i >= 0; i--) {
        const t = staff[i];
        if (STAFF_PROPERTIES_DONE_RE.test(t) || t === "[画像]") break;
        if (STAFF_PICKUP_DECL_RE.test(t)) { f.push({ kind: "repeat_promise", detail: `前の宣言: ${t.slice(0, 40)}` }); break; }
      }
    }
  }
  if (input.expectStage && input.brainStage && input.expectStage !== input.brainStage) {
    f.push({ kind: "stage_mismatch", detail: `筋書き=${input.expectStage}／ブレイン=${input.brainStage}` });
  }
  if ((input.stateConflicts ?? 0) > 0) f.push({ kind: "state_conflict", detail: `ずれ ${input.stateConflicts} 件` });
  if (sent && input.materialMustShow && input.materialMustShow.length > 0) {
    const flat = toHalf(sent).replace(/[s,]/g, "");
    const missing = input.materialMustShow.filter((x) => x && !flat.includes(toHalf(x).replace(/[s,]/g, "")));
    if (missing.length > 0) f.push({ kind: "material_missing", detail: `文に無い: ${missing.slice(0, 4).join("・")}` });
  }
  return f;
}

/** 検査の要約（種類ごとの件数） */
export function summarizeSimAudit(rows: ReadonlyArray<{ findings: ReadonlyArray<SimAuditFinding> }>): Array<{ kind: SimAuditFinding["kind"]; label: string; count: number }> {
  const kinds = Object.keys(KIND_JA) as SimAuditFinding["kind"][];
  // 影の道の4種（--shadow の時だけ出る）は1件以上ある時だけ並べる（--shadow なしの要約は今までと同じ7種）
  const SHADOW_ONLY = new Set<string>(["draft_conflicts_aix", "draft_does_aix_job", "aix_followup_missing", "aix_scene_skipped"]);
  return kinds
    .map((k) => ({ kind: k, label: KIND_JA[k], count: rows.reduce((n, r) => n + r.findings.filter((x) => x.kind === k).length, 0) }))
    .filter((s) => !SHADOW_ONLY.has(s.kind) || s.count > 0);
}

// ─── スタッフ側の決め方（ブレインの判断 → 何を送るか） ───

/** 会話だけで作れる AIX（材料＝物件の画像・見積書・管理会社の回答・日程の選択が要らない） */
export const SIM_TEXT_ONLY_AIX: ReadonlySet<string> = new Set([
  "condition_hearing", "application_push", "followup_revive", "greeting_viewing",
]);

export type SimStaffPlan =
  | { kind: "aix"; action: string; checkPattern: string | null }
  | { kind: "aix_material"; action: string; checkPattern: string | null; material: SimAixMaterial }
  | { kind: "aix_needs_material"; action: string; reason: string }
  | { kind: "draft" }
  | { kind: "wait" };

/**
 * ブレインの判断から、スタッフ役が何をするか（純関数）。
 *   reply_mode=aix で action があれば AIX。会話だけで作れる AIX は作って送る。
 *   材料の要る AIX は、材料の候補（pool・customer-sim-material）から保存済みの材料を選べれば送る（aix_material）／
 *   選べなければ止めて理由を出す（aix_needs_material）。pool を渡さない時は材料の要る AIX は全部止める（従来どおり）。
 *   それ以外は下書きを送る。判断がまだ無ければ待つ。
 */
export function planStaffAction(
  meta: { action?: string | null; reply_mode?: string | null; check_pattern?: string | null } | null | undefined,
  pool?: SimMaterialPool | null,
): SimStaffPlan {
  if (!meta) return { kind: "wait" };
  const action = meta.action ?? null;
  const checkPattern = meta.check_pattern ?? null;
  if (meta.reply_mode === "aix" && action) {
    if (SIM_TEXT_ONLY_AIX.has(action)) return { kind: "aix", action, checkPattern };
    if (!pool) return { kind: "aix_needs_material", action, reason: "材料の候補を渡していない" };
    const pick = pickSimMaterial(action, checkPattern, pool);
    if (!pick.ok) return { kind: "aix_needs_material", action, reason: pick.reason };
    return { kind: "aix_material", action, checkPattern: pick.material.kind === "check_result" ? pick.material.checkPattern : checkPattern, material: pick.material };
  }
  return { kind: "draft" };
}
