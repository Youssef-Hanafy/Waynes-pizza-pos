import { describe,it,expect } from "vitest";
// @ts-expect-error The release operator tool is also executed directly by Node on Vercel.
import {assertForwardRelease} from "../scripts/verify-release.mjs";
import {execFileSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {parseRelease, acceptsClientContract} from "../src/lib/pos/release";
describe("release promotion protection",()=>{
 it("supports legacy clients only within the declared compatibility window",()=>{
  const release={build:"B",commit:"a".repeat(40),builtAt:new Date().toISOString(),contract:1,minimumClient:0,minimumBridge:1};
  expect(acceptsClientContract(null,release)).toBe(true);expect(acceptsClientContract("1",release)).toBe(true);
  expect(acceptsClientContract("2",release)).toBe(false);expect(acceptsClientContract("invalid",release)).toBe(false);
  expect(acceptsClientContract("1",{...release,contract:2,minimumClient:2})).toBe(false);
 });
 it("accepts a descendant and refuses a real older Git commit",()=>{
  const dir=mkdtempSync(join(tmpdir(),"wayne-release-"));
  const git=(...args:string[])=>execFileSync("git",args,{cwd:dir,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  try{
   git("init");git("-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-m","first");const old=git("rev-parse","HEAD");
   git("-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-m","second");const current=git("rev-parse","HEAD");
   const ancestor=(a:string,b:string)=>{try{git("merge-base","--is-ancestor",a,b);return true;}catch{return false;}};
   expect(()=>assertForwardRelease(old,current,ancestor)).not.toThrow();
   expect(()=>assertForwardRelease(current,old,ancestor)).toThrow("does not contain");
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it("rejects unverifiable identities instead of guessing",()=>{expect(()=>assertForwardRelease("", "a".repeat(40),()=>true)).toThrow();expect(parseRelease({build:"B"})).toBeNull();});
 it("parses only a complete contract",()=>{const r={build:"dpl_verified",commit:"a".repeat(40),builtAt:new Date().toISOString(),contract:1,minimumClient:0,minimumBridge:1};expect(parseRelease(r)).toEqual(r);expect(parseRelease({...r,minimumClient:2})).toBeNull();});
});
