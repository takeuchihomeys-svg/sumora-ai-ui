// 2026-09-15 竹内（yasuki 事例）: 内覧の内容（内覧に行ったスタッフが分かったこと）・連絡してくる人の取り違え
// 実行: npx tsx app/lib/__tests__/viewing-report.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { normalizeViewingReport, pickViewingRowForReport, recentViewingReports, viewingReportBlockForBrain, viewingReportNoteForReply, VIEWING_REPORT_MAX_CHARS } from "../viewing-report";
import { fixThirdPartyContactWait } from "../contact-actor";
import { applySurfaceFixes } from "../validate-reply";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
  };
}

const NOW = Date.parse("2026-09-15T16:00:00+09:00");
const YASUKI = "息子に確認の連絡を入れますので夕方くらいになると思いますが折り返しの連絡をさせて頂きます。";
const DRAFT = "かしこまりました！！\n息子様からのご返答お待ちしております😊！！\n気になる点等出てきましたらいつでもお気軽にご連絡ください！！";
const SENT = "かしこまりました！！\nご返答お待ちしております😊！！\n気になる点等出てきましたらいつでもお気軽にご連絡ください！！";

console.log("連絡してくる人の取り違え");
it("yasuki: お客様が自分で折り返す →「息子様からの」を外す（スタッフの実送信と同じ）", () => expect(fixThirdPartyContactWait(DRAFT, YASUKI).text).toBe(SENT));
it("後処理（applySurfaceFixes）でも直る", () => {
  const r = applySurfaceFixes(DRAFT, { customerName: "yasuki", customerMessage: YASUKI });
  expect(r.text).toBe(SENT);
  expect(r.applied.join(",")).toContain("CONTACT_ACTOR_FIXED");
});
it("本番の再現の形「息子様のご返答お待ち」→「ご返答お待ち」", () => expect(fixThirdPartyContactWait("かしこまりました！！\n息子様のご返答お待ちしております😊！！", YASUKI).text).toBe("かしこまりました！！\nご返答お待ちしております😊！！"));
it("本番の再現の形「息子様のご確認お待ち」→「ご返答お待ち」", () => expect(fixThirdPartyContactWait("息子様のご確認お待ちしております😊！！", YASUKI).text).toBe("ご返答お待ちしております😊！！"));
it("お客様へのお願い「息子様へのご確認、よろしくお願いいたします」は触らない", () => expect(fixThirdPartyContactWait("息子様へのご確認、よろしくお願いいたします😊！！", YASUKI).count).toBe(0));
it("家族から連絡させる時は触らない（息子から連絡させます）", () => expect(fixThirdPartyContactWait("息子様からのご連絡お待ちしております！！", "息子から連絡させますのでよろしくお願いします").count).toBe(0));
it("家族から来る話の時は触らない（主人から電話がいくと思います）", () => expect(fixThirdPartyContactWait("ご主人様からのお電話お待ちしております！！", "主人から電話がいくと思います。私からもまた連絡します").count).toBe(0));
it("管理会社からのご連絡は触らない", () => expect(fixThirdPartyContactWait("管理会社からのご連絡お待ちしております！！", "また連絡します").count).toBe(0));
it("お客様が連絡すると言っていなければ触らない", () => expect(fixThirdPartyContactWait(DRAFT, "息子と相談してみます").count).toBe(0));
it("同居人様からのご返事お待ち → 外す（同居人と相談してまた連絡いたします）", () => expect(fixThirdPartyContactWait("同居人様からのご返事お待ちしております！！", "同居人と相談してまた連絡いたします！").text).toBe("ご返事お待ちしております！！"));

console.log("内覧の内容");
it("入力の整形（空行・前後の空白・長さ）", () => {
  expect(normalizeViewingReport("  A を気に入っている \n\n 契約は息子様  \n")).toBe("A を気に入っている\n契約は息子様");
  expect(normalizeViewingReport("あ".repeat(900)).length).toBe(VIEWING_REPORT_MAX_CHARS);
});
it("書く記録: 今日の内覧を選ぶ（未来の予定・キャンセルは選ばない）", () => {
  const rows = [
    { id: "f", scheduled_date: "2026-09-20", status: "scheduled" },
    { id: "t", scheduled_date: "2026-09-15", status: "scheduled" },
    { id: "c", scheduled_date: "2026-09-14", status: "cancelled" },
  ];
  expect(pickViewingRowForReport(rows, "2026-09-15")?.id).toBe("t");
});
it("書く記録: 翌日に入れた時は前日の内覧（日付経過）を選ぶ", () => expect(pickViewingRowForReport([{ id: "y", scheduled_date: "2026-09-14", status: "lapsed" }], "2026-09-15")?.id).toBe("y"));
it("書く記録: 4日より前しか無ければ null（今日の記録を作る）", () => expect(pickViewingRowForReport([{ id: "o", scheduled_date: "2026-09-10", status: "done" }], "2026-09-15")).toBe(null));

const R = { viewedOn: "2026-09-15", propertyName: "レオンコンフォート難波サウスゲート 502号室", report: "サウスゲート502を気に入っている\n契約は息子様（代理契約・管理会社OK）\n息子様に確認してから夕方にお客様から返事", reportedAt: "2026-09-15T03:10:00Z" };
it("ブレインに渡す: 日付・物件・内容・矛盾させない指示", () => {
  const b = viewingReportBlockForBrain([R], NOW);
  expect(b).toContain("【内覧に行ったスタッフの記録");
  expect(b).toContain("9/15 内覧（レオンコンフォート難波サウスゲート 502号室）: サウスゲート502を気に入っている ／ 契約は息子様");
  expect(b).toContain("latent_intent");
});
it("返信生成に渡す: 連絡してくる人の例・書き写さない", () => {
  const n = viewingReportNoteForReply([R], NOW);
  expect(n).toContain("連絡してくるのはお客様ご本人");
  expect(n).toContain("書き写さない");
});
it("内覧の内容が無ければ何も渡さない", () => { expect(viewingReportBlockForBrain([], NOW)).toBe(""); expect(viewingReportNoteForReply([], NOW)).toBe(""); });
it("90日より古い内容は渡さない・新しい順に2件まで", () => {
  const old = { ...R, reportedAt: "2026-05-01T00:00:00Z" };
  const a = { ...R, reportedAt: "2026-09-10T00:00:00Z", report: "A" }, b = { ...R, reportedAt: "2026-09-12T00:00:00Z", report: "B" };
  const rs = recentViewingReports([old, a, R, b], NOW);
  expect(rs.map((x) => x.report[0]).join("")).toBe("サB");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
