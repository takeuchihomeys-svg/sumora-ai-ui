// 「こちらの送信に対してお客様がどう返すか」をブレインに渡す文のテスト（自己完結ハーネス）
// 実行: npx tsx app/lib/__tests__/send-reply-timing.test.ts
import { buildSendReplyTimingNote, wherePositioned, SEND_REPLY_STATS, BALANCE_STATS } from "../send-reply-timing";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const truthy = (a: unknown, msg = "") => { if (!a) throw new Error(`expected truthy ${msg}`); };
const falsy = (a: unknown, msg = "") => { if (a) throw new Error(`expected falsy ${msg}: ${JSON.stringify(a)}`); };
const eq = (a: unknown, b: unknown) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };

const NOW = Date.parse("2026-09-23T12:00:00+09:00");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const note = (o: Partial<Parameters<typeof buildSendReplyTimingNote>[0]>) => buildSendReplyTimingNote({
  lastStaffAt: ago(2), lastStaffAixType: null, customerRepliedAfter: false,
  staffCount: 10, customerCount: 8, now: NOW, ...o,
});

describe("種類と経過時間の掛け合わせ", () => {
  it("物件オススメは種類名と実測が入る", () => {
    const s = note({ lastStaffAixType: "property_recommendation" });
    truthy(s.includes("物件オススメ"));
    truthy(s.includes("72.8%"));
    truthy(s.includes("2.0時間経過"));
  });
  it("内覧のご案内は「ほぼ必ず・すぐ返る」の注記が付く", () => {
    const s = note({ lastStaffAixType: "viewing_invite" });
    truthy(s.includes("内覧のご案内"));
    truthy(s.includes("ほぼ必ず・すぐ返る"));
  });
  it("物件オススメ・物件送付は「沈黙＝脈なしとは限らない」の注記が付く", () => {
    truthy(note({ lastStaffAixType: "property_recommendation" }).includes("脈なし とは限らない"));
    truthy(note({ lastStaffAixType: "property_send" }).includes("脈なし とは限らない"));
  });
  it("種類が分からない（手打ち）は手打ちの実測を使う", () => {
    const s = note({ lastStaffAixType: null });
    truthy(s.includes("手打ち"));
    truthy(s.includes("92.9%"));
  });
  it("知らない種類でも落ちず手打ち扱いにする", () => truthy(note({ lastStaffAixType: "unknown_action" }).includes("手打ち")));
  it("お客様が返していれば反応待ちではないと書く", () => {
    const s = note({ customerRepliedAfter: true });
    truthy(s.includes("反応待ちではない"));
    falsy(s.includes("経過）"), "経過時間は出さない");
  });
  it("送信時刻が無ければ時間の行を出さない", () => falsy(note({ lastStaffAt: null }).includes("経過）")));
});

// 2026-09-23 全件監査で気づいた: ブレインが走るのはほとんどお客様が返信した瞬間。
//   「あと何時間待つか」より「今回は何時間で返してきたか」が効く（竹内さんの問いそのもの）
describe("お客様が何時間で返したか", () => {
  const replied = (aix: string, sentAgoH: number, repliedAgoH: number) => buildSendReplyTimingNote({
    lastStaffAt: ago(sentAgoH), lastStaffAixType: aix, customerRepliedAfter: true,
    customerRepliedAt: ago(repliedAgoH), staffCount: 10, customerCount: 8, now: NOW,
  });
  it("見積書に3.1時間で返信＝75%の範囲内", () => {
    const s = replied("estimate_sheet", 3.1, 0);
    truthy(s.includes("【見積書】から 3.1時間後に返信"));
    truthy(s.includes("4人に3人の範囲内"));
  });
  it("見積書に10分で返信＝中央値より早い", () => truthy(replied("estimate_sheet", 10 / 60, 0).includes("より早い返信")));
  it("物件送付に2.3日で返信＝遅い方の4分の1", () => truthy(replied("property_send", 55, 0).includes("遅い方の4分の1")));
  it("内覧のご案内に5日で返信＝9割が返し終わる時間を過ぎた", () => truthy(replied("viewing_invite", 120, 0).includes("9割が返し終わる時間を過ぎて")));
  it("返信時刻が無ければ従来どおり「反応待ちではない」", () =>
    truthy(note({ customerRepliedAfter: true, customerRepliedAt: null }).includes("反応待ちではない")));
  it("返信が送信より前（時計のずれ）なら速さを出さない", () =>
    truthy(buildSendReplyTimingNote({
      lastStaffAt: ago(1), lastStaffAixType: "estimate_sheet", customerRepliedAfter: true,
      customerRepliedAt: ago(3), staffCount: 10, customerCount: 8, now: NOW,
    }).includes("反応待ちではない")));
  it("速さの行にも命令形を入れない", () => {
    for (const h of [0.1, 3, 40, 200]) falsy(/追って|待って|すべき|してください/.test(replied("property_send", h, 0)));
  });
});

describe("分布のどこにいるか（材料として渡す・指示にしない）", () => {
  const s = SEND_REPLY_STATS.property_recommendation;
  it("中央値より前", () => truthy(wherePositioned(1, s).includes("半分のお客様がまだ返していない")));
  it("中央値〜75%", () => truthy(wherePositioned(10, s).includes("4人に1人")));
  it("75%〜90%", () => truthy(wherePositioned(60, s).includes("10人に1人")));
  it("90%超え", () => truthy(wherePositioned(200, s).includes("9割が返し終わっている")));
  // 設計知見「AIX の要否・種類はブレインだけが判断」: 「待て」「追え」と書かない
  it("命令形の言葉を入れない", () => {
    for (const h of [0.1, 10, 60, 200]) {
      const t = wherePositioned(h, s);
      falsy(/追って|待って|しなさい|すべき|してください/.test(t), t);
    }
  });
});

describe("送信と返信のバランス", () => {
  it("通数と比を出し、成約側の実測を併記する", () => {
    const s = note({ staffCount: 23, customerCount: 10 });
    truthy(s.includes("こちら 23通 : お客様 10通"));
    truthy(s.includes(String(BALANCE_STATS.won.ratioMedian)));
  });
  it("こちらが多く送っている時だけ注意の1行が付く", () => {
    truthy(note({ staffCount: 23, customerCount: 10 }).includes("こちらが多く送っている側"));
    falsy(note({ staffCount: 10, customerCount: 12 }).includes("こちらが多く送っている側"));
  });
  it("通数が少ない会話ではバランスを出さない（母数が足りない）", () =>
    falsy(note({ staffCount: 2, customerCount: 2 }).includes("この会話の通数")));
});

describe("全体の形", () => {
  it("渡す物が無ければ空文字", () => eq(buildSendReplyTimingNote({
    lastStaffAt: null, lastStaffAixType: null, customerRepliedAfter: false,
    staffCount: 1, customerCount: 1, now: NOW,
  }), ""));
  it("見出しが付く", () => truthy(note({}).includes("【⏱ 送信と返信のバランス")));
  // この関数は数字と種類名しか受け取らないので、個人情報や物件名が混ざる経路が無いことを形で確かめる
  it("本名・物件名・号室が混ざらない", () => {
    const s = note({ lastStaffAixType: "property_recommendation", staffCount: 23, customerCount: 10 });
    falsy(/号室|[ァ-ヶー]{4,}(?:マンション|ハイツ|レジデンス)?\s*\d{3,}/.test(s), s);
    falsy(/[一-龥]{2,4}さん/.test(s), s);   // 「お客様」は一般語なので当てない
  });
  it("長すぎない（1回あたり 500字以内）", () => truthy(note({ lastStaffAixType: "property_recommendation" }).length < 500));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => `- ${f}`).join("\n")); process.exit(1); }
