/**
 * 総合テスト: 「通常モードの人の手本」と「自動モード」を**項目ごとに比べる**
 *
 * 竹内さん「これでちゃんと実際のと比べてできるようになっているか含めてテストする。
 *   抜けがあれば追加して補強する」
 *
 * 実行: npx tsx scripts/audit-vs-human.ts
 *
 * ⚠ tsconfig が全 .ts を型チェックの対象にしているので、**トップレベルに関数や定数を置かない**
 *   （他の scripts と名前がぶつかって型エラーになる）。即時実行の関数で包む。
 */
void (async () => {
  const API_BASE = "https://sumora-ai-ui.vercel.app";
  type ShotRow = Record<string, unknown>;

  const fetchShots = async (days: number): Promise<ShotRow[]> => {
    const r = await fetch(`${API_BASE}/api/human-motion?shots=1&days=${days}&limit=2000`, { cache: "no-store" });
    const j = await r.json();
    return ((j.rows ?? []) as ShotRow[]);
  };

  /** ops の並びから「欄の名前の順番」を取り出す（同じ日の同じ並びは1回） */
  const sequencesOf = (rows: ShotRow[]): string[][] => {
    const out: string[][] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const raw = r.shot_ops;
      if (!Array.isArray(raw)) continue;
      const seq = (raw as Array<Record<string, unknown>>).map((o) => String(o?.f ?? "").trim()).filter(Boolean);
      if (seq.length < 2) continue;
      const day = String(r.created_at ?? "").slice(0, 10);
      const sig = day + "|" + seq.join(">");
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(seq);
    }
    return out;
  };

  const tallyNext = (seqs: string[][]) => {
    const t = new Map<string, Map<string, number>>();
    for (const s of seqs) for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], b = s[i];
      if (a === b) continue;
      if (!t.has(a)) t.set(a, new Map());
      const m = t.get(a)!;
      m.set(b, (m.get(b) ?? 0) + 1);
    }
    const out = new Map<string, { to: string; n: number; total: number }>();
    for (const [a, m] of t) {
      const list = Array.from(m.entries()).sort((x, y) => y[1] - x[1]);
      const total = list.reduce((s, [, n]) => s + n, 0);
      out.set(a, { to: list[0][0], n: list[0][1], total });
    }
    return out;
  };

  const rows = await fetchShots(14);
  console.log("写真の行:", rows.length);

  const normal = rows.filter((r) => String(r.mode ?? "").trim() === "normal");
  const auto = rows.filter((r) => /aix/i.test(String(r.mode ?? "").trim()));
  const unknown = rows.filter((r) => !String(r.mode ?? "").trim());
  console.log(`  通常: ${normal.length}行 ／ 自動(aix): ${auto.length}行 ／ モード不明: ${unknown.length}行`);

  const nSeq = sequencesOf(normal);
  const aSeq = sequencesOf(auto);
  const uSeq = sequencesOf(unknown);
  console.log(`  一連の並び: 通常 ${nSeq.length}本 ／ 自動 ${aSeq.length}本 ／ 不明 ${uSeq.length}本`);

  if (!nSeq.length) {
    console.log("\n【結論】通常モードの記録がありません。通常モードで録画して検索すると手本が作れます。");
    console.log("（記録のモード別の内訳は /api/human-learn-profile の mode_counts で見られます）");
    return;
  }

  const humanNext = tallyNext(nSeq);
  console.log("\n=== ① 手本: 通常モードで人が押した順番（上位15）");
  const humanList = Array.from(humanNext.entries()).sort((a, b) => b[1].n - a[1].n);
  for (const [from, v] of humanList.slice(0, 15)) {
    const pct = Math.round((v.n / v.total) * 100);
    console.log(`  ${String(v.n).padStart(3)}回 ${String(pct).padStart(3)}%  ${from.slice(0, 24)} → ${v.to.slice(0, 24)}`);
  }

  console.log("\n=== ② 自動モードとの比較");
  if (!aSeq.length) {
    console.log("  ⚠ 自動モードの記録が0本。比べられません。");
    console.log("    → 自動モードで1回検索して録画すると比べられます。");
  } else {
    const autoNext = tallyNext(aSeq);
    let same = 0, diff = 0, missing = 0;
    const gaps: Array<{ from: string; human: string; auto: string | null }> = [];
    for (const [from, v] of humanList) {
      const a = autoNext.get(from);
      if (!a) { missing++; gaps.push({ from, human: v.to, auto: null }); }
      else if (a.to === v.to) same++;
      else { diff++; gaps.push({ from, human: v.to, auto: a.to }); }
    }
    console.log(`  同じ: ${same} ／ 違う: ${diff} ／ 自動で押していない: ${missing}`);
    if (gaps.length) {
      console.log("\n  ▼ 補強リスト");
      for (const g of gaps.slice(0, 15)) {
        console.log(`    ${g.from.slice(0, 22)} … 人は「${g.human.slice(0, 20)}」へ / 自動は「${(g.auto ?? "（押していない）").slice(0, 20)}」`);
      }
    }
  }

  console.log("\n=== ③ 検索まで到達したか");
  for (const [name, seqs] of [["通常", nSeq], ["自動", aSeq], ["不明", uSeq]] as Array<[string, string[][]]>) {
    if (!seqs.length) continue;
    const reached = seqs.filter((s) => s.some((x) => /検索/.test(x))).length;
    console.log(`  ${name}: ${reached}/${seqs.length}（${Math.round((reached / seqs.length) * 100)}%）`);
  }

  console.log("\n=== ④ 種類が other の欄（押せたか確認しにくい）");
  const otherKinds: Record<string, number> = {};
  for (const r of rows) for (const o of (r.shot_ops ?? []) as Array<Record<string, unknown>>) {
    const w = String(o.w ?? "");
    if (w === "other" || w === "") {
      const f = String(o.f ?? "(なし)");
      otherKinds[f] = (otherKinds[f] || 0) + 1;
    }
  }
  for (const [k, n] of Object.entries(otherKinds).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${n}回  ${k}`);
  }

  console.log("\n=== ⑤ 地域・駅の段が手本に入っているか");
  const areaRe = /所在地|区を選ぶ|町字|地域の設定|沿線|駅の設定/;
  const nArea = nSeq.filter((s) => s.some((x) => areaRe.test(x))).length;
  console.log(`  通常: ${nArea}/${nSeq.length} 本に地域・駅の段がある`);

  console.log("\n=== ⑥ 操作の間（人が待つ長さ）");
  for (const [name, sub] of [["通常", normal], ["自動", auto]] as Array<[string, ShotRow[]]>) {
    const g = sub.map((r) => Number(r.gap_ms)).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    if (g.length) console.log(`  ${name}: ${Math.round(g[Math.floor(g.length / 2)])}ms（${g.length}件）`);
  }

  console.log("\n=== ⑦ 結論");
  if (!aSeq.length) {
    console.log("  自動モードの記録が無いので「実際と比べる」はまだできていません。");
    console.log("  → 自動モードで1回検索して録画してください。この道具が自動で比べます。");
  } else {
    console.log("  上記の差分が「補強リスト」です。");
  }
})();

