#!/usr/bin/env node

/*
 * Import readline for interactive CLI input, child_process to spawn commands,
 * fs to read files, and os to get the home directory. Exit with an error
 * if OPENAI_API_KEY is missing and -h was not passed.
 */
import { createInterface } from 'readline'; import { spawn } from 'child_process'; import { readFileSync, existsSync, readdirSync } from 'fs'; import { homedir } from 'os'; const DIR = new URL('.', import.meta.url).pathname; process.env.MI_PATH = new URL(import.meta.url).pathname; if (!process.env.OPENAI_API_KEY && !process.argv.includes('-h')) { console.error('OPENAI_API_KEY required'); process.exit(1); }

/* Tools the agent can invoke. */
const tools = {

  /* Run a command in a detached bash shell; resolve with combined output. */
  bash: ({command,timeout,bg}) => { if (bg) { const log=`/tmp/mi-${Date.now()}.log`; const proc=spawn('bash',['-c',`${command} >${log} 2>&1`],{stdio:'ignore',detached:true}); proc.unref(); return `pid:${proc.pid} log:${log}`; } return new Promise(resolve => { const child = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

    /* Collect stdout and stderr into a single string. */
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);

    /* Kill the process group on SIGINT; remove the listener on exit. */
    const cleanup = () => { try { process.kill(-child.pid) } catch (err) {} }; process.on('SIGINT', cleanup); const timer = timeout ? setTimeout(() => { cleanup(); resolve(output+'\n[timeout]') }, +timeout) : null;

    /* Resolve with collected output once the child process exits. */
    child.on('exit', () => { process.off('SIGINT', cleanup); if (timer) clearTimeout(timer); resolve(output); }); }); },

  /* Load a skill's SKILL.md by name, or list available skills as `- name: description` bullets parsed from YAML frontmatter. */
  skill: ({name}) => name ? loadSkill(name) : listSkills().join('\n'),

}; const meta = s => ({ name: s.match(/^name:\s*(.+)$/m)?.[1], description: s.match(/^description:\s*(.+)$/m)?.[1] || '' }), getSkillDirs = () => [`${DIR}skills/`, `${process.env.HOME || homedir()}/.agents/skills/`], dim = s => `\x1b[90m${s}\x1b[0m`;
const listSkills = () => getSkillDirs().flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(dirName => existsSync(dir+dirName+'/SKILL.md')).map(dirName => { const {name,description} = meta(readFileSync(dir+dirName+'/SKILL.md','utf8')); return `- ${name||dirName}: ${description}`; }) : []), loadSkill = name => { for (const dir of getSkillDirs()) if (existsSync(dir+name+'/SKILL.md')) return readFileSync(dir+name+'/SKILL.md','utf8'); }, makeParams = (...keys) => ({ type: 'object', properties: Object.fromEntries(keys.map(key => [key.replace('?',''), { type: 'string' }])), required: keys.filter(key => !key.startsWith('?')) });

/* Tool definitions formatted for the OpenAI API. */
const toolsDef = [{ name: 'bash', description: 'Runs in a detached process group. Returns combined stdout+stderr. Optional: timeout=ms kills after delay; bg=truthy fully detaches and returns pid + log file path.', parameters: makeParams('command', '?timeout', '?bg') }, { name: 'skill', description: 'With name: returns that skill\'s SKILL.md body. Without name: lists available skills with descriptions.', parameters: makeParams('?name') }].map(func => ({ type: 'function', function: func }));

/*
 * Call the chat API in a loop, executing tool calls, until the model
 * returns a plain text reply. Streams content tokens to stdout as they arrive.
 */
async function run(messages) { while (true) {

  /* POST with stream:true; throw on non-200 by reading the JSON error body. */
  const response = await fetch(`${(process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '')}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: process.env.MODEL || 'gpt-5.4', messages, tools: toolsDef, stream: true }) }); if (!response.ok) { const error = await response.json().catch(()=>({})); throw new Error(error.error?.message || `HTTP ${response.status}`); }

  /* Iterate SSE deltas: write content tokens to stdout, merge tool_call fragments by index into one assistant message. */
  const message = { role: 'assistant', content: '' }, dec = new TextDecoder(); let buf = '';
  for await (const chunk of response.body) { buf += dec.decode(chunk, {stream:true}); let sep; while ((sep = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, sep); buf = buf.slice(sep+2); for (const line of ev.split('\n')) { if (!line.startsWith('data: ')) continue; const data = line.slice(6); if (data === '[DONE]') continue; let json; try { json = JSON.parse(data); } catch { continue; } if (json.error) throw new Error(json.error.message || JSON.stringify(json.error)); const delta = json.choices?.[0]?.delta; if (!delta) continue; if (delta.content) { process.stdout.write(delta.content); message.content += delta.content; } if (delta.tool_calls) { message.tool_calls ||= []; for (const toolDelta of delta.tool_calls) { const merged = message.tool_calls[toolDelta.index] ||= { id:'', type:'function', function:{name:'',arguments:''} }; if (toolDelta.id) merged.id = toolDelta.id; if (toolDelta.type) merged.type = toolDelta.type; if (toolDelta.function?.name) merged.function.name += toolDelta.function.name; if (toolDelta.function?.arguments) merged.function.arguments += toolDelta.function.arguments; } } } } }
  if (message.content) process.stdout.write('\n'); messages.push(message); if (!message.tool_calls) return;

  for (const toolCall of message.tool_calls) {
    const {name} = toolCall.function, args = JSON.parse(toolCall.function.arguments);

    /* Log the call, run the tool, log a truncated result, push to history. */
    console.log(dim(`⟡ ${name}(${JSON.stringify(args)})`)); const out = String(await tools[name](args));
    console.log(dim(out.length > 200 ? out.slice(0, 200) + '…' : out)); messages.push({ role: 'tool', tool_call_id: toolCall.id, content: out });

  } } }

/* System prompt: built-in instructions plus current directory and date. */
const SYSTEM = (process.env.SYSTEM_PROMPT || 'You are an autonomous agent running in a raw terminal. Your output is printed verbatim—there is no markdown renderer, so avoid **, `, #, and ``` which display as literal characters. Use whitespace and plain punctuation to structure text.\n\nAct rather than speculate. Explore the problem, form a plan, execute one step at a time, verify each step before proceeding. If something fails, diagnose and retry. Keep going until the task is complete. When a request matches a skill description below, load that skill and follow it.\n\nMinimize context usage when reading files: head -20 for starts, tail -20 for ends, sed -n \'10,30p\' for ranges, grep -n to locate then read around matches. Reserve cat for short files. Edit with sed -i or heredocs (cat > file <<\'EOF\'). Always read before editing.\n\nWhen done, show the command output that proves it—not a summary.') + `\nCWD: ${process.cwd()}\nDate: ${new Date().toISOString()}`;

/* History seeded with the system prompt; getArg reads a named CLI flag. */
const history = [{ role: 'system', content: SYSTEM }], getArg = key => (idx => idx >= 0 && process.argv[idx + 1])(process.argv.indexOf(key));

if (process.argv.includes('-h')) { console.log('usage: mi [-p prompt] [-f file] [-h]\n  pipe: echo "..." | mi    repl: /reset clears history\nenv: OPENAI_API_KEY, MODEL, OPENAI_BASE_URL, SYSTEM_PROMPT\nbash tool args: timeout=<ms> kills after delay · bg=truthy detaches and returns pid+log'); process.exit(0); }

/* Prepend -f file, AGENTS.md, and the skills index (if present) to the system message. */
const fileArg = getArg('-f'); if (fileArg) history[0].content += `\n\nFile (${fileArg}):\n` + readFileSync(fileArg, 'utf8'); if (existsSync('AGENTS.md')) history[0].content += '\n' + readFileSync('AGENTS.md', 'utf8'); const skills = listSkills(); if (skills.length) history[0].content += '\n\nSkill descriptions:\n' + skills.join('\n');

if (getArg('-p')) { history.push({ role: 'user', content: getArg('-p') }); await run(history); process.exit(0); }

if (!process.stdin.isTTY) { let inputStr = ''; for await (const chunk of process.stdin) inputStr += chunk; history.push({ role: 'user', content: inputStr.trim() }); await run(history); process.exit(0); }

/* Set up the readline interface and enter the interactive REPL. */
const readLine = createInterface({ input: process.stdin, output: process.stdout }); const promptUser = query => new Promise(resolve => readLine.question(query, resolve)); const ver = JSON.parse(readFileSync(DIR+'package.json','utf8')).version; console.log('\x1b[38;5;208m◰ mi\x1b[90m/'+ver+'\x1b[0m');

readLine.on('close', () => process.exit(0)); while (true) { const input = await promptUser('\n> '); if (input === '/reset') { history.splice(1); console.log(dim('✓ reset')); continue; } if (input.trim()) { history.push({ role: 'user', content: input }); process.stdout.write(dim('─────')+'\n'); try { await run(history); } catch(error) { console.error('\x1b[31m✗ ' + error.message + '\x1b[0m'); history.pop(); } } }
