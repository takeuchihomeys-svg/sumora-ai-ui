// 2026-09-15 竹内（カイナ事例）: 物件ピックアップの「会話を合わせる」— 会話の糸口の抽出と内覧誘導の除去
// 実行: npx tsx app/lib/__tests__/property-send-match.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { extractPropertySendThreads, buildPropertySendThreadsBlock, stripViewingInviteLines, stripRepeatedThanksLines, fixPickupTense } from "../property-send-match";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
    notToContain(s: string) { if (typeof actual === "string" && actual.includes(s)) throw new Error(`expected not to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
  };
}

// カイナ（🐈‍⬛）の実会話（9/10〜9/15）
const KAINA = [
  { sender: "staff", text: "カイナさんお世話になっております！！\n\n大国町・桜川・南船場エリア周辺全域からカイナさんにオススメできるお部屋ピックアップさせて頂きました😊！！\nお気に召されお部屋全て代理契約可能か貸主側へ交渉させて頂きます！！\nお手隙の際にご査収ください😌！！" },
  { sender: "customer", text: "ありがとうございます！\n1度この2つで代理契約可能か確認していただけますでしょうか？💭" },
  { sender: "staff", text: "かしこまりました！！\n代理契約可能か明日管理会社に確認出来次第ご連絡させて頂きます😌！！" },
  { sender: "staff", text: "お待たせ致しました！！\nS-RESIDENCE難波大国町Deux\nS-RESIDENCE難波Brillerともに\n代理契約可能となります！！\n\nよろしければ一度お部屋ご内覧如何でしょうか😊！！" },
  { sender: "customer", text: "内覧してみて、もう少し広めのお部屋も見てみたいです！" },
  { sender: "staff", text: "カイナさん\n本日お時間頂きありがとうございました！！\nエリア広げさせていただき、大きめのお部屋ピックアップしお送りさせていただきます😊！！" },
];

it("カイナ: 前回のピックアップ送付より後の糸口だけ拾う（代理契約の依頼・広めのお部屋・エリアを広げる約束）", () => {
  const th = extractPropertySendThreads(KAINA);
  expect(th.customer.join(" | ")).toContain("広めのお部屋");
  expect(th.customer.join(" | ")).toContain("代理契約可能か確認");
  expect(th.staff.join(" | ")).toContain("エリア広げさせていただき");
  expect(th.staff.join(" | ")).toContain("代理契約可能か明日管理会社に確認");
  // 前回の送付（9/10 の「ピックアップさせて頂きました」）とその中の約束は含めない
  expect(th.staff.join(" | ")).notToContain("貸主側へ交渉");
});
it("定型の「ピックアップしてお送りさせて頂きます」は約束の糸口にしない", () => {
  const th = extractPropertySendThreads([{ sender: "staff", text: "かしこまりました！！\n梅田周辺からピックアップしてお送りさせて頂きます！！" }]);
  expect(th.staff.length).toBe(0);
});
it("カイナ: 続いている事情（代理契約）は前回の送付より前からも拾い、ブロックで「今回の物件でどうするか」を求める", () => {
  const th = extractPropertySendThreads(KAINA);
  expect(th.requirements.join(" | ")).toContain("代理契約");
  const b = buildPropertySendThreadsBlock(th);
  expect(b).toContain("続いている事情");
  expect(b).toContain("交渉（確認）させて頂きます");
});
it("続いている事情は requirementSources（お客様の発言を長めに）から拾える（直近の窓に無くても）", () => {
  const th = extractPropertySendThreads(
    [{ sender: "staff", text: "本日16時よりお部屋ご案内させて頂きます！" }, { sender: "customer", text: "こちらこそよろしくお願いいたします" }],
    { requirementSources: [{ sender: "customer", text: "こちらの物件は代理契約可能でしょうか？" }, { sender: "customer", text: "こちらこそよろしくお願いいたします" }] },
  );
  expect(th.requirements.join(" | ")).toContain("代理契約");
  expect(th.customer.length).toBe(0);
});
it("糸口が無ければブロックは「無し」", () => {
  expect(buildPropertySendThreadsBlock({ customer: [], requirements: [], staff: [] })).toContain("無し");
});
it("こちらの前の発言のお礼の繰り返し（本日はお時間頂きありがとうございました）を落とす", () => {
  const r = stripRepeatedThanksLines("カイナさんお世話になっております！！\n\n本日はお時間頂きありがとうございました！！\n\nエリア広げさせていただき、大きめのお部屋でカイナさんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！");
  expect(r.removed).toBe(1);
  expect(r.text).toBe("カイナさんお世話になっております！！\n\nエリア広げさせていただき、大きめのお部屋でカイナさんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！");
});
it("画像だけの発言・関係ない雑談は拾わない", () => {
  const th = extractPropertySendThreads([{ sender: "customer", text: "[画像]" }, { sender: "customer", text: "ありがとうございます！" }]);
  expect(th.customer.length).toBe(0);
});
it("内覧誘導・日時の行を落とす（内覧提案 OFF）", () => {
  const r = stripViewingInviteLines("〇〇さんお世話になっております！！\n\n梅田から〇〇さんにオススメできるお部屋ピックアップさせて頂きました！！\n\n〇〇さんお気に召されましたらご都合よろしいお日にちにご案内させて頂きます😊！！\n直近ですと\n9/16（水）15:00〜17:00\nご案内可能です！！\n\nお手隙の際にご査収ください😌！！");
  expect(r.removed).toBe(4);
  expect(r.text).toBe("〇〇さんお世話になっております！！\n\n梅田から〇〇さんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！");
});
it("内覧誘導が無ければそのまま", () => {
  const t = "〇〇さん\n\n条件広げてお送りしております！！\nお手隙の際にご査収ください😌！！";
  expect(stripViewingInviteLines(t).text).toBe(t);
});

it("ピックアップ行の未来形を過去形に（本番で写した「ピックアップしお送りさせていただきます」）", () => {
  const r = fixPickupTense("カイナさんお世話になっております！！\n\nエリア広げさせていただき、大きめのお部屋でカイナさんにオススメできるお部屋ピックアップしお送りさせていただきます😊！！\n\nお手隙の際にご査収ください😌！！");
  expect(r.fixed).toBe(1);
  expect(r.text).toContain("お部屋ピックアップさせていただきました😊！！");
  expect(fixPickupTense("お部屋ピックアップさせて頂きました！！").fixed).toBe(0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
