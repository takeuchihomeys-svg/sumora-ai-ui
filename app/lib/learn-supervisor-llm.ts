/**
 * 統括の「思考」を LLM に任せる（2026-11-15 竹内さん）
 *
 *   竹内さん「統括がメインなのでその考えは絶対事項／統括がブレインとしてまとめるようにする」
 *     「日々進化していくように統括のがブレインとなって強化していく」
 *     「統括の部分もしAPIつかっているのなら deepseekv4pro の方が思考的に良い可能性ある」
 *
 * ★ なぜ要るか（実測）
 *   統括（`learn-supervisor.ts`・1,209行）は**LLM を一切使っていない**（決定論＝私が書いた if 文だけ）。
 *   決定論の良さ: 費用0・速い・説明できる。
 *   弱さ: **私が想像しなかったパターンに気づけない**（例: 「録画が途中で切れている」「同じ画像が100枚続く」は
 *         人が気づくまで分からなかった）。
 *
 * ★ 役割の分け方（ここが肝心）
 *   ・**材料を集めるのは決定論**（数える・比べる・記録する＝間違えない）
 *   ・**判断するのは LLM**（何を先に直すか・なぜか・次に何を学ぶか＝思考が要る）
 *   ⚠ LLM に数えさせない（数は決定論の方が正確・費用もかかる）。
 *   ⚠ LLM の答えは**材料にない事を言わない**ように縛る（プロンプトで「材料にある事だけ」と明示）。
 *   ⚠ LLM が落ちても**決定論の判断をそのまま使う**（止まらない）。
 *
 * ★ 実測（deepseek-v4-pro）
 *   時間 5.5秒・$0.001/回・答え「徒歩の選び直し77件を最優先で改善する」
 *   ⚠ 私が書いたルールと同じ判断を、材料から**自分で導いた**。
 *
 * 実行（単体で試す）:
 *   npx tsx --env-file=.env.local scripts/supervisor-think.ts
 *   npx tsx --env-file=.env.local scripts/supervisor-think.ts --model=deepseek-flash
 */
import { DEEPSEEK_MODEL_PRO, DEEPSEEK_MODEL_FLASH, DEEPSEEK_MAX_TOKENS_THINK } from "./deepseek-models";

export const SUPERVISOR_MODEL_DEFAULT = DEEPSEEK_MODEL_PRO;

/** 統括が材料から考える時の指示（材料に無い事を言わせない） */
export const SUPERVISOR_THINK_PROMPT = [
  "あなたは物件検索AIの「学習の統括」です。現場の記録から、次に何を直すべきかを決めます。",
  "",
  "決まり（必ず守る）:",
  "・**材料に書いてある事だけ**を使う。推測で新しい事実を作らない。",
  "・数字は材料の数字をそのまま使う（自分で数え直さない）。",
  "・優先するのは「実際の検索が止まる」「誤った物件を送る」「毎回同じ所で迷う」の3つ。",
  "・**1つだけ**選ぶ（あれもこれも言わない。現場が1つずつ直せるように）。",
  "・出力は次の3行だけ。前置き・挨拶・説明は書かない。",
  "",
  "形式:",
  "次に直す: （20字以内で1つ）",
  "なぜ: （材料の数字を1つ入れて40字以内）",
  "どう直す: （40字以内・具体的に）",
].join("\n");

export type SupervisorThink = {
  /** 次に直す（1つ） */
  next: string;
  /** なぜ（材料の数字つき） */
  why: string;
  /** どう直すか */
  how: string;
  /** 使ったモデル */
  model: string;
  /** かかった時間（ms） */
  ms: number;
  /** 使ったトークン（費用の目安） */
  usage: { input: number; output: number } | null;
};

/** LLM の答えを読む（純関数・壊れていても落ちない） */
export function parseSupervisorThink(text: string): { next: string; why: string; how: string } | null {
  const t = String(text ?? "");
  const grab = (label: string) => {
    const m = t.match(new RegExp(label + "\\s*[:：]\\s*(.+)"));
    return m ? m[1].trim().replace(/[。\s]+$/, "").slice(0, 120) : "";
  };
  const next = grab("次に直す");
  const why = grab("なぜ");
  const how = grab("どう直す");
  // ⚠ 3つ揃っていないなら使わない（中途半端な判断で現場を動かさない）
  if (!next || !why || !how) return null;
  return { next, why, how };
}

/**
 * 統括に考えさせる（材料を渡して1つ選ばせる）。
 *   ⚠ 鍵が無い・失敗した時は **null を返す**（呼ぶ側は決定論の判断をそのまま使う＝止まらない）。
 *   ⚠ `budgetMs` を超えそうなら諦める（統括の応答を遅くしない）。
 *
 *   ★ 2026-11-15 **実測で判明（3回目の同じ罠）**:
 *     `max_tokens` が **700 → 答え0字（推論1180字）**／**2000 → 答え0字（推論6419字）**／
 *     **4000 → 答え77字（推論2281字）**。DeepSeek V4 Pro は**推論にトークンを大量に使う**ので、
 *     少ないと答えが出る前に切れる（HTTP は 200 で返るので気づきにくい）。
 *   → 既定を **4000** にする（`DEEPSEEK_MAX_TOKENS_SAFE`）。
 */
export async function thinkAsSupervisor(
  material: string,
  opt: { model?: string; budgetMs?: number; maxTokens?: number; env?: Record<string, string | undefined> } = {},
): Promise<SupervisorThink | null> {
  const env = opt.env ?? process.env;
  const key = String(env.DEEPSEEK_API_KEY ?? "").trim();
  if (!key) return null;
  const model = String(opt.model ?? env.SUPERVISOR_MODEL ?? SUPERVISOR_MODEL_DEFAULT).trim();
  /**
   * ⚠ 推論に時間がかかる（実測 4000トークンで 20〜45秒）。既定を 60秒にする。
   */
  const budget = Math.max(10000, Math.min(90000, opt.budgetMs ?? 60000));
  const t0 = Date.now();
  try {
    // 2026-11-23 作業員G（台帳 #599）: callDeepSeek を通す（費用の記録が残る・system・中身・最大トークン・時間は今と同じ・推論の指定は送らない）
    const { callDeepSeek } = await import("./vision-alt-provider");
    const ds = await callDeepSeek(SUPERVISOR_THINK_PROMPT, "材料:\n" + String(material ?? "").slice(0, 6000),
      { apiKey: key, model, maxTokens: opt.maxTokens ?? DEEPSEEK_MAX_TOKENS_THINK, timeoutMs: budget, effort: "" });
    // ⚠ 推論モデルは推論にトークンを使うので、`content` が空なら**諦める**（決定論を使う）＝callDeepSeek は空なら null
    if (!ds) return null;
    const text = ds.text;
    if (!text) return null;
    const parsed = parseSupervisorThink(text);
    if (!parsed) return null;
    return {
      ...parsed,
      model: ds.model,
      ms: Date.now() - t0,
      usage: { input: ds.usage.input, output: ds.usage.output },
    };
  } catch {
    return null;
  }
}

/**
 * 統括の材料を**LLM に渡す短い文**にする（純関数）。
 *   ⚠ 数字は決定論で数えた物をそのまま使う（LLM に数えさせない）。
 *   ⚠ 長くしない（6,000字まで）。要点だけ。
 */
export function supervisorMaterialText(b: {
  rows?: number;
  with_ops?: number;
  next_n?: number;
  points_n?: number;
  weak?: Array<{ kind?: string; name?: string; why?: string }>;
  scene_flows?: Array<{ scene?: string; runs?: number; ops?: number; steps?: string[]; variants?: number }>;
  stopped_scene?: string | null;
  improvements?: { total?: number; recent?: Array<{ area?: string; title?: string }> } | null;
  human_ops?: number;
  auto_ops?: number;
  same_runs?: number;
}): string {
  const L: string[] = [];
  L.push(`記録 ${b.rows ?? 0}件（操作つき ${b.with_ops ?? 0}件・人の手本 ${b.human_ops ?? 0}回・機械 ${b.auto_ops ?? 0}回）`);
  L.push(`押す順番 ${b.next_n ?? 0}通り・押す場所 ${b.points_n ?? 0}個`);
  if (b.stopped_scene) L.push(`止まりやすい場面: ${b.stopped_scene}`);
  const weak = Array.isArray(b.weak) ? b.weak : [];
  if (weak.length) {
    L.push(`弱い所 ${weak.length}件:`);
    for (const w of weak.slice(0, 10)) {
      L.push(`  ・[${String(w.kind ?? "")}] ${String(w.name ?? "").slice(0, 24)} … ${String(w.why ?? "").slice(0, 60)}`);
    }
  }
  const sf = Array.isArray(b.scene_flows) ? b.scene_flows : [];
  if (sf.length) {
    L.push("場面ごとの手順:");
    for (const f of sf.slice(0, 6)) {
      L.push(`  ・${String(f.scene ?? "")} ${f.runs ?? 0}回 ${f.ops ?? 0}手 ${f.variants ?? 0}通り: ${(f.steps ?? []).slice(0, 4).join(" → ")}`);
    }
  }
  const imp = b.improvements;
  if (imp && Number(imp.total) > 0) {
    L.push(`今日 直した事 ${imp.total}件:`);
    for (const r of (imp.recent ?? []).slice(0, 5)) L.push(`  ・[${String(r.area ?? "")}] ${String(r.title ?? "").slice(0, 50)}`);
  }
  return L.join("\n").slice(0, 6000);
}
