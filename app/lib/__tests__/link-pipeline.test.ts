// 2026-11-15「ちゃんと連携できるようにボトルネック改善／会話の時統括把握」
import { buildLinkPipeline } from "../bundle-reflect";

function ok(name: string, cond: boolean) {
  if (!cond) throw new Error("FAIL: " + name);
  console.log("  OK", name);
}

console.log("■ 連携パイプライン（ボトルネック把握）");

const stuck4 = buildLinkPipeline({
  photoInStorage: 262,
  withOps: 200,
  screenSolid: 33,
  screenAll: 71,
  hint: { read_count: 0, read_at: null, auto_after: false, bundle_at: null },
});
ok("段階4で止まる", stuck4.bottleneck_n === 4);
ok("ボトルネック文に拡張", !!(stuck4.bottleneck && /拡張|read_count/.test(stuck4.bottleneck)));
ok("line に Storage✓", /1\.写真Storage保存✓/.test(stuck4.line));
ok("line に拡張✗", /4\.拡張が束を読む✗/.test(stuck4.line));

const done = buildLinkPipeline({
  photoInStorage: 100,
  withOps: 80,
  screenSolid: 20,
  screenAll: 40,
  hint: { read_count: 2, read_at: "2026-11-15T14:00:00Z", auto_after: true, bundle_at: null },
});
ok("全部OKなら bottleneck null", done.bottleneck_n === null && done.bottleneck === null);
ok("連携完了と書く", /連携完了/.test(done.line));

const stuck1 = buildLinkPipeline({
  photoInStorage: 0,
  withOps: 10,
  screenSolid: 0,
  screenAll: 0,
  hint: { read_count: 0, read_at: null, auto_after: false, bundle_at: null },
});
ok("写真0なら段階1で止まる", stuck1.bottleneck_n === 1);

console.log("\n止まっている例:", stuck4.line);
console.log("すべて合格");
