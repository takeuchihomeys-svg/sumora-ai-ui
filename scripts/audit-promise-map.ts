// scripts/audit-promise-map.ts — 「約束」の分野の地図（根 promise:kept_true）: 竹内さん本人の約束の 種類 → 場面 → 外れの型 → 原因 の木・葉ごとの土台の表・統括ブレインへの届き方（読むだけ・LLM なし）
// 2026-11-23 作業員L（竹内さんの決定 KB 0f38f47f・統括役の割り振り）。元の数えは B1（scripts/audit-promise-kept.ts --out=<json>）の1約束1行。
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-kept.ts --days=14 --out=<b1.json>
//       npx tsx --env-file=.env.local scripts/audit-promise-map.ts --json=<b1.json> [--out=<map.json>]
//   または --days=<日数>（--json の代わり・B1 をその場で流す。14日を超えるのは夜だけ）。--out の json は { root, turns, nodes, table }（作業員P の地図の builder promise_map が turns を読む）
//   外れの番だけ、会話と時刻（前後10分）で行動台帳（sent_facts）とカレンダーの【必ず】を読んで原因を分ける。会話の文は出さない（頭8字だけ）
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { sceneOfWatchKey } from "../app/lib/metric-map";
import { promiseMapTurns, buildPromiseTree, promiseFoundationRows, PROMISE_MAP_MISS_JA, PROMISE_MAP_CAUSE_JA, type PromiseMapRow, type PromiseEvidence } from "./lib/promise-map";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const KIND_WORD: Record<string, RegExp> = { pickup: /ピックアップ|物件(?:を)?(?:送|お送り)/, check: /確認/, estimate: /見積/, viewing_slot: /内覧/, callback: /電話/ };
(async () => {
  // 2026-11-23 作業員P の地図（builder promise_map）が夜に --days=60 --out=<一時> で回す: --json が無ければ B1 をその場で流して json を作る（14日を超える読みは夜だけ）
  let jsonPath = arg("json");
  if (!jsonPath) {
    const days = Number(arg("days", "14")) || 14;
    const jstH = new Date(Date.now() + 9 * 36e5).getUTCHours();
    if (days > 14 && jstH >= 9 && jstH < 22 && !process.argv.includes("--force")) throw new Error("14日を超える読みは夜だけ（JST 22〜9時）。昼は --days=14 まで");
    jsonPath = join(tmpdir(), `promise-map-b1-${process.pid}.json`);
    execFileSync(process.execPath, [...process.execArgv, join(dirname(process.argv[1]), "audit-promise-kept.ts"), `--days=${days}`, "--max-convs=400", `--out=${jsonPath}`], { stdio: ["ignore", "ignore", "inherit"], timeout: 600_000 });
  }
  const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as PromiseMapRow[] | { rows?: PromiseMapRow[] };
  // 場面は P の地図と同じ鍵（sceneOfWatchKey: conditions・question・ack・considering・property_share・viewing・cost・apply・other）。B1 の「少数」は other
  const rows = (Array.isArray(raw) ? raw : raw.rows ?? []).map((r) => ({ ...r, scene: r.scene && r.scene !== "少数" ? sceneOfWatchKey(r.scene) : "other" }));
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  // 外れの番の印（行動台帳・カレンダー）
  const ev = new Map<string, PromiseEvidence>();
  const misses = rows.filter((r) => r.writer === "takeuchi" && (r.state === "late" || r.state === "overdue"));
  for (const r of misses) {
    const { data: c } = await sb.from("conversations").select("id").like("id", `${r.conv}%`).limit(1);
    const id = (c ?? [])[0]?.id as string | undefined;
    if (!id) continue;
    const t = Date.parse(r.at), lo = new Date(t - 10 * 60_000).toISOString(), hi = new Date(t + 10 * 60_000).toISOString();
    const [{ data: f }, { data: cal }] = await Promise.all([
      sb.from("sent_facts").select("kind, status, detail").eq("conversation_id", id).eq("status", "promised").gte("sent_at", lo).lte("sent_at", hi).limit(5),
      sb.from("calendar_events").select("is_done").eq("conversation_id", id).like("notes", "【必ず】%").gte("created_at", lo).lte("created_at", hi).limit(5),
    ]);
    const fs = (f ?? []) as Array<{ kind: string; detail: { closed_by?: unknown } | null }>;
    const cs = (cal ?? []) as Array<{ is_done: boolean | null }>;
    ev.set(`${r.conv}@${r.at}`, { ledgerKind: fs[0]?.kind ?? null, ledgerClosed: fs.some((x) => !!x.detail?.closed_by), calendarDone: cs.length ? cs.every((x) => x.is_done === true) : null });
  }
  const turns = promiseMapTurns(rows, (r) => ev.get(`${r.conv}@${r.at}`));
  const nodes = buildPromiseTree(turns);
  // 土台: 決まり（KB の現行の行の題に約束と種類の言葉）・試験の問題（spec の why・type に約束と種類の言葉）・統括の材料のスイッチ（本番の上書きが無ければコードの既定 on）
  const kinds = [...new Set(turns.map((x) => x.kind))];
  const kbKinds = new Set<string>();
  for (const k of kinds) {
    const w = KIND_WORD[k]; if (!w) continue;
    const { data } = await sb.from("system_design_thinking").select("title").eq("is_current", true).ilike("title", "%約束%").limit(300);
    if (((data ?? []) as Array<{ title: string }>).some((x) => w.test(x.title))) kbKinds.add(k);
  }
  let spec: Array<{ why?: string; type?: string; tags?: unknown }> = [];
  try { spec = JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8")); } catch { /* 無い */ }
  const examKinds = new Set(kinds.filter((k) => KIND_WORD[k] && spec.some((p) => { const s = `${p.type ?? ""} ${p.why ?? ""}`; return /約束/.test(s) && KIND_WORD[k].test(s); })));
  const { data: sw } = await sb.from("brain_switch_versions").select("switches").order("last_seen_at", { ascending: false }).limit(1);
  const overdueMaterialOn = !/^CONDUCTOR_OVERDUE_PROMISES=off/m.test(String((sw ?? [])[0]?.switches ?? ""));
  const table = promiseFoundationRows(nodes, { kbKinds, examKinds, overdueMaterialOn });

  const root = nodes[0];
  console.log(`約束の地図（根 promise:kept_true・竹内さん本人の約束で判定のある物）: n ${root?.n ?? 0}・期限の内に果たした ${root?.ok ?? 0}（${root?.value ?? "—"}%）・外れ ${root?.misses ?? 0}`);
  for (const x of nodes.slice(1)) {
    const label = x.dim === "miss" ? PROMISE_MAP_MISS_JA[x.val as never] ?? x.val : x.dim === "cause" ? PROMISE_MAP_CAUSE_JA[x.val as never] ?? x.val : x.val;
    console.log(`${"  ".repeat(x.depth)}${x.dim}: ${label}  n=${x.n}・外れ ${x.misses}`);
  }
  console.log(`\n## 葉（種類 × 場面）ごとの土台（決まり・材料・物差し・試験の問題）と統括ブレインへの届き方・統括の材料 CONDUCTOR_OVERDUE_PROMISES=${overdueMaterialOn ? "on" : "off"}`);
  for (const t of table) console.log(`${t.leaf.replace("promise:kept_true/", "")}  n=${t.n}・外れ ${t.misses}｜決まり ${t.rule}・材料 ${t.material}・物差し ${t.measure}・試験 ${t.exam}｜${t.deliveredToBrain}`);
  console.log(`\n外れの番（会話の頭8字・種類・場面・原因）: ${turns.filter((x) => x.miss !== "ok").map((x) => `${x.id.slice(0, 8)}:${x.kind}:${x.scene}:${x.cause}`).join(" ")}`);
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ root: "promise:kept_true", turns, nodes, table }, null, 1));
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
