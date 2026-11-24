// 台帳の built_off の行の off の理由と継ぎ目（scripts/lib/off-reason.ts）
// 実行: npx tsx scripts/lib/__tests__/off-reason.test.ts（全 PASS で exit 0）
import { classifyOff, jointOf, blockRanking, defaultsFromCode, chainPlaceOf, groupByPart, autoReadersOf, titlePlaceOf, majorityPlace, type OffItem } from "../off-reason";
import type { LinkageRow } from "../../../app/lib/linkage-map";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const row = (o: Partial<LinkageRow> & { id: string; stage: LinkageRow["stage"] }): LinkageRow => ({ name: o.id, producer: "-", key: "-", readers: [], switches: [], readerSwitches: [], fill: { src: "meta", path: "x" } as never, owner: "-", layer: "土台", next: "-", ...o });
const map = [
  row({ id: "read.x", stage: "read", switches: ["X_MAT"], readers: ["conductor.compose_plan"] }),
  row({ id: "read.y", stage: "read", switches: ["Y_MAT"], readers: ["next.measure"] }),
  row({ id: "read.z", stage: "read", switches: ["Z_MAT"], readers: ["conductor.brief"] }),
  row({ id: "conductor.brief", stage: "conductor", switches: ["BRIEF"], readers: ["writer.reply"] }),
  row({ id: "writer.w", stage: "writer", switches: ["W_USE"], readers: ["check.final"] }),
];
const I = (o: Partial<OffItem>): OffItem => ({ id: 1, title: "t", owner: "作業員A", switch_name: null, ...o });
const ctx = { map, readInCode: new Set(["X_MAT", "Y_MAT", "Z_MAT", "W_USE", "BRIEF", "Q"]), defaults: new Map<string, "on" | "off">([["BRIEF", "off"]]), mapLine: new Map([["read.x", 10]]), composePlanMade: { made: 9, n: 128 } };

ok("「悪化0なら既定 on」は悪化ではない", classifyOff(I({ switch_name: "Q", next_step: "試験を積んで悪化0なら既定 on" }), ctx).reason === "d");
ok("試験で悪化した行は (c)", classifyOff(I({ switch_name: "Q", exam_labels: ["l1"], exam_result: "q197 が悪化1" }), ctx).reason === "c");
ok("竹内さん待ちは (e)", classifyOff(I({ switch_name: "Q", next_step: "竹内さんの確認待ち" }), ctx).reason === "e");
const va = classifyOff(I({ switch_name: "X_MAT" }), ctx);
ok("材料を作る側が off は (a)・届いていない", va.reason === "a" && va.reach === "届いていない" && va.parts[0] === "read.x");
ok("材料を使う側（書き手）が off は (b)・届いている", classifyOff(I({ switch_name: "W_USE" }), ctx).reason === "b");
ok("コードに読む所が無いスイッチは (a) 配線なし", classifyOff(I({ switch_name: "NO_WHERE" }), ctx).parts[0] === "配線なし");
const jx = jointOf(va, ctx);
ok("設計図を読む材料は ③統括が読む（9/128 の証拠つき）", jx.joint === 3 && jx.evidence.includes("9/128") && jx.evidence.includes("linkage-map.ts:10"), jx);
ok("物差しだけが読む材料は ③（統括の読む所なし）", jointOf(classifyOff(I({ switch_name: "Y_MAT" }), ctx), ctx).joint === 3);
ok("統括の読む行の作る側が既定 off なら ③（そのスイッチの名前）", jointOf(classifyOff(I({ switch_name: "Z_MAT" }), ctx), ctx).block.includes("BRIEF"));
ok("書き手の部品は ⑤", jointOf(classifyOff(I({ switch_name: "W_USE" }), ctx), ctx).joint === 5);
ok("継ぎ目の順位は行の多い順", blockRanking([{ id: 1, joint: 3, block: "A", evidence: "" }, { id: 2, joint: 3, block: "A", evidence: "" }, { id: 3, joint: 5, block: "B", evidence: "" }])[0].rows.length === 2);
const d = defaultsFromCode('x(env.A_ON ?? "").trim() !== "off"; y(env.B_OFF ?? "").trim().toLowerCase() === "on";', ["A_ON", "B_OFF", "C_NONE"]);
ok("コードの既定を読む（!== off＝on・=== on＝off・無い物は無し）", d.get("A_ON") === "on" && d.get("B_OFF") === "off" && !d.has("C_NONE"));
ok("鎖の場所はファイルで（compose＝④・書き手＝⑤・最終チェック＝⑥）", chainPlaceOf("app/lib/compose-head.ts") === 4 && chainPlaceOf("app/api/aix-template-generate/route.ts") === 5 && chainPlaceOf("app/lib/final-check.ts") === 6 && chainPlaceOf("app/lib/zzz.ts") === null);
ok("部品ごとにまとめ、設計図を読む部品に印", groupByPart([va], map, []).some((g) => g.part === "read.x" && g.composePlan));

// #675 の続き（11/24 夕）: 地図の外のブレインの材料の行の読む側
const FS = [
  { path: "app/lib/brain-x.ts", text: "export const xOn = () => (process.env.X_SW ?? \"\") === \"on\";\nfunction xLine() { return xOn() ? \"a\" : \"\"; }\nexport function xBlock() { return xLine(); }" },
  { path: "app/lib/brain-core.ts", text: "const a = xBlock();\nconst meta = {\n  feel_inputs: process.env.F_SW === \"on\" ? 1 : undefined,\n  seen_note: process.env.S_SW === \"on\" ? 1 : undefined,\n};" },
  { path: "app/lib/conductor-brief.ts", text: "const s = meta.seen_note;" },
];
ok("入口を同じファイルの中でたどり brain-core が呼ぶ＝ブレインの入力", autoReadersOf("app/lib/brain-x.ts", 1, FS).readers[0] === "read.brain", autoReadersOf("app/lib/brain-x.ts", 1, FS));
ok("ブレインの欄を統括が読まない＝読む側なし", autoReadersOf("app/lib/brain-core.ts", 3, FS).readers.length === 0 && /feel_inputs/.test(autoReadersOf("app/lib/brain-core.ts", 3, FS).why));
ok("ブレインの欄を統括が読む＝conductor.brief", autoReadersOf("app/lib/brain-core.ts", 4, FS).readers[0] === "conductor.brief");
ok("題の言葉で場所（物差し＝⑧）", titlePlaceOf("土台「約束」の物差しが無い").place === 8);
ok("題で決まらない時は null", titlePlaceOf("拡張の束の作り直し").place === null);
ok("読み込む所の多数（同数は前の方）", majorityPlace([5, 1, 5, null]) === 5 && majorityPlace([5, 1]) === 1);

console.log(`off-reason: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
