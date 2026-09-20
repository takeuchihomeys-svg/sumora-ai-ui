// AIX テンプレート（2通目）の長さの目安（竹内「生成される文が長すぎる」）。
//
// 実測（scripts/audit-template-length.ts・直近120日）が根拠:
//   実送信の2通目 1,419通: 中央値 120字・4行
//   **成約した会話の2通目 114通: 中央値 108字・3行**（25% 65 / 75% 140）
//   分布: 0〜60字 19.2% / 60〜100字 16.0% / **100〜140字 34.3%（最頻）** /
//         140〜180字 8.3% / 180〜240字 6.3% / 240字〜 15.8% ＝ **140字未満が69.5%**
//   生成が長い経路: property_recommendation 生成257字→実送信234字 ／ property_send_widen 生成170字→実送信112字
//
// 実行: npx tsx app/lib/__tests__/template-length.test.ts（全 PASS で exit 0）
import { buildLengthNote, checkLength, isLengthGuided, TEMPLATE_LENGTH_GUIDE, LENGTH_FREE_ACTIONS } from "../template-length";

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

// 竹内さんが見せた実物（和樹さん・21:21 の2通目）＝ 目指す形
const REAL_2ND = "お送りさせて頂きましたお部屋の中でもジーメゾン泉大津ペルファットが特に和樹さんにオススメのお部屋となります！！\nペット2匹飼育可能となります😊！！\n和樹さん達がお気に召されたお部屋ご内覧させて頂きますのでお気軽にお申し付けください😌！！";

describe("長さを縛る種類", () => {
  for (const a of ["property_recommendation", "property_send", "estimate_sheet", "property_check_result", "viewing_invite", "meeting_place", "property_send_widen"]) {
    it(`G ${a} は縛る`, () => { expect(isLengthGuided(a)).toBe(true); });
  }
  it("★ G8 種類が分からない時も縛る（長い方に倒さない）", () => {
    expect(isLengthGuided(null)).toBe(true);
    expect(isLengthGuided("")).toBe(true);
    expect(isLengthGuided("unknown_action")).toBe(true);
  });
});

describe("長さを縛らない種類（フォームの全文を送る）", () => {
  for (const a of ["condition_hearing", "application_push_format", "document_request"]) {
    it(`F ${a} は縛らない`, () => {
      expect(isLengthGuided(a)).toBe(false);
      expect(buildLengthNote(a)).toBe("");
    });
  }
  it("F4 一覧は空でない（配線事故の検知）", () => { expect(LENGTH_FREE_ACTIONS.size >= 3).toBe(true); });
});

describe("プロンプトに入れる指示", () => {
  it("★ N1 目的（返信・訴求）から書く — 長さの制限が主語ではない", () => {
    const n = buildLengthNote("property_recommendation");
    expect(n).toContain("返信をもらうため");
    expect(n).toContain("訴求のため");
    expect(n).toContain("108字");
  });
  it("★ N1b 返信率の実測を根拠として見せる", () => {
    const n = buildLengthNote("property_recommendation");
    expect(n).toContain("100〜140字で81.0%");
    expect(n).toContain("63.9%");
  });
  it("★ N1c 成約データの実物（スタッフの見立て）を手本として見せる", () => {
    const n = buildLengthNote("property_send");
    expect(n).toContain("かなりオススメ出来るお部屋が募集に出ました");
    expect(n).toContain("私個人的には");
  });
  it("★ N1d 毎回の申込誘導を止める（実送信8.8%・内覧6.1%）", () => {
    const n = buildLengthNote("property_recommendation");
    expect(n).toContain("毎回「お気に召されましたらお申込みでお部屋を抑えさせて頂きます」で終わらせない");
    expect(n).toContain("8.8%");
    expect(n).toContain("どちらも1割未満");
  });
  it("★ N1f 共感フレーズを止める（実送信の2通目1,424通で0通）", () => {
    const n = buildLengthNote("property_recommendation");
    expect(n).toContain("ますよね");
    expect(n).toContain("気持ちの代弁・同調");
    expect(n).toContain("1,424通で**0通**");
  });
  it("★ N1e 希少性の煽りを名指しで止める（YUMA で実際に出た）", () => {
    const n = buildLengthNote("property_check_result");
    expect(n).toContain("他のお客様からお申込みが入る可能性");
    expect(n).toContain("埋まってしまう");
  });
  it("★ N2 上限を明示して「超えたら書き直す」と言う", () => {
    expect(buildLengthNote("property_send")).toContain("180字を超えたら**要点を削って**書き直す");
  });
  it("★ N3 長くなる原因（箇条書きの並べ直し）を名指しで止める", () => {
    const n = buildLengthNote("property_recommendation");
    expect(n).toContain("1通目で既に送っている");
    expect(n).toContain("並べ直さない");
  });
});

describe("長さの点検（実物で確かめる）", () => {
  it(`★ C1 竹内さんの実物（${REAL_2ND.length}字・3行）は基準内`, () => {
    const r = checkLength(REAL_2ND, "property_recommendation");
    expect(r.ok).toBe(true);
    expect(r.over).toBe(0);
  });
  it("★ C2 実測で長かった生成（257字相当）は基準外として記録される", () => {
    const long = "あ".repeat(257);
    const r = checkLength(long, "property_recommendation");
    expect(r.ok).toBe(false);
    expect(r.over).toBe(257 - TEMPLATE_LENGTH_GUIDE.max);
  });
  it("C3 フォーム系は長くても基準内（縛らない）", () => {
    expect(checkLength("あ".repeat(400), "condition_hearing").ok).toBe(true);
  });
  it("★ C4 点検は本文を書き換えない（長さで切ると文が壊れる）", () => {
    const r = checkLength(REAL_2ND, "property_recommendation");
    // 返すのは測った値だけ。text を返さない設計であることを型で固定する
    expect(Object.keys(r).sort().join(",")).toBe("bullets,len,lines,ok,over");
  });
  it("C5 成約データの中央値108字は基準の内側", () => {
    expect(checkLength("あ".repeat(108), "property_send").ok).toBe(true);
  });
  it("C6 実送信の75パーセンタイル140字も基準の内側", () => {
    expect(checkLength("あ".repeat(140), "property_send").ok).toBe(true);
  });

  // 2026-09-20 竹内「返信や訴求の為」: 箇条書きは返信率が13ポイント低い（63.9% vs 全体76.8%）
  it("★ C7 オススメポイントの箇条書きは基準外として記録される（返信率63.9%）", () => {
    const bulleted = "🌟パークモダン新大阪 503\n（オススメポイント）\n・家賃126,000円・管理費15,000円\n・間取り：1LDK\n・御堂筋線「新大阪」徒歩10分";
    const r = checkLength(bulleted, "property_recommendation");
    expect(r.bullets).toBe(3);
    expect(r.ok).toBe(false);
  });
  it("C8 箇条書きが1行だけなら基準内（並べ直しではない）", () => {
    const r = checkLength("和樹さんにオススメのお部屋となります！！\n・ペット2匹飼育可能となります😊！！\nお気軽にお申し付けください😌！！", "property_recommendation");
    expect(r.bullets).toBe(1);
    expect(r.ok).toBe(true);
  });
  it("★ C9 竹内さんの実物は箇条書き0（そのまま基準内）", () => {
    expect(checkLength(REAL_2ND, "property_recommendation").bullets).toBe(0);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
