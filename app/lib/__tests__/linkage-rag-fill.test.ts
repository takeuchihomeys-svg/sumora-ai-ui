// npx tsx app/lib/__tests__/linkage-rag-fill.test.ts
// 2026-11-28 作業員L（台帳 #557）: 連携の地図の RAG の行を rag_call_logs の呼び出しの数と行が返った割合で測る
import assert from "node:assert/strict";
import { LINKAGE_MAP, rowStatus, RAG_FILL_RPC, type SwitchState } from "../linkage-map";
const on = (name: string): SwitchState => ({ name, value: "on", from: "default", on: true });
const off = (name: string): SwitchState => ({ name, value: "off", from: "default", on: false });
const row = (id: string) => LINKAGE_MAP.find((r) => r.id === id)!;
// 4行とも rpc の表にある
for (const id of ["rag.reply_examples", "rag.knowledge", "rag.takeuchi", "rag.aix_examples"]) { const f = row(id).fill; assert.ok(f.src === "rag" && RAG_FILL_RPC[f.name], id); }
const st = (id: string, fill: { rate: number | null; n: number } | undefined, sw = on) => rowStatus(row(id), sw, { [id]: fill });
assert.equal(st("rag.reply_examples", { rate: 0.986, n: 175 }).status, "connected");
assert.match(st("rag.reply_examples", { rate: 0.986, n: 175 }).why, /match_reply_examples.*99%（175 回・7日）/);
assert.equal(st("rag.knowledge", { rate: 0.2, n: 50 }).status, "sparse");
assert.equal(st("rag.knowledge", { rate: 0, n: 50 }).status, "broken");
assert.equal(st("rag.aix_examples", { rate: 0, n: 0 }).status, "broken");
assert.equal(st("rag.aix_examples", undefined).status, "unknown");
// 竹内さんの手本の RAG は文の指示役（BRAIN_COMPOSE_BLUEPRINT・既定 off）の中だけ＝off の間は呼ばれないので「親が off」
assert.equal(st("rag.takeuchi", { rate: 0, n: 0 }, off).status, "parent_off");
console.log("linkage-rag-fill ok 11");
