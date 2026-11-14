/**
 * 点検: 学習に入る**ゴミデータ**を全部洗い出す
 *
 * 竹内さん「ちゃんと動き理解した学習になっているのか／ゴミデータが入らないようになっているか／
 *   学習は統括の部分が管轄して整理もできているのか」
 *
 * 実行: npx tsx scripts/audit-learn-garbage.ts
 */
void (async () => {
  const BASE = "https://sumora-ai-ui.vercel.app";
  type R = Record<string, unknown>;
  const j = await (await fetch(`${BASE}/api/human-motion?shots=1&days=14&limit=2000`, { cache: "no-store" })).json();
  const rows = (j.rows ?? []) as R[];
  console.log("写真の行:", rows.length);

  // ① 操作の並びから、ゴミの種類を数える
  type Issue = { kind: string; n: number; sample: string };
  const issues = new Map<string, Issue>();
  const add = (kind: string, sample: string) => {
    const cur = issues.get(kind) ?? { kind, n: 0, sample };
    cur.n++;
    issues.set(kind, cur);
  };

  const allNames = new Map<string, number>();
  let totalOps = 0;
  for (const r of rows) {
    const ops = Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [];
    if (!ops.length) continue;
    const seq = ops.map((o) => String(o.f ?? "").trim()).filter(Boolean);
    totalOps += seq.length;

    // ① 交互クリック（A B A B…の3往復以上）
    let alt = 0;
    for (let i = 2; i < seq.length; i++) {
      if (seq[i] === seq[i - 2] && seq[i] !== seq[i - 1]) alt++;
      else alt = 0;
      if (alt >= 4) { add("交互クリック（トグル跡）", seq.slice(Math.max(0, i - 4), i + 1).join("→")); break; }
    }
    // ② 同じ欄が4回以上連続
    let run = 1;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] === seq[i - 1]) { run++; if (run >= 4) { add("同じ欄の4連打", seq[i]); break; } }
      else run = 1;
    }
    // ③ 名前が無い・1文字だけ（div/span/td 等の入れ物）
    for (const s of seq) {
      allNames.set(s, (allNames.get(s) ?? 0) + 1);
      if (s.length <= 1) add("名前が1文字以下", s);
    }
    // ④ 押す対象ではない物（種類 other で、名前が入れ物だけ）
    for (const o of ops) {
      const f = String(o.f ?? "");
      const w = String(o.w ?? "");
      if (w === "other" && /^(div|span|svg|td|tr|th|img|a|li|p|i|b)$/i.test(f)) add("押す対象でない入れ物", f);
    }
    // ⑤ 同じ並びの重複（同じ日）
    const day = String(r.created_at ?? "").slice(0, 10);
    const sig = day + "|" + seq.join(">");
    if (!(globalThis as unknown as Record<string, Set<string>>).__seen) {
      (globalThis as unknown as Record<string, Set<string>>).__seen = new Set();
    }
    const seen = (globalThis as unknown as Record<string, Set<string>>).__seen;
    if (seen.has(sig)) add("同じ日の同じ並び（水増し）", sig.slice(0, 60));
    else seen.add(sig);
  }

  console.log("操作の延べ数:", totalOps, "／ 名前の種類:", allNames.size);
  console.log("\n=== ① ゴミの種類（検出した数）");
  if (!issues.size) console.log("  ✓ ゴミは見つかりませんでした");
  for (const v of Array.from(issues.values()).sort((a, b) => b.n - a.n)) {
    console.log(`  ${String(v.n).padStart(4)}件  ${v.kind}  例: ${v.sample.slice(0, 50)}`);
  }

  console.log("\n=== ② 名前の種類（多い順・上位30）");
  const names = Array.from(allNames.entries()).sort((a, b) => b[1] - a[1]);
  for (const [n, c] of names.slice(0, 30)) console.log(`  ${String(c).padStart(4)}回  ${n}`);

  console.log("\n=== ③ 怪しい名前（入れ物・記号だけ）");
  const sus = names.filter(([n]) => n.length <= 2 || /^(div|span|svg|td|tr|th|img)$/i.test(n) || /^[#.]/.test(n));
  for (const [n, c] of sus.slice(0, 20)) console.log(`  ${String(c).padStart(4)}回  "${n}"`);

  // ④ 学習の束が、このゴミを捨てているか
  const prof = await (await fetch(`${BASE}/api/human-learn-profile?touch=0`, { cache: "no-store" })).json();
  const b = (prof.bundle ?? {}) as R;
  console.log("\n=== ④ 学習の束に残っているか");
  const pt = (b.points ?? {}) as Record<string, { w?: string }>;
  const other = Object.entries(pt).filter(([, v]) => v.w === "other");
  console.log("  学んだ欄:", Object.keys(pt).length, "／ そのうち other:", other.length);
  for (const [k, v] of other.slice(0, 12)) console.log(`    ${k}（${v.w}）`);
  const nxt = (b.next ?? {}) as Record<string, unknown>;
  const nxtKeys = Object.keys(nxt);
  const badNext = nxtKeys.filter((k) => /^(div|span|svg|td|tr|th|img)$/i.test(k) || k.length <= 2);
  console.log("  押す順番:", nxtKeys.length, "／ うち怪しい:", badNext.length, badNext.slice(0, 8).join(","));
}
)();
