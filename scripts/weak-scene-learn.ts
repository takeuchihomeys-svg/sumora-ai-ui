/**
 * 弱い場面の課題欄を、通常録画の画像から改善されるまで読む
 * （統括: 課題欄は通常の最新〜近い画像から / 種類割れは多い方）
 */
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const LIST_BASE = "https://sumora-ai-ui.vercel.app";
const INGEST = process.env.AUDIT_BASE || "http://localhost:3999";
const WEAK = [
  "required_time",
  "transportation_id",
  "rental_cost2",
  "rental_cost1",
  "structured_date",
  "update_date",
  "city_code",
  "one_city",
  "確定してリストへ",
  "所在地絞り込み",
];
const LIMIT = Math.min(20, Math.max(10, Number(process.env.SHOT_LEARN_LIMIT) || 16));

const PROMPT = `リアプロ画面の操作できる欄だけを読む。入力中身・個人情報は書かない。
JSONのみ: {"screen":"form|modal|list|other","fields":[{"name":"HTMLのnameか短い日本語","kind":"select|text|checkbox|radio|button|link","x":0-1,"y":0-1}]}
優先: update_date, rental_cost1/2, structured_date, transportation_id, required_time, 区のチェック, 確定してリストへ。
nameは可能なら HTML name（update_date 等）。区は「大阪市〇〇区」。最大35。`;

async function ask(b64: string) {
  const dsKey = (process.env.DEEPSEEK_API_KEY || "").trim();
  if (!dsKey) return { fields: [] as Array<Record<string, unknown>>, screen: "?", why: "no_key" };
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${dsKey}` },
    body: JSON.stringify({
      model: (process.env.SHOT_LEARN_MODEL || "deepseek-flash").trim(),
      max_tokens: 12000,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "弱い場面の欄（プルダウン・区・確定）の種類と位置を優先。" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) return { fields: [], screen: "?", why: `http_${res.status}` };
  const j = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = String(j.choices?.[0]?.message?.content ?? "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { fields: [], screen: "?", why: "no_json" };
  try {
    const o = JSON.parse(m[0]) as { screen?: string; fields?: Array<Record<string, unknown>> };
    return { fields: Array.isArray(o.fields) ? o.fields : [], screen: String(o.screen || "?") };
  } catch {
    return { fields: [], screen: "?", why: "parse" };
  }
}

function isWeakRow(row: Record<string, unknown>): boolean {
  const ops = Array.isArray(row.shot_ops) ? (row.shot_ops as Array<{ f?: string; w?: string }>) : [];
  const pf = row.point_fields && typeof row.point_fields === "object"
    ? Object.keys(row.point_fields as object)
    : [];
  const blob = [...ops.map((o) => String(o.f || "")), ...pf].join("|");
  return WEAK.some((w) => blob.includes(w));
}

async function main() {
  const r = await fetch(`${LIST_BASE}/api/human-motion?mode=normal&limit=400&days=1&shots=1`, { cache: "no-store" });
  if (!r.ok) throw new Error("list_" + r.status);
  const j = await r.json() as { rows?: Array<Record<string, unknown>> };
  const candidates = (j.rows ?? [])
    .filter((x) => String(x.shot_url || "").length > 10 && Number(x.shot_w) >= 800 && isWeakRow(x))
    .filter((x) => String(x.created_at || "") >= "2026-11-16T02:45:00");

  const picked: typeof candidates = [];
  let last = 0;
  for (const x of candidates.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    const t = Date.parse(String(x.created_at));
    if (last && t - last < 1800) continue;
    picked.push(x);
    last = t;
    if (picked.length >= LIMIT) break;
  }
  console.log("弱い場面の通常画像", picked.length, "/候補", candidates.length);

  const kindVote = new Map<string, Map<string, number>>();
  const posAcc = new Map<string, { xs: number[]; ys: number[] }>();
  const items: Array<{ id: number; shot_learn: Record<string, unknown> }> = [];

  for (let i = 0; i < picked.length; i++) {
    const row = picked[i];
    const at = String(row.created_at).slice(11, 19);
    process.stdout.write(`… ${i + 1}/${picked.length} ${at} `);
    const ir = await fetch(String(row.shot_url), { cache: "no-store" });
    if (!ir.ok) { console.log("fetch_fail"); continue; }
    let jpeg: Buffer = Buffer.from(await ir.arrayBuffer());
    try {
      const sharp = (await import("sharp")).default;
      const meta = await sharp(jpeg).metadata();
      const next = (meta.width || 0) > 2000
        ? await sharp(jpeg).resize({ width: 2000 }).jpeg({ quality: 90 }).toBuffer()
        : await sharp(jpeg).jpeg({ quality: 90 }).toBuffer();
      jpeg = Buffer.from(next);
    } catch { /* keep */ }
    const got = await ask(jpeg.toString("base64"));
    if (!got.fields.length) { console.log("skip", got.why); continue; }

    const fields = got.fields
      .filter((f) => {
        const name = String(f.name || "");
        const kind = String(f.kind || "");
        if (!name || name.length > 40) return false;
        if (/北区、中央区|手順|をクリック/.test(name)) return false; // まとめ文言は捨てる
        return ["select", "text", "checkbox", "radio", "button", "link"].includes(kind);
      })
      .map((f) => ({
        name: String(f.name).slice(0, 40),
        kind: String(f.kind),
        x: typeof f.x === "number" ? f.x : null,
        y: typeof f.y === "number" ? f.y : null,
      }));

    for (const f of fields) {
      if (!kindVote.has(f.name)) kindVote.set(f.name, new Map());
      const m = kindVote.get(f.name)!;
      m.set(f.kind, (m.get(f.kind) || 0) + 1);
      if (f.x != null && f.y != null) {
        const p = posAcc.get(f.name) || { xs: [], ys: [] };
        p.xs.push(f.x);
        p.ys.push(f.y);
        posAcc.set(f.name, p);
      }
    }
    console.log(`OK screen=${got.screen} fields=${fields.length}`);
    items.push({
      id: Number(row.id),
      shot_learn: {
        screen: got.screen || "form",
        fields: fields.slice(0, 40),
        by: "vision",
        confidence: 0.78,
        from: "weak-scene-learn",
      },
    });
  }

  const avg = (a: number[]) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 1000) / 1000 : null);
  console.log("\n■ 種類の多数決（弱い欄）");
  const majority: Array<{ name: string; kind: string; n: number; x: number | null; y: number | null }> = [];
  for (const [name, votes] of [...kindVote.entries()].sort((a, b) => {
    const na = [...a[1].values()].reduce((s, x) => s + x, 0);
    const nb = [...b[1].values()].reduce((s, x) => s + x, 0);
    return nb - na;
  })) {
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best) continue;
    const conflict = votes.size > 1;
    const pos = posAcc.get(name);
    const row = {
      name,
      kind: best[0],
      n: best[1],
      x: pos ? avg(pos.xs) : null,
      y: pos ? avg(pos.ys) : null,
    };
    if (WEAK.some((w) => name.includes(w)) || /区|確定|update|rental|struct|transport|required|square/.test(name)) {
      console.log(`  ${conflict ? "⚠割れ→" : "✓"}${name}: ${best[0]}×${best[1]}` +
        (conflict ? ` (他:${[...votes.entries()].filter((x) => x[0] !== best[0]).map((x) => x[0] + "×" + x[1]).join(",")})` : "") +
        ` xy≈${row.x},${row.y}`);
      majority.push(row);
    }
  }

  const dir = join(process.cwd(), "scripts", "_weak-scene-learn");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ at: new Date().toISOString(), majority, items: items.length }, null, 2));

  console.log("\ningest", items.length, "→", INGEST);
  if (items.length) {
    const res = await fetch(`${INGEST}/api/shot-learn-ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    console.log("http", res.status, (await res.text()).slice(0, 300));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
