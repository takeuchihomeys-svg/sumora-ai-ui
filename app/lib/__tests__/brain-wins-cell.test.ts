// セルの必須要素とブレインの避ける話題がぶつかった時、**ブレインが勝つ**（竹内 2026-09-21）。
//
// 竹内「ブレインが勝つようにする」
//
// ■ 何が本当の穴だったか
//   旧実装は `avoidConflictsWithCell` で **brain の avoid を削って**セルの必須要素を通していた。
//   ＝ ブレインが「今回は費用の話をしない」と決めても、その判断が**プロンプトから消えていた**。
//   実物（会話 d99ab7e6）: ブレイン「家賃4万の新条件で探し直す／見積書・初期費用は避ける」
//     × セル PD_CONDITION_CHANGE の必須「初期費用も最大限割引させて頂き…」
//
// ■ 実測で「要素ごと落とす」は行き過ぎと分かった
//   scripts/audit-brain-wins-cell.ts（直近60日・スナップショット912件）:
//     落とした必須要素 23個のうち **22個（95.7%）はスタッフが実送信で書いていた**
//       estimate 11/11(100%) ／ new_pickup 10/10(100%) ／ viewing 1/2(50%)
//   理由: ①estimate は 2026-09-14 くれあ事例で竹内さんが「必須要素を優先」と決めた物
//        ②new_pickup の要素は「随時ピックアップ宣言 **or** 扉を開ける1文」で逃げ道が要素の中にある
//
// ■ だから既定は "annotate"
//   avoid は削らない（ブレインの判断がプロンプトに残る＝ブレインが勝つ）。
//   要素は落とさず、**その要素の行に**「この話題に触れない形で書く」を添えて1か所で解決する
//   （設計知見「禁止と必須が同じ語を扱う時は、禁止を並べ合うのではなくトークン1つに寄せる」）。
//   BRAIN_WINS_CELL=drop で要素ごと落とす形／=off で旧動作。
//
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/brain-wins-cell.test.ts
import { resolveMustInclude, brainWinsCell, type PairContext, type BrainConversationScope } from "../reply-context";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
  };
}

const COST_ELEMENT = "初期費用を抑える宣言「初期費用も最大限割引させて頂き{name}のお引越しにかかる費用を出来る限り抑えさせて頂きます！！」（お客様が初期費用を抑えたい／物件が決まる前に費用を聞いた。見積書・金額は書かない）";
const PICKUP_ELEMENT = "随時ピックアップ宣言 or 扉を開ける1文";

function makePair(labels: string[], opts: { preferWhenAvoid?: boolean } = {}): PairContext {
  return {
    rule: {
      id: "TEST_CELL", direction: "", tpoLabel: "", mustNot: [],
      mustInclude: labels.map((label) => ({
        label,
        ...(opts.preferWhenAvoid ? { preferWhenAvoid: [{ avoid: /見積/, use: "金額は書かずに費用を抑える方向だけ伝える" }] } : {}),
      })),
    },
  } as unknown as PairContext;
}
const strategy = (avoid: string[]): BrainConversationScope =>
  ({ avoid_topics: avoid, engagement_stance: null } as unknown as BrainConversationScope);

describe("★ 既定（annotate）: 要素は落とさず、その行で解決する", () => {
  it("★ A1 必須要素は残る（実測95.7%でスタッフは書いている）", () => {
    const r = resolveMustInclude(makePair([COST_ELEMENT]), { strategy: strategy(["見積書"]), brainFresh: true, mode: "annotate" });
    expect(r.active.length).toBe(1);
    expect(r.dropped.length).toBe(0);
  });
  it("★ A2 その要素の行に「この話題に触れない形で書く」が付く", () => {
    const r = resolveMustInclude(makePair([COST_ELEMENT]), { strategy: strategy(["見積書"]), brainFresh: true, mode: "annotate" });
    expect(r.active[0].avoidNote ?? "").toContain("ブレインの判断");
    expect(r.active[0].avoidNote ?? "").toContain("見積書");
    expect(r.active[0].avoidNote ?? "").toContain("触れない");
  });
  it("★ A3 「or」の逃げ道がある要素は、そちらを使えと書く（new_pickup の実物）", () => {
    const r = resolveMustInclude(makePair([PICKUP_ELEMENT]), { strategy: strategy(["新規物件ピックアップ"]), brainFresh: true, mode: "annotate" });
    expect(r.active.length).toBe(1);
    expect(r.active[0].avoidNote ?? "").toContain("or");
  });
  it("★ A4 ぶつからない要素には注記を付けない（余計な指示を増やさない）", () => {
    const r = resolveMustInclude(makePair(["受け止め1文", COST_ELEMENT]), { strategy: strategy(["見積書"]), brainFresh: true, mode: "annotate" });
    expect(r.active.length).toBe(2);
    expect(r.active[0].avoidNote === undefined).toBe(true);
    expect((r.active[1].avoidNote ?? "").length > 0).toBe(true);
  });
});

describe("drop（要素ごと落とす・選択式）", () => {
  it("★ D1 drop なら落とす", () => {
    const r = resolveMustInclude(makePair([COST_ELEMENT]), { strategy: strategy(["見積書"]), brainFresh: true, mode: "drop" });
    expect(r.active.length).toBe(0);
    expect(r.dropped[0].cls).toBe("estimate");
  });
  it("★ D2 落とした事実を返す（黙って消さない）", () => {
    const r = resolveMustInclude(makePair([PICKUP_ELEMENT]), { strategy: strategy(["新規物件ピックアップ"]), brainFresh: true, mode: "drop" });
    expect(r.dropped[0].avoid).toBe("新規物件ピックアップ");
    expect(r.dropped[0].cls).toBe("new_pickup");
  });
});

describe("触らない場合", () => {
  it("★ N1 ブレインの判断が古い（brainFresh=false）なら触らない", () => {
    const r = resolveMustInclude(makePair([COST_ELEMENT]), { strategy: strategy(["見積書"]), brainFresh: false, mode: "annotate" });
    expect(r.active[0].avoidNote === undefined).toBe(true);
  });
  it("★ N2 避ける話題が無ければ触らない", () => {
    const r = resolveMustInclude(makePair([COST_ELEMENT]), { strategy: strategy([]), brainFresh: true, mode: "annotate" });
    expect(r.active[0].avoidNote === undefined).toBe(true);
  });
  it("★ N3 セルに「避ける時の言い換え」が既にあれば触らない（セルがブレインに合わせてある）", () => {
    const r = resolveMustInclude(makePair(["御見積書とあわせてご連絡"], { preferWhenAvoid: true }), { strategy: strategy(["見積書"]), brainFresh: true, mode: "annotate" });
    expect(r.active[0].avoidNote === undefined).toBe(true);
  });
  it("★ N4 off なら今までどおり（注記も落としもしない）", () => {
    const r = resolveMustInclude(makePair([COST_ELEMENT]), { strategy: strategy(["見積書"]), brainFresh: true, mode: "off" });
    expect(r.active.length).toBe(1);
    expect(r.active[0].avoidNote === undefined).toBe(true);
  });
  it("N5 セルが無ければ空", () => {
    expect(resolveMustInclude({} as PairContext, { strategy: strategy(["見積書"]) }).active.length).toBe(0);
  });
});

describe("スイッチ", () => {
  it("★ S1 既定は annotate（要素を落とさない側）", () => {
    expect(brainWinsCell({})).toBe("annotate");
  });
  it("★ S2 drop / off に切り替えられる", () => {
    expect(brainWinsCell({ BRAIN_WINS_CELL: "drop" })).toBe("drop");
    expect(brainWinsCell({ BRAIN_WINS_CELL: "off" })).toBe("off");
    expect(brainWinsCell({ BRAIN_WINS_CELL: " OFF " })).toBe("off");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
