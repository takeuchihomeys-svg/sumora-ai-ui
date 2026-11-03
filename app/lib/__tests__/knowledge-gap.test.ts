// app/lib/__tests__/knowledge-gap.test.ts — 知識の穴の拾い出し（実物の本文で）
import { staffOnlyFactLines, isGapTurn, answeringStaffTexts, parseGapExtract, groupGapCandidates, factSimilarity, knownFactOf, gapChapterMarkdown, type GapTurnRow } from "../knowledge-gap";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const row = (draft: string, staff: string[], aix: string[] = []): GapTurnRow => ({ id: 1, conversation_id: "c", customer_turn_at: "2026-10-28T00:00:00Z", scene_key: null, draft_first: draft, staff_texts: staff.map((text) => ({ text, burst: true })), staff_aix: aix.map((a) => ({ aix_type: a })) });
// #8811 実物
t("下書きが確認の約束・実送信が答えた → 拾う", isGapTurn(row("かしこまりました！！\nルディシアコート205号室のペット飼育の可否と同性の方同士でのご入居が可能か、管理会社に確認させていただきます！！\n確認出来次第ご連絡させて頂きます！！", ["はい！！\nルディシアコートはペットの飼育も同性でのご友人の方同士でのお申込み、審査可能なお部屋となります！！\nお手隙の際にご確認ください！！"])));
// #670 実物（実送信も約束）
t("実送信も約束（確認してご連絡）→ 拾わない", !isGapTurn(row("はい😊！！\nエアコンの件、明日確認してご連絡させて頂きます😌！！", ["はい😊！！\nエアコンの件、明日確認してご連絡させて頂きます😌！！"])));
t("下書きがぼかしていない → 拾わない", !isGapTurn(row("ペット可のお部屋となります！！", ["ペット可のお部屋となります！！"])));
t("了承・お礼だけの実送信 → 拾わない", !isGapTurn(row("確認させて頂きます！！", ["かしこまりました！！何卒よろしくお願い致します😊！！"])));
t("答えた通だけ残す", answeringStaffTexts(row("確認させて頂きます", ["確認させて頂きます！！確認出来次第ご連絡させて頂きます！！", "契約期間が4年間となり、お部屋自体の更新料はございません！！"])).length === 1);
const p = parseGapExtract('前置き [{"n":1,"kind":"company","fact":"引越し業者の手配ができる","question":"引越し業者の手配ができるで合っていますか","building":null},{"n":2,"kind":"bad","fact":"x"}] 後');
t("JSON を読む・知らない種類は捨てる", p.size === 1 && p.get(1)?.kind === "company");
t("似方", factSimilarity("代理契約は郵送で来阪不要", "代理契約は書類を郵送で来阪不要") > 0.45);
const ev = (id: number, writer: string | null) => ({ turnId: id, conversationId: "c", at: `2026-10-2${id}T00:00:00Z`, scene: null, draftHead: "d", staffHead: "s", staffMsgId: `m${id}`, writer });
const g = groupGapCandidates([
  { ex: { n: 1, kind: "procedure", fact: "代理契約は郵送で来阪不要", question: "q", building: null }, ev: ev(1, "employee") },
  { ex: { n: 2, kind: "procedure", fact: "代理契約は書類を郵送で来阪不要", question: "q", building: null }, ev: ev(2, "takeuchi") },
  { ex: { n: 3, kind: "staff_only", fact: "募集中", question: "q", building: null }, ev: ev(3, "takeuchi") },
]);
t("似た候補は1つ・竹内さんの根拠があれば裏取り・スタッフだけは数えない", g.length === 1 && g[0].evidence.length === 2 && g[0].backedByTakeuchi, g);
t("既にある会社の事実に当たる", knownFactOf("申込から入居まで最短2週間程", [{ id: "procedure:lead", fact: "空室で即入居できるお部屋なら、お申込から最短で2週間程がご入居の目安。" }]) === "procedure:lead");
t("無い事実は当たらない", knownFactOf("引越し業者の手配ができる", [{ id: "procedure:lead", fact: "空室で即入居できるお部屋なら、お申込から最短で2週間程がご入居の目安。" }]) === null);
const md = gapChapterMarkdown({ generatedAt: "x", days: 30, counts: { turns: 10, vague: 3, picked: 2, byKind: { procedure: 2 }, knowledge: 1, backed: 1, ask: 0, known: 0, property: 0 }, candidates: g, rows: [] });
t("章の見出しと根拠の id", md.startsWith("## 知識の弱さ（B の候補）") && md.includes("m2"), md);
t("網③: 実送信だけの事実の文（引越し業者の手配）", staffOnlyFactLines("本日はお時間頂きありがとうございました！！\n引越し業者につきましては弊社でご案内可能か確認させて頂きます！！", "本日はお時間頂きありがとうございました！！\n引越し業者の手配もさせて頂きます！！").length === 1);
t("網③: 下書きと同じ文・お手隙の文は数えない", staffOnlyFactLines("こちら募集中となります！！", "こちら募集中となります！！\nお手隙の際にご査収ください！！").length === 0);
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
