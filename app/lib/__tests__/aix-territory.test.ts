// AIX の担当がブレインの戦略文に混ざった時、同じ行に線を添えられるか。
//
// 2026-09-20 竹内「AIX から返信する部分は AIX からスタッフが送るから大丈夫／②や⑤の部分等は AIX から」
//   YUMA で ③（内覧希望）が再発した時の**実物の brain_meta** をそのままテストに使う（想像で作らない）。
//
// 実行: npx tsx app/lib/__tests__/aix-territory.test.ts（全 PASS で exit 0）
import { detectAixTerritory, buildAixTerritoryGuard, AIX_TERRITORY } from "../aix-territory";
import { AIX_ACTION_REPLY_DIRECTION } from "../aix-taxonomy";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (Array.isArray(actual) ? !actual.includes(item) : typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    not: { toContain(item: unknown) { if (Array.isArray(actual) ? actual.includes(item) : typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`); } },
  };
}

// ── YUMA の実物（2026-09-20 の conversations.suggested_aix_meta）──
const YUMA_WP = "直近の複数内覧候補日時を提示し、当日確定後は物件名・号室・待ち合わせ場所・住所を復唱して内覧を確実に実施させる";
const YUMA_CS = "内覧希望を頂いたので直近の複数候補日時を提示し、内覧完了から申込への流れをつくらせて頂きます。";
const YUMA_STEPS = [
  "Step1（今すぐ）: カレンダーで直近の空き時間を複数確認する",
  "Step2: AIXボタンviewing_inviteを押す",
  "Step3: 【AIX】内覧候補日時をそのまま送る（曜日誤記なく複数枠を並列提示）",
];

describe("YUMA ③再発の実物", () => {
  it("A1 winning_pattern の「候補日時を提示」を AIX【内覧日調整】の担当と見抜く", () => {
    const hits = detectAixTerritory(YUMA_WP);
    expect(hits.map((h) => h.aix)).toContain("viewing_invite");
  });

  it("A2 winning_pattern の「待ち合わせ場所・住所を復唱」を AIX【待ち合わせ】の担当と見抜く", () => {
    const hits = detectAixTerritory(YUMA_WP);
    expect(hits.map((h) => h.aix)).toContain("meeting_place");
  });

  it("A3 closing_strategy の「直近の複数候補日時を提示し」も見抜く", () => {
    expect(detectAixTerritory(YUMA_CS).map((h) => h.aix)).toContain("viewing_invite");
  });

  it("★ A4 戦略に添える注記が出る（本文に書かないと同じ行で言う）", () => {
    const guard = buildAixTerritoryGuard([YUMA_WP, YUMA_CS]);
    expect(guard.length > 0).toBe(true);
    expect(guard).toContain("今回の本文には書かない");
    expect(guard).toContain("内覧日調整");
  });

  it("A5 注記には AIX 側の forbid をそのまま載せる（禁止の出所を1つにする）", () => {
    const guard = buildAixTerritoryGuard([YUMA_WP]);
    expect(guard).toContain(AIX_ACTION_REPLY_DIRECTION.viewing_invite.forbid);
  });

  it("A6 next_steps の「【AIX】内覧候補日時をそのまま送る」も担当として拾う", () => {
    expect(buildAixTerritoryGuard(YUMA_STEPS)).toContain("内覧日調整");
  });
});

describe("当てすぎない（普通の戦略文は素通し）", () => {
  const OK = [
    "お客様のご条件に合うお部屋をピックアップしてお送りし、反応を見て内覧へ繋げる",
    "見積書をお送りして初期費用の不安を解消する",
    "条件ヒアリングを進めて希望を具体化する",
    "お客様の懸念に事実で answering し、別物件を提案する",
    "内覧のご案内をして申込へ繋げる",
  ];
  for (const [i, s] of OK.entries()) {
    it(`B${i + 1} 「${s.slice(0, 22)}…」には何も足さない`, () => {
      expect(buildAixTerritoryGuard([s])).toBe("");
    });
  }
  it("B6 何も無ければ空文字（注記を無条件に出さない）", () => {
    expect(buildAixTerritoryGuard([null, undefined, ""])).toBe("");
  });
});

describe("定数の自己整合", () => {
  it("C1 AIX_TERRITORY の aix は全て AIX_ACTION_REPLY_DIRECTION に実在する", () => {
    const unknownAix = AIX_TERRITORY.filter((t) => !AIX_ACTION_REPLY_DIRECTION[t.aix]).map((t) => t.aix);
    expect(JSON.stringify(unknownAix)).toBe("[]");
  });
  it("C2 同じ文で同じ AIX×what を二重に返さない", () => {
    const hits = detectAixTerritory(`${YUMA_WP} ${YUMA_CS}`);
    const keys = hits.map((h) => `${h.aix}|${h.what}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
