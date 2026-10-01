import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const DIR = "C:/Users/竹内悠~1/AppData/Local/Temp/claude/c--Users-------sumora-ai-ui/90d5437f-9ec8-479d-94e9-1097dde86432/scratchpad/tplfix";
const CLOSE = (s: string) => s.replace(/お気に召されたお部屋ご都合よろしい/g, "お気に召されましたらご都合よろしい");
const FIX: Record<string, (s: string) => string> = {
  "648240d7-1b2c-4794-900f-10f7e6a98580": CLOSE, // 1件特にオススメ
  "c8ec4b46-6fae-44f0-bc21-d56d1a30bd8f": (s) => CLOSE(s).replace(/𝚂𝚊𝚗𝚊\.さん/g, "アカウント名さん"), // 【複数】見積書
  "cb02db16-7304-4a2a-ba5b-b68e294e7725": (s) => CLOSE(s).replace(/mai\.tさん/g, "アカウント名さん"), // [B5編集]百舌館
  "ecabbb83-7956-4a5f-b67f-d1fc98786759": (s) => s.replace(/タクヤさん/g, "アカウント名さん").replace("98,500円", "〇〇円").replace("お気に召さましたら", "お気に召されましたら"), // 【初期費用】訴求
  "c7210610-d33d-4214-bacf-101f3e239772": (s) => s.replace(/🐈‍⬛さん/g, "アカウント名さん"), // 【新着】
  "773f1bde-d360-48cf-8727-c8bbbe0fbbb3": (s) => s.replace(/大野さん/g, "アカウント名さん"), // 【新着】見積書同封・初期費用
};
const apply = process.argv.includes("--apply");
(async () => {
  const { data, error } = await sb.from("templates").select("id,category,label,text").in("id", Object.keys(FIX));
  if (error) throw error;
  if (data!.length !== 6) throw new Error("expected 6 rows, got " + data!.length);
  if (apply) writeFileSync(`${DIR}/templates-before.json`, JSON.stringify(data, null, 2), "utf8");
  const after: any[] = [];
  for (const r of data!) {
    const next = FIX[r.id](r.text);
    if (next === r.text) throw new Error("no change for " + r.label);
    after.push({ ...r, text: next });
    console.log(`===== ${r.label}（${r.category}）\n--- 前\n${r.text}\n--- 後\n${next}\n`);
    if (apply) { const { data: u, error: e } = await sb.from("templates").update({ text: next }).eq("id", r.id).select("id,text"); if (e) throw e; if (u?.length !== 1 || u[0].text !== next) throw new Error("update not applied " + r.label); }
  }
  if (apply) { writeFileSync(`${DIR}/templates-after.json`, JSON.stringify(after, null, 2), "utf8"); console.log("APPLIED"); }
})();
