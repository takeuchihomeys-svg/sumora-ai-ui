// F54 課題学習完全 / F55 自動反映確認（純関数・DB無し）
// 実行: npx tsx app/lib/__tests__/foundation-f54-f55.test.ts
import {
  auditChallengeLearnComplete,
  auditAutoReflectVerified,
  auditPlaybookRulesReflect,
  auditProReflectResponsibility,
  collectBundleFieldSets,
} from "../learn-foundation-audit";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
};

console.log("■ collectBundleFieldSets");
{
  const bundle = {
    points: { "rental_cost2": { x: 10, y: 20, n: 3 } },
    shots: {
      learned: {
        form: [{ name: "room_layout_id[]", x: 1, y: 2, n: 5, kind: "checkbox" }],
      },
    },
  };
  const sets = collectBundleFieldSets(bundle);
  ok("points に rental_cost2", sets.points.has("rental_cost2"));
  ok("learned に room_layout_id[]", sets.learned.has("room_layout_id[]"));
}

console.log("\n■ auditChallengeLearnComplete");
{
  const good = auditChallengeLearnComplete({
    challengeFields: ["rental_cost2", "room_layout_id[]"],
    bundle: {
      points: {
        rental_cost2: { x: 1, y: 2 },
        "room_layout_id[]": { x: 5, y: 6 },
      },
      shots: {
        learned: {
          form: [
            { name: "room_layout_id[]", x: 3, y: 4, kind: "checkbox" },
            { name: "rental_cost2", x: 1, y: 2, kind: "select" },
          ],
        },
      },
    },
    normalUnlearned: 0,
  });
  ok("各課題欄が points∧learned・未学習0→✓", good.ok);

  const missLearned = auditChallengeLearnComplete({
    challengeFields: ["required_time"],
    bundle: {
      points: { required_time: { x: 1, y: 2 } },
      shots: { learned: { form: [] } },
    },
    normalUnlearned: 0,
  });
  ok("pointsのみ→✗", !missLearned.ok);
  ok("learned欠", missLearned.missingLearned.includes("required_time"));

  const todo = auditChallengeLearnComplete({
    challengeFields: [],
    bundle: { points: {}, shots: { learned: {} } },
    normalUnlearned: 3,
  });
  ok("未学習あり→✗", !todo.ok);
  ok("通常未学習=3", todo.normalTodo === 3);

  const vacuous = auditChallengeLearnComplete({
    challengeFields: [],
    bundle: { points: {}, shots: { learned: {} } },
    normalUnlearned: 0,
  });
  ok("課題無・未学習0→✓", vacuous.ok);
}

console.log("\n■ auditAutoReflectVerified");
{
  const full = auditAutoReflectVerified({
    readCount: 2,
    autoAfterBundle: 1,
    reflectOk: 1,
    flowReflectOk: 0,
    aimYes: 0,
  });
  ok("read+auto+reflect→✓", full.ok);

  const aim = auditAutoReflectVerified({ readCount: 1, autoAfterBundle: 2, reflectOk: 0, flowReflectOk: 0, aimYes: 3 });
  ok("aim有で✓", aim.ok);

  const flow = auditAutoReflectVerified({ readCount: 1, autoAfterBundle: 1, reflectOk: 0, flowReflectOk: 1, aimYes: 0 });
  ok("flow_reflectで✓", flow.ok);

  const noRead = auditAutoReflectVerified({ readCount: 0, autoAfterBundle: 1, reflectOk: 1, aimYes: 1 });
  ok("read0→✗", !noRead.ok);

  const noAuto = auditAutoReflectVerified({ readCount: 1, autoAfterBundle: 0, reflectOk: 1, aimYes: 1 });
  ok("自動0→✗", !noAuto.ok);

  const noMark = auditAutoReflectVerified({ readCount: 1, autoAfterBundle: 1, reflectOk: 0, flowReflectOk: 0, aimYes: 0 });
  ok("印なし→✗", !noMark.ok);
}

console.log("\n■ auditProReflectResponsibility (F56)");
{
  const full = auditProReflectResponsibility({
    f53Ok: true, f54Ok: true, f55Ok: true, f15Ok: true, f28Ok: true, f29Ok: true,
  });
  ok("6/6揃えば✓", full.ok && full.done === 6 && full.missing.length === 0);

  const waitReflect = auditProReflectResponsibility({
    f53Ok: true, f54Ok: false, f55Ok: false, f15Ok: false, f28Ok: false, f29Ok: false,
  });
  ok("F55未なら最優先が自動再読込", !waitReflect.ok && waitReflect.done === 1 && /2\.8\.101/.test(waitReflect.next));

  const waitF54 = auditProReflectResponsibility({
    f53Ok: true, f54Ok: false, f55Ok: true, f15Ok: true, f28Ok: true, f29Ok: true, f54Next: "残り通常を画像学習",
  });
  ok("F55済でF54未ならf54Next採用", !waitF54.ok && waitF54.done === 5 && /残り通常/.test(waitF54.next));
}

console.log("\n■ auditPlaybookRulesReflect (F63)");
{
  const full = auditPlaybookRulesReflect({
    codeRulesV: "e0b8837b",
    dbRulesV: "e0b8837b",
    seenRulesV: "e0b8837b",
    readCount: 2,
  });
  ok("DB=既読=コード・read≥1→✓", full.ok);

  const staleSeen = auditPlaybookRulesReflect({
    codeRulesV: "e0b8837b",
    dbRulesV: "e0b8837b",
    seenRulesV: "4c266b56",
    readCount: 2,
  });
  ok("自動既読が旧→✗", !staleSeen.ok && /自動既読≠コード/.test(staleSeen.line));

  const noRead = auditPlaybookRulesReflect({
    codeRulesV: "e0b8837b",
    dbRulesV: "e0b8837b",
    seenRulesV: "e0b8837b",
    readCount: 0,
  });
  ok("read0→✗", !noRead.ok && /read=0/.test(noRead.line));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);