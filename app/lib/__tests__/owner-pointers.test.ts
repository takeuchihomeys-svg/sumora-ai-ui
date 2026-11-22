// app/lib/__tests__/owner-pointers.test.ts — 竹内さんの指摘の帳面の分け方（2026-11-21 作業員N・台帳 #472）
//   実行: npx tsx app/lib/__tests__/owner-pointers.test.ts
import { pointerExamVerdict } from "../owner-pointers-server";
import { pointerKindsOf, pointerAreasOf, canAdvance, pointerFromWorkItem, POINTER_KINDS } from "../owner-pointers";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

// 竹内さんの実際の言葉（台帳の引用）
t("画像の読み取り＝読めていない", pointerKindsOf("なんでこれよみとれていないのか？重要なのは、お客さんが反応した画像")[0] === "unread");
t("統括→文生成の連携＝連携が切れている", pointerKindsOf("統括→文生成の連携を細かく（統括が渡した欄が書き手に届き）")[0] === "link_broken");
t("土台を具体的に＝細分化（主）", pointerKindsOf("土台の部分もちゃんと具体的にするように細かく")[0] === "not_subdivided");
t("試験の効率＝試験", pointerKindsOf("試験いまもっと効率よく出来る方法はあるのか").includes("exam"));
t("LINE が重い＝故障", pointerKindsOf("またLINEと繋がりにくかったり重いときがある 原因見つけて改善する").includes("outage"));
t("当たらなければ other", pointerKindsOf("Aでおねがい")[0] === "other");
t("足りていない土台＝土台が無い", pointerKindsOf("この仕組み化に足りていない土台があれば設立する")[0] === "no_foundation" && pointerKindsOf("土台の部分もちゃんと具体的に")[0] === "not_subdivided");
t("built_off の行は off のままを足す", pointerKindsOf("Aでおねがい", { builtOff: true }).includes("left_off"));
t("型の名前は表の CHECK と同じ", pointerKindsOf("画像 連携 細分化 物差し 決まり 既定 off 把握 試験 拾い上げ 重い 材料").every((k) => (POINTER_KINDS as readonly string[]).includes(k)));

t("分野: 2通目と AIX", pointerAreasOf("2通目の訴求の細かいずれ").includes("aix2"));
t("分野: 画像", pointerAreasOf("画像から物件名も把握する").includes("image"));
t("分野: 無ければ other", pointerAreasOf("Aでおねがい")[0] === "other");
t("分野: 拡張・統括Pro は search", pointerAreasOf("統括Proが脳として弱点をすぐ把握")[0] === "search" && pointerAreasOf("自動モードの録画で弱い所")[0] === "search");

t("状態は前にだけ進む", canAdvance("received", "checked") && !canAdvance("on", "fixing") && canAdvance("exam_passed", "closed"));

const p = pointerFromWorkItem({ id: 461, title: "画像: お客様が反応したこちらの画像は必ず読む", requested_quote: "なんでこれよみとれていないのか？", requested_at: "2026-11-21T01:00:00Z", created_at: "2026-11-21T01:00:00Z", stage: "todo", kb_ids: ["abcdef1234"] });
t("台帳の行から: 言葉・型・状態・つなぎ", p.quote.startsWith("なんでこれ") && p.kinds[0] === "unread" && p.state === "received" && p.work_item_ids[0] === 461 && p.kb_ids[0] === "abcdef12" && p.source_ref === "461");
t("台帳 done は ready・dropped は closed", pointerFromWorkItem({ id: 1, title: "x", requested_quote: null, requested_at: null, created_at: "2026-11-11T00:00:00Z", stage: "done" }).state === "ready"
  && pointerFromWorkItem({ id: 2, title: "x", requested_quote: null, requested_at: null, created_at: "2026-11-11T00:00:00Z", stage: "dropped" }).state === "closed");
// 試験の係との受け口（H と決めた: その行の qids だけで見る・揺れだけは進めない）
t("全部比べて悪化なし＝進める", pointerExamVerdict(["q441", "q442"], { compared: ["q441", "q442", "q057"], worseSure: ["q057"], flaky: [] }) === "advance");
t("確かな悪化＝worse", pointerExamVerdict(["q441"], { compared: ["q441"], worseSure: ["q441"], flaky: [] }) === "worse");
t("比べていない qid＝incomplete", pointerExamVerdict(["q441", "q999"], { compared: ["q441"], worseSure: [], flaky: [] }) === "incomplete");
t("揺れだけ＝flaky（進めない）", pointerExamVerdict(["q441"], { compared: ["q441"], worseSure: [], flaky: ["q441"] }) === "flaky");
t("qids が空＝incomplete", pointerExamVerdict([], { compared: [], worseSure: [], flaky: [] }) === "incomplete");
t("引用が無い時は題を言葉の代わりに", pointerFromWorkItem({ id: 3, title: "時系列の把握", requested_quote: null, requested_at: null, created_at: "2026-11-15T00:00:00Z", stage: "building" }).quote === "時系列の把握");

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
