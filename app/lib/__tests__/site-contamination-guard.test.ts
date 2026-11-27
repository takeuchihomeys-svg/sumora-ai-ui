/**
 * サイト横断汚染ガードテスト（2026-11-27）
 *
 * 1) human-motion-sanitize が [object ...] とリアプロ↔ITANDI 混入を確実に落とす
 * 2) learn-bundle-preserve の scope="itandi" がリアプロ駅手順（駅の設定へ進む等）を継承・混載しない
 * 3) human_learn_profile へ書く全経路が prepareBundleForWrite(bundle, scope) の第2引数（サイト）を渡している
 *
 * 実行: npx tsx app/lib/__tests__/site-contamination-guard.test.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sanitizeHumanMotionPayload } from "@/app/lib/human-motion-sanitize";
import { inheritLinkFoundations } from "@/app/lib/learn-bundle-preserve";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: string) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};

console.log("■ ① human-motion-sanitize: 破損名とサイト横断混入を除去する");
{
  const rp = sanitizeHumanMotionPayload({
    site: "realpro",
    fields: ["rental_cost2", "#[object HTMLInputElement]", "#_r_5r_｜input.css-vm8hlm", "city_code[]", "rent:lteq"],
    field_order: ["rental_cost2", "#_r_5r_｜input.css-vm8hlm"],
    point_fields: { "rental_cost2": { x: 0.5, y: 0.5 }, "#[object HTMLInputElement]": { x: 0.1, y: 0.2 }, "#_r_1_｜button.css-abcd": { x: 0.2, y: 0.2 } },
    opens: { "rental_cost2": { options: 3 }, "#_r_5r_｜input.css-vm8hlm": { modal: 1 } },
    shot_ops: [{ f: "rental_cost2", k: "click" }, { f: "rent:lteq", k: "input" }, { f: "[object HTMLSelectElement]", k: "click" }],
  });
  ok("realpro: 正常なリアプロ要素は残る", rp.fields?.includes("rental_cost2") === true && rp.fields?.includes("city_code[]") === true);
  ok("realpro: [object ...] が除去される", !rp.fields?.some((x) => x.includes("[object ")));
  ok("realpro: ITANDI要素(#_r_*_, css-*, rent:lteq)が除去される", !rp.fields?.some((x) => x.includes("_r_5r_") || x.includes("rent:lteq")));
  ok("realpro: point_fields / opens / shot_ops からも除去される",
    !!rp.point_fields && !("#[object HTMLInputElement]" in rp.point_fields) && !("#_r_1_｜button.css-abcd" in rp.point_fields)
    && !!rp.opens && !("#_r_5r_｜input.css-vm8hlm" in rp.opens)
    && rp.shot_ops?.length === 1 && rp.shot_ops[0].f === "rental_cost2");
  ok("realpro: 除去件数とサンプルが記録される", rp.filtered_count === 9 && rp.filtered_samples.length > 0, `filtered=${rp.filtered_count} samples=${JSON.stringify(rp.filtered_samples)}`);

  const it = sanitizeHumanMotionPayload({
    site: "itandi",
    fields: ["rent:lteq", "eq_rm[]", "city_code[]", "#top_free", "#main_form", "小窓の確定", "駅の設定へ進む"],
    field_order: ["rent:lteq", "eq_rm[]"],
    point_fields: { "rent:lteq": { x: 0.3, y: 0.4 }, "eq_rm[]": { x: 0.5, y: 0.5 } },
    opens: { "rent:lteq": { options: 2 }, "city_code[]": { modal: 1 } },
    shot_ops: [{ f: "rent:lteq", k: "click" }, { f: "city_code[]", k: "click" }],
  });
  ok("itandi: 正常なITANDI要素は残る", it.fields?.includes("rent:lteq") === true && it.fields?.includes("小窓の確定") === true);
  ok("itandi: リアプロ要素(eq_rm[], city_code[], #top_free, #main_form, 駅の設定へ進む)が除去される",
    it.fields?.length === 2 && !it.fields.includes("eq_rm[]") && !it.fields.includes("駅の設定へ進む"));
  ok("itandi: point_fields / opens / shot_ops からもリアプロ要素が除去される",
    !!it.point_fields && !("eq_rm[]" in it.point_fields) && !!it.opens && !("city_code[]" in it.opens) && it.shot_ops?.length === 1);
}

console.log("\n■ ② inheritLinkFoundations: scope=itandi にリアプロ駅手順を継承しない");
async function checkPreserve() {
  const dirtyOldBundle = {
    foundation_audit: { ok: true },
    scene_flows: [
      { scene: "station", steps: ["沿線・駅絞り込みを押す", "駅の設定へ進む", "確定してリストへ"] },
    ],
  };
  const mockSupabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: async () => ({ data: [{ id: 2520, bundle: dirtyOldBundle }], error: null }),
          }),
        }),
      }),
    }),
  };
  const itandiBundle: Record<string, unknown> = {
    scene_flows: [
      { scene: "station", steps: ["路線・駅選択をクリック", "駅の設定へ進む"] },
    ],
  };
  const res = await inheritLinkFoundations(mockSupabase as unknown as import("@supabase/supabase-js").SupabaseClient, itandiBundle, "itandi");
  const stFlow = (itandiBundle.scene_flows as Array<{ scene?: string; steps?: string[] }>).find((f) => f.scene === "station");
  ok("itandi: inherit後も駅の設定へ進む等が含まれない", !!stFlow && stFlow.steps?.includes("路線・駅選択をクリック") === true && !stFlow.steps?.some((s) => /駅の設定へ進む|沿線の設定へ戻る|one_station/.test(s)), JSON.stringify(stFlow));
  ok("itandi: 履歴からリアプロ駅手順をコピーしない", res.preserved === false && !JSON.stringify(itandiBundle.scene_flows).includes("確定してリストへ"), JSON.stringify(res));
}

console.log("\n■ ③ prepareBundleForWrite の全呼出が第2引数(scope)を渡している");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
{
  const root = join(__dirname, "../../..");
  const files = walk(join(root, "app")).concat(walk(join(root, "scripts")));
  const bad: string[] = [];
  const callRe = /\bprepareBundleForWrite\(([^()]+)\)/g;
  for (const f of files) {
    if (f.includes("__tests__")) continue;
    if (f.endsWith("bundle-write-prepare.ts")) continue;
    const src = readFileSync(f, "utf8");
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(src)) !== null) {
      // 定義やimportではなく実呼出でカンマ（第2引数）が無い物を検知
      if (!m[1].includes(",")) {
        bad.push(f.replace(root, "").replace(/\\/g, "/") + ": prepareBundleForWrite(" + m[1] + ")");
      }
    }
  }
  ok("prepareBundleForWrite 全呼出に第2引数 scope がある", bad.length === 0, bad.join(" / "));
}

checkPreserve().then(() => {
  console.log(`\n結果: ${pass} ok / ${fail} ng`);
  if (fail) process.exit(1);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
