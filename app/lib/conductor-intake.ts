// app/lib/conductor-intake.ts — 入口の統括の最初の読み（Sonnet）のプロンプトの組み立てと答えの読み（純関数・DB/LLM なし）
//
// 2026-11-04 竹内さん（KB P1 75da346a・前の 4d9a0518 は退役）: 入口の最初の読みは Sonnet。記録だけの1週間は、5番に1番を DeepSeek でも読んで当たりを比べる。
//   「プロンプトキャッシュと RAG 検索を、ちゃんと AIX-META のように使えるように」:
//   ① 作り置き（キャッシュ）: 毎回同じ部分を先頭に固定する（P0・P1 の決まり・取扱説明書の短い形・場面の目次・統括メタの書き方）。
//      変わる部分（会話・帳面・前の番）は後ろ。先頭の文は版が変わる時だけ変える（日時・顧客名・件数を先頭に入れない＝KB 4f4fe21c と同じ形）。
//   ③ 検索の問いは文書と同じ構成で、統括メタは絞り込みと並べ替えだけ（conductor-meta.rerankByMeta）。ここではメタの言葉を問いに混ぜない。
// 切替: CONDUCTOR_INTAKE（既定 off・shadow＝読んで記録だけ）。テスト: app/lib/__tests__/conductor-intake.test.ts
import { REPLY_SCENE_JA, type ReplyScene } from "./reply-scene";
import { NEED_TOOLS, type NeedTool } from "./brain-need";
import { ROSTER } from "./conductor-roles";
import { CONDUCTOR_PRIORITY_LINE, type ConductorRole } from "./conductor-handoff";

type Env = Record<string, string | undefined>;
export type IntakeMode = "off" | "shadow";
export function conductorIntakeMode(env: Env = typeof process !== "undefined" ? process.env : {}): IntakeMode {
  return (env.CONDUCTOR_INTAKE ?? "").trim().toLowerCase() === "shadow" ? "shadow" : "off";
}
/** 先頭の文の版（中身を変えたら上げる＝作り置きが作り直される） */
export const INTAKE_PREFIX_VERSION = "ci-v1";

const SCENES = Object.keys(REPLY_SCENE_JA) as ReplyScene[];
const ROLES = ["aix_desk", "compose", "writer", "check", "fetch", "deep", "second"] as const;

/** 先頭（作り置き）の固定の文。取扱説明書の短い形は、版が変わる時（毎週の書き直し）だけ変わる */
export function intakePrefix(manualShortForms: ReadonlyArray<{ brain: string; short: string }>): string {
  const manuals = [...manualShortForms].sort((a, b) => a.brain.localeCompare(b.brain)).map((m) => `- ${m.brain}: ${m.short}`).join("\n");
  return [
    `あなたは賃貸の仲介会社の LINE 返信の「入口の統括」です（版 ${INTAKE_PREFIX_VERSION}）。お客様の今の番を最初に読み、場面・やる事・動かす担当・要る材料・迷いを決まった形の JSON で書きます。返信の文は書きません。判断（返信か AIX か）は判断のブレインが決めます。あなたは担当の選び方と材料の当たりを付ける役です。`,
    `【絶対の決まり（P0）】スタッフだけが知る事（管理会社の確認の結果・募集状況・交渉の結果・撮影した写真・見積の金額・内覧の日程の確定・入居可能日）は AIX で送る番。返信は AI が知り得る事だけ。判断はすべてブレインが決める（決まった計算は候補と安全の線だけ）。`,
    CONDUCTOR_PRIORITY_LINE,
    `【場面（scene はこの中から1つ）】${SCENES.map((s) => `${s}=${REPLY_SCENE_JA[s]}`).join("／")}`,
    `【担当（roles はこの中から）】${ROSTER.filter((r) => (ROLES as readonly string[]).includes(r.id)).map((r) => `${r.id}=${r.does}`).join("／")}`,
    `【要る材料（need はこの中から）】${NEED_TOOLS.join("・")}`,
    `【担当の取扱説明書（短い形）】\n${manuals || "- （まだ無い）"}`,
    `【書き方】JSON だけを返す: {"scene": "場面", "roles": ["担当"], "need": ["材料"], "todos": [{"kind": "answer|promise|aix|fetch|check", "what": "20字以内"}], "doubt": {"kind": "何の迷いか（20字以内）", "between": ["案A", "案B"]} または null, "confidence": "high|mid|low"}。一覧に無い言葉を作らない。軽い番（お礼・スタンプだけ）は roles を ["writer"] だけにする。`,
  ].join("\n\n");
}

/** 後ろ（毎回変わる部分）: 会話・帳面・前の番。問いの文はお客様の発言と状況のまとめのまま */
export function intakeUser(o: { customerTurn: string; lastStaff: string | null; ledgerBlock: string; carryLine: string; ruleMeta: string }): string {
  return [
    `【お客様の今の番】\n${o.customerTurn.slice(0, 800)}`,
    o.lastStaff ? `【直前のこちらの送信】\n${o.lastStaff.slice(0, 400)}` : "",
    o.ledgerBlock ? o.ledgerBlock.slice(0, 2500) : "",
    o.carryLine ? `【前の番】${o.carryLine}` : "",
    o.ruleMeta ? `【決まった計算の候補（参考）】${o.ruleMeta}` : "",
  ].filter(Boolean).join("\n\n");
}

export type IntakeAnswer = {
  scene: ReplyScene; roles: ConductorRole[]; need: NeedTool[];
  todos: Array<{ kind: "answer" | "promise" | "aix" | "fetch" | "check"; what: string }>;
  doubt: { kind: string; between: [string, string] } | null;
  confidence: "high" | "mid" | "low";
};
const TODO_KINDS = ["answer", "promise", "aix", "fetch", "check"] as const;
/** 答えの読み（一覧に無い値は捨てる・造語を入れない） */
export function parseIntake(raw: string | null | undefined): IntakeAnswer | null {
  const m = String(raw ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  if (!SCENES.includes(o.scene as ReplyScene)) return null;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const roles = arr(o.roles).filter((r): r is ConductorRole => (ROLES as readonly string[]).includes(r));
  const need = arr(o.need).filter((n): n is NeedTool => (NEED_TOOLS as readonly string[]).includes(n));
  const todos = (Array.isArray(o.todos) ? o.todos : []).map((t) => t as { kind?: unknown; what?: unknown })
    .filter((t) => (TODO_KINDS as readonly string[]).includes(String(t.kind))).slice(0, 6)
    .map((t) => ({ kind: String(t.kind) as IntakeAnswer["todos"][number]["kind"], what: String(t.what ?? "").slice(0, 20) }));
  const d = o.doubt as { kind?: unknown; between?: unknown } | null | undefined;
  const between = Array.isArray(d?.between) ? d!.between.map((x) => String(x).slice(0, 30)) : [];
  const conf = ["high", "mid", "low"].includes(String(o.confidence)) ? (String(o.confidence) as IntakeAnswer["confidence"]) : "mid";
  return { scene: o.scene as ReplyScene, roles: [...new Set(roles)], need: [...new Set(need)], todos, doubt: d && between.length === 2 ? { kind: String(d.kind ?? "").slice(0, 20), between: [between[0], between[1]] } : null, confidence: conf };
}

/** 5番に1番を DeepSeek でも読む（会話と番の時刻の決まった hash・繊細な会話は呼ぶ側で外す） */
export function intakeCompareTurn(conversationId: string, turnAt: string | null): boolean {
  const s = `${conversationId}|${turnAt ?? ""}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % 5 === 0;
}
/** Sonnet と DeepSeek の答えの合い方（場面・担当・材料） */
export function intakeAgreement(a: IntakeAnswer | null, b: IntakeAnswer | null): { scene: boolean; roles: boolean; need: boolean } | null {
  if (!a || !b) return null;
  const same = (x: string[], y: string[]) => x.length === y.length && [...x].sort().join() === [...y].sort().join();
  return { scene: a.scene === b.scene, roles: same(a.roles, b.roles), need: same(a.need, b.need) };
}

/** 1回の費用の見積もり（USD・Sonnet: 入力 $3/M・作り置きの読み $0.3/M・作り置きの書き $3.75/M・出力 $15/M） */
export function intakeCostUsd(o: { prefixTokens: number; variableTokens: number; outputTokens: number; cacheHit: boolean }): number {
  const pre = o.cacheHit ? o.prefixTokens * 0.3e-6 : o.prefixTokens * 3.75e-6;
  return Math.round((pre + o.variableTokens * 3e-6 + o.outputTokens * 15e-6) * 1e5) / 1e5;
}
