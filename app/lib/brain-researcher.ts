// app/lib/brain-researcher.ts（純関数・DB/LLM なし）— DeepSeek の「調べる係」の決まり
//
// 2026-10-16 竹内悠馬「決まった処理で拾えない物（『さっきの部屋』『前に言ってた条件』等）を、DeepSeek が何を調べるか決めて DB から取ってくる。
//   取ってきた材料はまとめ直さずそのまま Claude（判断する係）へ」（DeepSeek は要約で数字を19〜34%落とす＝設計知見）。
//   - DeepSeek に渡すのはお客様の今の連投の文だけ（伏せた物・300字まで）。会話の履歴・申込以降・本人確認書類・個人の値は渡さない（alt-pii-gate・deepseek cutoff）。
//   - DeepSeek が決めるのは「どの記録を・どの語で調べるか」だけ（最大3件）。記録を読むのはコード（読むだけ）。材料は記録の行そのまま。
//   - DeepSeek が止まった・読めない時は飛ばす（判断はいつも通り）。
//   戻す: BRAIN_RESEARCHER=off（既定 off・試験で実送信に近づいた時だけ on にする）

export function brainResearcherEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.BRAIN_RESEARCHER ?? "off").trim().toLowerCase() === "on";
}

/** 決まった処理（引用・名指し・台帳の推定）で拾えない「前の物を指す」言い方 */
export const VAGUE_REF_RE = /さっき(?:の|送|言|教)|先ほど(?:の|送|言|教)|先程(?:の|送|言|教)|前に(?:言|送|話|聞|教|見)|以前(?:に)?(?:言|送|話|聞|教|見|の)|前回(?:の|言|送)|この前(?:の|言|送)|あの(?:物件|部屋|お部屋|マンション)|最初(?:の|に)(?:物件|部屋|お部屋|送)|前の(?:物件|部屋|お部屋|条件|方)|言って(?:た|いた)|話して(?:た|いた)|教えて(?:もらっ|いただい|頂い)た|送って(?:もらっ|いただい|頂い)た(?:物件|部屋|お部屋|やつ|の)/;

export function researcherTrigger(i: { customerText: string; postApply: boolean; propertyResolved: boolean }): { run: boolean; reason: string } {
  if (i.postApply) return { run: false, reason: "post_apply" };
  const t = String(i.customerText ?? "");
  if (!VAGUE_REF_RE.test(t)) return { run: false, reason: "no_vague_ref" };
  // 台帳が今の番の物件を1件に決めた時は要らない（条件の話は物件が決まっていても調べる）
  if (i.propertyResolved && !/条件|希望|言って|話して/.test(t)) return { run: false, reason: "resolved" };
  return { run: true, reason: "vague_ref" };
}

export const RESEARCH_KINDS = ["sent_properties", "customer_shared", "past_lines", "conditions", "viewings", "estimates"] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];
export type ResearchLookup = { kind: ResearchKind; query: string };

/** DeepSeek の前置き（固定＝前置きキャッシュ）。お客様の文は user に */
export const RESEARCHER_SYSTEM = `あなたは賃貸仲介の会話の「調べる係」です。お客様の発言の中の「さっきの部屋」「前に言ってた条件」「あの物件」等が何を指すかを確かめるために、どの記録を調べるかだけを決めます。答え・推測・要約は書きません。
調べられる記録（kind）:
- sent_properties: こちらが送った物件（新しい順・物件名・号室・送った日時・家賃・募集状況）
- customer_shared: お客様が送ってきた物件（URL・画面の物件名）
- past_lines: 過去の会話の行（query の語を含む行）
- conditions: 希望条件の変更の記録（項目・前の値・変えた日時）
- viewings: 内覧の予定・記録
- estimates: 送った御見積書（物件名・初期費用）
JSON だけを返す: {"lookups":[{"kind":"上のどれか","query":"past_lines の時だけ探す語（物件名の一部・設備・条件の語）。他は空"}]}
最大3件。指す物が分からない時ほど広く（sent_properties と customer_shared の両方）。関係ない記録は選ばない。`;

export function buildResearcherUser(maskedCustomerText: string): string {
  return `お客様の今の発言:\n${Array.from(String(maskedCustomerText ?? "")).slice(0, 300).join("")}`;
}

export function parseResearcherOutput(text: string): ResearchLookup[] | null {
  const fb = text.indexOf("{"), lb = text.lastIndexOf("}");
  if (fb < 0 || lb <= fb) return null;
  try {
    const j = JSON.parse(text.slice(fb, lb + 1)) as { lookups?: Array<{ kind?: unknown; query?: unknown }> };
    if (!Array.isArray(j.lookups)) return null;
    const out: ResearchLookup[] = [];
    for (const l of j.lookups) {
      const kind = String(l?.kind ?? "") as ResearchKind;
      if (!(RESEARCH_KINDS as readonly string[]).includes(kind)) continue;
      const query = Array.from(String(l?.query ?? "").replace(/[\r\n]/g, " ").trim()).slice(0, 20).join("");
      if (out.some((o) => o.kind === kind && o.query === query)) continue;
      out.push({ kind, query });
      if (out.length >= 3) break;
    }
    return out;
  } catch { return null; }
}

/** ブレインに渡す材料（記録の行そのまま・まとめ直さない） */
export function researcherBlock(i: { customerText: string; results: Array<{ kind: ResearchKind; query: string; lines: string[] }> }): string {
  const KJ: Record<ResearchKind, string> = { sent_properties: "こちらが送った物件", customer_shared: "お客様が送ってきた物件", past_lines: "過去の会話の行", conditions: "希望条件の変更", viewings: "内覧", estimates: "送った御見積書" };
  const body = i.results.filter((r) => r.lines.length).map((r) => `■${KJ[r.kind]}${r.query ? `（「${r.query}」）` : ""}\n${r.lines.join("\n")}`);
  if (!body.length) return "";
  return `【調べる係が取ってきた記録（お客様の「${Array.from(i.customerText.replace(/\s+/g, " ")).slice(0, 40).join("")}」が指す物の候補・まとめ直していない記録そのまま）】
※どれを指すかはあなた（判断する係）が会話と合わせて決める。決まらない時は勝手に1件に決めず確かめる。
${body.join("\n")}`;
}
