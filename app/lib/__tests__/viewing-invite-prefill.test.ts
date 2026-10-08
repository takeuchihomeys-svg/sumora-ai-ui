// 2026-10-05 竹内（ゆいと事例）「日程はお客さんから指定がなければいれない」: AIX【内覧へ！】を開いた時の日の先入れ・日程の材料が無い時の出口
// 実行: npx tsx app/lib/__tests__/viewing-invite-prefill.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { customerViewingDateSpec, resolveViewingInvitePrefill, specExtraYmds, stripUnbackedScheduleLines, noSpecBehaviorFromEnv, type ViewingInviteDay } from "../viewing-invite-prefill";
import { extractRequestedViewingDates } from "../viewing-date-request";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { const a = JSON.stringify(actual), b = JSON.stringify(exp); if (a !== b) throw new Error(`expected ${b} but got ${a}`); } };
}

// 2026-10-05(月) 14:48 JST（ゆいと事例の時刻）
const NOW = Date.parse("2026-10-05T14:48:00+09:00");
const conv = (...texts: Array<[string, string]>) => texts.map(([sender, text]) => ({ sender, text }));
const spec = (t: string) => customerViewingDateSpec(conv(["staff", "よろしければ一度ご都合よろしいお日にちにお部屋ご案内させていただきます😊！！"], ["customer", t]), NOW);

// カレンダー: 本日〜1週間（fetchCalendarSlots の基準の日の並び）
const days: ViewingInviteDay[] = [
  { ymd: "2026-10-05", fullyBooked: true, slots: [] },
  { ymd: "2026-10-06", fullyBooked: false, slots: ["12:00〜13:00"] },
  { ymd: "2026-10-07", fullyBooked: false, slots: ["14:00〜16:00"] },
  { ymd: "2026-10-08", fullyBooked: false, slots: ["14:00〜15:00"] },
  { ymd: "2026-10-09", fullyBooked: false, slots: ["11:00〜13:00"] },
  { ymd: "2026-10-10", fullyBooked: false, slots: ["11:00〜13:00"] },
  { ymd: "2026-10-11", fullyBooked: true, slots: [] },
];
const on = (r: { enabled: boolean[] }) => r.enabled.map((b, i) => (b ? days[i].ymd.slice(5) : "")).filter(Boolean).join(",");

console.log("── 指定の読み取り（お客様の最新の発言だけ）");
it("実物（ゆいと 10/5 14:46）「内見いつ行けますでしょうか？」は指定なし", () => {
  expect(spec("ありがとうございます。\n内見いつ行けますでしょうか？").kind).toBe("none");
});
it("「内覧したいです」「なるべく早く見たい」「早めに」は指定なし（推測しない）", () => {
  expect(spec("内覧したいです！").kind).toBe("none");
  expect(spec("なるべく早く見たいです").kind).toBe("none");
  expect(spec("早めに内見お願いできますか？").kind).toBe("none");
});
it("実物（ゆいと 10/6 13:25）「木曜日内見いけますか？」は日付の指定 10/8(木)", () => {
  const s = spec("ありがとうございます。\n木曜日内見いけますか？");
  expect(s.kind).toBe("dates");
  expect(s.kind === "dates" ? s.dates.map((d) => d.label) : []).toBe(["10/8(木)"]);
});
it("「18日はどうでしょうか？」「10月9日で」は日付", () => {
  expect(specExtraYmds(spec("18日はどうでしょうか？"))).toBe(["2026-10-18"]);
  expect(specExtraYmds(spec("10月9日で"))).toBe(["2026-10-09"]);
});
it("「土日なら行けます」＝次の土日（10/10・10/11）", () => {
  const s = spec("土日なら行けます");
  expect(s.kind).toBe("range");
  expect(specExtraYmds(s)).toBe(["2026-10-10", "2026-10-11"]);
});
it("「来週の週末はいかがですか」＝来週の土日（10/17・10/18）", () => {
  expect(specExtraYmds(spec("来週の週末はいかがですか"))).toBe(["2026-10-17", "2026-10-18"]);
});
it("「来週でお願いしたいです」＝来週の月〜日", () => {
  const s = spec("来週でお願いしたいです");
  expect(s.kind === "range" ? [s.ymds[0], s.ymds[s.ymds.length - 1]] : []).toBe(["2026-10-12", "2026-10-18"]);
});
it("「平日だと助かります」＝本日からの平日", () => {
  const s = spec("平日だと助かります");
  expect(s.kind === "range" ? s.ymds.slice(0, 5) : []).toBe(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
});
it("断りの文（「土日は仕事なので」）の幅は読まない", () => {
  expect(spec("土日は仕事なので厳しいです").kind).toBe("none");
});
it("実物（監査 8/17）「毎週土日しか空いてないのですが予定は合いますか？」＝土日（「しか」で限る）", () => {
  expect(specExtraYmds(spec("内見行きたいです！\n毎週土日しか空いてないのですが予定は合いますか？\n出来れば午前中が望ましいです"))).toBe(["2026-10-10", "2026-10-11"]);
});
it("指定はお客様の最新の発言だけ（前の発言の「土日」は読まない）", () => {
  const s = customerViewingDateSpec(conv(["customer", "土日なら行けます"], ["staff", "かしこまりました！！"], ["customer", "内見いつ行けますか？"]), NOW);
  expect(s.kind).toBe("none");
});
it("最後がスタッフでも、その前のお客様の連投を読む", () => {
  const s = customerViewingDateSpec(conv(["customer", "木曜日内見いけますか？"], ["staff", "かしこまりました！！"]), NOW);
  expect(s.kind).toBe("dates");
});

console.log("── 開いた時のチェック");
it("実物（ゆいと）: 指定なし → どの日も入れない・内覧日指定ありで開かない", () => {
  const r = resolveViewingInvitePrefill({ days, spec: spec("内見いつ行けますでしょうか？") });
  expect(on(r)).toBe("");
  expect(r.specificMode).toBe(false);
});
it("日付の指定 → その日だけ・内覧日指定あり", () => {
  const r = resolveViewingInvitePrefill({ days, spec: spec("木曜日内見いけますか？") });
  expect(on(r)).toBe("10-08");
  expect(r.specificMode).toBe(true);
});
it("幅の指定（土日）→ 幅の中の空いている日だけ（10/11 は埋まり）", () => {
  const r = resolveViewingInvitePrefill({ days, spec: spec("土日なら行けます") });
  expect(on(r)).toBe("10-10");
  expect(r.specificMode).toBe(false);
});
it("幅の指定（平日）→ 前から空いている日を最大3つ（本日は埋まり）", () => {
  expect(on(resolveViewingInvitePrefill({ days, spec: spec("平日だと助かります") }))).toBe("10-06,10-07,10-08");
});
it("退去予定物件は 9/19 の決まり（渡された退去日以降の結果）のまま", () => {
  const vac = days.map((d) => d.ymd >= "2026-10-09" && !d.fullyBooked);
  expect(on(resolveViewingInvitePrefill({ days, spec: { kind: "none" }, vacancyEnabled: vac }))).toBe("10-09,10-10");
});
it("戻し（NEXT_PUBLIC_VIEWING_INVITE_PREFILL=nearest3）→ 従来の直近の空いている日3つ", () => {
  expect(noSpecBehaviorFromEnv("nearest3")).toBe("nearest3");
  expect(noSpecBehaviorFromEnv(undefined)).toBe("empty");
  expect(on(resolveViewingInvitePrefill({ days, spec: { kind: "none" }, noSpec: "nearest3", baseCount: 7 }))).toBe("10-06,10-07,10-08");
});

console.log("── 出口: 材料が無いのに出た日程の段");
it("実物の形（ゆいと 10/5 14:48 の生成文）を材料なしで通すと日程の段だけ落ちる", () => {
  const src = "かしこまりました！！\nお部屋ご案内させて頂きます😊！！\n\n直近ですと\n明日 10/6(火) 13:00〜14:00\n10/7(水) 14:00〜16:00\n10/8(木) 14:00〜15:00にてご案内可能です😌！！\n\nゆいとさんご都合よろしいお日にち御座いますでしょうか！！";
  const r = stripUnbackedScheduleLines(src);
  expect(r.text).toBe("かしこまりました！！\nお部屋ご案内させて頂きます😊！！\n\nゆいとさんご都合よろしいお日にち御座いますでしょうか！！");
  expect(r.removed.length).toBe(4);
});
it("日程の無い文は1文字も変えない", () => {
  const src = "かしこまりました！！\nお部屋ご案内させて頂きます！！\nゆいとさんご都合よろしいお日にち御座いますでしょうか😊！！";
  expect(stripUnbackedScheduleLines(src).text).toBe(src);
  expect(stripUnbackedScheduleLines(src).removed.length).toBe(0);
});
it("日付だけ・時刻なしの文（「10/31退去予定」「7/12日以降」）は落とさない", () => {
  const src = "フジパレス西加賀屋 305号室現在募集中となります！！\n7/11日退去予定のお部屋で7/12日以降でお部屋ご案内可能です！！";
  expect(stripUnbackedScheduleLines(src).text).toBe(src);
});
it("行の途中で改行された「ご案内可能です😊！！」も日程の続きとして落とす", () => {
  const r = stripUnbackedScheduleLines("かしこまりました！！\n\n直近ですと\n10/7(水) 14:00〜16:00\nご案内可能です😊！！\n〇〇さんご都合よろしいお日にち御座いますでしょうか！！");
  expect(r.text).toBe("かしこまりました！！\n\n〇〇さんご都合よろしいお日にち御座いますでしょうか！！");
});

console.log("── 既存の日付の読み取りは変わらない（文の切り方を外に出しただけ）");
it("「本日は厳しいので18日はどうでしょうか？」は 18日 だけ（隼斗事例）", () => {
  const n = Date.parse("2026-09-15T14:44:00+09:00");
  expect(extractRequestedViewingDates("本日は厳しいので18日はどうでしょうか？", n).map((d) => d.label)).toBe(["9/18(金)"]);
});

console.log("── 2026-10-08 竹内さん「〇日以降の時は AIX の内覧調整でその日以降で出す」（お客様の事情）");
const at = (iso: string) => `${iso}+09:00`;
const convAt = (...rows: Array<[string, string, string]>) => rows.map(([sender, text, t]) => ({ sender, text, rawCreatedAt: new Date(Date.parse(at(t))).toISOString() }));
it("前の発言「都合つくのが10月8日以降になりそうです」→ 今の発言に日付なし → 10/8 からの幅（10/8・10/9・10/10）", () => {
  const s = customerViewingDateSpec(convAt(
    ["customer", "内覧は都合つくのが10月8日以降になりそうです🙇", "2026-10-03T12:00:00"],
    ["staff", "かしこまりました！！", "2026-10-03T12:10:00"],
    ["customer", "ここめっちゃいいですね！内覧したいです！", "2026-10-05T14:40:00"],
  ), NOW);
  expect(s.kind).toBe("range");
  expect(on(resolveViewingInvitePrefill({ days, spec: s }))).toBe("10-08,10-09,10-10");
  expect(specExtraYmds(s)[0]).toBe("2026-10-08");
});
it("今の発言「20日以降でお願いします」はその日だけ（内覧日指定あり）でなく 20日からの幅", () => {
  const s = spec("20日以降でお願いします");
  expect(s.kind).toBe("range");
  expect(specExtraYmds(s).slice(0, 2)).toBe(["2026-10-20", "2026-10-21"]);
});
it("「20日でお願いします」（以降なし）は今まで通りその日だけ", () => expect(spec("20日でお願いします").kind).toBe("dates"));
it("前の発言の日付が過ぎていれば使わない（指定なし＝どの日も入れない）", () => {
  const s = customerViewingDateSpec(convAt(
    ["customer", "内覧は都合つくのが10月2日以降になりそうです", "2026-09-28T12:00:00"],
    ["customer", "内覧したいです！", "2026-10-05T14:40:00"],
  ), NOW);
  expect(s.kind).toBe("none");
});
it("時刻の無い発言（rawCreatedAt なし）は前の発言の事情を読まない＝今まで通り", () => expect(spec("ここ内覧したいです").kind).toBe("none"));
it("NEXT_PUBLIC_VIEWING_INVITE_FROM_CIRCUMSTANCE=off で今まで通り（以降でもその日だけ）", () => {
  process.env.NEXT_PUBLIC_VIEWING_INVITE_FROM_CIRCUMSTANCE = "off";
  expect(spec("20日以降でお願いします").kind).toBe("dates");
  delete process.env.NEXT_PUBLIC_VIEWING_INVITE_FROM_CIRCUMSTANCE;
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
