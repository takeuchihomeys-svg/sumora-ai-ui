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
import { conductorFocusMode, FOCUS_INTAKE_RULES, FOCUS_SUB_RULES, focusSubOn, focusIntakeField, TURN_TOPICS_RULES, TURN_TOPICS_FIELD, turnTopicsOn, FOCUS_GUARD_RULES, FOCUS_GUARD_FIELD, focusGuardOn, parseFocusRead, type FocusRead } from "./conductor-focus";

type Env = Record<string, string | undefined>;
export type IntakeMode = "off" | "shadow";
export function conductorIntakeMode(env: Env = typeof process !== "undefined" ? process.env : {}): IntakeMode {
  return (env.CONDUCTOR_INTAKE ?? "").trim().toLowerCase() === "shadow" ? "shadow" : "off";
}
/** 先頭の文の版（中身を変えたら上げる＝作り置きが作り直される） */
export const INTAKE_PREFIX_VERSION = "ci-v1";

/**
 * 2026-11-05 作業員4（統括役の指示・P0 575a7cd5「統括は重点を先に決め、必要なブレインだけを動かす」の一部）: 場面ごとの「AIX の番になる合図」（ci-v3）。
 *   元はつなぎの芯の ci-v2（w2-conductor・未コミット・INTAKE_AIX_CUES）。ci-v2 の再生 ci-ds4（DeepSeek・竹内さんの番185・帳面あり）は
 *   AIX の番 24〜26→51/70 に上がったが、返信の番が 67〜74→49/115 に下がった（ack 18/30）＝お礼の番の合図が強すぎた。
 *   v3 はお礼の番の合図を「重点が約束を果たす時だけ」＝帳面に果たしていない『こちらの約束』がある時だけ AIX に絞る（KB 3f67fd3f: お礼の番は返信で完了が基本）。
 *   内覧の合図は ci-v2 のまま（KB ee24fa7c・1290264c）。どれも竹内さんの決定に根拠がある物だけ（創作の決まりを足さない）。
 *   切替: CONDUCTOR_INTAKE_CUES=v3（既定 off＝先頭の文は ci-v1 のまま・作り置きも崩さない）。入口の読みは記録だけ＝本番の判断は変わらない。
 */
export const INTAKE_AIX_CUES_V3 = [
  "お礼・了承の番（ack）: 返信で受けて完了させるのが基本（roles は writer だけ・やる事に aix を入れない）。この番の重点が『約束を果たす』時だけ、AIX の担当（aix_desk）とやる事 aix を入れる＝【帳面】に、こちらの約束（ピックアップ・物件確認・見積書 等）があり、その後にその約束を果たした送付の行が無い時。その AIX は約束した物（物件ピックアップ（複数）か物件オススメ（1件）・確認の結果・見積書）。帳面に果たしていない約束が無い時は AIX を入れない",
  "内覧の番（viewing）: 候補の日時を出す番は AIX【内覧調整】、日にちが決まった番は AIX【待ち合わせ場所】（＝確定）。別の質問の番では段階を進めない",
] as const;
export const intakeCuesV3On = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_INTAKE_CUES ?? "").trim().toLowerCase() === "v3";
// 2026-11-05 作業員5（KB P0 575a7cd5）: CONDUCTOR_FOCUS=shadow の時だけ、先頭に「表→背景→重点」の段を足す（版に +f1・既定 off は ci-v1／ci-v3 のまま1字も変えない）
export const intakePrefixVersion = (env: Env = typeof process !== "undefined" ? process.env : {}) => `${intakeCuesV3On(env) ? "ci-v3" : INTAKE_PREFIX_VERSION}${conductorFocusMode(env) !== "off" ? `+f1${focusSubOn(env) ? "s1" : ""}${turnTopicsOn(env) ? "t1" : ""}${focusGuardOn(env) ? "g1" : ""}` : ""}`;

const SCENES = Object.keys(REPLY_SCENE_JA) as ReplyScene[];
const ROLES = ["aix_desk", "compose", "writer", "check", "fetch", "deep", "second"] as const;

/** 先頭（作り置き）の固定の文。取扱説明書の短い形は、版が変わる時（毎週の書き直し）だけ変わる */
export function intakePrefix(manualShortForms: ReadonlyArray<{ brain: string; short: string }>, env: Env = typeof process !== "undefined" ? process.env : {}): string {
  const v3 = intakeCuesV3On(env);
  const focus = conductorFocusMode(env) !== "off";
  const manuals = [...manualShortForms].sort((a, b) => a.brain.localeCompare(b.brain)).map((m) => `- ${m.brain}: ${m.short}`).join("\n");
  return [
    `あなたは賃貸の仲介会社の LINE 返信の「入口の統括」です（版 ${intakePrefixVersion(env)}）。お客様の今の番を最初に読み、場面・やる事・動かす担当・要る材料・迷いを決まった形の JSON で書きます。返信の文は書きません。判断（返信か AIX か）は判断のブレインが決めます。あなたは担当の選び方と材料の当たりを付ける役です。`,
    `【絶対の決まり（P0）】スタッフだけが知る事（管理会社の確認の結果・募集状況・交渉の結果・撮影した写真・見積の金額・内覧の日程の確定・入居可能日）は AIX で送る番。返信は AI が知り得る事だけ。判断はすべてブレインが決める（決まった計算は候補と安全の線だけ）。`,
    CONDUCTOR_PRIORITY_LINE,
    ...(v3 ? [`【AIX の番になる合図（場面ごと）】\n${INTAKE_AIX_CUES_V3.map((c) => `- ${c}`).join("\n")}`] : []),
    ...(focus ? [FOCUS_INTAKE_RULES] : []),
    // 2026-11-13 作業員5: 重点の下の種類（CONDUCTOR_FOCUS_SUB=on の時だけ・版に s1）
    ...(focus && focusSubOn(env) ? [FOCUS_SUB_RULES] : []),
    // 2026-11-13 作業員5: 連投の話題ごとの主と従（CONDUCTOR_TOPIC_STATE=on の時だけ・版に t1）
    ...(focus && turnTopicsOn(env) ? [TURN_TOPICS_RULES] : []),
    // 2026-11-13 作業員5（作業員10 の頼み）: 触れない話題と条件の繰り返しの範囲（CONDUCTOR_FOCUS_GUARD=on の時だけ・版に g1）
    ...(focus && focusGuardOn(env) ? [FOCUS_GUARD_RULES] : []),
    `【場面（scene はこの中から1つ）】${SCENES.map((s) => `${s}=${REPLY_SCENE_JA[s]}`).join("／")}`,
    `【担当（roles はこの中から）】${ROSTER.filter((r) => (ROLES as readonly string[]).includes(r.id)).map((r) => `${r.id}=${r.does}`).join("／")}`,
    `【要る材料（need はこの中から）】${NEED_TOOLS.join("・")}`,
    `【担当の取扱説明書（短い形）】\n${manuals || "- （まだ無い）"}`,
    `【書き方】JSON だけを返す: {"scene": "場面", "roles": ["担当"], "need": ["材料"], "todos": [{"kind": "answer|promise|aix|fetch|check", "what": "20字以内"}], "doubt": {"kind": "何の迷いか（20字以内）", "between": ["案A", "案B"]} または null, "confidence": "high|mid|low"${focus ? `, ${focusIntakeField(env)}${turnTopicsOn(env) ? `, ${TURN_TOPICS_FIELD}` : ""}${focusGuardOn(env) ? `, ${FOCUS_GUARD_FIELD}` : ""}` : ""}}。一覧に無い言葉を作らない。${v3 ? "軽い番（お礼・スタンプだけ）は、上の合図（帳面に果たしていない約束）に当たらない限り roles を [\"writer\"] だけにする。" : "軽い番（お礼・スタンプだけ）は roles を [\"writer\"] だけにする。"}`,
  ].join("\n\n");
}

/** 後ろ（毎回変わる部分）: 会話・帳面・前の番。問いの文はお客様の発言と状況のまとめのまま */
export function intakeUser(o: { customerTurn: string; lastStaff: string | null; ledgerBlock: string; carryLine: string; ruleMeta: string; nearFocusLine?: string }): string {
  return [
    `【お客様の今の番】\n${o.customerTurn.slice(0, 800)}`,
    o.lastStaff ? `【直前のこちらの送信】\n${o.lastStaff.slice(0, 400)}` : "",
    o.ledgerBlock ? o.ledgerBlock.slice(0, 2500) : "",
    o.carryLine ? `【前の番】${o.carryLine}` : "",
    o.ruleMeta ? `【決まった計算の候補（参考）】${o.ruleMeta}` : "",
    o.nearFocusLine ? o.nearFocusLine : "",
  ].filter(Boolean).join("\n\n");
}

export type IntakeAnswer = {
  scene: ReplyScene; roles: ConductorRole[]; need: NeedTool[];
  todos: Array<{ kind: "answer" | "promise" | "aix" | "fetch" | "check"; what: string }>;
  doubt: { kind: string; between: [string, string] } | null;
  confidence: "high" | "mid" | "low";
  /** 2026-11-05 作業員5: 表→背景→重点（CONDUCTOR_FOCUS=shadow の時だけ・無い番は省く） */
  focus_read?: FocusRead | null;
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
  const fr = o.focus_read !== undefined ? parseFocusRead(o) : undefined;
  return { scene: o.scene as ReplyScene, roles: [...new Set(roles)], need: [...new Set(need)], todos, doubt: d && between.length === 2 ? { kind: String(d.kind ?? "").slice(0, 20), between: [between[0], between[1]] } : null, confidence: conf, ...(fr !== undefined ? { focus_read: fr } : {}) };
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

/** 読みが AIX の番と見たか（AIX の担当 aix_desk を呼ぶ・やる事に aix がある）。再生の試験（conductor-intake-replay）の採点と同じ見方 */
export function intakeSaysAix(a: Pick<IntakeAnswer, "roles" | "todos"> | null | undefined): boolean {
  return !!a && (a.roles.includes("aix_desk") || a.todos.some((t) => t.kind === "aix"));
}
/**
 * digest.ci の1行（記録だけ）。2026-11-05 作業員4（brain_weaknesses meeting-gap:conductor-intake-digest-thin）:
 *   前は「場面|自信|cr|ds:一致」だけで、本番の記録から入口の読みの当たり（返信か AIX か・竹内さんの最初の一手と比べる）を数えられなかった。
 *   後ろに |a0/a1（Sonnet が AIX の番と見たか）、DeepSeek でも読んだ番は |dx:<DeepSeek の場面>:a0/a1 を足す（75da346a ②の比べを本番の記録で）。
 *   前の形の読み手（audit-prod-as-exam の /\|ds:(.)/）はそのまま読める。
 */
export function intakeDigestLine(ci: { answer?: IntakeAnswer | null; ds?: IntakeAnswer | null; cacheRead?: number | null; agree?: { scene: boolean; roles: boolean; need: boolean } | null } | null | undefined): string | null {
  if (!ci?.answer) return null;
  const a = ci.answer;
  const ag = ci.agree ? `${ci.agree.scene ? "s" : "-"}${ci.agree.roles ? "r" : "-"}${ci.agree.need ? "n" : "-"}` : "";
  const roles = Array.isArray(a.roles) ? a.roles : [], todos = Array.isArray(a.todos) ? a.todos : [];
  const ds = ci.ds && Array.isArray(ci.ds.roles) && Array.isArray(ci.ds.todos) ? ci.ds : null;
  return `${a.scene}|${a.confidence?.[0] ?? ""}|cr${ci.cacheRead ?? 0}${ag ? `|ds:${ag}` : ""}|a${intakeSaysAix({ roles, todos }) ? 1 : 0}${ds ? `|dx:${ds.scene}:a${intakeSaysAix(ds) ? 1 : 0}` : ""}`;
}

/** 1回の費用の見積もり（USD・Sonnet: 入力 $3/M・作り置きの読み $0.3/M・作り置きの書き $3.75/M・出力 $15/M） */
export function intakeCostUsd(o: { prefixTokens: number; variableTokens: number; outputTokens: number; cacheHit: boolean }): number {
  const pre = o.cacheHit ? o.prefixTokens * 0.3e-6 : o.prefixTokens * 3.75e-6;
  return Math.round((pre + o.variableTokens * 3e-6 + o.outputTokens * 15e-6) * 1e5) / 1e5;
}
