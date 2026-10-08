import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {createRequire, registerHooks, syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {
  curlConfig,
  ENDPOINT,
  loadDocument,
  MAX_INPUT_BYTES,
  pageIndices,
  parseResponse,
  proxyConfig,
  requestOcr,
  saveArtifacts,
} from '../ocr/client.ts';

// Use Pi's runtime TypeBox, just as the extension loader does (no npm install).
const piDir = process.env.PI_TEST_PACKAGE_DIR ?? join(execFileSync('npm', ['root', '-g'], {encoding: 'utf8'}).trim(), '@earendil-works/pi-coding-agent');
const requirePi = createRequire(join(piDir, 'package.json'));
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'typebox') return {url: pathToFileURL(requirePi.resolve('typebox')).href, shortCircuit: true};
    if (specifier === './client.js' && context.parentURL?.endsWith('/ocr/index.ts')) return {url: new URL('./client.ts', context.parentURL).href, shortCircuit: true};
    return nextResolve(specifier, context);
  },
});
let extension;
try { ({default: extension} = await import('../ocr/index.ts')); } finally { hooks.deregister(); }

function setEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function registered() {
  let tool;
  const commands = new Map();
  const events = new Map();
  extension({
    registerTool(value) { tool = value; },
    registerCommand(name, value) { commands.set(name, value); },
    on(name, handler) { events.set(name, handler); },
  });
  assert.equal(tool.name, 'ocr');
  return {tool, status: commands.get('ocr-status'), approval: commands.get('ocr-approval'), events};
}

function approvalContext(cwd, confirm = async () => true) {
  const notifications = [];
  const statuses = new Map();
  return {
    hasUI: true,
    cwd,
    notifications,
    statuses,
    ui: {
      confirm,
      notify(message) { notifications.push(message); },
      setStatus(key, value) { statuses.set(key, value); },
    },
  };
}

const proxy = 'http://x:fictional-proxy-password@127.0.0.1:18099';
const config = {proxy, ca: '/tmp/fixture.crt', model: 'mistral-ocr-latest'};
const pdf = Buffer.from('%PDF-1.4\nfictional PDF for transport tests\n%%EOF');
// These fixtures exercise signature sniffing, not image decoding (which is
// deliberately left to Mistral). No actual OCR provider is called.
const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const images = [['image/png', png], ['image/jpeg', jpeg]];
const imageResponse = JSON.stringify({
  model: 'mistral-ocr-fixture',
  pages: [{index: 0, markdown: 'Untrusted image transcription'}],
  usage_info: {pages_processed: 1},
});
const response = JSON.stringify({
  model: 'mistral-ocr-fixture',
  pages: [{index: 4, markdown: '# Untrusted text'}, {index: 0, markdown: 'Hello'}],
  usage_info: {pages_processed: 2},
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ocr-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

test('requires a loopback proxy and CA, never accepts upstream keys as transport config', () => {
  assert.throws(() => proxyConfig({MISTRAL_API_KEY: 'not-a-real-key'}), /requires the nono/);
  assert.throws(() => proxyConfig({HTTPS_PROXY: proxy}), /requires the nono/);
  assert.deepEqual(proxyConfig({HTTPS_PROXY: proxy, NODE_EXTRA_CA_CERTS: config.ca, MISTRAL_API_KEY: 'unused-secret'}), config);
  assert.equal(proxyConfig({HTTPS_PROXY: proxy, CURL_CA_BUNDLE: config.ca, NODE_EXTRA_CA_CERTS: 'other'}).ca, config.ca);
  for (const value of ['invalid', 'https://127.0.0.1:9', 'http://example.org:9', 'http://127.0.0.1:9/path', proxy + '\n']) {
    assert.throws(() => proxyConfig({HTTPS_PROXY: value, CURL_CA_BUNDLE: config.ca}));
  }
  assert.throws(() => proxyConfig({HTTPS_PROXY: proxy, CURL_CA_BUNDLE: config.ca, MISTRAL_OCR_MODEL: 'expensive-chat-model'}));
  assert.equal(proxyConfig({HTTPS_PROXY: proxy, CURL_CA_BUNDLE: config.ca, MISTRAL_OCR_MODEL: 'mistral-ocr-fixture'}).model, 'mistral-ocr-fixture');
});

test('first page default, sorted indices, bounded selections, no duplicates', () => {
  assert.deepEqual(pageIndices(), [0]);
  assert.deepEqual(pageIndices([4, 0, 19]), [0, 4, 19]);
  for (const value of [[], [-1], [1000], [0.5], [NaN], [0, 0], ['0'], null, Array.from({length: 26}, (_, i) => i)]) {
    assert.throws(() => pageIndices(value));
  }
});

test('images are one page and reject PDF page selections', () => {
  for (const [type] of images) {
    assert.deepEqual(pageIndices(undefined, type), [0]);
    assert.deepEqual(pageIndices([0], type), [0]);
    for (const pages of [[1], [0, 1], [4, 0]]) {
      assert.throws(() => pageIndices(pages, type), /Images are a single page/);
    }
  }
});

test('loads an immutable bounded PDF snapshot through a normal symlink', async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'input.pdf'), pdf);
  await symlink(join(dir, 'input.pdf'), join(dir, 'link.pdf'));
  const document = await loadDocument(dir, 'link.pdf');
  await writeFile(join(dir, 'input.pdf'), '%PDF-1.7\nchanged');
  assert.deepEqual(document.bytes, pdf);
  assert.equal(document.mediaType, 'application/pdf');
  assert.match(document.path, /input\.pdf$/);
  assert.match(document.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(() => loadDocument(dir, 'missing.pdf'), /Cannot read/);
  await assert.rejects(() => loadDocument(dir, '.'), /Cannot read/);
  await assert.rejects(() => loadDocument(dir, 'https://example.org/input.pdf'), /not a URL/);
  await writeFile(join(dir, 'bad.pdf'), 'not a PDF');
  await assert.rejects(() => loadDocument(dir, 'bad.pdf'), /Cannot read/);
  await writeFile(join(dir, 'large.pdf'), Buffer.alloc(MAX_INPUT_BYTES + 1));
  await assert.rejects(() => loadDocument(dir, 'large.pdf'), /at most 20 MiB/);
});

test('detects PNG and JPEG by bytes, not extensions, and rejects unsupported signatures', async (t) => {
  const dir = await fixture(t);
  for (const [type, bytes] of images) {
    await writeFile(join(dir, 'misleading.pdf'), bytes);
    const document = await loadDocument(dir, 'misleading.pdf');
    assert.equal(document.mediaType, type);
    assert.deepEqual(document.bytes, bytes);
    assert.match(document.sha256, /^[a-f0-9]{64}$/);
  }
  await writeFile(join(dir, 'misleading.png'), pdf);
  assert.equal((await loadDocument(dir, 'misleading.png')).mediaType, 'application/pdf');
  for (const bytes of [Buffer.from('GIF89a'), Buffer.from('RIFF0000WEBP'), Buffer.from('<svg/>'), png.subarray(0, 7), jpeg.subarray(0, 2), Buffer.from('not an image')]) {
    await writeFile(join(dir, 'spoofed.png'), bytes);
    await assert.rejects(() => loadDocument(dir, 'spoofed.png'), /Cannot read a regular PDF, PNG, or JPEG/);
  }
  await writeFile(join(dir, 'oversized.png'), Buffer.concat([png, Buffer.alloc(MAX_INPUT_BYTES)]));
  await assert.rejects(() => loadDocument(dir, 'oversized.png'), /at most 20 MiB/);
});

test('curl config fixes destination, forces proxy, validates TLS, and contains only a phantom', () => {
  const text = curlConfig(config, '/tmp/a "quoted"\\name/request.json');
  assert.ok(text.includes(`url = "${ENDPOINT}"`));
  assert.match(text, /noproxy = ""/);
  assert.match(text, /Authorization: Bearer proxied/);
  assert.match(text, /max-redirs = 0/);
  assert.match(text, /cacert = /);
  assert.match(text, /max-time = 180/);
  assert.doesNotMatch(text, /insecure|location|retry|verbose|trace/);
  assert.ok(text.includes('a \\"quoted\\"\\\\name'));
  assert.throws(() => curlConfig(config, '/tmp/a\nurl = malicious'), /Invalid/);
});

test('validates response shape, retains page ordering and reports missing pages', () => {
  const parsed = parseResponse(response, [0, 4, 19]);
  assert.deepEqual(parsed.pages.map((page) => page.index), [0, 4]);
  assert.ok(parsed.warnings.some((warning) => warning.includes('19')));
  for (const raw of [
    'secret invalid json',
    'null',
    '{}',
    JSON.stringify({model: 'mistral-ocr-fixture', pages: []}),
    JSON.stringify({model: 'mistral-ocr-fixture', pages: [{index: 99, markdown: 'secret'}]}),
    JSON.stringify({model: 'mistral-ocr-fixture', pages: [{index: 0, markdown: 42}]}),
    JSON.stringify({model: 'mistral-ocr-fixture', pages: [{index: 0, markdown: 'a'}, {index: 0, markdown: 'b'}]}),
  ]) {
    assert.throws(() => parseResponse(raw, [0, 4]), (error) => {
      assert.match(error.message, /Invalid OCR response/);
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  }
});

test('saves private archival JSON, page-marked Markdown, and provenance without overwriting', async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'input.pdf'), pdf);
  const document = await loadDocument(dir, 'input.pdf');
  const out = await mkdtemp(join(dir, 'ocr-'));
  const result = await saveArtifacts(out, document, [0, 4], config.model, response);
  assert.equal(await readFile(result.json_artifact, 'utf8'), response);
  assert.equal(await readFile(result.markdown_artifact, 'utf8'), '<!-- PDF page 1; zero-based index 0 -->\n\nHello\n\n<!-- PDF page 5; zero-based index 4 -->\n\n# Untrusted text\n');
  const manifest = JSON.parse(await readFile(result.manifest_artifact, 'utf8'));
  assert.equal(manifest.source_sha256, document.sha256);
  assert.equal(manifest.source_media_type, 'application/pdf');
  assert.ok(result.warnings.some(warning => warning.includes('entire source PDF')));
  assert.equal(manifest.entire_document_transmitted, true);
  assert.equal(manifest.requested_model, config.model);
  assert.equal(manifest.returned_model, 'mistral-ocr-fixture');
  assert.deepEqual(result.page_indices, [0, 4]);
  assert.equal((await stat(result.json_artifact)).mode & 0o777, 0o600);
  assert.equal((await stat(out)).mode & 0o777, 0o700);
  await assert.rejects(() => saveArtifacts(out, document, [0, 4], config.model, response), /do not repeat/);
  assert.equal(await readFile(result.json_artifact, 'utf8'), response);
});

test('archives an HTTP-200 response before schema validation so paid results are recoverable', async (t) => {
  const dir = await fixture(t);
  const raw = '{"model":"future-model","pages":[]}';
  await assert.rejects(() => saveArtifacts(dir, {path: 'input.pdf', bytes: pdf, sha256: 'fixture', mediaType: 'application/pdf'}, [0], config.model, raw), /validation or writing failed/);
  assert.equal(await readFile(join(dir, 'response.json'), 'utf8'), raw);
});

// A fake executable exercises child-process hygiene, output bounds and cleanup
// without opening a socket, reading 1Password, or sending a document anywhere.
async function fakeCurl(t, behavior) {
  const dir = await fixture(t);
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const capture = join(dir, 'capture.json');
  await writeFile(join(bin, 'curl'), `#!${process.execPath}
const fs = require('node:fs');
let config = '';
process.stdin.on('data', chunk => config += chunk);
process.stdin.on('end', () => {
  const path = JSON.parse(config.match(/^data-binary = (.+)$/m)[1]).slice(1);
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({config, args: process.argv.slice(2), env: process.env, path, request: JSON.parse(fs.readFileSync(path))}));
  fs.appendFileSync(${JSON.stringify(capture + '.calls')}, '1\\n');
  ${behavior}
});
`, {mode: 0o700});
  for (const [name, value] of Object.entries({PATH: bin, MISTRAL_API_KEY: 'DO-NOT-INHERIT', SSLKEYLOGFILE: 'DO-NOT-INHERIT'})) {
    setEnv(t, name, value);
  }
  const ca = join(dir, 'ca.crt');
  await writeFile(ca, 'fixture CA');
  setEnv(t, 'HTTPS_PROXY', proxy);
  setEnv(t, 'https_proxy', undefined);
  setEnv(t, 'CURL_CA_BUNDLE', ca);
  setEnv(t, 'MISTRAL_OCR_MODEL', undefined);
  return {dir, config: {...config, ca}, capture, document: {path: 'fixture.pdf', bytes: pdf, sha256: 'fixture', mediaType: 'application/pdf'}};
}

test('transport passes payload privately, discards errors, and cleans the request spool', async (t) => {
  const fixture = await fakeCurl(t, `process.stderr.write('private diagnostic'); process.stdout.write(${JSON.stringify(response + '\n200')});`);
  assert.deepEqual(await requestOcr(fixture.document, [0, 4], fixture.config), {raw: response, warnings: []});
  const capture = JSON.parse(await readFile(fixture.capture, 'utf8'));
  assert.deepEqual(capture.args, ['--disable', '--config', '-']);
  assert.equal(capture.env.MISTRAL_API_KEY, undefined);
  assert.equal(capture.env.SSLKEYLOGFILE, undefined);
  assert.deepEqual(capture.request.pages, [0, 4]);
  assert.equal(capture.request.include_image_base64, false);
  assert.equal(capture.request.document.document_url, `data:application/pdf;base64,${pdf.toString('base64')}`);
  assert.equal(capture.request.model, config.model);
  await assert.rejects(() => readFile(capture.path), {code: 'ENOENT'});
});

test('HTTP failures suppress upstream bodies and do not retry', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('secret upstream details\\n429');`);
  await assert.rejects(() => requestOcr(fixture.document, [0], fixture.config), (error) => {
    assert.match(error.message, /HTTP 429/);
    assert.doesNotMatch(error.message, /secret/);
    assert.match(error.message, /Do not automatically retry/);
    return true;
  });
  const capture = JSON.parse(await readFile(fixture.capture, 'utf8'));
  await assert.rejects(() => readFile(capture.path), {code: 'ENOENT'});
});

test('redirects are errors, not a second request', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('redirect body\\n302');`);
  await assert.rejects(() => requestOcr(fixture.document, [0], fixture.config), /HTTP 302/);
});

test('transport output is bounded even without Content-Length', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write(Buffer.alloc(33 * 1024 * 1024));`);
  await assert.rejects(() => requestOcr(fixture.document, [0], fixture.config), /exceeded 32 MiB/);
});

test('cancellation terminates curl and cleans sensitive temporary input', async (t) => {
  const fixture = await fakeCurl(t, 'setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const pending = requestOcr(fixture.document, [0], fixture.config, controller.signal);
  // Attach the rejection assertion before cancellation to avoid an unhandled rejection.
  const rejected = assert.rejects(pending, /cancelled/);
  for (let i = 0; i < 200; i++) {
    try { await readFile(fixture.capture); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  controller.abort();
  await rejected;
  const capture = JSON.parse(await readFile(fixture.capture, 'utf8'));
  await assert.rejects(() => readFile(capture.path), {code: 'ENOENT'});
});

test('pre-aborted requests and missing CA fail before launching curl', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('should not execute');`);
  await assert.rejects(() => requestOcr(fixture.document, [0], fixture.config, AbortSignal.abort()));
  await assert.rejects(() => requestOcr(fixture.document, [0], {...fixture.config, ca: '/nonexistent/ca'}), /Cannot read/);
  await assert.rejects(() => readFile(fixture.capture), {code: 'ENOENT'});
});

test('extension refuses headless calls and declined uploads before any HTTP request', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('should not execute');`);
  await writeFile(join(fixture.dir, 'input.pdf'), pdf);
  const {tool} = registered();
  await assert.rejects(() => tool.execute('headless', {path: 'input.pdf'}, undefined, undefined, {hasUI: false, cwd: fixture.dir}), /without a UI/);
  let confirmations = 0;
  const ctx = {hasUI: true, cwd: fixture.dir, ui: {confirm: async (_title, message) => {
    confirmations++;
    assert.match(message, /ENTIRE PDF/);
    assert.match(message, /page indices: 0/);
    return false;
  }}};
  await assert.rejects(() => tool.execute('declined', {path: 'input.pdf'}, undefined, undefined, ctx), /not approved/);
  await assert.rejects(() => tool.execute('declined-again', {path: 'input.pdf'}, undefined, undefined, ctx), /not approved/);
  assert.equal(confirmations, 2, 'guard resets after each rejected call');
  assert.equal((await readdir(fixture.dir)).some(name => name.startsWith('ocr-')), false);
  await assert.rejects(() => readFile(fixture.capture), {code: 'ENOENT'});
});

test('first use grants sticky session approval, skips subsequent PDF/image prompts, and can be revoked', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write(${JSON.stringify(imageResponse + '\n200')});`);
  await writeFile(join(fixture.dir, 'input.pdf'), pdf);
  await writeFile(join(fixture.dir, 'scan.png'), png);
  const {tool, approval, status} = registered();
  let confirmations = 0;
  const ctx = approvalContext(fixture.dir, async (title, message) => {
    confirmations++;
    assert.match(title, /Allow OCR uploads for this session/);
    assert.match(message, /any supported local PDF, PNG, or JPEG/);
    assert.match(message, /ENTIRE file/);
    assert.match(message, /embedded metadata and unselected PDF pages/);
    assert.match(message, /incurs API charges/);
    assert.match(message, /no session spending cap/);
    assert.match(message, /not saved or shared with subagents/);
    assert.match(message, /automatic retries/);
    assert.match(message, /First upload:/);
    assert.match(message, /File: .*input\.pdf/);
    return true;
  });
  await tool.execute('first-use', {path: 'input.pdf'}, undefined, undefined, ctx);
  assert.equal(ctx.statuses.get('ocr-approval'), 'OCR: allowed for session');
  ctx.ui.confirm = async () => assert.fail('session approval must skip upload prompts');
  await approval.handler('session', ctx);
  await status.handler('', ctx);
  assert.match(ctx.notifications.at(-1), /allowed for this session/);
  for (const path of ['input.pdf', 'scan.png']) {
    const result = await tool.execute('session-approved', {path}, undefined, undefined, ctx);
    assert.equal(result.structuredContent.pages_processed, 1);
  }
  assert.equal(confirmations, 1);
  await assert.rejects(() => tool.execute('headless', {path: 'input.pdf'}, undefined, undefined, {...ctx, hasUI: false}), /without a UI/);
  await assert.rejects(() => tool.execute('invalid-pages', {path: 'input.pdf', pages: Array.from({length: 26}, (_, i) => i)}, undefined, undefined, ctx), /Select 1-25/);
  await assert.rejects(() => tool.execute('invalid-image-pages', {path: 'scan.png', pages: [1]}, undefined, undefined, ctx), /Images are a single page/);
  await assert.rejects(() => tool.execute('cancelled', {path: 'input.pdf'}, AbortSignal.abort(), undefined, ctx), {name: 'AbortError'});
  const captureBeforeRevoke = await readFile(fixture.capture, 'utf8');
  await approval.handler('revoke', ctx);
  assert.equal(ctx.statuses.get('ocr-approval'), undefined);
  await status.handler('', ctx);
  assert.match(ctx.notifications.at(-1), /next upload will ask for session approval/);
  ctx.ui.confirm = async () => { confirmations++; return false; };
  await assert.rejects(() => tool.execute('revoked', {path: 'input.pdf'}, undefined, undefined, ctx), /not approved/);
  assert.equal(confirmations, 2);
  assert.equal(await readFile(fixture.capture, 'utf8'), captureBeforeRevoke);
  ctx.ui.confirm = async () => { confirmations++; return true; };
  await tool.execute('reapproved', {path: 'input.pdf'}, undefined, undefined, ctx);
  ctx.ui.confirm = async () => assert.fail('renewed approval must also be sticky');
  await tool.execute('still-approved', {path: 'scan.png'}, undefined, undefined, ctx);
  assert.equal(confirmations, 3);
});

test('declined session approval, status queries, invalid arguments, and headless opt-in never grant approval', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('should not execute');`);
  await writeFile(join(fixture.dir, 'input.pdf'), pdf);
  const {tool, approval} = registered();
  let confirmations = 0;
  const ctx = approvalContext(fixture.dir, async () => { confirmations++; return false; });
  await approval.handler('', ctx);
  assert.match(ctx.notifications.at(-1), /next upload will ask for session approval/);
  await approval.handler('always', ctx);
  assert.match(ctx.notifications.at(-1), /Usage:/);
  assert.equal(confirmations, 0);
  const output = [];
  t.mock.method(console, 'log', message => output.push(message));
  await approval.handler('session', {...ctx, hasUI: false});
  assert.match(output.at(-1), /requires an interactive confirmation/);
  assert.equal(confirmations, 0);
  await approval.handler('session', ctx);
  assert.match(ctx.notifications.at(-1), /next upload will ask for session approval/);
  await assert.rejects(() => tool.execute('declined-session', {path: 'input.pdf'}, undefined, undefined, ctx), /not approved/);
  assert.equal(confirmations, 2);
  assert.equal(ctx.statuses.get('ocr-approval'), undefined);
  await assert.rejects(() => readFile(fixture.capture), {code: 'ENOENT'});
});

test('session lifecycle resets approval and fresh extension instances never inherit it', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('should not execute');`);
  await writeFile(join(fixture.dir, 'input.pdf'), pdf);
  const {tool, approval, events} = registered();
  const ctx = approvalContext(fixture.dir);
  for (const event of [
    ...['startup', 'reload', 'new', 'resume', 'fork'].map(reason => ({type: 'session_start', reason})),
    ...['quit', 'reload', 'new', 'resume', 'fork'].map(reason => ({type: 'session_shutdown', reason})),
  ]) {
    ctx.ui.confirm = async () => true;
    await approval.handler('session', ctx);
    assert.equal(ctx.statuses.get('ocr-approval'), 'OCR: allowed for session');
    await events.get(event.type)(event, ctx);
    assert.equal(ctx.statuses.get('ocr-approval'), undefined);
    ctx.ui.confirm = async () => false;
    await assert.rejects(() => tool.execute(event.reason, {path: 'input.pdf'}, undefined, undefined, ctx), /not approved/);
  }
  ctx.ui.confirm = async () => true;
  await approval.handler('session', ctx);
  ctx.ui.confirm = async () => false;
  const fresh = registered();
  await assert.rejects(() => fresh.tool.execute('fresh', {path: 'input.pdf'}, undefined, undefined, ctx), /not approved/);
  await assert.rejects(() => readFile(fixture.capture), {code: 'ENOENT'});
});

test('late session confirmation cannot undo revocation or lifecycle resets', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('should not execute');`);
  const {approval, events} = registered();
  for (const action of ['revoke', 'session_start', 'session_shutdown']) {
    let resolveConfirmation;
    const ctx = approvalContext(fixture.dir, () => new Promise(resolve => { resolveConfirmation = resolve; }));
    const pending = approval.handler('session', ctx);
    assert.equal(typeof resolveConfirmation, 'function');
    if (action === 'revoke') await approval.handler('revoke', ctx);
    else await events.get(action)({type: action, reason: 'reload'}, ctx);
    resolveConfirmation(true);
    await pending;
    assert.match(ctx.notifications.at(-1), /next upload will ask for session approval/);
    assert.equal(ctx.statuses.get('ocr-approval'), undefined);
  }
  await assert.rejects(() => readFile(fixture.capture), {code: 'ENOENT'});
});

test('a first-use confirmation resolved after cancellation or revocation never grants approval', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('should not execute');`);
  await writeFile(join(fixture.dir, 'input.pdf'), pdf);
  for (const action of ['cancel', 'revoke', 'session_start']) {
    const {tool, approval, events} = registered();
    const controller = new AbortController();
    let entered;
    let resolveConfirmation;
    const confirming = new Promise(resolve => { entered = resolve; });
    const ctx = approvalContext(fixture.dir, () => {
      entered();
      return new Promise(resolve => { resolveConfirmation = resolve; });
    });
    const pending = tool.execute('pending-first-use', {path: 'input.pdf'}, controller.signal, undefined, ctx);
    const rejected = assert.rejects(pending, /not approved/);
    await confirming;
    if (action === 'cancel') controller.abort();
    else if (action === 'revoke') await approval.handler('revoke', ctx);
    else await events.get('session_start')({type: 'session_start', reason: 'new'}, ctx);
    resolveConfirmation(true);
    await rejected;
    await approval.handler('', ctx);
    assert.match(ctx.notifications.at(-1), /next upload will ask for session approval/);
    assert.equal(ctx.statuses.get('ocr-approval'), undefined);
    ctx.ui.confirm = async () => false;
    await assert.rejects(() => tool.execute('after-reset', {path: 'input.pdf'}, undefined, undefined, ctx), /not approved/);
  }
  await assert.rejects(() => readFile(fixture.capture), {code: 'ENOENT'});
});

test('overlapping commands and first-use OCR cannot open a second approval dialog', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write(${JSON.stringify(imageResponse + '\n200')});`);
  await writeFile(join(fixture.dir, 'input.pdf'), pdf);
  for (const [first, second] of [['command', 'tool'], ['tool', 'command'], ['command', 'command']]) {
    const {tool, approval} = registered();
    let entered;
    let resolveConfirmation;
    let confirmations = 0;
    const confirming = new Promise(resolve => { entered = resolve; });
    const ctx = approvalContext(fixture.dir, () => {
      confirmations++;
      entered();
      return new Promise(resolve => { resolveConfirmation = resolve; });
    });
    const invoke = kind => kind === 'command'
      ? approval.handler('session', ctx)
      : tool.execute('first-use', {path: 'input.pdf'}, undefined, undefined, ctx);
    const pending = invoke(first);
    await confirming;
    await assert.rejects(() => invoke(second), /approval is already pending/);
    assert.equal(confirmations, 1);
    resolveConfirmation(true);
    await pending;
    assert.equal(ctx.statuses.get('ocr-approval'), 'OCR: allowed for session');
    ctx.ui.confirm = async () => assert.fail('existing approval must be retained');
    await tool.execute('after-overlap', {path: 'input.pdf'}, undefined, undefined, ctx);
  }
});

test('a rejected confirmation promise releases the approval guard without granting approval', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('should not execute');`);
  await writeFile(join(fixture.dir, 'input.pdf'), pdf);
  const {tool, approval} = registered();
  const ctx = approvalContext(fixture.dir, async () => { throw new Error('UI unavailable'); });
  await assert.rejects(() => approval.handler('session', ctx), /UI unavailable/);
  await approval.handler('', ctx);
  assert.match(ctx.notifications.at(-1), /next upload will ask for session approval/);
  ctx.ui.confirm = async () => false;
  await assert.rejects(() => tool.execute('next-call', {path: 'input.pdf'}, undefined, undefined, ctx), /not approved/);
  await assert.rejects(() => readFile(fixture.capture), {code: 'ENOENT'});
});

test('first-use approval survives transport failure without automatically retrying', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('secret upstream details\\n429');`);
  await writeFile(join(fixture.dir, 'input.pdf'), pdf);
  const {tool, approval} = registered();
  let confirmations = 0;
  const ctx = approvalContext(fixture.dir, async () => { confirmations++; return true; });
  await assert.rejects(() => tool.execute('failure', {path: 'input.pdf'}, undefined, undefined, ctx), /HTTP 429.*Do not automatically retry/);
  assert.equal(confirmations, 1);
  await approval.handler('', ctx);
  assert.match(ctx.notifications.at(-1), /allowed for this session/);
  assert.equal(await readFile(fixture.capture + '.calls', 'utf8'), '1\n');
  assert.equal((await readdir(fixture.dir)).some(name => name.startsWith('ocr-')), false);
});

test('extension uploads exactly the approved snapshot, returns artifacts not OCR text, and limits concurrency', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write(${JSON.stringify(response + '\n200')});`);
  await writeFile(join(fixture.dir, 'input.pdf'), pdf);
  const {tool} = registered();
  let confirmations = 0;
  const ctx = approvalContext(fixture.dir, async () => {
    confirmations++;
    await assert.rejects(() => tool.execute('concurrent', {path: 'input.pdf'}, undefined, undefined, ctx), /Another OCR call/);
    await writeFile(join(fixture.dir, 'input.pdf'), '%PDF-1.4\nchanged during approval');
    return true;
  });
  const result = await tool.execute('approved', {path: 'input.pdf', pages: [4, 0]}, undefined, undefined, ctx);
  assert.equal(confirmations, 1);
  assert.equal(result.structuredContent.pages_processed, 2);
  assert.deepEqual(result.structuredContent.page_indices, [0, 4]);
  assert.doesNotMatch(result.content[0].text, /# Untrusted text/);
  assert.match(result.content[0].text, /file:\/\//);
  const capture = JSON.parse(await readFile(fixture.capture, 'utf8'));
  assert.equal(capture.request.document.document_url, `data:application/pdf;base64,${pdf.toString('base64')}`);
  assert.equal(await readFile(result.structuredContent.json_artifact, 'utf8'), response);
});

for (const [type, bytes] of images) {
  test(`extension uploads an approved ${type} snapshot and saves image-specific provenance`, async (t) => {
    const fixture = await fakeCurl(t, `process.stdout.write(${JSON.stringify(imageResponse + '\n200')});`);
    // A misleading suffix cannot change the request type or approval wording.
    await writeFile(join(fixture.dir, 'scan.pdf'), bytes);
    const source = await loadDocument(fixture.dir, 'scan.pdf');
    const {tool} = registered();
    let confirmations = 0;
    const ctx = approvalContext(fixture.dir, async (title, message) => {
      confirmations++;
      assert.match(title, /Allow OCR uploads for this session/);
      assert.match(message, type === 'image/png' ? /Upload: ENTIRE PNG image/ : /Upload: ENTIRE JPEG image/);
      assert.match(message, /embedded metadata/);
      assert.match(message, /one page \(index 0\)/);
      assert.doesNotMatch(message, /Upload: ENTIRE PDF/);
      await writeFile(join(fixture.dir, 'scan.pdf'), pdf);
      return true;
    });
    const params = {path: 'scan.pdf', ...(type === 'image/jpeg' ? {pages: [0]} : {})};
    const result = await tool.execute('image', params, undefined, undefined, ctx);
    assert.equal(confirmations, 1);
    const capture = JSON.parse(await readFile(fixture.capture, 'utf8'));
    assert.deepEqual(capture.request.document, {type: 'image_url', image_url: `data:${type};base64,${bytes.toString('base64')}`});
    assert.equal(Object.hasOwn(capture.request, 'pages'), false);
    assert.equal(capture.request.include_image_base64, false);
    assert.equal(capture.env.MISTRAL_API_KEY, undefined);
    await assert.rejects(() => readFile(capture.path), {code: 'ENOENT'});
    assert.equal(result.structuredContent.pages_processed, 1);
    assert.deepEqual(result.structuredContent.page_indices, [0]);
    assert.equal(await readFile(result.structuredContent.json_artifact, 'utf8'), imageResponse);
    assert.equal(await readFile(result.structuredContent.markdown_artifact, 'utf8'), '<!-- Image 1; zero-based index 0 -->\n\nUntrusted image transcription\n');
    const manifest = JSON.parse(await readFile(result.structuredContent.manifest_artifact, 'utf8'));
    assert.equal(manifest.source_media_type, type);
    assert.equal(manifest.source_sha256, source.sha256);
    assert.equal(manifest.source_bytes, bytes.length);
    assert.equal(manifest.entire_document_transmitted, true);
    assert.deepEqual(manifest.requested_page_indices, [0]);
    assert.ok(result.structuredContent.warnings.some(warning => warning.includes('entire source image')));
    assert.ok(result.structuredContent.warnings.every(warning => !warning.includes('PDF')));
    assert.doesNotMatch(result.content[0].text, /Untrusted image transcription/);
  });
}

test('invalid image page selections fail before confirmation or any upload', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('should not execute');`);
  await writeFile(join(fixture.dir, 'scan.png'), png);
  const {tool} = registered();
  const ctx = {hasUI: true, cwd: fixture.dir, ui: {confirm: async () => assert.fail('must not prompt')}};
  for (const pages of [[1], [0, 1]]) {
    await assert.rejects(() => tool.execute('invalid-image', {path: 'scan.png', pages}, undefined, undefined, ctx), /Images are a single page/);
  }
  const document = await loadDocument(fixture.dir, 'scan.png');
  await assert.rejects(() => requestOcr(document, [1], fixture.config), /Images are a single page/);
  await assert.rejects(() => readFile(fixture.capture), {code: 'ENOENT'});
  assert.equal((await readdir(fixture.dir)).some(name => name.startsWith('ocr-')), false);
});

test('declining an image upload makes no HTTP request', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('should not execute');`);
  await writeFile(join(fixture.dir, 'scan.jpg'), jpeg);
  const {tool} = registered();
  const ctx = {hasUI: true, cwd: fixture.dir, ui: {confirm: async () => false}};
  await assert.rejects(() => tool.execute('declined-image', {path: 'scan.jpg'}, undefined, undefined, ctx), /not approved/);
  await assert.rejects(() => readFile(fixture.capture), {code: 'ENOENT'});
});

test('cancellation dismisses pending confirmation and releases the per-session guard', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('should not execute');`);
  await writeFile(join(fixture.dir, 'input.pdf'), pdf);
  const {tool} = registered();
  const controller = new AbortController();
  let entered;
  const confirming = new Promise(resolve => entered = resolve);
  const ctx = {hasUI: true, cwd: fixture.dir, ui: {confirm: (_title, _message, options) => {
    assert.equal(options.signal, controller.signal);
    entered();
    return new Promise(resolve => options.signal.addEventListener('abort', () => resolve(false), {once: true}));
  }}};
  const pending = tool.execute('cancel-dialog', {path: 'input.pdf'}, controller.signal, undefined, ctx);
  await confirming;
  controller.abort();
  await assert.rejects(pending, /not approved/);
  ctx.ui.confirm = async () => false;
  await assert.rejects(() => tool.execute('next-call', {path: 'input.pdf'}, undefined, undefined, ctx), /not approved/);
  await assert.rejects(() => readFile(fixture.capture), {code: 'ENOENT'});
});

function failSpoolCleanup(t) {
  const original = fs.promises.rm;
  t.mock.method(fs.promises, 'rm', async (path, options) => {
    if (String(path).includes('pi-ocr-request-')) throw new Error('PRIVATE FILESYSTEM DIAGNOSTIC');
    return original(path, options);
  });
  syncBuiltinESMExports();
  t.after(() => { fs.promises.rm = original; syncBuiltinESMExports(); });
  return original;
}

test('cleanup failure preserves paid results and adds a sanitized persisted warning', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write(${JSON.stringify(response + '\n200')});`);
  const clean = failSpoolCleanup(t);
  const result = await requestOcr(fixture.document, [0, 4], fixture.config);
  const capture = JSON.parse(await readFile(fixture.capture, 'utf8'));
  t.after(() => clean(dirname(capture.path), {recursive: true, force: true}));
  assert.equal(result.raw, response);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Remove that private directory manually/);
  assert.doesNotMatch(result.warnings[0], /PRIVATE FILESYSTEM DIAGNOSTIC/);
  const out = await mkdtemp(join(fixture.dir, 'ocr-'));
  const artifacts = await saveArtifacts(out, fixture.document, [0, 4], config.model, result.raw, result.warnings);
  assert.ok(artifacts.warnings.includes(result.warnings[0]));
  const manifest = JSON.parse(await readFile(artifacts.manifest_artifact, 'utf8'));
  assert.ok(manifest.warnings.includes(result.warnings[0]));
});

test('cleanup failure cannot replace the primary sanitized transport error', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('SECRET UPSTREAM BODY\\n429');`);
  const clean = failSpoolCleanup(t);
  await assert.rejects(() => requestOcr(fixture.document, [0], fixture.config), (error) => {
    assert.match(error.message, /HTTP 429/);
    assert.match(error.message, /Do not automatically retry/);
    assert.match(error.message, /Remove that private directory manually/);
    assert.doesNotMatch(error.message, /PRIVATE FILESYSTEM DIAGNOSTIC|SECRET UPSTREAM BODY/);
    return true;
  });
  const capture = JSON.parse(await readFile(fixture.capture, 'utf8'));
  t.after(() => clean(dirname(capture.path), {recursive: true, force: true}));
});

test('status does not reveal proxy passwords, source credentials or make a request', async (t) => {
  const fixture = await fakeCurl(t, `process.stdout.write('should not execute');`);
  const {status} = registered();
  let message;
  await status.handler('', {hasUI: true, ui: {notify(text) { message = text; }}});
  assert.match(message, /not verified/);
  assert.doesNotMatch(message, /fictional-proxy-password|DO-NOT-INHERIT/);
  await assert.rejects(() => readFile(fixture.capture), {code: 'ENOENT'});
});
