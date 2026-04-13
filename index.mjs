#!/usr/bin/env node
import { createInterface } from 'readline'; import { spawn } from 'child_process'; import { readFileSync, writeFileSync } from 'fs';
const tools = {
  bash: ({command})=>new Promise(r=>{const c=spawn('bash',['-c',command],{stdio:['ignore','pipe','pipe'],detached:true});let o='';c.stdout.on('data',d=>o+=d);c.stderr.on('data',d=>o+=d);const h=()=>{try{process.kill(-c.pid)}catch(e){}};process.on('SIGINT',h);c.on('exit',()=>{process.off('SIGINT',h);r(o)})}),
  read:  ({path})         => readFileSync(path,'utf8'),
  write: ({path,content}) => (writeFileSync(path,content),'ok'),
};
const mkp = (...keys) => ({type:'object',properties:Object.fromEntries(keys.map(k=>[k,{type:'string'}])),required:keys});
const defs = [{name:'bash',description:'run bash cmd',parameters:mkp('command')},{name:'read',description:'read a file',parameters:mkp('path')},{name:'write',description:'write a file',parameters:mkp('path','content')}].map(f=>({type:'function',function:f}));
async function run(msgs) { while (true) {
    const r = await fetch(`${(process.env.OPENAI_BASE_URL||'https://api.openai.com').replace(/\/+$/,'')}/v1/chat/completions`,{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},
      body:JSON.stringify({model:process.env.MODEL||'gpt-5.4',messages:msgs,tools:defs})}).then(r=>r.json());
    const msg = r.choices?.[0]?.message; if (!msg) throw new Error(JSON.stringify(r));
    msgs.push(msg); if (!msg.tool_calls) return msg.content;
    for (const t of msg.tool_calls) {
      const {name}=t.function, args=JSON.parse(t.function.arguments), dim=s=>`\x1b[90m${s}\x1b[0m`;
      console.log(dim(`⟡ ${name}(${JSON.stringify(args)})`));
      const out=String(await tools[name](args)); console.log(dim(out.length>200?out.slice(0,200)+'…':out));
      msgs.push({role:'tool',tool_call_id:t.id,content:out});
    } } }
const SYSTEM = (process.env.SYSTEM_PROMPT || 'You are an autonomous agent. Prefer action over speculation—use tools to answer questions and complete tasks.\nbash runs any shell command: curl/wget for HTTP, git, package managers, compilers, anything available on the system.\nread/write operate on local files. Always read before editing; write complete files.\nApproach: explore, plan, act one step at a time, verify. Be concise.') + `\nCWD: ${process.cwd()}\nDate: ${new Date().toISOString()}`;
const hist = [{role:'system',content:SYSTEM}], arg = k => (i=>i>=0&&process.argv[i+1])(process.argv.indexOf(k));
if (process.argv.includes('-h')) { console.log('usage: mi [-p prompt] [-f file] [-h]\n  pipe: echo "..." | mi    repl: /reset clears history\nenv: OPENAI_API_KEY, MODEL, OPENAI_BASE_URL, SYSTEM_PROMPT'); process.exit(0); }
const fArg = arg('-f'); if (fArg) hist[0].content += `\n\nFile (${fArg}):\n` + readFileSync(fArg,'utf8');
if (arg('-p')) { hist.push({role:'user',content:arg('-p')}); console.log(await run(hist)); process.exit(0); }
if (!process.stdin.isTTY) { let s=''; for await(const c of process.stdin)s+=c; hist.push({role:'user',content:s.trim()}); console.log(await run(hist)); process.exit(0); }
const rl = createInterface({input:process.stdin,output:process.stdout}); const ask = q => new Promise(r=>rl.question(q,r));
rl.on('close',()=>process.exit(0)); while (true) { const i = await ask('\n> '); if (i==='/reset'){hist.splice(1);continue} if (i.trim()) { hist.push({role:'user',content:i}); console.log(await run(hist)); } }
