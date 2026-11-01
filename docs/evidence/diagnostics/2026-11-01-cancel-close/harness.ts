import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/storage/src/store.ts';
import { ArtifactStore } from '../packages/storage/src/artifacts.ts';
import { createWorktree } from '../packages/storage/src/git-workspace.ts';
import { WorkerSupervisor } from '../packages/supervisor/src/index.ts';
import { ClaudeHeadlessStream } from '../packages/adapters/src/live/claude-headless.ts';
import { LiveTurnRunner } from '../apps/controller/src/turn-runner.ts';
const executable = 'C:/Users/jiang/.local/bin/claude.exe';
const version = spawnSync(executable, ['--version'], {encoding:'utf8'}).stdout.trim().split(' ')[0];
const base = realpathSync(mkdtempSync(join(tmpdir(), 'xcd-')));
const repo = join(base,'repo'); mkdirSync(repo);
const git = (...args: string[]) => { const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'}); if(r.status)throw Error(r.stderr);return r.stdout.trim(); };
git('init','-q','-b','main');writeFileSync(join(repo,'README.md'),'# diagnostic\n');git('add','.');git('-c','user.name=t','-c','user.email=t@t','commit','-qm','base');
const workspace=createWorktree(repo,'main',join(base,'wt'),'xvant/diagnostic');
const store=new Store(join(base,'state.sqlite'),{owner:'diagnostic'});
const trace: unknown[]=[]; const log=(...x:unknown[])=>{trace.push(x);console.log(JSON.stringify(x));};
for(const name of ['requestInterrupt','bindRun','finish','unknown'] as const){
 const real=store.providers[name].bind(store.providers) as (...a:unknown[])=>unknown;
 (store.providers as unknown as Record<string,unknown>)[name]=(...a:unknown[])=>{log('provider',name,a[0],name==='bindRun'?a[2]:name==='finish'?a[3]:null);try{return real(...a);}catch(e){log('provider-error',name,(e as Error).message);throw e;}};
}
const realSpawn=childProcess.spawn;
childProcess.spawn=function(...args){const child=realSpawn(...args); const label=String(args[0]).includes('taskkill')?'killer:'+JSON.stringify(args[1]):'owned'; const started=Date.now(); child.on('exit',(code,signal)=>log('child-exit',label,Date.now()-started,code,signal)); child.on('close',(code,signal)=>log('child-close',label,Date.now()-started,code,signal));return child;};
syncBuiltinESMExports();
const receive=ClaudeHeadlessStream.prototype.receive;
ClaudeHeadlessStream.prototype.receive=function(bytes){try{const r=receive.call(this,bytes);log('stream',this.started,this.finished,r.frames.map(f=>({type:f.type,subtype:f.subtype})));return r;}catch(e){log('stream-error',(e as Error).message);throw e;}};
const start=WorkerSupervisor.prototype.start;
let runner: LiveTurnRunner;
const id='diagnostic-'+randomUUID().slice(0,8);
WorkerSupervisor.prototype.start=function(request){
 const result=start.call(this,request);
 const versionProbe=request.args.includes('--version');
 log('start',versionProbe?'probe':'turn');
 if(!versionProbe)setTimeout(()=>{log('interrupt',runner.interrupt(id));}, Number(process.argv[2]??500));
 return {...result,result:result.result.then(r=>{log('shutdown',versionProbe?'probe':'turn',r.reason,r.exitCode,r.outputTruncated);return r;})};
};
runner=new LiveTurnRunner(store,new ArtifactStore(join(base,'objects')),[{alias:'claude-3',runtimeKind:'claude',quotaGroupId:'claude-pro',roles:['worker'],model:'haiku'}],{claude:{executable,version,qualified:true,model:'haiku'}},{timeoutMs:30000,onEvent:(_a,_t,e)=>log('event',e.kind,e.kind==='auth'?e.text:'[omitted]')});
try{
 log('base',base,'version',version,'delay',process.argv[2]??500);
 const result=await runner.run({taskId:id,projectId:'diagnostic',alias:'claude-3',prompt:'Add stats.js exporting mean, median and mode with short comments. Do not edit other files.',workspace,checks:{test:{executable:process.execPath,args:['-e','process.exit(0)']}}});
 log('outcome',result.status);
 const c=store.providers.get(id);log('saved',c.status,c.outcome,c.interrupt,store.providers.occupied('worker:claude-3'));
}finally{
 writeFileSync(join(base,'trace.json'),JSON.stringify(trace,null,2)); store.close();
 console.log('DIAGNOSTIC_RETAINED '+base);
}
