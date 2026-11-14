/**
 * 総合点検: 通常モード（人が押した記録）と自動モードの**ギャップ**を本番APIから測る
 *
 * 竹内さん「実際テストして全部の動きできるか／検索まで押せるか／
 *   途中で本来プルダウンなのにプルダウンと判断できていない部分や押すことができていないボタンはあるか／
 *   実際の通常モードでの検索のデータと比べてのギャップを強化」
 *
 * 実行: npx tsx scripts/audit-mode-gap.ts
 */
const API = "https://sumora-ai-ui.vercel.app";

type Row = Record<string, unknown>;
const MODE_JA: Record<string, string> = { normal: "通常", staff: "スタッフ", aix: "AIX（自動）", brain: "ブレイン", brain_aix: "ブレイン×AIX", brain_normal: "ブレイン×通常" };

async function fetchShots(days: number): Promise<Row[]> {
  const out: Row[] = [];
  for (const limit of [2000]) {
    const r = await fetch(`${API}/api/human-motion?shots=1&days=${days}&limit=${limit}`, { cache: "no-store" });
    const j = await r.json();
    out.push(...((j.rows ?? []) as Row[]));
  }
  return out;
}

async function main() {
  const rows = await fetchShots(14);
  console.log("=== ① 写真の行:", rows.length, "（直近14日）");

  // ② モード別
  const byMode = new Map<string, Row[]>();
  for (const r of rows) {
    const m = String(r.mode ?? "").trim() || "(空)";
    if (!byMode.has(m)) byMode.set(m, []);
    byMode.get(m)!.push(r);
  }
  console.log("\n=== ② モード別");
  for (const [m, sub] of Array.from(byMode.entries()).sort((a, b) => b[1].length - a[1].length)) {
    const withOps = sub.filter((x) => Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).length > 0);
    console.log(`  ${MODE_JA[m] || m}: ${sub.length}行 / ops付き ${withOps.length}`);
  }

  // ③ 欄ごとの押され方
  type Stat = { n: number; kinds: Record<string, number>; modes: Record<string, number> };
  const fields = new Map<string, Stat>();
  for (const r of rows) {
    const pf = r.point_fields as Record<string, Record<string, unknown>> | null;
    const mode = String(r.mode ?? "").trim() || "(空)";
    if (!pf || typeof pf !== "object") continue;
    for (const [name, v] of Object.entries(pf)) {
      if (!v || typeof v !== "object") continue;
      const n = Number(v.n) || 0;
      if (n <= 0) continue;
      if (!fields.has(name)) fields.set(name, { n: 0, kinds: {}, modes: {} });
      const st = fields.get(name)!;
      st.n += n;
      const k = typeof v.w === "string" ? v.w : "(不明)";
      st.kinds[k] = (st.kinds[k] || 0) + 1;
      st.modes[mode] = (st.modes[mode] || 0) + 1;
    }
  }
  const list = Array.from(fields.entries()).sort((a, b) => b[1].n - a[1].n);
  console.log("\n=== ③ 欄ごと（押された回数の多い順・上位25）");
  for (const [name, st] of list.slice(0, 25)) {
    const kinds = Object.entries(st.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join("・");
    console.log(`  ${String(st.n).padStart(4)}回  ${name.slice(0, 26).padEnd(28)} [${kinds}]`);
  }

  // ④ プルダウンと判断できていない疑い
  const sus = list.filter(([, st]) => {
    const k = Object.keys(st.kinds);
    return k.includes("(不明)") || k.includes("other");
  });
  console.log("\n=== ④ 種類が分からない・other（プルダウン判断の疑い）:", sus.length, "件");
  for (const [name, st] of sus.slice(0, 20)) {
    console.log(`  ${name.slice(0, 30)}  [${Object.entries(st.kinds).map(([k, n]) => `${k}×${n}`).join("・")}]`);
  }

  // ⑤ ギャップ（通常にあるが自動に無い）
  console.log("\n=== ⑤ 通常にあって自動に無い欄（ギャップ）");
  let gaps = 0;
  for (const [name, st] of list) {
    const inNormal = (st.modes["normal"] ?? 0) > 0;
    const inAuto = Object.keys(st.modes).some((m) => m.startsWith("aix") || m.includes("aix"));
    if (inNormal && !inAuto && st.n >= 2) {
      gaps++;
      if (gaps <= 15) console.log(`  ${name.slice(0, 30)}（通常で${st.n}回）`);
    }
  }
  if (!gaps) console.log("  （自動モードの記録が無いので比べられません）");

  // ⑥ 検索まで到達したか
  console.log("\n=== ⑥ 並びに「検索」があるか（モード別）");
  for (const [m, sub] of byMode) {
    let reached = 0, total = 0;
    for (const r of sub) {
      const ops = Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [];
      if (!ops.length) continue;
      total++;
      if (ops.some((o) => /検索/.test(String(o.f ?? "")))) reached++;
    }
    if (total) console.log(`  ${MODE_JA[m] || m}: ${reached}/${total}`);
  }

  // ⑦ ops の中の「押せた物」の種類
  console.log("\n=== ⑦ ops に出てくる種類（上位）");
  const kinds: Record<string, number> = {};
  for (const r of rows) for (const o of (r.shot_ops ?? []) as Array<Record<string, unknown>>) {
    const w = String(o.w ?? "(なし)");
    kinds[w] = (kinds[w] || 0) + 1;
  }
  for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${k}: ${n}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
