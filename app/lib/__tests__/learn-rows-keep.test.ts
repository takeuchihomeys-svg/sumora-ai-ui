// 2026-11-20 竹内さん「画像多すぎたらそこでデータくっているのではないか」
//   実測: 新しい順 10,000行の上限で、読んだ写真 5,870枚のうち 4,684枚が束の外だった。
import { readRowsKeepingLearned, KEEP_OUTSIDE_CAP_OR, BUNDLE_MOTION_COLS } from "../learn-rows-keep";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log("✓", name); } else { fail++; console.log("✗", name, detail === undefined ? "" : JSON.stringify(detail)); }
};

type R = { created_at: string; mode: string; learned: boolean };
// 新しい順の行（i が大きいほど古い）
const mk = (n: number, learnedEvery: number): R[] =>
  Array.from({ length: n }, (_, i) => ({
    created_at: new Date(Date.UTC(2026, 10, 20) - i * 1000).toISOString(),
    mode: i % 5 === 0 ? "normal" : "aix",
    learned: i % learnedEvery === 0,
  }));

function db(all: R[]) {
  const calls: string[] = [];
  return {
    calls,
    newest: async (a: number, b: number) => { calls.push(`n${a}`); return { data: all.slice(a, b + 1), error: null }; },
    olderKept: async (edge: string, a: number, b: number) => {
      calls.push(`k${a}`);
      const older = all.filter((r) => r.created_at < edge && (r.learned || r.mode === "normal"));
      return { data: older.slice(a, b + 1), error: null };
    },
  };
}

void (async () => {
  {
    const all = mk(2500, 7);
    const d = db(all);
    const r = await readRowsKeepingLearned({ maxRows: 1000, pageSize: 100, newest: d.newest, olderKept: d.olderKept });
    const outside = all.slice(1000);
    const want = outside.filter((x) => x.learned || x.mode === "normal").length;
    ok("上限に当たったと分かる", r.capped);
    ok("新しい順は上限まで", r.rows.slice(0, 1000).every((x, i) => x === all[i]));
    ok("上限の外の読んだ写真・通常録画は全部足す", r.kept === want, { kept: r.kept, want });
    ok("上限の外の自動の未読写真は足さない", r.rows.slice(1000).every((x) => x.learned || x.mode === "normal"));
    ok("重複なし（lt で境目より古い物だけ）", new Set(r.rows.map((x) => x.created_at)).size === r.rows.length);
    ok("読んだ写真は1枚も落ちない", all.filter((x) => x.learned).every((x) => r.rows.includes(x)));
  }
  {
    const all = mk(300, 3);
    const d = db(all);
    const r = await readRowsKeepingLearned({ maxRows: 1000, pageSize: 100, newest: d.newest, olderKept: d.olderKept });
    ok("上限に届かない時は今まで通り（別枠を読まない）", !r.capped && r.kept === 0 && r.rows.length === 300 && !d.calls.some((c) => c.startsWith("k")), d.calls);
  }
  {
    const all = mk(1500, 2);
    const d = db(all);
    const r = await readRowsKeepingLearned({
      maxRows: 1000, pageSize: 100, newest: d.newest,
      olderKept: async () => ({ data: null, error: { message: "timeout" } }),
    });
    ok("別枠が読めなくても束は作れる（fail-open・理由を返す）", !r.error && r.rows.length === 1000 && r.keptError === "timeout");
  }
  {
    const r = await readRowsKeepingLearned({
      maxRows: 1000, pageSize: 100,
      newest: async () => ({ data: null, error: { message: "boom" } }),
      olderKept: async () => ({ data: [], error: null }),
    });
    ok("新しい順が読めない時はエラーを返す", r.error === "boom");
  }
  ok("別枠の条件は読んだ写真か通常録画", KEEP_OUTSIDE_CAP_OR === "shot_learn.not.is.null,mode.eq.normal");
  ok("束の列に写真そのもの（shot_b64）を入れない", !(BUNDLE_MOTION_COLS as readonly string[]).includes("shot_b64"));
  ok("束の列に shot_learn・shot_ops・mode がある", ["shot_learn", "shot_ops", "mode", "created_at"].every((c) => (BUNDLE_MOTION_COLS as readonly string[]).includes(c)));

  const fs = await import("fs");
  const path = await import("path");
  const root = path.join(__dirname, "../../..");
  const src = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
  const sls = src("app/lib/shot-learn-server.ts");
  ok("写真学習の後の作り直しは select(\"*\") で読まない", !/from\("human_motion_learn"\)\.select\("\*"\)/.test(sls));
  for (const f of ["app/lib/shot-learn-server.ts", "app/api/human-learn-profile/route.ts", "app/api/cron/human-learn-brain/route.ts"]) {
    ok(`${f} は上限の外の学びを別枠で読む`, /readRowsKeepingLearned/.test(src(f)) && /KEEP_OUTSIDE_CAP_OR/.test(src(f)));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
