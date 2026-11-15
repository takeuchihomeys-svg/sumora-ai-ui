import { supabase } from "../app/lib/supabase-server";
import { splitByCustomer, summarizeRun } from "../app/lib/customer-runs";
import { readShotFieldsWithWhy } from "../app/lib/shot-learn-server";

/** 同じ画面（操作の並びが同じ）は1枚だけ */
function dedupe(list: any[]): any[] {
  const seen = new Map<string, number>();
  const out: any[] = [];
  for (const r of list) {
    const sig = ((r.shot_ops ?? []) as any[]).map((o) => String(o?.f ?? "") + ":" + String(o?.k ?? "")).join("|");
    const key = sig && sig !== ":diag" && sig !== ":" ? sig : "(操作なし)";
    const n = seen.get(key) || 0;
    if (n >= 1) continue;
    seen.set(key, n + 1);
    out.push(r);
  }
  return out;
}

void (async () => {
  let rows: any[] = [];
  for (let from = 0; from < 3000; from += 1000) {
    const { data } = await supabase.from("human_motion_learn")
      .select("id,created_at,shot_key,shot_w,shot_ops,shot_learn")
      .gte("created_at", new Date(Date.now()-6*3600_000).toISOString())
      .order("created_at",{ascending:true}).range(from, from+999);
    rows = rows.concat((data ?? []) as any[]);
    if ((data ?? []).length < 1000) break;
  }
  const runs = splitByCustomer(rows as never);
  const names = ["まりあ", "ゆーと", "悠"];
  let cost = 0;
  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri];
    const todo = dedupe(run.rows.filter((r: any) => r.shot_key && !r.shot_learn && Number(r.shot_w) >= 800));
    console.log("\n===== " + (names[ri] ?? (ri+1)+"組目") + " : 読む " + todo.length + "枚 =====");
    let ok = 0, fields = 0, skip = 0, idx = 0;
    const worker = async () => {
      for (;;) {
        const i = idx++; if (i >= todo.length) return;
        const t = todo[i];
        const got = await readShotFieldsWithWhy(t.shot_key);
        if (!got.sl) { skip++; console.log("  ✗ " + String(got.why).slice(0,60)); continue; }
        const { error } = await supabase.from("human_motion_learn").update({ shot_learn: got.sl }).eq("id", t.id);
        if (!error) { ok++; fields += got.sl.fields.length; }
        console.log("  ✓ " + (i+1) + "/" + todo.length + " 欄" + got.sl.fields.length + "個 " + Math.round(got.ms/1000) + "秒");
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, Math.max(1, todo.length)) }, () => worker()));
    cost += ok * 0.17;
    console.log("  → 読めた " + ok + "枚・欄 " + fields + "個・読めず " + skip + "枚（累計 約" + Math.round(cost) + "円）");
  }
  console.log("\n===== 合計 約" + Math.round(cost) + "円 =====");
})();
