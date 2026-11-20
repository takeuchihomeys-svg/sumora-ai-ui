// app/lib/supervisor-owner-ask.ts — 統括Pro が「最善の判断」をし、迷ったら竹内さんへ【推奨つき】で確認を取る形（純関数・DB も LLM も持たない）
//
// 2026-11-19 竹内さん「判断も統括pro最善の判断できるように仕組みもつくって／迷ったら俺に推奨で確認とるかたちで」
//
// 形:
//   1. Pro は判断のたびに「確信（high/mid/low）」と「根拠」を言い、迷う所は owner_asks（選択肢つき・推奨1つ・理由）で出す（プロンプトは learn-supervisor-pro.ts）。
//   2. Pro が出し忘れても、**決定論の関所**が聞くべき場面を拾う（費用が出る・DB の構造変更・一括やモードの方針変更・本番への反映・統括の言葉の矛盾・確信が低い）。
//      ＝「聞くかどうか」を LLM の気分に任せない。
//   3. 聞く時は**必ず推奨を1つ**付ける（選択肢の中から）。推奨が無い／選択肢に無い時は「保留（何も変えない）」を足して推奨にする。
//   4. 聞かないで決めてよいのは、無料・元に戻せる・既に決まった方針の中、の時だけ。
//   5. 台帳 owner_questions（既存）に入れる（supervisor-owner-ask-server.ts）。答えは scripts/owner-questions.ts --answer で設計知見（P1）になり、次の判断の材料（kb_hits）に戻る。
//   ⚠ 自動で直す範囲は広げない（CLAUDE.md 7）。ここは「聞く」まで。答えが来るまで該当の作業は保留。

export type AskTrigger = "cost" | "db_change" | "policy" | "deploy" | "contradiction" | "low_confidence" | "other";
export type AskConfidence = "high" | "mid" | "low";

export const ASK_TRIGGER_JA: Record<AskTrigger, string> = {
  cost: "費用が出る",
  db_change: "DB の構造変更",
  policy: "動き方の方針の変更",
  deploy: "本番への反映",
  contradiction: "統括の言葉の矛盾",
  low_confidence: "確信が低い",
  other: "その他の迷い",
};

export type OwnerAsk = {
  question: string;
  options: string[];
  /** 必ず options の中の1つ */
  recommended: string;
  why: string;
  trigger: AskTrigger;
  /** "pro" = Pro が出した／"gate" = 決定論の関所が拾った */
  source: "pro" | "gate";
  /** scope・日付を付ける前の種（trigger + 問いの要約） */
  key: string;
};

export const HOLD_OPTION = "保留（今は何も変えない）";
const MAX_ASKS = 4;

function clean(s: unknown, n: number): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

/** 問いの要約から安定した短い種を作る（同じ問いは同じ種） */
export function askKey(trigger: AskTrigger, question: string): string {
  const base = question.replace(/[\s　、。,.「」『』（）()・:：;；?？!！]/g, "").slice(0, 40);
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return `${trigger}-${h.toString(36)}`;
}

/** 推奨を必ず選択肢の中の1つにする。選択肢が2つ未満なら保留を足す。 */
export function ensureRecommended(options: string[], recommended: string | null | undefined): { options: string[]; recommended: string } {
  let opts = options.map((o) => clean(o, 80)).filter(Boolean);
  opts = [...new Set(opts)].slice(0, 5);
  const rec = clean(recommended, 120);
  if (rec) {
    const hit = opts.find((o) => o === rec) ?? opts.find((o) => o.includes(rec) || rec.includes(o));
    if (hit) {
      if (opts.length < 2) opts.push(HOLD_OPTION);
      return { options: opts, recommended: hit };
    }
  }
  // 推奨が無い／選択肢に無い → 何も変えない案を足して、それを推奨にする（勝手に動く方を勧めない）
  if (!opts.includes(HOLD_OPTION)) opts.push(HOLD_OPTION);
  return { options: opts.slice(0, 5), recommended: HOLD_OPTION };
}

const TRIGGERS = new Set<string>(Object.keys(ASK_TRIGGER_JA));

/** Pro の JSON の owner_asks を安全な形にする（質問が空・選択肢が無い物は捨てない＝保留つきで残す） */
export function parseOwnerAsks(raw: unknown): OwnerAsk[] {
  if (!Array.isArray(raw)) return [];
  const out: OwnerAsk[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const question = clean(r.question ?? r.q, 200);
    if (!question) continue;
    const optsRaw = Array.isArray(r.options) ? r.options : [];
    const { options, recommended } = ensureRecommended(optsRaw.map((o) => String(o ?? "")), clean(r.recommended, 120));
    const t = clean(r.trigger, 20);
    const trigger: AskTrigger = TRIGGERS.has(t) ? (t as AskTrigger) : "other";
    out.push({ question, options, recommended, why: clean(r.why, 240) || "（理由は Pro が書かなかった）", trigger, source: "pro", key: askKey(trigger, question) });
    if (out.length >= MAX_ASKS) break;
  }
  return out;
}

export function parseConfidence(raw: unknown): AskConfidence | null {
  const s = clean(raw, 10).toLowerCase();
  return s === "high" || s === "mid" || s === "low" ? s : null;
}

export type GateInput = {
  /** Pro が実際に出した文（today / next_line / build_next / path_to_100 / weak_fixes.next / bug_fixes を連結）。meet の議題は入れない */
  proText: string;
  verdict?: string | null;
  coverage?: number | null;
  /** 根拠の行（値だけでよい） */
  evidenceValues?: string[];
  confidence?: AskConfidence | null;
  confidenceWhy?: string | null;
};

const RE_DB = /ALTER\s+TABLE|CREATE\s+(TABLE|INDEX|VIEW)|DROP\s+(TABLE|COLUMN|VIEW)|DDL|列を(足|追加)|カラムを(足|追加)|テーブルを(作|追加|足)/i;
const RE_POLICY = /busy_other_customer|一括(全体)?を止め|次(の)?(客|お客さん)を飛ば|既定(の)?(動き|設定)を変え|モード(全体)?の(方針|既定)|自動で直す範囲/;
const RE_DEPLOY = /main(へ|に)?\s*(push|デプロイ|マージ)|本番(へ|に)?(デプロイ|反映|出す)|Vercel(へ|に)?(デプロイ|反映)/i;
const RE_COST = /yes-cost|有料|費用(が|を)?(かか|出)|photo_learn[^。]{0,40}(実行|枚)|flash[^。]{0,20}(実行|読む|読み)/;

/** 判断の中に「高い到達」と「反映の実証 read=0」が同居しているか（統括の言葉の矛盾） */
export function findContradictions(input: Pick<GateInput, "verdict" | "coverage" | "proText" | "evidenceValues">): string[] {
  const hay = [input.proText, ...(input.evidenceValues ?? [])].join("\n");
  const high = input.verdict === "ready" || input.verdict === "almost" || (Number(input.coverage) || 0) >= 80;
  const m = hay.match(/(F55|F38)[^。\n]{0,24}?read\s*=\s*0/);
  const out: string[] = [];
  if (high && m) {
    out.push(`到達の表示（verdict=${input.verdict ?? "-"}・材料${input.coverage ?? "-"}%）と、反映の実証が未達（${m[0].slice(0, 40)}）が同時に出ています`);
  }
  return out;
}

/** 決定論の関所: 聞くべき場面を拾い、必ず推奨つきの問いにする */
export function deriveGateAsks(input: GateInput): OwnerAsk[] {
  const t = input.proText || "";
  const asks: OwnerAsk[] = [];
  const push = (trigger: AskTrigger, question: string, options: string[], recommended: string, why: string) => {
    const e = ensureRecommended(options, recommended);
    asks.push({ question, options: e.options, recommended: e.recommended, why, trigger, source: "gate", key: askKey(trigger, question) });
  };

  if (RE_DB.test(t)) {
    push("db_change", "統括Pro の次手に DB の構造変更（列・表の追加など）が含まれています。中身を見せてから当ててよいですか",
      ["まず中身（SQL）を見せる", "今は構造を変えない"], "まず中身（SQL）を見せる",
      "DB の構造変更は竹内さんの OK が先（絶対ルール）。見せてから当て、同時に migrate-schema も直す");
  }
  if (RE_POLICY.test(t)) {
    push("policy", "統括Pro の次手に、一括・次のお客さんへの進み方など「動き方の方針」を変える内容が含まれています。変えてよいですか",
      ["変える前に影響を見せる", "今の方針のまま"], "変える前に影響を見せる",
      "一括全体が止まる／飛ぶなど、お客さん全員に効く変更は先に確認する決まり");
  }
  if (RE_DEPLOY.test(t)) {
    push("deploy", "統括Pro の次手に本番（main／Vercel）への反映が含まれています。出してよいですか",
      ["cursor-ext で確認してから出す", "今は出さない"], "cursor-ext で確認してから出す",
      "本番への push は承認が要る。拡張は再読込→自動1回で確かめてからでも遅くない");
  }
  if (RE_COST.test(t)) {
    push("cost", "統括Pro の次手に費用が出る学習（写真の読み取り photo_learn／flash）が含まれています。どこまでやりますか",
      ["統括が決めた枚数で実行する（2枚の dry-run で読み方を確かめてから）", "まず --dry-run で枚数と費用を見せる", "今は実行しない"],
      "統括が決めた枚数で実行する（2枚の dry-run で読み方を確かめてから）",
      "2026-11-20 竹内さん「枚数も改善するためならどれだけ使ってもよい 統括pro判断するかたちとする」。dry-run は読み方の確かめ（2枚）で、枚数の許可待ちにしない");
  }
  for (const c of findContradictions(input)) {
    push("contradiction", `統括の言葉が食い違っています: ${c}。どちらを今の結論として扱いますか`,
      ["反映の実証が済むまで「未実証」として扱う", "今の表示のまま扱う"], "反映の実証が済むまで「未実証」として扱う",
      "拡張を再読込して自動を1回走らせた実測（read≥1）が出るまでは、到達とは言えない（束に載せただけで改善済みとしない決まり）");
  }
  if (input.confidence === "low") {
    push("low_confidence", `統括Pro の確信が低い判断です${input.confidenceWhy ? `（${clean(input.confidenceWhy, 80)}）` : ""}。このまま次手を進めてよいですか`,
      ["無料の実測を先に増やしてから決める", "今の次手で進める"], "無料の実測を先に増やしてから決める",
      "確信が低いまま直すと別の所が壊れる。DB・録画の実データを先に読む決まり");
  }
  return asks;
}

/** Pro の問いと関所の問いを1つにまとめる（同じ trigger は Pro の方を残す・最大4件・推奨は必ずある） */
export function mergeAsks(proAsks: OwnerAsk[], gateAsks: OwnerAsk[]): OwnerAsk[] {
  const out: OwnerAsk[] = [];
  const seenKey = new Set<string>();
  const seenTrigger = new Set<AskTrigger>();
  for (const a of [...proAsks, ...gateAsks]) {
    if (seenKey.has(a.key)) continue;
    // 関所の問いは、同じ trigger の Pro の問いがもうあれば足さない（二重に聞かない）
    if (a.source === "gate" && seenTrigger.has(a.trigger)) continue;
    const e = ensureRecommended(a.options, a.recommended);
    out.push({ ...a, options: e.options, recommended: e.recommended });
    seenKey.add(a.key);
    seenTrigger.add(a.trigger);
    if (out.length >= MAX_ASKS) break;
  }
  return out;
}

/** 台帳に入れる種（scope と日付つき）。同じ日・同じ問いは1回だけ */
export function ledgerDedupeKey(scope: string, a: Pick<OwnerAsk, "key">, jstDay: string): string {
  return `sup-pro:${scope}:${a.key}:${jstDay}`;
}
/** 同じ scope・同じ trigger で未回答がある間は、新しい日でも足さない */
export function ledgerOpenPrefix(scope: string, trigger: AskTrigger): string {
  return `sup-pro:${scope}:${trigger}-`;
}

export function jstDayOf(nowMs: number): string {
  return new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");
}

/** 竹内さんに見せる文（推奨つき） */
export function renderOwnerAsks(asks: ReadonlyArray<OwnerAsk>, ids?: ReadonlyArray<string | null>): string[] {
  if (!asks.length) return ["  （迷い無し＝無料・元に戻せる・既に決まった方針の中で進めてよい）"];
  const lines: string[] = [];
  asks.forEach((a, i) => {
    lines.push(`  ${i + 1}. [${ASK_TRIGGER_JA[a.trigger]}・${a.source === "pro" ? "Pro" : "関所"}] ${a.question}`);
    lines.push(`     選択: ${a.options.join(" ／ ")}`);
    lines.push(`     → オススメ: ${a.recommended}（${a.why}）`);
    const id = ids?.[i];
    if (id) lines.push(`     [id ${id.slice(0, 8)}] 答える: npx tsx --env-file=.env.local scripts/owner-questions.ts --answer ${id.slice(0, 8)} "<答え>"`);
  });
  return lines;
}

/** Pro が出した文を連結する（関所の判定に使う）。meet の議題は含めない＝竹内さんの言葉で関所が鳴らないように */
export function proTextOf(e: {
  today?: string[]; link_gap?: string | null; next_line?: string | null; foundation_gaps?: string[]; build_next?: string | null;
  weak_fixes?: Array<{ next?: string; how?: string }>; bug_fixes?: string[]; path_to_100?: string | null;
}): string {
  return [
    ...(e.today ?? []), e.link_gap ?? "", e.next_line ?? "", ...(e.foundation_gaps ?? []), e.build_next ?? "", e.path_to_100 ?? "",
    ...(e.weak_fixes ?? []).flatMap((w) => [w.next ?? "", w.how ?? ""]), ...(e.bug_fixes ?? []),
  ].filter(Boolean).join("\n");
}
