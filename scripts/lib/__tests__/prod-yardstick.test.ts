// 本番の記録の物差し（scripts/lib/prod-yardstick.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/prod-yardstick.test.ts（全 PASS で exit 0）
import { judgeTurn, countByScene, sceneDrift, problemsForDrift, beyondCandidates, wilson, modelSplitTable, type YardTurn } from "../prod-yardstick";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

const T = (scene: string, brain: string, staff: string, extra: Partial<YardTurn> = {}): YardTurn => ({ scene, brain, staff, writer: "takeuchi", at: "2026-11-01T00:00:00Z", ...extra });

ok("一手: 同じ系統→当たり", judgeTurn(T("s", "見積", "見積")) === "hit");
ok("一手: 違う→外れ", judgeTurn(T("s", "返信", "見積")) === "miss");
ok("一手: 違うが原則で良い→超えた候補（外れにしない・11/05 竹内さん）", judgeTurn(T("s", "返信", "見積", { principleOk: true })) === "beyond");

{
  const m = countByScene([T("a", "x", "x"), T("a", "x", "y"), T("a", "x", "x", { writer: "staff2" })]);
  ok("数え: 既定は竹内さんの番だけ", m.get("a")!.n === 2 && m.get("a")!.hit === 1);
  const m2 = countByScene([T("a", "x", "x", { writer: "staff2" })], { writers: ["staff2"] });
  ok("数え: 書き手を選べる", m2.get("a")!.n === 1);
}
{
  const w = wilson(9, 10); ok("Wilson: 幅は0〜1で p を含む", w.lo > 0.5 && w.hi <= 1 && w.lo < 0.9 && w.hi > 0.9);
}
{
  const rep = (n: number, s: string, hit: boolean) => Array.from({ length: n }, () => T(s, "x", hit ? "x" : "y"));
  const before = countByScene([...rep(18, "見積", true), ...rep(2, "見積", false), ...rep(3, "内覧", true)]);
  const after = countByScene([...rep(4, "見積", true), ...rep(16, "見積", false), ...rep(3, "内覧", false)]);
  const d = sceneDrift(before, after);
  const mitsu = d.find((x) => x.scene === "見積")!, nai = d.find((x) => x.scene === "内覧")!;
  ok("比べ: はっきり下がった", mitsu.verdict === "down", JSON.stringify(mitsu));
  ok("比べ: 少ない場面は待つ", nai.verdict === "few");
  ok("比べ: 下がった場面が先頭", d[0].scene === "見積");
  const ids = problemsForDrift(d, new Map([["見積", ["q010", "q011"]], ["内覧", ["q020"]]]), ["q024"]);
  ok("問題: 下がった場面だけ＋回帰の必須", ids.sort().join(",") === "q010,q011,q024");
}
{
  const before = countByScene(Array.from({ length: 20 }, () => T("見積", "x", "x")));
  const after = countByScene(Array.from({ length: 20 }, () => T("見積", "返信", "x", { principleOk: true })));
  ok("比べ: 超えた候補は下がりに数えない", sceneDrift(before, after)[0].verdict !== "down");
  ok("候補の一覧", beyondCandidates(Array.from({ length: 3 }, () => T("見積", "返信", "x", { principleOk: true }))).length === 3);
}

{
  const t = modelSplitTable([{ scene: "見積", claude: "見積", deepseek: "見積" }, { scene: "見積", claude: "見積", deepseek: "返信" }, { scene: null, claude: "x", deepseek: "x" }]);
  ok("割れの表: 場面ごとの一致率", t.get("見積")!.rate === 0.5 && t.get("（場面なし）")!.rate === 1);
}

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
