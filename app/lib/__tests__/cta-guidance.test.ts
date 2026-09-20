// 2通目に CTA（内覧・申込の誘い）を付けるかの判断（竹内「ブレインが判断する／刺さっているなら誘導する」）。
//
// 実測（scripts/audit-cta-trigger.ts・直近180日・AIX の1通目→30分以内の2通目 1,424組）:
//   全体 12.7%
//   お客様の反応別: positive **30.6%**（成約した会話では**60.0%**）／question 19.4%／ack_only 8.4%／
//                   concern **3.2%**／condition_change **1.1%**
//   前向きの中身別: appraisal **45.5%**／viewing_explicit **31.3%**（内覧29.9 / 申込1.5）
//   AIX 別: 待ち合わせ50.0%／内覧日調整49.1%／申込へ28.6%（申込27.0）／見積書22.1%（申込15.8）／
//           物件確認9.2%／物件オススメ9.1%／**物件ピックアップ3.0%**／**ヒアリング0.0%**
//
// ⚠ purchase_signal_level は使わない（設計知見「peak は申込しそうではなく申込したを言っていた」）。
//
// 実行: npx tsx app/lib/__tests__/cta-guidance.test.ts（全 PASS で exit 0）
import { resolveCtaGuidance, CTA_RATE_BY_ACTION, CTA_RATE_BY_KIND, CTA_RATE_OVERALL } from "../cta-guidance";

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
    not: { toContain(item: unknown) { if (typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected not to contain ${JSON.stringify(item)}`); } },
  };
}

describe("刺さっている時は誘導する（竹内さんの指示）", () => {
  it("★ P1 内覧したい（viewing_explicit）→ 内覧に誘う（実測31.3%・内覧29.9%）", () => {
    const g = resolveCtaGuidance({ customerKind: "positive", positiveKind: "viewing_explicit", action: "property_recommendation" });
    expect(g.mode).toBe("push");
    expect(g.kind).toBe("viewing");
    expect(g.note).toContain("31.3%");
    expect(g.note).toContain("内覧");
  });
  it("★ P2 褒め・評価（appraisal）→ 誘う（実測45.5%）", () => {
    const g = resolveCtaGuidance({ customerKind: "positive", positiveKind: "appraisal", action: "property_recommendation" });
    expect(g.mode).toBe("push");
    expect(g.note).toContain("45.5%");
  });
  it("★ P3 成約データの60%を根拠として見せる", () => {
    expect(resolveCtaGuidance({ customerKind: "positive", positiveKind: "viewing_explicit", action: "property_send" }).note).toContain("成約した会話では60%");
  });
  it("P4 前向き×見積書送る → 申込に誘う（この AIX は申込15.8% > 内覧6.3%）", () => {
    const g = resolveCtaGuidance({ customerKind: "positive", positiveKind: "viewing_explicit", action: "estimate_sheet" });
    expect(g.kind).toBe("apply");
  });
  // 2026-09-21 YUMA 検証: 日時なしで日程だけ聞く形は実送信の2通目で0〜1通（AIX【内覧日調整】の担当）
  it("★ P6 内覧に誘う時は「ご案内させて頂きます」— 日程を聞かせない", () => {
    const n = resolveCtaGuidance({ customerKind: "positive", positiveKind: "viewing_explicit", action: "property_send" }).note;
    expect(n).toContain("ご案内させて頂きます");
    expect(n).toContain("日程を聞かない");
    expect(n).toContain("AIX【内覧日調整】");
  });
  it("P5 押し付けない言い方を指定する", () => {
    expect(resolveCtaGuidance({ customerKind: "positive", positiveKind: "appraisal", action: "property_recommendation" }).note).toContain("お気に召されましたら");
  });
});

describe("刺さっていない時は誘導しない", () => {
  it("★ N1 懸念（concern）→ 書かない（実測3.2%）", () => {
    const g = resolveCtaGuidance({ customerKind: "concern", action: "property_recommendation" });
    expect(g.mode).toBe("none");
    expect(g.note).toContain("3.2%");
    expect(g.note).toContain("書かない");
  });
  it("★ N2 条件の変更（condition_change）→ 書かない（実測1.1%）", () => {
    const g = resolveCtaGuidance({ customerKind: "condition_change", action: "property_recommendation" });
    expect(g.mode).toBe("none");
    expect(g.note).toContain("1.1%");
  });
  it("★ N3 懸念は AIX が誘う種類（内覧日調整49%）でも書かない — お客様の反応が優先", () => {
    expect(resolveCtaGuidance({ customerKind: "concern", action: "viewing_invite" }).mode).toBe("none");
  });
});

describe("AIX の種類でも決まる", () => {
  it("★ A1 物件ピックアップ（実測3.0%）×相槌 → 書かない", () => {
    const g = resolveCtaGuidance({ customerKind: "ack_only", action: "property_send" });
    expect(g.mode).toBe("none");
    expect(g.note).toContain("3%");
  });
  it("★ A2 ヒアリング（実測0.0%）→ 書かない", () => {
    expect(resolveCtaGuidance({ customerKind: "other", action: "condition_hearing" }).mode).toBe("none");
  });
  it("★ A6 お客様の反応が優先 — 物件ピックアップでも「内覧したい」なら誘う（竹内さんの指示）", () => {
    const g = resolveCtaGuidance({ customerKind: "positive", positiveKind: "viewing_explicit", action: "property_send" });
    expect(g.mode).toBe("push");
    expect(g.kind).toBe("viewing");
  });
  it("A7 ただし懸念はどの AIX でも書かない（否定的な反応が最優先）", () => {
    expect(resolveCtaGuidance({ customerKind: "concern", action: "application_push" }).mode).toBe("none");
  });
  it("★ A3 内覧日調整（実測49.1%）→ 付けてよい・内覧中心", () => {
    const g = resolveCtaGuidance({ customerKind: "other", action: "viewing_invite" });
    expect(g.mode).toBe("push");
    expect(g.kind).toBe("viewing");
  });
  it("★ A4 申込へ！（実測28.6%・申込27.0%）→ 付けてよい・申込中心", () => {
    const g = resolveCtaGuidance({ customerKind: "other", action: "application_push" });
    expect(g.mode).toBe("push");
    expect(g.kind).toBe("apply");
  });
  // 2026-09-21 YUMA 検証: 内覧日調整（49.1%）でも「よろしくお願いします」だけの相槌では誘う場面ではない
  //   （1通目が「ご内覧可否確認させて頂きます」＝まだ結果が出ていない）。実測 ack_only は 8.4%
  it("★ A8 誘う種類でも**相槌だけ**なら soft（実測 ack_only 8.4%）", () => {
    expect(resolveCtaGuidance({ customerKind: "ack_only", action: "viewing_invite" }).mode).toBe("soft");
    expect(resolveCtaGuidance({ customerKind: "ack_only", action: "application_push" }).mode).toBe("soft");
  });
  it("A9 相槌でも前向きな中身があれば positive 側で拾われる（②の分岐が先）", () => {
    expect(resolveCtaGuidance({ customerKind: "positive", positiveKind: "viewing_explicit", action: "viewing_invite" }).mode).toBe("push");
  });
  it("A5 見積書送る（22.1%・申込15.8%）→ 申込中心", () => {
    expect(resolveCtaGuidance({ customerKind: "other", action: "estimate_sheet" }).kind).toBe("apply");
  });
});

describe("迷う場面は言い切らない（振り子を止める）", () => {
  it("★ S1 物件オススメ×相槌 → soft（任意）", () => {
    const g = resolveCtaGuidance({ customerKind: "ack_only", action: "property_recommendation" });
    expect(g.mode).toBe("soft");
    expect(g.note).toContain("任意");
    expect(g.note).toContain("無理に誘わない");
  });
  it("S2 質問（19.4%）×物件確認した（9.2%）→ soft", () => {
    expect(resolveCtaGuidance({ customerKind: "question", action: "property_check_result" }).mode).toBe("soft");
  });
  it("S3 種類も反応も分からない → soft（極端に倒さない）", () => {
    const g = resolveCtaGuidance({ customerKind: null, action: null });
    expect(g.mode).toBe("soft");
  });
  it("S4 どの結果も note は空でない（渡す物が必ずある）", () => {
    for (const k of ["positive", "concern", "ack_only", "question"] as const) {
      expect(resolveCtaGuidance({ customerKind: k, action: "property_recommendation" }).note.length > 0).toBe(true);
    }
  });
});

describe("実測の表の自己整合", () => {
  it("C1 AIX 別の率は all >= viewing かつ all >= apply", () => {
    for (const [k, v] of Object.entries(CTA_RATE_BY_ACTION)) {
      if (v.all + 0.01 < v.viewing || v.all + 0.01 < v.apply) throw new Error(`${k} の内訳が合計を超えている`);
    }
  });
  it("C2 反応別の率は positive が最大・condition_change が最小", () => {
    const vals = Object.values(CTA_RATE_BY_KIND) as number[];
    expect(CTA_RATE_BY_KIND.positive).toBe(Math.max(...vals));
    expect(CTA_RATE_BY_KIND.condition_change).toBe(Math.min(...vals));
  });
  it("C3 全体の率は 12.7%（監査と同じ値）", () => { expect(CTA_RATE_OVERALL).toBe(12.7); });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
