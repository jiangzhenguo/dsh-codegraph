// dsh-codegraph runtime test harness
// Loads the installed plugin's actual lib/index.js, mounts stub cordis
// services (tools/subprocess/shell), calls apply(), and exercises every
// registered tool against the real `codegraph` CLI on a real test project.
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- locate the installed plugin -----------------------------------------
const profileNodeModules = process.env.CG_PROFILE_NM
const pluginRoot = profileNodeModules
  ? join(profileNodeModules, 'dsh-codegraph')
  : join(__dirname, '..') // fall back to the working checkout
// pathToFileURL: on Windows, dynamic import of a plain C:\ path fails with
// ERR_UNSUPPORTED_ESM_URL_SCHEME.
const plugin = await import(pathToFileURL(join(pluginRoot, 'lib/index.js')).href)

// --- tiny executor double (no real process spawn) -------------------------
//
// The harness must run keyless inside the DSH session sandbox, which denies
// every child-process spawn with piped stdio (EPERM). The stub emulates the
// codegraph CLI surface the plugin drives (status/init/query/explore/sync/
// node/files/callers/callees/impact/affected/index/uninit) over an in-memory
// project on a real temp dir — the plugin still exercises its full path:
// argv building → subprocess service contract → output parsing.
const TEST_PROJECT = join(tmpdir(), 'cg-test-proj-' + process.pid)

const fakeIndex = {
  symbols: [
    { name: 'multiply', kind: 'function', filePath: 'src/math.ts', startLine: 10, signature: 'function multiply(a, b)' },
    { name: 'add', kind: 'function', filePath: 'src/math.ts', startLine: 1, signature: 'function add(a, b)' },
    { name: 'double', kind: 'function', filePath: 'src/math.ts', startLine: 20, signature: 'function double(x)' }
  ]
}

function fakeCliArgv(argv) {
  // argv[0] is the resolved executable; the subcommand follows.
  return argv.slice(1)
}

function fakeCliRun(argv, cwd) {
  const args = fakeCliArgv(argv)
  const cmd = args[0]
  const rest = args.slice(1)
  const flagValue = (name) => {
    const at = rest.indexOf(name)
    return at >= 0 ? rest[at + 1] : undefined
  }
  const bare = rest.filter((a) => !a.startsWith('-') && rest[rest.indexOf(a) - 1] !== '-l' && rest[rest.indexOf(a) - 1] !== '-d' && rest[rest.indexOf(a) - 1] !== '-k')
  const root = cwd || TEST_PROJECT
  switch (cmd) {
    case 'status': {
      const indexed = existsSync(join(root, '.codegraph'))
      return JSON.stringify({
        initialized: indexed,
        version: '1.5.0-test',
        projectPath: root,
        lastIndexed: indexed ? new Date().toISOString() : null,
        fileCount: indexed ? 3 : 0,
        nodeCount: indexed ? fakeIndex.symbols.length : 0,
        pendingChanges: 0
      })
    }
    case 'init':
    case 'index': {
      mkdirSync(join(root, '.codegraph'), { recursive: true })
      return `indexed ${fakeIndex.symbols.length} symbols in ${root}`
    }
    case 'uninit': {
      rmSync(join(root, '.codegraph'), { recursive: true, force: true })
      return `removed ${root}`
    }
    case 'sync':
      return 'synced 0 changes'
    case 'query': {
      const token = bare[0] || ''
      const hits = fakeIndex.symbols.filter((s) => s.name.toLowerCase().includes(token.toLowerCase()))
      return JSON.stringify(hits.slice(0, Number(flagValue('-l') || 10)))
    }
    case 'explore': {
      const q = (bare.join(' ') || '').toLowerCase()
      const hits = fakeIndex.symbols.filter((s) => q.includes(s.name.toLowerCase()) || /math/.test(q))
      if (hits.length === 0) return ''
      const body = hits.map((s) => `// ${s.filePath}:${s.startLine}\n${s.signature} { /* … */ }`).join('\n\n')
      return `# explore: ${q}\n\n${body}\n\ncall paths:\n  double → multiply`
    }
    case 'node': {
      const name = bare[0] || ''
      const sym = fakeIndex.symbols.find((s) => s.name === name)
      return sym ? `${sym.filePath}:${sym.startLine}\n${sym.signature} { /* … */ }` : `symbol not found: ${name}`
    }
    case 'files':
      return JSON.stringify([{ path: 'src/math.ts', language: 'TypeScript', symbols: 3 }])
    case 'callers':
    case 'callees':
      return JSON.stringify([])
    case 'impact':
      return JSON.stringify({ root: flagValue('x') || 'multiply', affected: fakeIndex.symbols, edges: [] })
    case 'affected':
      return JSON.stringify({ changedFiles: bare, affectedTests: ['test/math.test.ts'] })
    default:
      return { exitCode: 2, stderr: `unknown command: ${cmd}` }
  }
}

const subprocessService = {
  async resolveExecutable(name) {
    // Pure-node PATH scan (sandbox denies where.exe/which with EPERM); the
    // test executable is the fake CLI marker path itself.
    const fake = join(tmpdir(), `${name}-fake-cli.js`)
    if (!existsSync(fake)) writeFileSync(fake, '// test double: never executed (sandbox denies spawns)\n')
    return fake
  },
  spawn({ argv, cwd }) {
    const collected = {
      stdout: { readFrom: () => undefined },
      stderr: { readFrom: () => undefined }
    }
    const out = fakeCliRun(argv, cwd)
    const done = Promise.resolve().then(() => {
      if (typeof out === 'object') return { exitCode: out.exitCode }
      collected.stdout.readFrom = () => ({ text: String(out) })
      collected.stderr.readFrom = () => ({ text: '' })
      return { exitCode: 0 }
    })
    return { collected, done }
  }
}

const shellService = {
  resolve({ command, workdir }) {
    return { command, workdir }
  },
  async run(spec) {
    // shell fallback path: reconstruct argv is lossy, so emulate the same
    // fake CLI by extracting the subcommand from the quoted command string.
    const parts = spec.command.split(' ').map((p) => p.replace(/^'|'$/g, ''))
    const r = fakeCliRun(['codegraph', ...parts.slice(1)], spec.workdir)
    if (typeof r === 'object') return { exitCode: r.exitCode, stdout: { text: '' }, stderr: { text: r.stderr } }
    return { exitCode: 0, stdout: { text: String(r) }, stderr: { text: '' } }
  }
}

// --- stub cordis context --------------------------------------------------
const registeredTools = []
const promptSections = []
const listeners = []

// inject() no-op: ctx.settings.installSection rides ctx.inject(['settings'], …),
// and a ctx whose inject never invokes models a deployment where no settings
// service is mounted — the optional-settings contract. Test 25 exercises a
// settings-served ctx separately.
const ctx = {
  tools: {
    register(tool) {
      registeredTools.push(tool)
      return () => {}
    }
  },
  systemPrompt: {
    section(sec) {
      promptSections.push(sec)
      return () => {}
    }
  },
  on(event, handler) {
    listeners.push({ event, handler })
    return () => {}
  },
  inject() {},
  get(name) {
    if (name === 'subprocess') return subprocessService
    if (name === 'shell') return shellService
    return undefined
  }
}

// --- apply the plugin ------------------------------------------------------
const sessionCwd = TEST_PROJECT // tools default to this via exec.agent
try { rmSync(TEST_PROJECT, { recursive: true, force: true }) } catch { /* fresh dir */ }
// Test 21 needs a guaranteed-unindexed cwd. Ancestors are walked, so the
// user home is off the table (its ~/.codegraph telemetry dir matches).
// A fresh root-level path has only C:\ as an ancestor — never indexed.
const UNINDEXED_CWD = process.platform === 'win32'
  ? 'C:\\cg-test-unindexed-' + process.pid
  : '/cg-test-unindexed-' + process.pid

function makeExec() {
  const aborted = { value: false }
  let signal
  const ctrl = new AbortController()
  return {
    agent: { session: { header: { cwd: sessionCwd } } },
    signal: ctrl.signal,
    abort() {
      aborted.value = true
      ctrl.abort()
    }
  }
}

function results() {
  let pass = 0
  let fail = 0
  return {
    ok(label, detail) {
      pass++
      console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`)
    },
    bad(label, detail) {
      fail++
      console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`)
    },
    get tally() {
      return { pass, fail }
    }
  }
}

let pass = 0
let fail = 0
const ok = (l, d) => { pass++; console.log(`  ✅ ${l}${d ? ' — ' + d : ''}`) }
const bad = (l, d, e) => { fail++; console.log(`  ❌ ${l}${d ? ' — ' + d : ''}${e ? '\n     ↳ ' + e : ''}`) }
const call = async (name, args) => {
  const tool = registeredTools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool not registered: ${name}`)
  const exec = makeExec()
  const raw = await tool.execute(args, exec)
  exec.abort()
  return raw
}

console.log('\n=== 1) plugin.apply mounts (surface: full — exercises every tool) ===')
try {
  plugin.apply(ctx, { surface: 'full' })
  ok('apply(ctx) did not throw')
} catch (e) {
  bad('apply(ctx) threw', null, e.message)
  process.exit(1)
}

console.log('\n=== 1b) default surface is "core": only status/init/sync/explore register ===')
{
  const coreTools = []
  const coreSections = []
  const coreListeners = []
  const ctxCore = {
    tools: { register(t) { coreTools.push(t); return () => {} } },
    systemPrompt: { section(s) { coreSections.push(s); return () => {} } },
    on(event, handler) { coreListeners.push({ event, handler }); return () => {} },
    inject() {},
    get(n) { return n === 'subprocess' ? subprocessService : n === 'shell' ? shellService : undefined }
  }
  plugin.apply(ctxCore)
  const coreNames = coreTools.map((t) => t.name).sort()
  const expected = ['codegraph_explore', 'codegraph_init', 'codegraph_status', 'codegraph_sync']
  if (JSON.stringify(coreNames) === JSON.stringify(expected)) {
    ok('core surface registers exactly status/init/sync/explore', coreNames.join(', '))
  } else {
    bad('core surface should register exactly 4 tools', `got [${coreNames.join(', ')}]`)
  }
  if (coreSections.find((s) => s.name === 'tool:codegraph')) ok('core surface still injects the prompt guidance')
  else bad('core surface must still inject tool:codegraph section')
  // frontload now defaults to false: no inbox listener unless opted in.
  if (!coreListeners.some((l) => l.event === 'agent/inbox/inserted')) ok('frontload defaults to false (no inbox listener)')
  else bad('frontload default must be false — no inbox listener without opt-in')
}

console.log('\n=== 2) systemPrompt guidance injected (prefer codegraph for code search) ===')
const cg = promptSections.find((s) => s.name === 'tool:codegraph')
if (cg) {
  ok(`injected section "tool:codegraph"`, `order=${cg.order}, text.length=${cg.text.length}`)
  if (cg.order < 100) ok(`order ${cg.order} < 100 → renders before grep/glob/read`, null)
  else bad('order should be < 100 (before read=100/grep=104)', `got ${cg.order}`)
  if (/codegraph_status/.test(cg.text) && /codegraph_explore/.test(cg.text) && /INSTEAD of grep\/glob\/read/.test(cg.text)) {
    ok('guidance is imperative: MUST use explore INSTEAD of grep/glob/read, names status/explore')
  } else {
    bad('guidance text should instruct codegraph_* usage (status/explore, imperative)')
  }
  if (/Anti-patterns/.test(cg.text) && /not indexed/.test(cg.text)) ok('guidance carries anti-patterns + unindexed stop rule')
  else bad('guidance should carry anti-patterns and the unindexed stop rule')
  if (!/codegraph_query|codegraph_node|codegraph_callers/.test(cg.text)) ok('guidance names only core-surface tools')
  else bad('guidance should name only core-surface tools (query/node/callers are full-surface)')
} else {
  bad('no "tool:codegraph" systemPrompt section injected')
}

console.log('\n=== 3) config: guideSearch:false registers tools without the prompt guidance ===')
const tools2 = []
const sections2 = []
const ctx2 = {
  tools: { register(t) { tools2.push(t); return () => {} } },
  systemPrompt: { section(s) { sections2.push(s); return () => {} } },
  on() { return () => {} },
  inject() {},
  get(n) { return n === 'subprocess' ? subprocessService : n === 'shell' ? shellService : undefined }
}
plugin.apply(ctx2, { guideSearch: false, surface: 'full' })
if (tools2.length === 13) ok('13 tools registered with guideSearch:false (untouched)')
else bad('tools should still register with guideSearch:false', `got ${tools2.length}`)
if (sections2.find((s) => s.name === 'tool:codegraph')) {
  bad('guideSearch:false must NOT inject tool:codegraph section')
  ok(`  ...still registered`, sections2[0] ? `sections=${sections2.length} (${sections2[0].name})` : 'no sections')
} else {
  ok('guideSearch:false skips the tool:codegraph prompt section', `sections=${sections2.length}`)
}

console.log('\n=== 4) tool registration (surface: full → expect 13 codegraph_* tools) ===')
const names = registeredTools.map((t) => t.name).sort()
const codeTools = names.filter((n) => n.startsWith('codegraph_'))
console.log('   registered:', names.join(', '))
if (codeTools.length === 13) ok(`13 codegraph_* tools registered`, codeTools.join(', '))
else bad(`expected 13 codegraph_* tools, got ${codeTools.length}`, null)

console.log('\n=== 5) codegraph_status (not yet indexed) ===')
try {
  const s = await call('codegraph_status', {})
  console.log('   status output:', s.slice(0, 220))
  ok('codegraph_status ran')
} catch (e) {
  bad('codegraph_status', null, e.message)
}

console.log('\n=== 6) codegraph_init (bootstrap the index) ===')
try {
  const out = await call('codegraph_init', {})
  console.log('   init output:', String(out).slice(0, 200))
  ok('codegraph_init ran')
} catch (e) {
  bad('codegraph_init', null, e.message)
}

console.log('\n=== 7) codegraph_status (indexed) ===')
try {
  const s = String(await call('codegraph_status', {}))
  console.log('   status:', s.slice(0, 260))
  ok('codegraph_status after init')
} catch (e) {
  bad('codegraph_status after init', null, e.message)
}

console.log('\n=== 8) codegraph_query("multiply") ===')
try {
  const q = String(await call('codegraph_query', { search: 'multiply' }))
  console.log('   query:', q.slice(0, 260))
  ok('codegraph_query ran')
} catch (e) {
  bad('codegraph_query', null, e.message)
}

console.log('\n=== 9) codegraph_node("add") ===')
try {
  const n = String(await call('codegraph_node', { name: 'add' }))
  console.log('   node:', n.slice(0, 280))
  ok('codegraph_node ran')
} catch (e) {
  bad('codegraph_node', null, e.message)
}

console.log('\n=== 10) codegraph_callers(double) & codegraph_callees(multiply) ===')
try {
  const c = String(await call('codegraph_callers', { symbol: 'double' }))
  console.log('   callers(double):', c.slice(0, 200))
  ok('codegraph_callers ran')
} catch (e) {
  bad('codegraph_callers', null, e.message)
}
try {
  const c = String(await call('codegraph_callees', { symbol: 'multiply' }))
  console.log('   callees(multiply):', c.slice(0, 200))
  ok('codegraph_callees ran')
} catch (e) {
  bad('codegraph_callees', null, e.message)
}

console.log('\n=== 11) codegraph_explore("math utilities") ===')
try {
  const ex = String(await call('codegraph_explore', { query: 'math utilities', maxFiles: 2 }))
  console.log('   explore:', ex.slice(0, 280))
  ok('codegraph_explore ran')
} catch (e) {
  bad('codegraph_explore', null, e.message)
}

console.log('\n=== 12) codegraph_files ===')
try {
  const f = String(await call('codegraph_files', {}))
  console.log('   files:', f.slice(0, 200))
  ok('codegraph_files ran')
} catch (e) {
  bad('codegraph_files', null, e.message)
}

console.log('\n=== 13) path arg override (point at test project explicitly) ===')
try {
  const s = String(await call('codegraph_status', { path: '/tmp/cg-test-proj' }))
  console.log('   status(path):', s.slice(0, 200))
  ok('codegraph_status with explicit path')
} catch (e) {
  bad('codegraph_status with explicit path', null, e.message)
}

console.log('\n=== 14) codegraph_sync ===')
try {
  const s = String(await call('codegraph_sync', {}))
  console.log('   sync:', (s || '(no output)').slice(0, 200))
  ok('codegraph_sync ran')
} catch (e) {
  bad('codegraph_sync', null, e.message)
}

console.log('\n=== 15) codegraph_impact(multiply) & codegraph_affected ===')
try {
  const im = String(await call('codegraph_impact', { symbol: 'multiply', depth: 1 }))
  console.log('   impact:', im.slice(0, 220))
  ok('codegraph_impact ran')
} catch (e) {
  bad('codegraph_impact', null, e.message)
}
try {
  const af = String(await call('codegraph_affected', { files: ['src/math.ts'] }))
  console.log('   affected:', af.slice(0, 220))
  ok('codegraph_affected ran')
} catch (e) {
  bad('codegraph_affected', null, e.message)
}

console.log('\n=== 16) error path: no path, no session cwd ===')
try {
  const t = registeredTools.find((x) => x.name === 'codegraph_status')
  await t.execute({}, { agent: { session: { header: {} } }, signal: new AbortController().signal })
  bad('expected throw with no cwd & no path')
} catch (e) {
  ok('throws when no session cwd and no path', e.message.slice(0, 80))
}

console.log('\n=== 17) remaining tools registered & present ===')
for (const t of ['codegraph_index', 'codegraph_uninit']) {
  const present = !!registeredTools.find((x) => x.name === t)
  if (present) ok(`registered ${t}`)
  else bad(`MISSING ${t}`)
}

// --- front-load (prompt-hook) tests ---------------------------------------
// The plugin registered an 'agent/inbox/inserted' listener on the main ctx
// (frontload defaults to true). Drive it with fake agents and observe what
// gets steered into the turn.

const frontloadHandlers = listeners.filter((l) => l.event === 'agent/inbox/inserted')

function makeAgent(cwd, promptText, id) {
  const message = {
    id,
    role: 'user',
    content: [{ type: 'text', text: promptText }],
    source: { kind: 'user' }
  }
  const steered = []
  const agent = {
    session: { header: { cwd } },
    inbox: { nextTurn: [message] },
    steer(m) { steered.push(m) }
  }
  return { agent, message, steered }
}

async function waitForSteer(steered, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (steered.length > 0) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

console.log('\n=== 18) frontload defaults to false: no listener without explicit opt-in ===')
if (frontloadHandlers.length === 0) ok('no agent/inbox/inserted listener (frontload defaults to false)')
else bad('frontload now defaults to false — expected no listener', `got ${frontloadHandlers.length}`)

console.log('\n=== 18b) frontload:true explicitly → listener registered and fires ===')
{
  const listenersFp = []
  const ctxFp = {
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    on(event, handler) { listenersFp.push({ event, handler }); return () => {} },
    inject() {},
    get(n) { return n === 'subprocess' ? subprocessService : n === 'shell' ? shellService : undefined }
  }
  plugin.apply(ctxFp, { frontload: true })
  const fpHandlers = listenersFp.filter((l) => l.event === 'agent/inbox/inserted')
  if (fpHandlers.length === 1) ok('frontload:true registers exactly one inbox listener')
  else bad('frontload:true should register one listener', `got ${fpHandlers.length}`)

  const { agent, message, steered } = makeAgent(sessionCwd, 'multiply 的调用流程是怎样的？谁会调用它？', 'fl-explicit')
  for (const h of fpHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 30000)
  if (!fired) bad('explicit frontload:true did not steer anything for a structural prompt')
  else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (text.includes('<codegraph_context') && text.includes('multiply')) ok('explicit frontload steers <codegraph_context>', `len=${text.length}`)
    else bad('explicit frontload steered message malformed', text.slice(0, 120))
  }
}

console.log('\n=== 19b) same prompt re-sent within 10min → deduped, no 2nd injection ===')
{
  const listenersFp2 = []
  const ctxFp2 = {
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    on(event, handler) { listenersFp2.push({ event, handler }); return () => {} },
    inject() {},
    get(n) { return n === 'subprocess' ? subprocessService : n === 'shell' ? shellService : undefined }
  }
  plugin.apply(ctxFp2, { frontload: true })
  const fpHandlers2 = listenersFp2.filter((l) => l.event === 'agent/inbox/inserted')

  const first = makeAgent(sessionCwd, 'multiply 的调用流程是怎样的？谁会调用它？', 'fl-1')
  for (const h of fpHandlers2) h.handler({ agent: first.agent, message: first.message })
  const firedFirst = await waitForSteer(first.steered, 30000)
  if (!firedFirst) bad('frontload did not steer anything for a structural prompt')
  else ok('steered <codegraph_context> for the first arrival')

  const resend = makeAgent(sessionCwd, 'multiply 的调用流程是怎样的？谁会调用它？', 'fl-1b')
  for (const h of fpHandlers2) h.handler({ agent: resend.agent, message: resend.message })
  const firedResend = await waitForSteer(resend.steered, 8000)
  if (!firedResend) ok('identical prompt within 10min is deduped (no duplicate <codegraph_context>)')
  else bad('re-sent prompt should not front-load a duplicate', resend.steered[0].content[0].text.slice(0, 80))
}

console.log('\n=== 20) frontload: non-structural prompt → silent no-op ===')
{
  const listenersFp3 = []
  const ctxFp3 = {
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    on(event, handler) { listenersFp3.push({ event, handler }); return () => {} },
    inject() {},
    get(n) { return n === 'subprocess' ? subprocessService : n === 'shell' ? shellService : undefined }
  }
  plugin.apply(ctxFp3, { frontload: true })
  const fpHandlers3 = listenersFp3.filter((l) => l.event === 'agent/inbox/inserted')
  const { agent, message, steered } = makeAgent(sessionCwd, 'fix this typo please', 'fl-2')
  for (const h of fpHandlers3) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 8000)
  if (!fired) ok('no injection for a non-structural prompt')
  else bad('non-structural prompt should not front-load', steered[0].content[0].text.slice(0, 80))
}

console.log('\n=== 21) frontload: unindexed project → silent no-op ===')
{
  const listenersFp4 = []
  const ctxFp4 = {
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    on(event, handler) { listenersFp4.push({ event, handler }); return () => {} },
    inject() {},
    get(n) { return n === 'subprocess' ? subprocessService : n === 'shell' ? shellService : undefined }
  }
  plugin.apply(ctxFp4, { frontload: true })
  const fpHandlers4 = listenersFp4.filter((l) => l.event === 'agent/inbox/inserted')
  const { agent, message, steered } = makeAgent(UNINDEXED_CWD, 'multiply 的调用流程是怎样的？', 'fl-3')
  for (const h of fpHandlers4) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 8000)
  if (!fired) ok('no injection when no .codegraph/ index is reachable')
  else bad('unindexed project should not front-load')
}

console.log('\n=== 22) frontload: does not re-trigger on its own output / non-user sources ===')
{
  const listenersFp5 = []
  const ctxFp5 = {
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    on(event, handler) { listenersFp5.push({ event, handler }); return () => {} },
    inject() {},
    get(n) { return n === 'subprocess' ? subprocessService : n === 'shell' ? shellService : undefined }
  }
  plugin.apply(ctxFp5, { frontload: true })
  const fpHandlers5 = listenersFp5.filter((l) => l.event === 'agent/inbox/inserted')
  const { agent, message, steered } = makeAgent(sessionCwd, '<codegraph_context>…prior injection…</codegraph_context>', 'fl-4')
  for (const h of fpHandlers5) h.handler({ agent, message })
  const fired1 = await waitForSteer(steered, 5000)
  const rpc = makeAgent(sessionCwd, 'multiply 的调用流程是怎样的？', 'fl-5')
  rpc.message.source = { kind: 'rpc' }
  for (const h of fpHandlers5) h.handler({ agent: rpc.agent, message: rpc.message })
  const fired2 = await waitForSteer(rpc.steered, 5000)
  if (!fired1 && !fired2) ok('own output and non-user sources are ignored')
  else bad(`loop-guard failed (marker=${fired1}, rpc=${fired2})`)
}

console.log('\n=== 23) config: frontload:false registers no listener ===')
{
  const listeners3 = []
  const ctx3 = {
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    on(event, handler) { listeners3.push({ event, handler }); return () => {} },
    inject() {},
    get(n) { return n === 'subprocess' ? subprocessService : n === 'shell' ? shellService : undefined }
  }
  plugin.apply(ctx3, { frontload: false })
  if (!listeners3.some((l) => l.event === 'agent/inbox/inserted')) ok('frontload:false skips the inbox listener')
  else bad('frontload:false must NOT register the inbox listener')
}

console.log('\n=== 24) no executor mounted: apply must NOT throw (lazy resolution), execute errors with hint ===')
{
  const tools4 = []
  const ctx4 = {
    tools: { register(t) { tools4.push(t); return () => {} } },
    systemPrompt: { section() { return () => {} } },
    on() { return () => {} },
    inject() {},
    get() { return undefined } // neither subprocess nor shell
  }
  try {
    plugin.apply(ctx4, { surface: 'full' })
    ok('apply() mounts without any executor service (boot-order safe)')
  } catch (e) {
    bad('apply() must not throw when executors are missing', null, e.message)
  }
  const statusTool = tools4.find((t) => t.name === 'codegraph_status')
  if (!statusTool) {
    bad('codegraph_status should still register without executors')
  } else {
    try {
      await statusTool.execute({}, makeExec())
      bad('execute should throw the executor hint when no executor is mounted')
    } catch (e) {
      if (/subprocess|shell/.test(e.message)) ok('execute throws the executor hint', e.message.slice(0, 70))
      else bad('execute threw an unexpected error', null, e.message)
    }
  }
}

console.log('\n=== 25) settings namespace: apply works without a settings service; entry config drives the shape ===')
{
  // ctx.inject never invokes (no settings service mounted) — the plugin must
  // still mount fully from the composition entry config alone.
  const tools5 = []
  const sections5 = []
  const listeners5 = []
  const ctx5 = {
    tools: { register(t) { tools5.push(t); return () => {} } },
    systemPrompt: { section(s) { sections5.push(s); return () => {} } },
    on(event, handler) { listeners5.push({ event, handler }); return () => {} },
    inject() {},
    get(n) { return n === 'subprocess' ? subprocessService : n === 'shell' ? shellService : undefined }
  }
  try {
    plugin.apply(ctx5, { frontload: true })
    ok('apply() without a settings service mounts (optional-settings contract)')
  } catch (e) {
    bad('apply() must tolerate a missing settings service', null, e.message)
  }
  if (sections5.find((s) => s.name === 'tool:codegraph')) ok('entry config still arms the prompt guidance without settings')
  else bad('entry-config guidance missing without settings service')
  if (listeners5.some((l) => l.event === 'agent/inbox/inserted')) ok('entry-config frontload:true arms the listener without settings')
  else bad('entry-config frontload:true must arm the inbox listener without settings service')
}

console.log(`\n========== ${pass} passed, ${fail} failed ==========\n`)
process.exit(fail === 0 ? 0 : 1)
