// AIX【内覧へ！】の時間帯の指定（「朝方は空いてないでしょうか」）を前の流れの日に重ねる（viewing-invite-prefill・NEXT_PUBLIC_VIEWING_TIME_OF_DAY）— LLM なし
// 実物: 10/20 会話H（お客様の名前は伏せた）。実行: npx tsx app/lib/__tests__/viewing-time-of-day.test.ts
import { customerViewingDateSpec, resolveViewingInvitePrefill, viewingTimeOfDayEnabled, TIME_OF_DAY_WINDOW } from "../viewing-invite-prefill";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

const NOW = Date.parse("2026-10-19T19:00:00+09:00");
const MSGS = [
  { sender: "customer", text: "今週の土曜内覧可能ですか？" },
  { sender: "staff", text: "〇〇さんお世話になっております！！\nかしこまりました！！\n2部屋まとめてお部屋ご案内させて頂きます！！\n\n10/24(土) 14:00〜16:00 \nご案内可能です😊！！\n\n〇〇さんご都合よろしいお時間御座いますでしょうか😌！！" },
  { sender: "customer", text: "朝方は空いてないでしょうか？" },
];
const days = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-24"].map((ymd) => ({ ymd, fullyBooked: false, slots: ["11:00〜18:30"] }));

console.log("viewing-time-of-day");
it("切替は既定 off・off は今まで通り（日の指定なし）", () => {
  delete process.env.NEXT_PUBLIC_VIEWING_TIME_OF_DAY;
  eq(viewingTimeOfDayEnabled(), false);
  eq(customerViewingDateSpec(MSGS, NOW).kind, "none");
});
it("on: 前の流れの日（10/24）＋朝方 → その日だけ・10:30〜12:00", () => {
  process.env.NEXT_PUBLIC_VIEWING_TIME_OF_DAY = "on";
  try {
    const sp = customerViewingDateSpec(MSGS, NOW);
    eq(sp.kind, "dates");
    if (sp.kind !== "dates") return;
    eq(sp.dates.map((d) => d.ymd), ["2026-10-24"]);
    eq(sp.timeOfDay, "morning");
    const pf = resolveViewingInvitePrefill({ days, spec: sp });
    eq(pf.enabled, [false, false, false, true]);
    eq(pf.timeWindow, TIME_OF_DAY_WINDOW.morning);
  } finally { delete process.env.NEXT_PUBLIC_VIEWING_TIME_OF_DAY; }
});
it("on: 日付も時間帯も同じ発言（「土曜の午前中」）", () => {
  process.env.NEXT_PUBLIC_VIEWING_TIME_OF_DAY = "on";
  try {
    const sp = customerViewingDateSpec([{ sender: "customer", text: "24日の午前中は空いてますか？" }], NOW);
    eq(sp.kind === "dates" ? [sp.dates[0].ymd, sp.timeOfDay] : null, ["2026-10-24", "morning"]);
  } finally { delete process.env.NEXT_PUBLIC_VIEWING_TIME_OF_DAY; }
});
it("on: 前に日が無ければ今まで通り（時間帯だけでは日を作らない）", () => {
  process.env.NEXT_PUBLIC_VIEWING_TIME_OF_DAY = "on";
  try {
    eq(customerViewingDateSpec([{ sender: "staff", text: "ご都合よろしいお日にち御座いますか" }, { sender: "customer", text: "朝方がいいです" }], NOW).kind, "none");
  } finally { delete process.env.NEXT_PUBLIC_VIEWING_TIME_OF_DAY; }
});
it("「夜分遅くに失礼致します」は時間帯の指定ではない", () => {
  process.env.NEXT_PUBLIC_VIEWING_TIME_OF_DAY = "on";
  try {
    eq(customerViewingDateSpec([...MSGS.slice(0, 2), { sender: "customer", text: "夜分遅くに失礼致します。2部屋とも見たいです" }], NOW).kind, "none");
  } finally { delete process.env.NEXT_PUBLIC_VIEWING_TIME_OF_DAY; }
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
