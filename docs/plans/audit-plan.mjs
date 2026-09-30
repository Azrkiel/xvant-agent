
import fs from "node:fs";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";

const plan = fs.readFileSync(new URL("./2026-09-26-xvant-implementation-plan.md", import.meta.url), "utf8");
const first = fs.readFileSync(new URL("./2026-09-26-xvant-first-slice.md", import.meta.url), "utf8");
const gates = fs.readFileSync(new URL("./2026-09-26-xvant-release-gates.md", import.meta.url), "utf8");
for (const [name, text] of [["plan",plan],["first-slice",first],["gates",gates]]) {
  assert.equal((text.match(/^\x60\x60\x60/gm) ?? []).length % 2, 0, name + " has unclosed fences");
  assert.ok(!/\b(TBD|TODO|FIXME|Loom)\b/.test(text), name + " has stale names/placeholders");
}
const tasks = [...plan.matchAll(/^- \[[ x]\] (P\d{2}\.\d+) /gm)].map(x=>x[1]);
assert.equal(tasks.length,new Set(tasks).size,"duplicate task IDs");
assert.equal(tasks.length,82,"expected 82 implementation tasks");
for(let i=0;i<=10;i++){
  const id=String(i).padStart(2,"0");
  assert.ok(plan.includes("Gate G"+id+":"),"missing gate G"+id);
  assert.ok(gates.includes("| G"+id+" |"),"missing gate register G"+id);
  assert.ok(tasks.some(x=>x.startsWith("P"+id+".")),"missing phase tasks");
}
for(let i=1;i<=16;i++) assert.ok(plan.includes("| R"+String(i).padStart(2,"0")+" |"),"missing requirement");
for(let i=1;i<=32;i++) assert.ok(plan.includes("| F"+String(i).padStart(2,"0")+" |"),"missing failure fixture");
const blocks=[...first.matchAll(/\x60\x60\x60typescript\r?\n([\s\S]*?)\x60\x60\x60/g)].map(x=>x[1]);
assert.equal(blocks.length,3,"expected contract, tests, implementation");
const redSource=blocks[0];
const greenSource=blocks[0].slice(0,blocks[0].indexOf("export function transition"))+blocks[2];
const compiledTests=stripTypeScriptTypes(blocks[1],{mode:"transform"})
  .replace(/import\s*\{[^}]*\}\s*from\s*["']vitest["'];?/g,
    "const {describe,expect,it} = globalThis.__xvantHarness;")
  .replace(/import\s*\{[^}]*\}\s*from\s*["']\.\/task\.js["'];?/g,
    "const {transition} = globalThis.__xvantModule;");

const results=[];
for(const [stage,source] of [["red",redSource],["green",greenSource]]){
  const js=stripTypeScriptTypes(source,{mode:"transform"});
  globalThis.__xvantModule=await import("data:text/javascript;base64,"+Buffer.from(js).toString("base64")+"#"+stage);
  const cases=[];
  globalThis.__xvantHarness={
    describe:(_name,fn)=>fn(),
    it:(name,fn)=>cases.push({name,fn}),
    expect:(actual)=>({
      toBe:expected=>assert.equal(actual,expected),
      not:{toBe:expected=>assert.notEqual(actual,expected)},
      toThrow:expected=>{
        assert.equal(typeof actual,"function");
        let thrown;
        try{actual();}catch(error){thrown=error;}
        assert.ok(thrown instanceof Error,"expected Error");
        assert.ok(thrown.message.includes(expected),"expected "+expected+"; received "+thrown.message);
      }
    })
  };
  await import("data:text/javascript;base64,"+Buffer.from(compiledTests).toString("base64")+"#"+stage);
  assert.equal(cases.length,15,"expected exactly 15 starter tests");
  const failed=[];
  for(const test of cases){try{test.fn();}catch(e){failed.push({name:test.name,error:e.message});}}
  if(stage==="red") assert.equal(failed.length,15,"red stage must fail all cases");
  else assert.deepEqual(failed,[],"green stage failures");
  results.push({stage,discovered:cases.length,passed:cases.length-failed.length,failed:failed.length});
}
console.log(JSON.stringify({
  documentAudit:"PASS",
  tasks:tasks.length,
  phases:11,
  requirements:16,
  failureScenarios:32,
  starterSnippetAudit:results,
  method:"Node built-in TypeScript transform and small assert harness; not an installed Vitest/project test run",
  node:process.version
},null,2));
