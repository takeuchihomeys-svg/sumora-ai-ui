// scripts/build-aix-desk-cards.ts — AIX のボタン×ピッカーごとの「担当の札」を作る（DB は読むだけ・LLM なし・LINE に送らない）
//
// 2026-10-29 竹内さん（KB P1 ad20192b「AIX の中身を理解」・03d2bdd2「ボタンとピッカーごとに担当」・76c249e0「竹内基準」）・作業員1:
//   担当の札＝その担当が持つ自分の中身（固定の文・キャッシュに乗せる）:
//     ①テンプレートの本文（templates の中で、その鍵で一番使われた物）②入力欄・確認事項（aix-pickers の子のピッカー）
//     ③竹内さんの決定（AIX_LEARNED.kb の設計知見の題）④竹内さんが実際にそのピッカーで送った場面と文（お客様の発言→竹内さんの文・伏せた物）
//     ⑤押し間違いの例（learn-aix-meanings の misByBtn）＋定義（カタログの staffOnly・when・似たボタンとの線）
//   学ぶのは竹内さんの送信だけ（messages.staff_writer='takeuchi'・sure）。スタッフの押し方は正解にしない（押し間違いの例にだけ使う）。
//   出力: <倉庫の根>/.claude/exam-cache/aix-desk/cards.json（札・お客様の会話から作った伏せた文を含むので git には入れない・手元だけ）／<倉庫の根>/.claude/exam-cache/aix-desk/<日付>.md（中身の薄い札の一覧＝竹内さんに聞く）
// 実行: npx tsx --env-file=.env.local scripts/build-aix-desk-cards.ts [--days=180] [--dry]
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIX_CATALOG, catalogKeyOfPress, MAIN_PICKER_FIELD } from "../app/lib/aix-catalog";
import { AIX_PICKERS } from "../app/lib/aix-pickers";
import { AIX_LEARNED } from "../app/lib/aix-catalog-learned";
import { maskExemplar, misPressOf } from "../app/lib/aix-meaning-learn";
import { isTestConversation } from "../app/lib/test-conversations";
import { maskExamText, addressNamesOf } from "./lib/brain-exam-mask";
import { examCacheRoot } from "./lib/llm-cassette";
import { loadRagRows, searchKb } from "../app/lib/design-knowledge-rag-server";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180"));
const DRY = process.argv.includes("--dry");
const OWNER_MIN = 3;
/** 伏せる: お客様の呼び名（「〇〇さん」）・URL・号室・【物件名】。テストの会話（YUMA）の文は使わない */
const safe = (t: string, names: string[]) => maskExemplar(maskExamText(String(t ?? "").replace(/https?:\/\/\S+/g, "[URL]"), null, names));
const isTestText = (t: string) => /YUMA/i.test(t);
const one = (s: string, n: number) => Array.from(String(s ?? "").replace(/\s+/g, " ").trim()).slice(0, n).join("");

async function pageAll<T>(table: string, cols: string, f: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    let r: any = null;
    for (let t = 0; t < 4; t++) { r = await f(sb.from(table).select(cols)).range(i, i + 999); if (!r.error) break; await new Promise((s) => setTimeout(s, 3000)); }
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    out.push(...((r.data ?? []) as T[]));
    if ((r.data ?? []).length < 1000) break;
  }
  return out;
}

type Usage = { conversation_id: string; aix_type: string | null; check_pattern: string | null; send_mode: string | null; app_sub_mode: string | null; picker_choices: unknown; generated_text: string | null; line_message_id: string | null; template_id: string | null; created_at: string };
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; line_message_id: string | null; staff_writer: string | null; staff_writer_confidence: string | null };

(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const usages = (await pageAll<Usage>("aix_usage_logs", "conversation_id, aix_type, check_pattern, send_mode, app_sub_mode, picker_choices, generated_text, line_message_id, template_id, created_at", (q) => q.gte("created_at", since).order("created_at")))
    .filter((u) => !isTestConversation(u.conversation_id));
  const convIds = [...new Set(usages.map((u) => u.conversation_id))];
  const byConv = new Map<string, Msg[]>();
  for (let i = 0; i < convIds.length; i += 50) {
    const part = convIds.slice(i, i + 50);
    const ms = await pageAll<Msg>("messages", "conversation_id, sender, text, created_at, line_message_id, staff_writer, staff_writer_confidence", (q) => q.in("conversation_id", part).gte("created_at", new Date(Date.parse(since) - 7 * 86_400_000).toISOString()).order("created_at"));
    for (const m of ms) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  }
  const byLm = new Map<string, Msg>();
  for (const list of byConv.values()) for (const m of list) if (m.line_message_id) byLm.set(m.line_message_id, m);

  // 鍵ごと: 竹内さんの送信（お客様の直前の発言→竹内さんの文）・テンプレートの使われ方（全員・テンプレの選びは判断ではない）
  const ownerScenes = new Map<string, Array<{ cust: string; sent: string }>>();
  const ownerCount = new Map<string, number>();
  const tplUse = new Map<string, Map<string, number>>();
  for (const u of usages) {
    const m = u.line_message_id ? byLm.get(u.line_message_id) : undefined;
    const key = catalogKeyOfPress({ aix_type: u.aix_type, check_pattern: u.check_pattern, send_mode: u.send_mode, app_sub_mode: u.app_sub_mode, picker_choices: u.picker_choices, text: u.generated_text ?? m?.text ?? null }).key;
    if (u.template_id) { const t = tplUse.get(key) ?? new Map<string, number>(); t.set(u.template_id, (t.get(u.template_id) ?? 0) + 1); tplUse.set(key, t); }
    if (!(m && m.staff_writer === "takeuchi" && m.staff_writer_confidence === "sure")) continue;
    ownerCount.set(key, (ownerCount.get(key) ?? 0) + 1);
    const list = byConv.get(u.conversation_id) ?? [];
    const at = Date.parse(m.created_at);
    const cust = [...list].reverse().find((x) => x.sender === "customer" && Date.parse(x.created_at) < at && (x.text ?? "").trim());
    const sc = ownerScenes.get(key) ?? [];
    const sentRaw = m.text ?? u.generated_text ?? "";
    const names = addressNamesOf(list.filter((x) => x.sender !== "customer").map((x) => x.text ?? ""));
    // 2026-10-29 点検: 竹内さん自身の押し間違い（文がそのピッカーの意味に合わない・例 内覧調整を押して待ち合わせの文）は手本にしない
    if (misPressOf(key, sentRaw)) continue;
    if (sc.length < 3 && cust && !isTestText(sentRaw) && !isTestText(cust.text ?? "")) sc.push({ cust: one(safe(cust.text ?? "", names), 90), sent: one(safe(sentRaw, names), 160) });
    ownerScenes.set(key, sc);
  }
  // テンプレートの本文
  const tplIds = [...new Set([...tplUse.values()].flatMap((m) => [...m.keys()]))];
  const tplText = new Map<string, { label: string; text: string }>();
  for (let i = 0; i < tplIds.length; i += 100) {
    const { data } = await sb.from("templates").select("id, label, text").in("id", tplIds.slice(i, i + 100));
    for (const t of (data ?? []) as Array<{ id: string; label: string; text: string }>) tplText.set(String(t.id), { label: t.label, text: t.text });
  }
  // 竹内さんの決定の題（AIX_LEARNED.kb の id 先頭8字）
  const kbIds = [...new Set(Object.values(AIX_LEARNED).flatMap((l) => l.kb ?? []))];
  const kbTitle = new Map<string, string>();
  // 竹内さんの決定（今の行・札「竹内さんの決定」）: 題にボタン名・ピッカー名の語がある物も担当に結ぶ（learned.kb だけでは薄い）
  const kbRows = await pageAll<{ id: string; title: string; tags: string[] | null; priority: number | null; created_at: string }>("system_design_thinking", "id, title, tags, priority, created_at", (q) => q.eq("is_current", true));
  for (const r of kbRows) { const k = r.id.slice(0, 8); if (kbIds.includes(k)) kbTitle.set(k, r.title); }
  /** ボタン名・ピッカー名の芯の語（括弧・「について」を外す・2字以上） */
  const coreWords = (label: string | null | undefined) => String(label ?? "").split(/[（）()／→・！]/).map((x) => x.replace(/について|した$|する$|送る$|してた$/g, "").trim()).filter((x) => x.length >= 2).flatMap((x) => (x.length >= 4 ? [x, x.slice(0, 2)] : [x]));
  // 竹内さんの決定（札「竹内さんの決定」の今の行）を担当の中身で引く（設計知見の RAG＝kb.ts と同じ searchKb・問いの埋め込みだけ）
  const ragRows = await loadRagRows(sb);
  const decisionsFor = async (e: { button: string; picker: { label: string } | null; staffOnly: string; when: string }): Promise<string[]> => {
    const q = `AIX【${e.button}】${e.picker ? `→${e.picker.label}` : ""}を押す時・押さない時 ${e.staffOnly} ${e.when}`.slice(0, 300);
    const hits = await searchKb(sb, q, { k: 12, rows: ragRows });
    // 2026-10-29 点検: 題にこのボタン・ピッカーの芯の語がある決定だけ（見積書の札に全力サポートの決定が付く等を外す）
    const words = coreWords(e.button).concat(coreWords(e.picker?.label ?? null));
    return hits.filter((h) => (h.row.tags ?? []).includes("竹内さんの決定") && h.vector >= 0.45 && words.some((w) => h.row.title.includes(w))).slice(0, 3).map((h) => `${String(h.row.id).slice(0, 8)} ${h.row.title}`);
  };
  // 押し間違いの例（learn-aix-meanings の最新の出力）
  let misByBtn: Record<string, { n: number; staff: number; owner: number; reasons: Record<string, number>; ex: string[] }> = {};
  const misDir = join(examCacheRoot(), "aix-meanings");
  if (existsSync(misDir)) {
    const f = readdirSync(misDir).filter((x) => x.endsWith(".json")).sort().pop();
    if (f) misByBtn = (JSON.parse(readFileSync(join(misDir, f), "utf8")).misByBtn ?? {}) as typeof misByBtn;
  }

  type Card = { key: string; button: string; picker: string | null; text: string; owner: number; thin: string[] };
  const cards: Card[] = [];
  for (const e of AIX_CATALOG) {
    if (!e.brainSelectable) continue;
    const spec = AIX_PICKERS[e.aixType];
    const learned = AIX_LEARNED[e.key];
    const mainField = MAIN_PICKER_FIELD[e.aixType];
    // ②入力欄・確認事項: 主のピッカー以外の子のピッカー（このピッカーの値の時だけ出る物と、いつも出る物）
    const inputs = (spec?.pickers ?? []).filter((p) => p.key !== mainField && (!p.onlyWhen || (e.picker && p.onlyWhen.key === e.picker.field && p.onlyWhen.values.includes(e.picker.value))))
      .map((p) => `${p.label}${p.options?.length ? `（${[...new Set(p.options.map((o) => o.label))].slice(0, 5).join("／")}）` : ""}`).slice(0, 8);
    const tu = [...(tplUse.get(e.key) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]);
    const tuAll = tu.reduce((a, [, n]) => a + n, 0);
    // 2026-10-29 点検: その鍵の送信の3割以上・3回以上で使われたテンプレートだけ（待ち合わせに「当日の持ち物」の続きの定型が付く等の取り違えを外す）
    const tpls = tu.filter(([, n]) => n >= 3 && n / Math.max(1, tuAll) >= 0.3).slice(0, 1).map(([id]) => tplText.get(id)).filter(Boolean) as Array<{ label: string; text: string }>;
    const scenes = ownerScenes.get(e.key) ?? [];
    const owner = ownerCount.get(e.key) ?? 0;
    const kb = [...new Set([...((learned?.kb ?? []).map((k) => kbTitle.has(k) ? `${k} ${kbTitle.get(k)}` : null).filter(Boolean) as string[]), ...(await decisionsFor(e))])].slice(0, 4);
    const mis = misByBtn[e.key];
    const thin: string[] = [];
    if (owner < OWNER_MIN) thin.push(`竹内さんの送信 ${owner}件（${OWNER_MIN}未満）`);
    if (!tpls.length) thin.push("テンプレートの記録なし");
    if (!kb.length) thin.push("竹内さんの決定なし");
    if (!e.when.trim()) thin.push("使う場面の定義なし");
    const lines: string[] = [];
    lines.push(`■担当 ${e.key}｜${e.button}${e.picker ? ` → ${e.picker.label}` : ""}`);
    lines.push(`送る中身（スタッフだけが知る事）: ${e.staffOnly || "なし（定型の資料・フォーム）"}`);
    lines.push(`使う場面: ${one(e.when, 200)}`);
    if (e.lines) lines.push(`似たボタンとの線: ${one(e.lines, 200)}`);
    if (learned?.purpose) lines.push(`目的: ${one(learned.purpose, 160)}`);
    if (learned?.writeContains?.length) lines.push(`竹内さんの文に入る物: ${learned.writeContains.join("・")}`);
    if (inputs.length) lines.push(`入力欄・確認事項: ${inputs.join("／")}`);
    if (tpls.length) lines.push(`テンプレート「${one(tpls[0].label, 30)}」: ${one(maskExemplar(tpls[0].text), 200)}`);
    if (kb.length) lines.push(`竹内さんの決定: ${kb.map((t) => one(t, 70)).join("／")}`);
    for (const s of scenes) lines.push(`竹内さんの番: 客「${s.cust}」→「${s.sent}」`);
    if (mis?.ex?.length) {
      const why = Object.entries(mis.reasons ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      const ex = mis.ex.find((x) => !isTestText(x));
      lines.push(`押し間違いの例（${mis.n}件・${one(why, 60)}）${ex ? `: 「${one(safe(ex, []), 100)}」` : ""}`);
    }
    cards.push({ key: e.key, button: e.button, picker: e.picker?.label ?? null, text: lines.join("\n"), owner, thin });
  }

  const genAt = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  const thinCards = cards.filter((c) => c.thin.length);
  console.log(`札 ${cards.length}枚・薄い札 ${thinCards.length}枚（竹内さんの送信 ${OWNER_MIN}未満 ${cards.filter((c) => c.owner < OWNER_MIN).length}）・平均 ${Math.round(cards.reduce((a, c) => a + c.text.length, 0) / Math.max(1, cards.length))}字`);
  if (DRY) { for (const c of cards.slice(0, 3)) console.log(`\n${c.text}`); process.exit(0); }

  const dir = join(examCacheRoot(), "aix-desk"); mkdirSync(dir, { recursive: true });
  const ts = [
    "// 生成物（scripts/build-aix-desk-cards.ts が作る・手で直さない・git に入れない）",
    `// 作った時: ${genAt} JST・aix_usage_logs ${usages.length}件（直近${DAYS}日）・竹内基準（竹内さんの送信だけを手本に・スタッフの押し方は押し間違いの例だけ）`,
    "// 文は伏せた物だけ（お客様の名前・物件名・号室）。owner＝竹内さんの送信の数・thin＝中身の足りない所（竹内さんに聞く）",
    "export type AixDeskCard = { key: string; button: string; picker: string | null; text: string; owner: number; thin: string[] };",
    `export const AIX_DESK_CARDS_GENERATED_AT = ${JSON.stringify(genAt)};`,
    `export const AIX_DESK_CARDS: Readonly<Record<string, AixDeskCard>> = ${JSON.stringify(Object.fromEntries(cards.map((c) => [c.key, c])), null, 2)};`,
    "",
  ].join("\n");
  void ts;
  writeFileSync(join(dir, "cards.json"), JSON.stringify({ generatedAt: genAt, cards: Object.fromEntries(cards.map((c) => [c.key, c])) }, null, 1));
  const md = [
    `# AIX の担当の札・中身の薄い札（${genAt}）`, "",
    `札 ${cards.length}枚のうち、竹内さんに聞きたい札 ${thinCards.length}枚（竹内さんの送信が ${OWNER_MIN}件未満・テンプレート・決定・場面の定義が無い）`, "",
    "| 担当 | ボタン → ピッカー | 竹内さんの送信 | 足りない物 |", "|---|---|---|---|",
    ...thinCards.sort((a, b) => a.owner - b.owner).map((c) => `| ${c.key} | ${c.button}${c.picker ? ` → ${c.picker}` : ""} | ${c.owner} | ${c.thin.join("・")} |`),
  ].join("\n");
  writeFileSync(join(dir, `${genAt.slice(0, 10)}.md`), md);
  console.log(`書いた: ${join(dir, "cards.json")}・${join(dir, `${genAt.slice(0, 10)}.md`)}`);
  process.exit(0);
})();
