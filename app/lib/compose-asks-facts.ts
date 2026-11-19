// app/lib/compose-asks-facts.ts — ブレインの依頼ごとの答えと、記録の値（見積の金額・内覧の日時）を文の統括の設計図の「事実」の欄へ渡す（COMPOSE_ASKS_FACTS・既定 off・純関数）
//   作業員10・2026-11-12 統括役（作業員1 の材料の抜けの台帳 6415f992: 文の事実が届いていない56件のうち c＝連携の切れ目 34件。
//     正解53 の28件はすべて、ブレインは turn_contract.asks に答え（answer・basis）を書いているのに設計図の事実の欄が空だった。
//     作業員1 の数えで c の中身は 内覧の日時 14・金額 8・入居時期 5）
//   決まり: 道（返信か AIX か・答えか約束か）が決まった後の値を写すだけ。決め直さない（REDECIDE_RULES）。
//     route=aix の依頼は事実に入れない（スタッフの番）。route=promise は「約束の中身」として入れる（結果は書かない）。
//     記録の値は値のまま（見積の金額・内覧の日時）。文は写さない。

type Env = Record<string, string | undefined>;
export function composeAsksFactsOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPOSE_ASKS_FACTS ?? "").trim().toLowerCase() === "on";
}
export type ComposeFact = { id: string; text: string; from: "会話" | "資料" | "会社の事実" | "一般" | "判断" | "約束の中身" | "見積の記録" | "内覧の記録"; quote?: string | null };
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, n = 60): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const BASIS_FROM: Record<string, ComposeFact["from"]> = { conversation: "会話", material: "資料", company_fact: "会社の事実", general: "一般", judgement: "判断" };

/** ブレインの依頼ごとの答え（turn_contract.asks）→ 事実。道が aix・none の依頼は入れない */
export function asksFactsOf(meta: unknown): ComposeFact[] {
  const tc = obj(obj(meta)?.turn_contract);
  const asks = Array.isArray(tc?.asks) ? (tc!.asks as unknown[]).map(obj).filter((a): a is Record<string, unknown> => !!a) : [];
  const out: ComposeFact[] = [];
  asks.forEach((a, k) => {
    const ans = str(a.answer, 80);
    if (!ans || a.route === "aix" || a.route === "none") return;
    out.push({ id: `f${k + 1}`, text: ans, from: a.route === "promise" ? "約束の中身" : BASIS_FROM[String(a.basis)] ?? "会話", quote: str(a.quote, 30) });
  });
  return out;
}
export type EstimateRec = { property_name?: string | null; room_no?: string | null; initial_cost_yen?: number | null; discount_yen?: number | null; created_at?: string | null };
export type ViewingRec = { dateMD: string | null; time: string | null; place?: string | null; day?: string | null } | null;
const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const md = (iso: string | null | undefined) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : null);
/** 記録の値（見積の金額・内覧の日時）→ 事実。値のまま（文は作らない） */
export function recordFactsOf(o: { estimates?: ReadonlyArray<EstimateRec>; viewing?: ViewingRec }): ComposeFact[] {
  const out: ComposeFact[] = [];
  (o.estimates ?? []).slice(0, 3).forEach((e, k) => {
    const name = [str(e.property_name, 30), e.room_no ? `${e.room_no}号室` : null].filter(Boolean).join(" ");
    const vals = [typeof e.initial_cost_yen === "number" && e.initial_cost_yen > 0 ? `初期費用 ${yen(e.initial_cost_yen)}` : null, typeof e.discount_yen === "number" && e.discount_yen > 0 ? `割引 ${yen(e.discount_yen)}` : null].filter(Boolean);
    if (vals.length) out.push({ id: `e${k + 1}`, text: `${name || "物件"}の御見積書: ${vals.join("・")}${md(e.created_at) ? `（${md(e.created_at)} 送付）` : ""}`, from: "見積の記録" });
  });
  const v = o.viewing;
  if (v && (v.dateMD || v.time)) out.push({ id: "v1", text: `決まっている内覧: ${[v.dateMD, v.time, v.place].filter(Boolean).join(" ")}`, from: "内覧の記録" });
  return out;
}
export function composeFactsNote(facts: ReadonlyArray<ComposeFact>, env?: Env): string {
  if (!composeAsksFactsOn(env) || !facts.length) return "";
  return `- 使う事実（ブレインの依頼ごとの答え・記録の値・出所つき・これ以外の値は書かない）:\n${facts.map((f) => `  ・${f.quote ? `「${f.quote}」→ ` : ""}${f.text}（${f.from}）`).join("\n")}`;
}
