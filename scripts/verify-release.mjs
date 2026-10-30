import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const git = (...args) => execFileSync("git",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
export function assertForwardRelease(live, candidate, ancestor) {
 if (!/^[a-f0-9]{7,40}$/.test(live) || !/^[a-f0-9]{40}$/.test(candidate)) throw Error("Release commit identity is missing or invalid");
 if (!ancestor(live,candidate)) throw Error("Candidate does not contain the current live commit; promotion refused");
}
export async function identity(url) {
 const response=await fetch(new URL(`/api/version?releaseCheck=${Date.now()}`,url),{cache:"no-store",signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error(`Version identity unavailable: HTTP ${response.status}`);
 return response.json();
}
async function main() {
 const args=process.argv.slice(2); const value=name=>args[args.indexOf(name)+1];
 const candidate=git("rev-parse",args.includes("--candidate")?value("--candidate"):"HEAD");
 const live=await identity(args.includes("--live")?value("--live"):"https://app.hanafymedia.com");
 // One verified legacy baseline predates the full /api/version contract. Never guess other builds.
 if(!live.commit && live.build==="dpl_H6w3ypXMdiefq9UpRHmCEZoUjtkz")live.commit="a17806f9c958933faf571a445b9d5435b5236080";
 // Vercel checkouts may be shallow. Fetch only the exact live object if necessary.
 try{git("cat-file","-e",`${live.commit}^{commit}`);}catch{git("fetch","--no-tags","--unshallow","origin");}
 assertForwardRelease(live.commit,candidate,(a,b)=>{try{git("merge-base","--is-ancestor",a,b);return true;}catch{return false;}});
 if(!args.includes("--build-guard")) {
  if(git("status","--porcelain"))throw Error("Checkout has uncommitted changes");
  const remote=git("ls-remote","origin","refs/heads/main").split(/\s/)[0];
  assertForwardRelease(remote,candidate,(a,b)=>{try{git("merge-base","--is-ancestor",a,b);return true;}catch{return false;}});
  if(!args.includes("--staging"))throw Error("Exact tested staging URL is required");
  const stage=await identity(value("--staging"));
  if(stage.commit!==candidate || !stage.build || !Number.isFinite(Date.parse(stage.builtAt)) || stage.contract!==1 || stage.minimumBridge!==1)throw Error("Staging is not the exact compatible candidate");
 }
 console.log(JSON.stringify({result:"PASS",liveCommit:live.commit,candidate,liveBuild:live.build}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
