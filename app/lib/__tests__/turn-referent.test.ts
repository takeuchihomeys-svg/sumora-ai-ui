// 主語の抜けた番の物件の候補（app/lib/turn-referent.ts・property-thread の台帳の文）のテスト（自己完結ハーネス）
// 2026-10-09。文と並びは scripts/audit-hidden-subject.ts の実物（60日・竹内さんの返事で正解が決まった番）の形（物件名だけ・画像は記号）。
// 実行: npx tsx app/lib/__tests__/turn-referent.test.ts
// 既定 off の2つ（PROPERTY_REFERENT_FALLBACK・PROPERTY_THREAD_OCR_REPAIR）を入れた形を確かめる
process.env.PROPERTY_REFERENT_FALLBACK = "on"; process.env.PROPERTY_THREAD_OCR_REPAIR = "on";
import { isHiddenSubjectTurn, refersToMany, resolveTurnReferent, turnReferentLines, type ReferentMention } from "../turn-referent";
import { resolvePropertyThreads, buildPropertyThreadNote, type PtMsg, type PtAix } from "../property-thread";

let passed = 0, failed = 0; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const truthy = (a: unknown, m = "") => { if (!a) throw new Error(`expected truthy ${m}`); };
const jst = (iso: string) => iso.slice(5, 16).replace("T", " ");
const M = (at: string, roomKey: string, by: "ours" | "customer" = "ours"): ReferentMention => ({ at, roomKey, display: roomKey, by });

describe("主語の抜けの判定", () => {
  it("「空いてますか？」「初期費用いくらですか？」「内見行きたいです！」は主語の抜け", () => {
    truthy(isHiddenSubjectTurn("26日の夕方18時頃なら空いてますでしょうか？"));
    truthy(isHiddenSubjectTurn("初期費用2980円でしょうか？"));
    truthy(isHiddenSubjectTurn("内見行きたいです！"));
  });
  it("物件名・号室・URL を自分で言っている発言は外す", () => {
    eq(isHiddenSubjectTurn("ロジワール城山の初期費用 / 解りますか？".replace(" / ", "\n")), false);
    eq(isHiddenSubjectTurn("301号室の内覧お願いしたいです"), false);
  });
  it("お礼・了承だけは外す", () => { eq(isHiddenSubjectTurn("ありがとうございます！"), false); eq(isHiddenSubjectTurn("了解です"), false); });
  it("「どっちも」「全部」は複数", () => { truthy(refersToMany("どっちも気になります")); eq(refersToMany("ここ見てみたいです"), false); });
});

describe("段の順（直前の送信 → こちらが最後 → お客様が最後）", () => {
  const t0 = "2026-09-19T06:04:10Z";
  it("直前のこちらの送信に1件 → その物件", () => {
    const r = resolveTurnReferent({ turnText: "初期費用いくらですか？", turnStartAt: t0, prevCustomerAt: "2026-09-19T05:00:00Z", mentions: [M("2026-09-19T05:30:00Z", "栄美グランドハイツ"), M("2026-09-10T05:30:00Z", "前の物件")], jst });
    eq(r?.kind, "one"); eq(r?.kind === "one" && r.display, "栄美グランドハイツ"); eq(r?.kind === "one" && r.step, "prev_send_one");
  });
  it("直前のこちらの送信に2件 → 決めない（候補を送った順）", () => {
    const r = resolveTurnReferent({ turnText: "初期費用2980円でしょうか？", turnStartAt: t0, prevCustomerAt: "2026-09-19T05:00:00Z", mentions: [M("2026-09-19T05:30:00Z", "栄美グランドハイツ"), M("2026-09-19T05:31:00Z", "浅香山住宅5号棟")], jst });
    eq(r?.kind, "many");
    const lines = turnReferentLines(r!, "初期費用2980円でしょうか？", jst).join("\n");
    truthy(/①栄美グランドハイツ.*②浅香山住宅5号棟/.test(lines), lines);
    truthy(/1件に決めて答えない/.test(lines), lines);
  });
  it("名前の一部（「カシータ見にいく」）が候補の1件だけに当たる → その物件", () => {
    const ms = [M("2026-09-19T05:30:00Z", "カシータ神戸元町JP 401号室"), M("2026-09-19T05:30:10Z", "エステムコートみなと元町THE FIRST")];
    const r = resolveTurnReferent({ turnText: "カシータ見にいくことって可能ですか", turnStartAt: t0, prevCustomerAt: "2026-09-19T05:00:00Z", mentions: ms, jst });
    eq(r?.kind === "one" && r.display, "カシータ神戸元町JP 401号室");
  });
  it("「どっちも」→ 直前に送った全部", () => {
    const r = resolveTurnReferent({ turnText: "どっちも気になります", turnStartAt: t0, prevCustomerAt: "2026-09-19T05:00:00Z", mentions: [M("2026-09-19T05:30:00Z", "A"), M("2026-09-19T05:31:00Z", "B")], jst });
    eq(r?.kind === "many" && r.step, "refers_many");
  });
  it("直前の送信が無い → こちらが最後に出した束が1件ならその物件", () => {
    const r = resolveTurnReferent({ turnText: "ここまだありますか？", turnStartAt: t0, prevCustomerAt: "2026-09-19T05:00:00Z", mentions: [M("2026-09-18T05:30:00Z", "LOHAS豊中稲津町")], jst });
    eq(r?.kind === "one" && r.step, "ours_last_one");
  });
  it("こちらが最後に出した後に、お客様が別の物件の名前を出していた → お客様の物件（新しい話）", () => {
    const r = resolveTurnReferent({ turnText: "いつ内見できますか？", turnStartAt: t0, prevCustomerAt: "2026-09-19T05:00:00Z", mentions: [M("2026-09-17T05:30:00Z", "A"), M("2026-09-18T05:30:00Z", "B", "customer")], jst });
    eq(r?.kind === "one" && r.display, "B"); eq(r?.kind === "one" && r.step, "customer_last");
  });
  it("14日より前の物件には飛ばない", () => {
    const r = resolveTurnReferent({ turnText: "ここまだありますか？", turnStartAt: t0, prevCustomerAt: "2026-09-19T05:00:00Z", mentions: [M("2026-08-20T05:30:00Z", "古い物件")], jst });
    eq(r, null);
  });
});

describe("台帳（property-thread）につなぐ", () => {
  const img = (lmid: string, at: string, url: string): PtMsg => ({ sender: "staff", text: "[画像]", created_at: at, line_message_id: lmid, image_url: url, is_aix_generated: true });
  it("cf2963d4 の形: 2件送った後の「初期費用2980円でしょうか？」→ 候補2件（決めない）・turnTargets は空のまま", () => {
    const messages: PtMsg[] = [
      { sender: "customer", text: "お願いします", created_at: "2026-09-19T05:00:00Z" },
      img("s1", "2026-09-19T05:30:00Z", "u1"), img("s2", "2026-09-19T05:30:01Z", "u2"),
      { sender: "customer", text: "初期費用2980円でしょうか？", created_at: "2026-09-19T06:04:10Z" },
    ];
    const s = resolvePropertyThreads({ messages, imageLabels: new Map([["u1", "栄美グランドハイツ 413号室"], ["u2", "浅香山住宅5号棟 503号室"]]) });
    eq(s.turnTargets.length, 0);
    eq(s.turnReferent?.kind, "many");
    const n = buildPropertyThreadNote(s);
    truthy(/決まらない/.test(n) && /①栄美グランドハイツ 413号室/.test(n), n);
  });
  it("直前に1件だけ送った後の「内見行きたいです！」→ ▶ その物件", () => {
    const messages: PtMsg[] = [
      { sender: "customer", text: "お願いします", created_at: "2026-09-19T03:00:00Z" },
      img("s1", "2026-09-19T03:10:00Z", "u1"),
      { sender: "customer", text: "内見行きたいです！", created_at: "2026-09-19T03:25:55Z" },
    ];
    const s = resolvePropertyThreads({ messages, imageLabels: new Map([["u1", "RISING Maison 本町橋 1505号室"]]) });
    const n = buildPropertyThreadNote(s);
    truthy(/▶ 今の番の物件（主語の無い発言「内見行きたいです！」）: RISING Maison 本町橋 1505号室/.test(n), n);
  });
  it("PROPERTY_REFERENT_FALLBACK=off で旧（台帳の文なし）", () => {
    process.env.PROPERTY_REFERENT_FALLBACK = "off";
    try {
      const messages: PtMsg[] = [img("s1", "2026-09-19T03:10:00Z", "u1"), { sender: "customer", text: "内見行きたいです！", created_at: "2026-09-19T03:25:55Z" }];
      eq(buildPropertyThreadNote(resolvePropertyThreads({ messages, imageLabels: new Map([["u1", "RISING Maison 本町橋 1505号室"]]) })), "");
    } finally { process.env.PROPERTY_REFERENT_FALLBACK = "on"; }
  });
});

describe("読み取りの名前の化け（OCR）", () => {
  const img = (lmid: string, at: string, url: string): PtMsg => ({ sender: "staff", text: "[画像]", created_at: at, line_message_id: lmid, image_url: url, is_aix_generated: true });
  it("512af5e5 の形: 画像の読み取り「ロッジール城山町 101号室」と AIX の「ロワジール城山町 101号室」は同じ部屋・表示は打った名前", () => {
    const messages: PtMsg[] = [img("s1", "2026-09-10T03:10:00Z", "u1")];
    const aix: PtAix[] = [{ created_at: "2026-09-10T03:10:02Z", aix_type: "property_send", property_names: ["ロワジール城山町 101号室"] }];
    const s = resolvePropertyThreads({ messages, imageLabels: new Map([["u1", "ロッジール城山町 101号室"]]), aix });
    eq(s.rooms.length, 1); eq(s.rooms[0].ref.display, "ロワジール城山町 101号室");
  });
  it("b50fd451 の形: 束の画像の読み取り「RIHGII Saison 3F田 1505号室」は AIX の「RISING Maison 本町橋 1505号室」に寄せる（引用先の名前）", () => {
    const messages: PtMsg[] = [
      img("s1", "2026-09-19T03:10:00Z", "u1"),
      { sender: "customer", text: "内見行きたいです！", created_at: "2026-09-19T03:25:55Z", line_message_id: "c1", quoted_message_id: "s1" },
    ];
    const aix: PtAix[] = [{ created_at: "2026-09-19T03:10:02Z", aix_type: "property_send", property_names: ["RISING Maison 本町橋 1505号室"] }];
    const s = resolvePropertyThreads({ messages, imageLabels: new Map([["u1", "RIHGII Saison 3F田 1505号室"]]), aix });
    eq(s.turnTargets[0]?.display, "RISING Maison 本町橋 1505号室");
    eq(s.rooms.length, 1);
  });
  it("号室が違えば同じにしない（同じ建物の別の部屋かもしれない）", () => {
    const messages: PtMsg[] = [img("s1", "2026-09-10T03:10:00Z", "u1")];
    const aix: PtAix[] = [{ created_at: "2026-09-10T03:10:02Z", aix_type: "property_send", property_names: ["ロワジール城山町 102号室"] }];
    eq(resolvePropertyThreads({ messages, imageLabels: new Map([["u1", "ロッジール城山町 101号室"]]), aix }).rooms.length, 2);
  });
  it("シリーズの番号が違えば同じにしない（サウスプレイスⅧ／Ⅵ）", () => {
    const messages: PtMsg[] = [img("s1", "2026-09-10T03:10:00Z", "u1")];
    const aix: PtAix[] = [{ created_at: "2026-09-10T03:10:02Z", aix_type: "property_send", property_names: ["エステムコート難波サウスプレイスⅥレジデンス 301号室"] }];
    eq(resolvePropertyThreads({ messages, imageLabels: new Map([["u1", "エステムコート難波サウスプレイスⅧレジデンス 301号室"]]), aix }).rooms.length, 2);
  });
  it("挨拶・ポータルの一覧の見出しを物件にしない", () => {
    const messages: PtMsg[] = [img("s1", "2026-09-10T03:10:00Z", "u1"), img("s2", "2026-09-10T03:10:01Z", "u2")];
    const s = resolvePropertyThreads({ messages, imageLabels: new Map([["u1", "お世話になっております！"], ["u2", "大阪府大阪市阿倍野区の賃貸物件一覧｜昭和・・・"]]) });
    eq(s.rooms.length, 0);
  });
});

console.log(`\n${failed ? "❌" : "✅"} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
