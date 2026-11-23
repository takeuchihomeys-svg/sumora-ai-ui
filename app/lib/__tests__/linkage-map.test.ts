// npx tsx app/lib/__tests__/linkage-map.test.ts
// 2026-11-15 作業員L: 連携の地図（行の形・状態の決め方・要約・md）とスイッチの既定の読み方
import assert from "node:assert/strict";
import { LINKAGE_MAP, STAGES, rowStatus, switchStateOf, metaFills, summaryLine, formatLinkageMd, mapSwitchNames, nonEmptyAt, type LinkageRow } from "../linkage-map";
import { LINKAGE_SWITCH_DEFAULTS } from "../linkage-switch-defaults";
import { compactResult } from "../linkage-watch-server";
import { defaultOfSnippet, scanSwitchDefaults } from "../../../scripts/lib/switch-default-scan";
import { buildDefaultsFile } from "../../../scripts/linkage-switch-defaults";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("行の id は重ならない・段は STAGES のどれか・持ち主と次の一手がある", () => {
  const ids = LINKAGE_MAP.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of LINKAGE_MAP) { assert.ok(STAGES.some((s) => s.id === r.stage), r.id); assert.ok(r.owner && r.name && r.next, r.id); }
});
t("読む側に地図の id の形（xxx.yyy）を書いたら、その行がある", () => {
  const ids = new Set(LINKAGE_MAP.map((r) => r.id));
  for (const r of LINKAGE_MAP) for (const x of r.readers) if (/^[a-z_]+\.[a-z_]+$/.test(x)) assert.ok(ids.has(x), `${r.id} → ${x}`);
});
t("地図のスイッチは全部コードにある（なし＝名前の誤り）・既定のファイルは今のソースと同じ", () => {
  for (const s of mapSwitchNames()) assert.notEqual(LINKAGE_SWITCH_DEFAULTS[s] ?? "なし", "なし", s);
  const cur = readFileSync(join(__dirname, "../linkage-switch-defaults.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(cur, buildDefaultsFile(), "npx tsx scripts/linkage-switch-defaults.ts --write");
});
t("既定の読み方（?? の値・=== on・!== off・=== off ? off : shadow・v の形）", () => {
  assert.equal(defaultOfSnippet(`.X ?? "").trim().toLowerCase() === "on";`, "X"), "off");
  assert.equal(defaultOfSnippet(`.X ?? "").trim().toLowerCase() !== "off";`, "X"), "on");
  assert.equal(defaultOfSnippet(`.X ?? "on").trim().toLowerCase() !== "off";`, "X"), "on");
  assert.equal(defaultOfSnippet(`.X ?? "").trim().toLowerCase() === "off" ? "off" : "shadow";`, "X"), "shadow");
  assert.equal(defaultOfSnippet(`.X ?? "").trim().toLowerCase(); return v === "shadow" || v === "on" ? "shadow" : "off";`, "X"), "off");
  const r = scanSwitchDefaults(["X", "Y"], [{ path: "a.ts", text: `const a = (env.X ?? "").trim() === "on";\nprocess.env.X = "on";` }, { path: "b.ts", text: `!off(envOf(env).Y)` }]);
  assert.equal(r[0].def, "off"); assert.equal(r[1].def, "on");
});
t("本番の値 → 既定 → 記録の外", () => {
  assert.deepEqual(switchStateOf("BRAIN_A", { BRAIN_A: "on" }, {}, ["BRAIN_"]), { name: "BRAIN_A", value: "on", from: "prod", on: true });
  assert.equal(switchStateOf("BRAIN_B", { BRAIN_A: "on" }, { BRAIN_B: "off" }, ["BRAIN_"]).from, "default");
  assert.equal(switchStateOf("OTHER_X", { BRAIN_A: "on" }, { OTHER_X: "shadow" }, ["BRAIN_"]).from, "unknown");
  assert.equal(switchStateOf("OTHER_X", null, { OTHER_X: "shadow" }, ["BRAIN_"]).on, true);
});
const row = (o: Partial<LinkageRow>): LinkageRow => ({ id: "x.y", stage: "read", name: "n", producer: "p", key: "meta.k", readers: ["r"], switches: [], readerSwitches: [], fill: { src: "meta", path: "k" }, owner: "o", layer: "連携", next: "-", ...o });
const sw = (vals: Record<string, string>) => (name: string) => switchStateOf(name, vals, {}, [""]);
t("状態: 親が off・読む側が off・欄が全部空・空が多い・つながっている・onWhen", () => {
  assert.equal(rowStatus(row({ switches: ["A"] }), sw({ A: "off" }), {}).status, "parent_off");
  assert.equal(rowStatus(row({ readerSwitches: ["B"] }), sw({ B: "off" }), { "x.y": { rate: 1, n: 3 } }).status, "broken");
  assert.equal(rowStatus(row({}), sw({}), { "x.y": { rate: 0, n: 5 } }).status, "broken");
  assert.equal(rowStatus(row({}), sw({}), { "x.y": { rate: 0.1, n: 10 } }).status, "sparse");
  assert.equal(rowStatus(row({}), sw({}), { "x.y": { rate: 0.8, n: 10 } }).status, "connected");
  assert.equal(rowStatus(row({ switches: ["T"], onWhen: { T: ["on"] } }), sw({ T: "log" }), {}).status, "parent_off");
  assert.equal(rowStatus(row({ fill: { src: "rag", name: "r" } }), sw({}), {}).status, "unknown");
  assert.equal(rowStatus(row({ producer: "（無い）" }), sw({}), {}).status, "broken");
});
t("meta の欄の空の割合・道の読み", () => {
  assert.equal(nonEmptyAt({ a: { b: [1] } }, "a.b"), true);
  assert.equal(nonEmptyAt({ a: { b: [] } }, "a.b"), false);
  const f = metaFills([{ conductor_focus: { focus: "answer" } }, {}]);
  assert.deepEqual(f["conductor.focus"], { rate: 0.5, n: 2 });
});
t("要約の1行（先週からの増減）と md（切れている行が一番上・段ごと）", () => {
  const results = [{ id: "read.brain", status: "broken" as const, why: "w", fill: 0, fillN: 3, offSwitches: [], offReaders: [] }, { id: "in.messages", status: "connected" as const, why: "", fill: 1, fillN: 3, offSwitches: [], offReaders: [] }];
  assert.match(summaryLine({ results, prevBroken: 3 }), /切れている 1行.*先週 3 → 1（-2）/);
  const md = formatLinkageMd({ at: "t", results, prevBroken: null, switches: {} });
  assert.ok(md.indexOf("## 切れている行") < md.indexOf("## ① お客様の通・画像"));
  assert.match(md, /\| 切れている \| ② ブレインの読み \|/);
});
// 2026-11-23 作業員L: 見張りの記録に測れなかった行（unknown）の名前と理由が残る（読む側が「つながっている」と見ないように）
{
  const rep = { at: "t", prevBroken: null, switches: {}, summary: "s", notes: [], results: [
    { id: "a", status: "connected", why: "ok", fill: 1, fillN: 3, offSwitches: [], offReaders: [] },
    { id: "b", status: "unknown", why: "本番の記録を読めなかった", fill: null, fillN: null, offSwitches: [], offReaders: [] },
    { id: "c", status: "broken", why: "読む側が無い", fill: null, fillN: null, offSwitches: [], offReaders: [] },
  ] } as never;
  const c = compactResult(rep);
  assert.equal(c.unknown, 1);
  assert.deepEqual(c.unmeasured, [{ id: "b", why: "本番の記録を読めなかった" }]);
  assert.deepEqual(c.cut.map((x) => x.id), ["c"]);
  console.log("linkage-watch unmeasured ok");
}
console.log(`${n} tests ok`);
