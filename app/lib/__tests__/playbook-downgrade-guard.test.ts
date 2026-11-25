/**
 * 手順書を古いコードで上書きしない（2.8.297・2026-11-25 22:00 の実測: 本番の古い main が 91件→23件へ戻した）
 * 実行: npx tsx app/lib/__tests__/playbook-downgrade-guard.test.ts
 */
import { cmpVer, isPlaybookNewerThanCode, pickNewestPlaybook } from "../playbook-freshness";
import { prepareBundleForWrite } from "../bundle-write-prepare";
import { buildPlaybook, PLAYBOOK_BUILD_V } from "../action-playbook";
import { AUTO_RULES_REVIEWED_UP_TO } from "../auto-procedure-rules";
import { inheritLinkFoundations } from "../learn-bundle-preserve";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, detail !== undefined ? JSON.stringify(detail) : ""); }
}

const CODE = { upTo: AUTO_RULES_REVIEWED_UP_TO, build: PLAYBOOK_BUILD_V };
const NEWER = { rules_up_to: "2.99.0", build_v: PLAYBOOK_BUILD_V, rules_v: "newer-rv", marker: "kept" };
const OLDER = { rules_up_to: "2.8.154", build_v: 6, rules_v: "old-rv" };

console.log("■ 版の比べ（数で桁ごと）");
ok("2.8.1000 は 2.8.295 より新しい", cmpVer("2.8.1000", "2.8.295") > 0);
ok("2.8.296 = 2.8.296", cmpVer("2.8.296", "2.8.296") === 0);
ok("空は古い扱い", cmpVer("", "2.8.1") < 0);

console.log("■ いまの手順書がコードより新しいか");
ok("版が新しい → 新しい", isPlaybookNewerThanCode(NEWER, CODE) === true);
ok("版が古い → 新しくない", isPlaybookNewerThanCode(OLDER, CODE) === false);
ok("版なし（古い手順書）は何にも勝たない", isPlaybookNewerThanCode({ build_v: 99 }, CODE) === false);
ok("null は新しくない", isPlaybookNewerThanCode(null, CODE) === false);
ok("同じ版で作り方が新しい → 新しい", isPlaybookNewerThanCode({ rules_up_to: CODE.upTo, build_v: CODE.build + 1 }, CODE) === true);
ok("同じ版・同じ作り方 → 新しくない（作り直してよい）", isPlaybookNewerThanCode({ rules_up_to: CODE.upTo, build_v: CODE.build }, CODE) === false);

console.log("■ 一番新しい手順書を選ぶ");
ok("版なしは選ばない", pickNewestPlaybook([{ build_v: 9 }]) === null);
ok("新しい版を選ぶ", pickNewestPlaybook([OLDER, NEWER, { rules_up_to: "2.8.200", build_v: 7 }]) === NEWER);

console.log("■ 作った手順書に版が付く");
{
  const pb = buildPlaybook({} as never);
  ok("rules_up_to がコードの版", pb.rules_up_to === AUTO_RULES_REVIEWED_UP_TO, pb.rules_up_to);
  const pb2 = buildPlaybook({} as never);
  ok("版（version）の計算に rules_up_to を入れない（同じ材料なら同じ）", pb.version === pb2.version);
}

console.log("■ prepareBundleForWrite: 新しい手順書は作り直さず残す");
{
  const b: Record<string, unknown> = { generated_at: "2026-11-25T00:00:00Z", playbook: { ...NEWER } };
  const r = prepareBundleForWrite(b);
  ok("残したと返す", r.playbook_kept_newer === true && r.playbook_ok === true, r);
  ok("手順書はそのまま（印が残る）", (b.playbook as { marker?: string }).marker === "kept");
  ok("generated_at を上げない", b.generated_at === "2026-11-25T00:00:00Z", b.generated_at);
}
console.log("■ prepareBundleForWrite: 古い・同じ手順書は作り直す");
{
  const b: Record<string, unknown> = { generated_at: "2026-11-25T00:00:00Z", playbook: { ...OLDER } };
  const r = prepareBundleForWrite(b);
  ok("作り直す", r.playbook_kept_newer === false && (b.playbook as { rules_up_to?: string }).rules_up_to === AUTO_RULES_REVIEWED_UP_TO, r);
  ok("決まりの版が変わったので generated_at を上げた", r.playbook_ver_bumped === true && b.generated_at !== "2026-11-25T00:00:00Z");
  const b2: Record<string, unknown> = {};
  const r2 = prepareBundleForWrite(b2);
  ok("手順書なしでも作る", r2.playbook_ok === true && r2.playbook_kept_newer === false);
}
console.log("■ 止める印: PLAYBOOK_DOWNGRADE_GUARD=off で今まで通り作り直す");
{
  process.env.PLAYBOOK_DOWNGRADE_GUARD = "off";
  const b: Record<string, unknown> = { playbook: { ...NEWER } };
  const r = prepareBundleForWrite(b);
  ok("off なら作り直す", r.playbook_kept_newer === false && (b.playbook as { marker?: string }).marker !== "kept");
  delete process.env.PLAYBOOK_DOWNGRADE_GUARD;
}

console.log("■ 引き継ぎ（履歴の新しい手順書）→ 作り直しでも残る・DB には出ない");
async function inheritCase() {
  const hist = [
    { bundle: { shots: { learned: {} }, playbook: { ...OLDER } }, created_at: "2026-11-25T13:00:00Z" },
    { bundle: { shots: { learned: {} }, playbook: { ...NEWER } }, created_at: "2026-11-25T12:00:00Z" },
  ];
  const sb = {
    from() {
      const b = {
        select() { return b; }, eq() { return b; }, order() { return b; }, gte() { return b; }, lte() { return b; }, or() { return b; },
        limit() { return Promise.resolve({ data: hist, error: null }); },
      };
      return b;
    },
  } as unknown as Parameters<typeof inheritLinkFoundations>[0];
  const nb: Record<string, unknown> = { shots: { total: 1 }, source: { rows: 1 } };
  await inheritLinkFoundations(sb, nb, "realpro", { lookback: 80, minSolid: 30 });
  ok("JSON にも DB にも印が出ない（列挙されない）", !JSON.stringify(nb).includes("__prev_playbook") && !Object.keys(nb).includes("__prev_playbook"));
  const r = prepareBundleForWrite(nb);
  ok("履歴の新しい手順書を残した（古い物は選ばない）", r.playbook_kept_newer === true && (nb.playbook as { marker?: string }).marker === "kept", r);
  ok("印は消える", (nb as { __prev_playbook?: unknown }).__prev_playbook === undefined);
}

console.log("■ 細く読む設定（本番の標準）でも歯止めが働く：印だけ読み、新しい時だけ本体を1回読む");
async function slimCase() {
  const queries: string[] = [];
  const mkSb = (slimRows: unknown[]) => ({
    from() {
      let cols = "";
      const b = {
        select(c: string) { cols = String(c); queries.push(cols.includes("playbook:bundle->playbook") ? "FULL_PB" : "SLIM"); return b; },
        eq() { return b; }, order() { return b; }, gte() { return b; }, lte() { return b; }, or() { return b; },
        limit() {
          if (cols.includes("playbook:bundle->playbook")) return Promise.resolve({ data: [{ playbook: { ...NEWER } }], error: null });
          return Promise.resolve({ data: slimRows, error: null });
        },
      };
      return b;
    },
  } as unknown as Parameters<typeof inheritLinkFoundations>[0]);
  const slimNewer = [
    { created_at: "2026-11-25T13:00:00Z", shots: { learned: {} }, pb_up_to: "2.8.154", pb_build: "6" },
    { created_at: "2026-11-25T12:00:00Z", shots: { learned: {} }, pb_up_to: "2.99.0", pb_build: String(PLAYBOOK_BUILD_V) },
  ];
  const nb: Record<string, unknown> = { shots: { total: 1 }, source: { rows: 1 } };
  await inheritLinkFoundations(mkSb(slimNewer), nb, "realpro", { lookback: 80, minSolid: 30 });
  ok("印だけ読み、本体は1回だけ読む", queries.filter((q) => q === "FULL_PB").length === 1 && queries.includes("SLIM"), queries);
  const r = prepareBundleForWrite(nb);
  ok("新しい手順書を残した（細い読みでも）", r.playbook_kept_newer === true && (nb.playbook as { marker?: string }).marker === "kept", r);
  ok("印の道具（__stamp_only 等）は手順書に混ざらない", !JSON.stringify(nb.playbook).includes("__stamp_only") && !JSON.stringify(nb.playbook).includes("__at"));

  queries.length = 0;
  const slimOlder = [{ created_at: "2026-11-25T13:00:00Z", shots: { learned: {} }, pb_up_to: "2.8.154", pb_build: "6" }];
  const nb2: Record<string, unknown> = { shots: { total: 1 }, source: { rows: 1 } };
  await inheritLinkFoundations(mkSb(slimOlder), nb2, "realpro", { lookback: 80, minSolid: 30 });
  ok("コードより新しい物が無ければ本体は読まない（余計な読みをしない）", !queries.includes("FULL_PB"), queries);
  const r2 = prepareBundleForWrite(nb2);
  ok("作り直す", r2.playbook_kept_newer === false && (nb2.playbook as { rules_up_to?: string }).rules_up_to === AUTO_RULES_REVIEWED_UP_TO);

  queries.length = 0;
  const slimNone = [{ created_at: "2026-11-25T13:00:00Z", shots: { learned: {} } }];
  const nb3: Record<string, unknown> = { shots: { total: 1 }, source: { rows: 1 } };
  await inheritLinkFoundations(mkSb(slimNone), nb3, "realpro", { lookback: 80, minSolid: 30 });
  ok("手順書の印が無い行（古い）だけなら何もしない", !queries.includes("FULL_PB") && prepareBundleForWrite(nb3).playbook_kept_newer === false);
}

inheritCase().then(slimCase).then(() => {
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
});
