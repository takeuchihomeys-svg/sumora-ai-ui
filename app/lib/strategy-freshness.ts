// app/lib/strategy-freshness.ts — 戦略の層（closing_strategy＝cs）の古い所に印を付ける（純関数・作業員5・11/13）
//
// 統括役（点検役の「会話の流れの読み」・主と従と鮮度・S1・S10）: cs が、お客様が外した物件・済んだ確認・今の番の対象と違う物件を指したまま
//   ブレインの材料に入り、今の番の読みを引っぱっていた。
//   ・12196: 「プレサンス立売堀アーバンスタイルの募集状況と法人契約を確認」→ お客様は「場所的にちょっと高い」と外した後も cs に残った
//   ・11865: 「お送り頂いた物件の募集状況を確認し…ご連絡」→ こちらは「現在募集に出ていないお部屋」と結果を送った後も cs に残った
//   ・13898: 別の物件へ移った番（下の moved。cs の物件と、今のお客様の連投が名指す物件が違う）
// 印の種類（約束を閉じる種類）: excluded（外した）・answered（答え済み＝結果を送った）・moved（別の物件へ移った）
// 切替: CONDUCTOR_TOPIC_STATE=on（既定 off）。決めるのはブレイン（印の付いた所を読みに使わない・材料の1行だけ）

type Env = Record<string, string | undefined>;
export const topicStateOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_TOPIC_STATE ?? "").trim().toLowerCase() === "on";

export type FreshMsg = { sender: string; text: string | null | undefined; created_at: string };
export type StaleMark = { kind: "excluded" | "answered" | "moved"; name: string | null; at: string };

const norm = (s: string) => s.normalize("NFKC").replace(/[\s　・･]+/g, "").toLowerCase();
/** 物件の名前を外した・要らないと言った（同じ通に名前と一緒に） */
const EXCLUDE_RE = /高い|高すぎ|微妙|ちょっと(?:気に|遠|狭|古)|やめ|外して|無しで|なしで|結構です|見送|候補から|ナシ|厳しい|合わない/;
/** こちらが確認・調べの結果を送った（募集の有無・審査中・見積） */
const REPORT_RE = /募集中(?:となり|となって|です)|募集(?:が|を)?終了|募集に出ていない|現在募集されて(?:おり|いない)|お申込み?が入って|審査中|御見積書となります|確認(?:させて頂き|致し)ましたところ/;
/** cs が確認・調べの約束を持っている */
const CS_CHECK_RE = /確認(?:し|して|出来次第|でき次第|を)|調べ|ご連絡/;

/** cs の古い所の印（前の戦略の時刻より後の通だけを見る・新しい順は問わない） */
export function staleStrategyMarks(o: { cs: string | null | undefined; csAt: string | null | undefined; messages: ReadonlyArray<FreshMsg>; knownNames: ReadonlyArray<string> }): StaleMark[] {
  const cs = String(o.cs ?? "");
  if (!cs.trim()) return [];
  const since = o.csAt ? Date.parse(o.csAt) : -Infinity;
  const after = o.messages.filter((m) => Date.parse(m.created_at) >= since && (m.text ?? "").trim());
  const ncs = norm(cs);
  const names = [...new Set(o.knownNames.map((n) => n.trim()).filter((n) => n.length >= 3))];
  const inCs = names.filter((n) => ncs.includes(norm(n)) || ncs.includes(norm(n).slice(0, 6)));
  const marks: StaleMark[] = [];
  // excluded: お客様が cs の物件を名指しで外した
  for (const m of after) {
    if (m.sender !== "customer") continue;
    const t = norm(m.text ?? "");
    for (const n of inCs) if ((t.includes(norm(n)) || t.includes(norm(n).slice(0, 6))) && EXCLUDE_RE.test(m.text ?? "")) marks.push({ kind: "excluded", name: n, at: m.created_at });
  }
  // answered: cs が確認の約束を持ち、その後にこちらが結果を送った
  if (CS_CHECK_RE.test(cs)) {
    const rep = after.find((m) => m.sender !== "customer" && REPORT_RE.test(m.text ?? ""));
    if (rep) marks.push({ kind: "answered", name: inCs.find((n) => norm(rep.text ?? "").includes(norm(n).slice(0, 6))) ?? null, at: rep.created_at });
  }
  // moved: 今のお客様の連投が名指すのは cs に無い物件だけ（cs は物件を名指している）
  let i = o.messages.length - 1; while (i >= 0 && o.messages[i].sender === "customer") i--;
  const burst = o.messages.slice(i + 1).filter((m) => m.sender === "customer");
  const burstNames = names.filter((n) => burst.some((m) => norm(m.text ?? "").includes(norm(n)) || norm(m.text ?? "").includes(norm(n).slice(0, 6))));
  if (inCs.length && burstNames.length && burstNames.every((n) => !inCs.includes(n))) marks.push({ kind: "moved", name: burstNames[0], at: burst[burst.length - 1]?.created_at ?? "" });
  const seen = new Set<string>();
  return marks.filter((m) => { const k = `${m.kind}|${m.name ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const KIND_JA: Record<StaleMark["kind"], string> = { excluded: "お客様が外した", answered: "こちらが結果を送って済んだ", moved: "お客様は別の物件の話に移った" };
/** ブレインの材料の1行（印が無ければ ""） */
export function staleStrategyLine(marks: ReadonlyArray<StaleMark>): string {
  if (!marks.length) return "";
  return `【前回の全体分析の古い所（読みに使わない）】${marks.map((m) => `${m.name ? `「${m.name}」` : "確認の約束"}は${KIND_JA[m.kind]}`).join("・")}。前回の全体分析（closing_strategy・next_steps）のその部分を今の番の方針にしない（今の番のお客様の言葉を先に読む）`;
}
