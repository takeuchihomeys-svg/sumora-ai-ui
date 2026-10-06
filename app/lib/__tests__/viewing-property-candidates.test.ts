// 2026-10-06 竹内（ゆいと・チンシャン事例）「送った物件選択してそこから おこなえるようにする（見積書作成の時のように）」: 内覧の AIX の送った物件の候補
// 実行: npx tsx app/lib/__tests__/viewing-property-candidates.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { viewingCandidatesFromChoice, preselectViewingCandidates, isAdditionalViewingRequest, candidateMatchesName, toggleCandidateInSlots } from "../viewing-property-candidates";
import type { EstimateTarget } from "../estimate-handoff";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { const a = JSON.stringify(actual), b = JSON.stringify(exp); if (a !== b) throw new Error(`expected ${b} but got ${a}`); } };
}

const T = (o: Partial<EstimateTarget> & { name: string }): EstimateTarget => ({
  room: null, source: "candidate", sourceLabel: "候補（スタッフが選ぶ）", at: "2026-10-04T03:52:06Z", materials: [], materialText: null,
  rent: null, managementFee: null, adMonths: null, adYen: null, adLabel: null, adSource: null, pickupId: null, dealStatus: null, ended: false, ...o,
});

// ゆいと（1191b1eb）の形: お客様 10/6 13:41「ここも行けますか？」＝10/4 のこちらの画像（🌟ディアコート曽根 302号室）を引用
const deare = T({ name: "ディアコート曽根", room: "302", source: "customer_quoted", sourceLabel: "お客様が引用して聞いたお部屋",
  materials: [{ url: "https://x.public.blob.vercel-storage.com/deare.png", kind: "pickup_page", label: "売上サポの資料" }],
  materialText: "物件名 ディアコート曽根\n所在地 大阪府豊中市曽根東町3丁目2-5\n交通 阪急宝塚本線 曽根駅 徒歩14分" });
const casa = T({ name: "カーサ・クラシオンF", room: "102",
  materials: [{ url: "https://x.public.blob.vercel-storage.com/casa.png", kind: "pickup_page", label: "売上サポの資料" }],
  materialText: "所在地\n大阪府豊中市島江町2丁目21番13号" });
const noBanchi = T({ name: "グランエクラ天満", room: "805", materialText: "所在地 大阪府大阪市北区天満3丁目" });
const choice = { target: deare, candidates: [], others: [casa, noBanchi, T({ name: "カーサ・クラシオンF" }), T({ name: "" })] };

console.log("── 候補の並び（見積書作成と同じ選び）");
const cands = viewingCandidatesFromChoice(choice);
it("target → others の順・名前の無い物と同じ建物の号室なしは外す", () => {
  expect(cands.map((c) => c.label)).toBe(["ディアコート曽根 302号室", "カーサ・クラシオンF 102号室", "グランエクラ天満 805号室"]);
});
it("住所は資料の文字の所在地（字のまま）・番地の有無", () => {
  expect(cands.map((c) => [c.address, c.addressHasBanchi])).toBe([
    ["大阪府豊中市曽根東町3丁目2-5", true], ["大阪府豊中市島江町2丁目21番13号", true], ["大阪府大阪市北区天満3丁目", false],
  ]);
});
it("資料の画像は売上サポの資料・お客様の発言で決まった印", () => {
  expect(cands[0].imageUrl).toBe("https://x.public.blob.vercel-storage.com/deare.png");
  expect(cands.map((c) => c.customerPointed)).toBe([true, false, false]);
});

console.log("── 先に選ぶ物（推測しない）");
it("実物（ゆいと 10/6 13:41）待ち合わせ: 「ここも行けますか？」は追加の内覧 → 引用した物件を待ち合わせに先に選ばない", () => {
  const p = preselectViewingCandidates(cands, { mode: "meeting", customerText: "ここも行けますか？" });
  expect(p.keys).toBe([]);
  expect(/追加の内覧/.test(p.reason)).toBe(true);
});
it("待ち合わせ: 欄に1件目の物件名（会話の決まり）が入っていればその候補", () => {
  expect(preselectViewingCandidates(cands, { mode: "meeting", customerText: "ここも行けますか？", currentName: "カーサ・クラシオンF" }).keys).toBe([cands[1].key]);
});
it("待ち合わせ: 追加の形でない引用（「ここ内見したいです」）は引用した物件", () => {
  expect(preselectViewingCandidates(cands, { mode: "meeting", customerText: "ここ内見したいです" }).keys).toBe([cands[0].key]);
});
it("内覧誘導: お客様の発言で決まった物件（追加の形でも）", () => {
  expect(preselectViewingCandidates(cands, { mode: "guide", customerText: "ここも行けますか？" }).keys).toBe([cands[0].key]);
});
it("お客様の発言で決まった物件が無い（こちらの送付・🌟だけ）なら選ばない", () => {
  const ours = viewingCandidatesFromChoice({ target: T({ name: "エスリード長堀タワー", room: "1007", source: "our_rec", sourceLabel: "直近にこちらがオススメしたお部屋（🌟）" }), candidates: [], others: [] });
  expect(preselectViewingCandidates(ours, { mode: "guide", customerText: "内覧したいです" }).keys).toBe([]);
  expect(preselectViewingCandidates(ours, { mode: "meeting", customerText: "内覧したいです" }).keys).toBe([]);
});

it("実物（ゆいと）: 送付の記録の飾り付きの同じお部屋（★築浅★ペット可★ディアコート曽根 302）は1つに寄せ、所在地を補う", () => {
  const d0 = T({ ...deare, materialText: null });
  const deco = T({ name: "★築浅★ペット可★ディアコート曽根", room: "302", materialText: "所在地 大阪府豊中市利倉東１丁目１４－５３" });
  const cs = viewingCandidatesFromChoice({ target: d0, candidates: [], others: [casa, deco] });
  expect(cs.map((c) => c.label)).toBe(["ディアコート曽根 302号室", "カーサ・クラシオンF 102号室"]);
  expect(cs[0].address).toBe("大阪府豊中市利倉東１丁目１４－５３");
});
it("お客様の最新の発言より前の引用は持ち越さない（turnStartAt）", () => {
  // 引用は 10/6 13:41（at を引用の時刻に）・最新の発言は 10/6 15:44「よろしくお願いします。」
  const cs = viewingCandidatesFromChoice({ target: T({ ...deare, at: "2026-10-06T04:41:19Z" }), candidates: [], others: [] });
  expect(preselectViewingCandidates(cs, { mode: "guide", customerText: "よろしくお願いします。", turnStartAt: "2026-10-06T06:44:08Z" }).keys).toBe([]);
  expect(preselectViewingCandidates(cs, { mode: "guide", customerText: "ここも行けますか？", turnStartAt: "2026-10-06T04:41:06Z" }).keys).toBe([cs[0].key]);
});

it("実物（監査）: 申込フォーマットの見出し・（室内イメージ）・特典あり は候補にしない／建物の番号違いは別・1字違いは寄せない（fail-closed）", () => {
  const cs = viewingCandidatesFromChoice({ target: null, candidates: [], others: [
    T({ name: "お申込者様記入欄" }), T({ name: "緊急連絡先欄" }), T({ name: "連帯保証人欄" }), T({ name: "法人御契約" }), T({ name: "（室内イメージ）" }), T({ name: "特典あり" }),
    T({ name: "コンテ池田", room: "203" }), T({ name: "コンチ池田", room: "203" }), T({ name: "ドミール桜川III", room: "203" }), T({ name: "ドミール桜川II", room: "203" }),
  ] });
  expect(cs.map((c) => c.label)).toBe(["コンテ池田 203号室", "コンチ池田 203号室", "ドミール桜川III 203号室", "ドミール桜川II 203号室"]);
});

console.log("── 追加の内覧の形");
it("ここも／こちらも／〇〇も見たい／追加で は追加", () => {
  for (const t of ["ここも行けますか？", "こちらも内見できますか", "このお部屋も見たいです", "追加でお願いします", "ちょっとここも見に行ってみたいです。"]) expect([t, isAdditionalViewingRequest(t)]).toBe([t, true]);
});
it("「ここ内見したいです」「内覧可能ですか？」は追加ではない", () => {
  for (const t of ["ここ内見したいです", "内覧可能ですか？", "13時から14時半でお願いします。"]) expect([t, isAdditionalViewingRequest(t)]).toBe([t, false]);
});

console.log("── 欄の物件名との一致・内覧誘導の枠");
it("「カーサ・クラシオンF 102号室」「カーサ・クラシオンF」は一致・別の号室は不一致", () => {
  expect(candidateMatchesName(cands[1], "カーサ・クラシオンF 102号室")).toBe(true);
  expect(candidateMatchesName(cands[1], "カーサ・クラシオンF")).toBe(true);
  expect(candidateMatchesName(cands[1], "カーサ・クラシオンF 203号室")).toBe(false);
  expect(candidateMatchesName(cands[1], "ディアコート曽根")).toBe(false);
});
it("枠: 空いている最初の枠に入れる・外すと枠を消す（1枠なら空に）・同じ物は二重に入れない", () => {
  let s = [{ name: "", roomNumber: "" }, { name: "", roomNumber: "" }, { name: "", roomNumber: "" }];
  let im = ["", "", ""];
  ({ slots: s, images: im } = toggleCandidateInSlots(s, im, cands[1], true));
  ({ slots: s, images: im } = toggleCandidateInSlots(s, im, cands[0], true));
  ({ slots: s, images: im } = toggleCandidateInSlots(s, im, cands[0], true));
  expect(s.map((x) => `${x.name}|${x.roomNumber}`)).toBe(["カーサ・クラシオンF|102", "ディアコート曽根|302", "|"]);
  expect(im[1]).toBe("https://x.public.blob.vercel-storage.com/deare.png");
  ({ slots: s, images: im } = toggleCandidateInSlots(s, im, cands[1], false));
  expect(s.map((x) => x.name)).toBe(["ディアコート曽根", ""]);
  const one = toggleCandidateInSlots([{ name: "ディアコート曽根", roomNumber: "302" }], ["u"], cands[0], false);
  expect(one).toBe({ slots: [{ name: "", roomNumber: "" }], images: [""] });
});
it("枠が埋まっていれば足す", () => {
  const r = toggleCandidateInSlots([{ name: "A荘", roomNumber: "" }], ["a"], cands[2], true);
  expect(r.slots.map((x) => x.name)).toBe(["A荘", "グランエクラ天満"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
