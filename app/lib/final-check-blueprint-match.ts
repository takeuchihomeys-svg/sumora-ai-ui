// app/lib/final-check-blueprint-match.ts — 最終チェックの4つ目の段: 下書きの1文ずつを文の設計図の行に当て、どの行にも当たらない文に印を付ける（純関数・LLM なし）
//
// 2026-11-13 作業員9（統括役 S9・点検役の Claude の進め方との比べ）: 最終チェックは「竹内さんに無い文の足し」と「設計図どおりか」を見ていなかった。
//   実例（line_watch_turns）:
//     12164 資料の事実の付け足し「こちらは現在建設中のため、ご内覧は入居日が近づいてからとなります！！」（竹内さんは消した）
//     12196 前の条件の全部の繰り返し「大阪市西区…家賃管理費込み8万〜12万・1LDK・36㎡以上・築15年以内・駅徒歩15分以内で…」（竹内さんは「家賃管理費込み12万円以内」だけ）
//     12348 材料の無い潜在の文「…一緒に進めていきましょう😌！！」（竹内さんの送信に無い）
//     対象の取り違え（戦略の層の別の物件を書く）
//   行の形は作業員10 の PlanRowV2（compose-plan-rows-v2.ts の10欄）に合わせる。ここでは当てに要る欄（role・sub・uses・how）だけを構造で受ける
//   （作業員10 の型を読み込まない＝その部品が入る前でも動く）。文の段は writing-blueprint.classifySentence（作業員10 の V2_OF と同じ考え）。
//   出口の決まり: 最初は**印だけ**（書き換えも止めもしない）。結果は generate-reply が1行のログ「fc:blueprint-unmatched」に出し、
//   見張りの materials.reply.blueprint に入る（line-watch-materials.summarizeMaterialLog）。誤った印の数を実送信で数えてから次を決める。
//   既定 off（FC_BLUEPRINT_MARK=on）。
import { partsOf, type BlueprintPart } from "./writing-blueprint";

export function fcBlueprintMarkOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.FC_BLUEPRINT_MARK ?? "").trim().toLowerCase() === "on";
}

/** 作業員10 の PlanRowV2 のうち当てに使う欄だけ */
export type BlueprintRowLike = {
  role: string;
  sub?: string | null;
  uses?: ReadonlyArray<{ field: string; value: string }> | null;
  how?: string | null;
};

export type UnmatchedKind = "fact_addition" | "condition_repeat" | "latent_no_material" | "object_mismatch" | "other";
export type UnmatchedMark = { sentence: string; part: BlueprintPart; kind: UnmatchedKind };

/** 文の段 → 行の役目（作業員10 の V2_OF の考え: 受け・挨拶＝頭／答え・約束＝押さえ／誘い＝つなぎ／支え・締め＝締め） */
const ROLE_OF_PART: Partial<Record<BlueprintPart, ReadonlyArray<string>>> = {
  greeting: ["head"], thanks: ["head"], ack: ["head"],
  answer: ["press", "trust"], promise: ["press"],
  invite: ["bridge"], support: ["close", "latent", "trust"], closing: ["close"],
};
/** どの行が無くても印を付けない段（名前・挨拶・受け・締めの定型）＝竹内さんの文の骨 */
const ALWAYS_OK: ReadonlySet<BlueprintPart> = new Set<BlueprintPart>(["name", "greeting", "thanks", "ack", "closing"]);

// 「全力でサポート」は竹内さんの継続の約束（締めの keep_promise）なので潜在の語に入れない
const LATENT_RE = /一緒に|頑張り|お任せ|ご安心|心強|寄り添/;
const CONFIRM_TAIL_RE = /^(?:確認|募集状況確認)?(?:出来|でき)次第(?:ご連絡|お送り)|^確認(?:出来|でき)次第/;
const CONDITION_REPEAT_MIN = 4;
const FACT_ENDING_RE = /(?:ため|為)[、,]|となります|でございます|ございます[！!。]|となっております|可能です|出来ません|できません/;
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

/** 条件の語（エリア・家賃・間取り・広さ・築年・徒歩 等）が何個入っているか */
export function conditionTokenHits(sentence: string, tokens: ReadonlyArray<string>): number {
  const s = norm(sentence);
  return [...new Set(tokens.map(norm).filter((t) => t.length >= 2))].filter((t) => s.includes(t)).length;
}

/**
 * 下書きの文ごとに、設計図の行に当たるかを見る。当たらない文に印を付ける（印だけ）。
 *   当たり: その文に行の uses の値が入っている／文の段が行の役目に合う（1行は1文だけ受ける＝竹内さんより文が多ければ余りに印）
 *   印の種類: 条件の語4つ以上＝condition_repeat／行に無い物件名＝object_mismatch／潜在の語＝latent_no_material／事実の言い方＝fact_addition／他
 */
export function markUnmatchedSentences(
  draft: string,
  rows: ReadonlyArray<BlueprintRowLike> | null | undefined,
  o: { conditionTokens?: ReadonlyArray<string>; propertyNames?: ReadonlyArray<string> } = {},
): UnmatchedMark[] | null {
  if (!rows || rows.length === 0) return null; // 設計図が無い番は何も言わない（印を付けない）
  const used = rows.map(() => 0);
  const values = rows.map((r) => (r.uses ?? []).map((u) => norm(String(u.value ?? ""))).filter((v) => v.length >= 2));
  const rowObjects = new Set(values.flat());
  const out: UnmatchedMark[] = [];
  const hasLatentRow = rows.some((r) => r.role === "latent");
  const mark = (text: string, part: BlueprintPart, kind: UnmatchedKind) => out.push({ sentence: text.slice(0, 80), part, kind });
  let prevPromise = false;
  for (const { part, text } of partsOf(draft).sentences) {
    if (ALWAYS_OK.has(part)) { prevPromise = false; continue; }
    const s = norm(text);
    // 約束の文の続き「確認出来次第ご連絡させて頂きます」は前の約束と1組（竹内さんの2文1組の形）＝別の行を要らない
    if (prevPromise && CONFIRM_TAIL_RE.test(text)) { prevPromise = false; continue; }
    prevPromise = part === "promise";
    // 先に見る印（行の役目に合っても付ける）:
    //   潜在の語は、潜在の行が無い時だけ（作業員10 は潜在の材料が無い番に潜在の行を立てない＝12348）
    if (!hasLatentRow && LATENT_RE.test(text)) { mark(text, part, "latent_no_material"); continue; }
    //   行に無い物件名（対象の取り違え）
    const names = (o.propertyNames ?? []).map(norm).filter((n) => n.length >= 3 && s.includes(n));
    if (names.length && !names.some((n) => [...rowObjects].some((v) => v.includes(n) || n.includes(v)))) { mark(text, part, "object_mismatch"); continue; }
    //   条件の繰り返し（竹内さんは変わった点だけ・stand の no_full_repeat）。竹内さんの送信でもエリア＋家賃で3つは入る＝4つ以上
    const condHits = conditionTokenHits(text, o.conditionTokens ?? []);
    if (condHits >= CONDITION_REPEAT_MIN) { mark(text, part, "condition_repeat"); continue; }
    // ① 値で当たる行（物件名・金額・日時・事実の文字）→ ② 段が行の役目に合う、まだ使っていない行
    let hit = values.findIndex((vs, i) => used[i] < 1 && vs.some((v) => s.includes(v)));
    if (hit < 0) {
      const roles = ROLE_OF_PART[part] ?? [];
      hit = rows.findIndex((r, i) => used[i] < 1 && roles.includes(r.role));
    }
    if (hit >= 0) { used[hit]++; continue; }
    mark(text, part, FACT_ENDING_RE.test(text) ? "fact_addition" : "other");
  }
  return out;
}

/** 見張りの materials に入れる1行のログ（generate-reply が console.info で出す） */
export function blueprintMarkLog(conversationId: string | null | undefined, marks: ReadonlyArray<UnmatchedMark> | null, rows: number): Record<string, unknown> {
  return { tag: "fc:blueprint-unmatched", conversationId: conversationId ?? null, rows, n: marks?.length ?? null,
    kinds: (marks ?? []).map((m) => m.kind), heads: (marks ?? []).slice(0, 4).map((m) => m.sentence.slice(0, 30)) };
}

/** お客様の条件の文（DB の登録）から、繰り返しを数える語を取る（エリア・家賃・間取り・広さ・築年・徒歩） */
export function conditionTokensForMark(conditions: string | null | undefined): string[] {
  const t = String(conditions ?? "").normalize("NFKC");
  const out = new Set<string>();
  for (const m of t.matchAll(/[0-9.]+万(?:円)?|[0-9]+[SLDK]{1,4}|[0-9]+(?:㎡|m2|平米)|築[0-9]+年|徒歩[0-9]+分|[一-龯ァ-ヶー]{2,8}(?:区|市|駅|町)/g)) out.add(m[0]);
  return [...out].slice(0, 20);
}
