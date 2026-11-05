// app/lib/conductor-handoff.ts — 3人の統括（LINE＝ブレイン・AIX の統括・文の統括）が同じ型で動くための「渡す形」と「確かめ」（純関数・DB/LLM なし）
//
// 2026-11-03 竹内さん（KB P1「ブレインの統括と文の統括を、ぶつからずに束ねる — Claude Code の統括のやり方を手本に」・「統括に6つ足す」①）:
//   1 任せる範囲をはっきり渡す … 統括は下の役に毎回同じ形で「決まった事（決め直さない）・あなたが決める事・守る線」を渡す（Handoff）
//   2 1つの正 … 判断の正は統括の決定1つ（last_brain_meta）。下の役の出力は提案。食い違いは opts.recheck（brain-recheck.ts）で統括が決め直す
//   3 結果を確かめる … AIX が統括の選んだ物か・意図（一番の要点）が届いたか・設計図どおりか・読み直しの回数・確かめの指摘を毎番 digest.hc に1行
//   4 優先の順で解く … CONDUCTOR_PRIORITY_ORDER（この1か所。3人とも同じ物を見る）
//   5 やる事を持ち越す … plan_ahead・開いている約束を Handoff.decided に入れる
//   6 同じ事をやり直さない … 入力が同じなら前の決定（BRAIN_INPUT_KEY_STRICT）・読み直しは理由をまとめて1回（brain-recheck）
//   ① 番ごとに呼ぶ役を選ぶ … candidateRoles は候補の網だけ（決めるのは統括）。呼んだ／呼ばなかった役を digest.rl に1行
// 切替: CONDUCTOR_HANDOFF（既定 on・=off で止める。2026-11-05 作業員9 がコメントをコードに合わせた: 本番で効くのは digest.rl の記録と、構成のブレイン（BRAIN_COMPOSE_BLUEPRINT・既定 off）の中の受け渡しだけ）。テスト: app/lib/__tests__/conductor-handoff.test.ts
type Env = Record<string, string | undefined>;
// 2026-11-03 竹内さん（記録だけのスイッチ）: 今つないでいるのは digest.rl（呼ぶ役の候補の記録）だけ＝既定 on（=off で止める）
export const conductorHandoffOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_HANDOFF ?? "").trim().toLowerCase() !== "off";

/** 4 ぶつかった時の解き方（この順・1か所） */
export const CONDUCTOR_PRIORITY_ORDER = [
  "P0（竹内さんの絶対・最優先）",
  "竹内さんの新しい決定（P1・新しい方）",
  "実データ（実際の送信・成約・一次の記録）",
  "古い決まり・網・注記",
] as const;
export const CONDUCTOR_PRIORITY_LINE = `【ぶつかった時の順】${CONDUCTOR_PRIORITY_ORDER.join(" → ")}。`;

export type ConductorRole = "line" | "aix_desk" | "compose" | "writer" | "check" | "fetch" | "deep" | "second";
export const ROLE_JA: Record<ConductorRole, string> = {
  line: "LINE の統括", aix_desk: "AIX の統括", compose: "構成のブレイン", writer: "書き手", check: "確かめ", fetch: "取りに行く", deep: "深く読む", second: "2通目",
};

export type HandoffDecided = {
  /** 統括の決定: AIX の鍵 または "reply" */
  action: string;
  stage: string | null;
  mainPoint: string | null;
  /** 3段の安心する物（relief） */
  relief: string | null;
  /** plan_ahead の先頭の手 */
  nextStep: string | null;
  openPromises: string[];
};
export type Handoff = { from: ConductorRole; to: ConductorRole; decided: HandoffDecided; yours: string[]; lines: string[] };

/** 役ごとの「あなたが決める事」（決まった事は決め直さない） */
const YOURS: Record<ConductorRole, string[]> = {
  line: [],
  aix_desk: ["AIX の担当（どの札・どのピッカー）", "AIX の番でないと思う時は理由つきの差し戻し（決め直しは統括）"],
  compose: ["趣旨・主語・添え・締め（設計図）", "一番の要点をメインの1文にする言い方"],
  writer: ["設計図の各部品の言い回し"],
  check: ["答え漏れ・根拠なしの指摘（直すかどうかは統括の読み直し）"],
  fetch: ["決められた道具の中で、どの行を取るか"],
  deep: ["材料を足した読み直しの結論の案"],
  second: ["2通目の訴求の言い回し"],
};
const LINES = [
  "統括の決定（AIX か返信か・一番の要点）を下の役で変えない。違うと思ったら提案として返す（黙って上書きしない）",
  "スタッフしか知らない事（確認の結果・見積の金額・内覧の確定）は文に書かない（AIX の番）",
  "絵文字・呼び方・会社の事実の決まり（出口の安全の線）は外さない",
];

export function buildHandoff(o: { to: ConductorRole; meta: Record<string, unknown>; openPromises?: ReadonlyArray<string> }): Handoff {
  const m = o.meta;
  const s = (v: unknown, n = 40) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  const pa = m.plan_ahead as { steps?: unknown[] } | undefined;
  const tl = m.three_layer as { relief?: unknown } | undefined;
  return {
    from: "line", to: o.to,
    decided: {
      action: s(m.action, 40) ?? "reply", stage: s(m.checkpoint_stage, 20), mainPoint: s(m.main_point, 60), relief: s(tl?.relief, 50),
      nextStep: Array.isArray(pa?.steps) ? s(pa?.steps?.[0], 20) : null, openPromises: [...(o.openPromises ?? [])].slice(0, 5),
    },
    yours: YOURS[o.to], lines: LINES,
  };
}
/** 下の役のプロンプトに入れる1ブロック（同じ形） */
export function handoffNote(h: Handoff): string {
  const d = h.decided;
  const dec = [
    `AIX か返信か: ${d.action === "reply" ? "返信" : `AIX ${d.action}`}`,
    d.stage ? `段階: ${d.stage}` : "", d.mainPoint ? `一番の要点: ${d.mainPoint}` : "", d.relief ? `安心する物: ${d.relief}` : "",
    d.nextStep ? `次の手: ${d.nextStep}` : "", d.openPromises.length ? `開いている約束: ${d.openPromises.join("・")}` : "",
  ].filter(Boolean).join("／");
  return [
    `【${ROLE_JA[h.from]}から${ROLE_JA[h.to]}へ】`, `決まった事（決め直さない）: ${dec}`,
    h.yours.length ? `あなたが決める事: ${h.yours.join("／")}` : "", `守る線: ${h.lines.join("／")}`, CONDUCTOR_PRIORITY_LINE,
  ].filter(Boolean).join("\n");
}

// ── 3 結果を確かめる（digest.hc）・通しの試験の「受け渡しの落ち」 ──────────────────────────
export type HandoffDrop = "aix_ignored" | "intent_lost" | "blueprint_drift" | "recheck_loop" | "check_ignored";
export const DROP_JA: Record<HandoffDrop, string> = {
  aix_ignored: "AIX の統括の答えが無視された", intent_lost: "意図（一番の要点）が設計図・文に届いていない", blueprint_drift: "文が設計図から外れた",
  recheck_loop: "読み直しが2回以上回った", check_ignored: "確かめの指摘が統括の決め直しに届いていない",
};
const squash = (s: string) => s.replace(/[\s、。・「」]/g, "");
export function handoffChecks(o: {
  /** AIX の統括の答え（鍵／"reply"／null＝呼んでいない） */ deskAnswer?: string | null;
  /** 統括の最終の決定（鍵／"reply"） */ finalAction: string;
  /** AIX の統括の答えが違う時、読み直しの口を通ったか */ rechecked?: boolean;
  mainPoint?: string | null; composeMain?: string | null; draftText?: string | null;
  /** 設計図どおりか（作業員6 compose-checks の結果・null＝確かめていない） */ blueprintOk?: boolean | null;
  recheckCount?: number; checkFindings?: number; checkRouted?: boolean;
}): { drops: HandoffDrop[]; digest: string } {
  const drops: HandoffDrop[] = [];
  const ax = o.deskAnswer == null ? "-" : o.deskAnswer === o.finalAction ? "ok" : o.rechecked ? "rc" : "x";
  if (ax === "x") drops.push("aix_ignored");
  const core = o.mainPoint ? squash(o.mainPoint).slice(0, 6) : "";
  const reached = (t: string | null | undefined) => !!(core && t && squash(t).includes(core));
  const target = o.composeMain ?? o.draftText ?? null;
  const it = !o.mainPoint || target == null ? "-" : reached(target) ? "ok" : "x";
  if (it === "x") drops.push("intent_lost");
  const bp = o.blueprintOk == null ? "-" : o.blueprintOk ? "ok" : "x";
  if (bp === "x") drops.push("blueprint_drift");
  if ((o.recheckCount ?? 0) >= 2) drops.push("recheck_loop");
  const ck = !o.checkFindings ? "-" : o.checkRouted ? "ok" : "x";
  if (ck === "x") drops.push("check_ignored");
  return { drops, digest: `ax:${ax}|it:${it}|bp:${bp}|rc:${o.recheckCount ?? 0}|ck:${ck}` };
}

// ── ① 番ごとに呼ぶ役の候補（網は候補だけ・決めるのは統括）→ digest.rl ──────────────────────
export function candidateRoles(o: {
  ackOnly?: boolean; stampOnly?: boolean; finalAction: string; confidence?: "high" | "mid" | "low" | null; missing?: ReadonlyArray<string>;
  difficulty?: "high" | "mid" | "low" | null; noGround?: boolean;
}): { call: ConductorRole[]; skip: ConductorRole[] } {
  const call = new Set<ConductorRole>(["writer"]);
  const light = !!(o.ackOnly || o.stampOnly);
  if (o.finalAction !== "reply") { call.add("aix_desk"); call.add("second"); }
  if (!light) call.add("compose");
  if (!light || o.noGround) call.add("check");
  if ((o.missing?.length ?? 0) > 0) call.add("fetch");
  if (o.confidence === "low" && o.difficulty === "high") call.add("deep");
  const all: ConductorRole[] = ["aix_desk", "compose", "writer", "check", "fetch", "deep", "second"];
  return { call: all.filter((r) => call.has(r)), skip: all.filter((r) => !call.has(r)) };
}
const ROLE_SHORT: Record<ConductorRole, string> = { aix_desk: "ad", compose: "cp", writer: "wr", check: "ck", fetch: "fe", deep: "dp", second: "s2", line: "ln" };
export const rolesDigest = (r: { call: ReadonlyArray<ConductorRole> }) => r.call.map((x) => ROLE_SHORT[x]).join(",");
