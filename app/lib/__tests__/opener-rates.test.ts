// 開口語を「一択」で決めつけない（竹内 2026-09-21）。
//
// 竹内「一択と指摘するんじゃなくて実際の成約データや直近の会話から学習して、
//   場面でいれるかどうかはブレインに判断させる。そのためにもブレインはあるのだから（文の構成等）」
//
// 実行: npx tsx app/lib/__tests__/opener-rates.test.ts（全 PASS で exit 0）
import {
  judgeOpener, openerLabelOf, sceneFromTpo, buildOpenerRateNote,
  OPENER_RATE, OPENER_SAMPLE, OPENER_RARE_PCT,
} from "../opener-rates";

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
    notToContain(item: unknown) { if (typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected ${JSON.stringify(actual)} NOT to contain ${JSON.stringify(item)}`); },
  };
}

describe("書き出しの種類を見分ける（監査と同じ順番）", () => {
  it("★ L1 かしこまりました", () => expect(openerLabelOf("かしこまりました！！\n探させて頂きます")).toBe("かしこまりました"));
  it("★ L2 はい", () => expect(openerLabelOf("はい😊！！\nご連絡お待ちしております")).toBe("はい"));
  it("★ L3 目的語ありのお礼", () => expect(openerLabelOf("ご条件お送り頂きありがとうございます😊！！")).toBe("〇〇頂きありがとうございます"));
  it("★ L4 目的語なしのお礼", () => expect(openerLabelOf("ありがとうございます！！")).toBe("ありがとうございます（目的語なし）"));
  it("★ L5 本題から始まる＝開口語なし", () => expect(openerLabelOf("9/8 15:00にウェルスクエア池田井口堂でお待ちしております")).toBe("開口語なし"));
  it("L6 はじめまして・お世話になっております", () => {
    expect(openerLabelOf("YUMAさん、はじめまして😊！！")).toBe("はじめまして");
    expect(openerLabelOf("YUMAさんお世話になっております！！")).toBe("お世話になっております");
  });
});

describe("場面を TPO ラベルから寄せる", () => {
  it("★ S1 感謝返し・短い了承 → 短い了承・お礼", () => {
    expect(sceneFromTpo("感謝返し")).toBe("短い了承・お礼");
    expect(sceneFromTpo("短い了承")).toBe("短い了承・お礼");
  });
  it("★ S2 条件提示 → 条件提示", () => expect(sceneFromTpo("条件提示")).toBe("条件提示"));
  it("S3 対応が付かなければ null（何も言わない）", () => expect(sceneFromTpo("知らない場面")).toBe(null));
  it("S4 空でも落ちない", () => expect(sceneFromTpo(null)).toBe(null));
});

describe("★ 一択とは言わない（竹内 2026-09-21）", () => {
  it("★ J1 短い了承で「かしこまりました」は指摘しない（実測8.7%・少数だが実在する）", () => {
    const v = judgeOpener("短い了承・お礼", "かしこまりました！！\n承知いたしました");
    expect(v.ok).toBe(true);
  });
  it("★ J2 短い了承で「開口語なし」も指摘しない（実測49.3%で一番多い）", () => {
    expect(judgeOpener("短い了承・お礼", "明日16:00にお待ちしております！！").ok).toBe(true);
  });
  it("★ J3 条件提示で「はい」は指摘しない（実測3.9%）", () => {
    expect(judgeOpener("条件提示", "はい😊！！\n探させて頂きます").ok).toBe(true);
  });
  it("★ J4 条件フォーム受領で「ご条件お送り頂きありがとうございます」は指摘しない（実測14.8%）", () => {
    expect(judgeOpener("条件フォーム受領", "ご条件お送り頂きありがとうございます😊！！\n探させて頂きます").ok).toBe(true);
  });
  it("★ J5 実送信でほぼ0（3%未満）の時だけ言う", () => {
    // 条件フォーム受領で「はい」は 0.6%
    const v = judgeOpener("条件フォーム受領", "はい😊！！\n探させて頂きます");
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.message).toContain("0.6%");
      expect(v.message).notToContain("一択");
      expect(v.message).toContain("多いのは");
    }
  });
  it("★ J6 言う時は率と母数を添える（根拠を隠さない）", () => {
    const v = judgeOpener("条件フォーム受領", "はい😊！！\n探させて頂きます");
    if (v.ok) throw new Error("指摘されるはず");
    expect(v.message).toContain(String(OPENER_SAMPLE["条件フォーム受領"]));
  });
  it("J7 場面が分からなければ何も言わない", () => {
    expect(judgeOpener(null, "なんでも").ok).toBe(true);
  });
  it("J8 母数が少ない場面では何も言わない（断り・キャンセル21通）", () => {
    expect(judgeOpener("断り・キャンセル", "はい😊！！").ok).toBe(true);
  });
});

describe("★ ブレインが決めていればブレインに従う", () => {
  it("★ B1 ブレインの判断と合っていれば何も言わない", () => {
    expect(judgeOpener("短い了承・お礼", "かしこまりました！！\nはい", "かしこまりました").ok).toBe(true);
  });
  it("★ B2 ブレインの判断と違えば言う（実測が多数派でも）", () => {
    // 開口語なしは実測49.3%で一番多いが、ブレインが「はい」と決めたならそちらに合わせる
    const v = judgeOpener("短い了承・お礼", "明日お待ちしております", "はい");
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.message).toContain("ブレインはこの場面の開口語を「はい」と判断");
      expect(v.suggestion).toContain("ブレインの判断を変えるなら");
    }
  });
  it("★ B3 ブレインの判断がある時は、実送信ほぼ0の線は使わない（ブレインが上）", () => {
    // 条件フォーム受領で「はい」は0.6%だが、ブレインが「はい」と決めていれば通す
    expect(judgeOpener("条件フォーム受領", "はい😊！！", "はい").ok).toBe(true);
  });
});

describe("ブレインに渡す材料", () => {
  it("★ R1 場面の分布をそのまま見せる", () => {
    const n = buildOpenerRateNote("条件提示");
    expect(n).toContain("かしこまりました 43.4%");
    expect(n).toContain("開口語なし 27.1%");
    expect(n).toContain("一択にはできない");
  });
  it("R2 母数が少ない場面では何も渡さない", () => {
    expect(buildOpenerRateNote("断り・キャンセル")).toBe("");
    expect(buildOpenerRateNote(null)).toBe("");
  });
  it("★ R3 どの場面も「一番多い形」が過半数に届いていない事を確かめる（一択にできない根拠）", () => {
    // 条件フォーム受領（はじめまして55.1%）と質問（開口語なし52.5%）以外は過半数なし
    for (const s of ["短い了承・お礼", "検討中・一時保留", "条件提示", "断り・キャンセル", "その他"] as const) {
      const top = Math.max(...Object.values(OPENER_RATE[s]));
      if (top >= 50) throw new Error(`${s} の一番多い形が ${top}% で過半数を超えている（一択にできてしまう）`);
    }
  });
  it("R4 ほぼ0の線は3%（実送信に本当にある形を禁止しない）", () => {
    expect(OPENER_RARE_PCT).toBe(3.0);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
