import {strict as assert} from 'node:assert';
import {execFile, spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {curlConfig, ENDPOINT} from '../ocr/client.ts';

const exec = promisify(execFile);

// All listeners, credentials, certificates, and documents are disposable. No
// normal proxy is touched, no 1Password lookup occurs, no Mistral call is made.
test('nono OCR route substitutes a Bearer key only for the allowed host/method/path', {
  skip: process.env.NONO_PROXY_INTEGRATION !== '1',
  timeout: 30_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-nono-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const caKey = join(dir, 'ca.key');
  const ca = join(dir, 'ca.crt');
  const key = join(dir, 'server.key');
  const cert = join(dir, 'server.crt');
  const openssl = join(dir, 'openssl.cnf');
  await writeFile(openssl, `[req]
prompt = no
distinguished_name = dn
x509_extensions = ca
[dn]
CN = OCR fixture CA
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
`);
  await exec('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', caKey]);
  await exec('openssl', ['req', '-new', '-x509', '-key', caKey, '-out', ca, '-days', '1', '-config', openssl]);
  await exec('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', join(dir, 'server.csr'), '-subj', '/CN=localhost']);
  await exec('openssl', ['x509', '-req', '-in', join(dir, 'server.csr'), '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '1', '-extfile', openssl, '-extensions', 'server']);
  const received = [];
  const upstream = createServer({key: await readFile(key), cert: await readFile(cert)}, (request, response) => {
    let body = '';
    request.on('data', chunk => body += chunk);
    request.on('end', () => {
      received.push({authorization: request.headers.authorization, method: request.method, path: request.url, body});
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end('{"model":"mistral-ocr-fixture","pages":[{"index":0,"markdown":"hello"}]}');
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const port = upstream.address().port;
  const example = JSON.parse(await readFile(new URL('../ocr/nono.example.json', import.meta.url), 'utf8'));
  const route = example.credentials.mistral_ocr;
  assert.equal(route.upstream, 'https://api.mistral.ai');
  assert.deepEqual(route.endpoint_policy, {default: {decision: 'deny'}, allow: [{method: 'POST', path: '/v1/ocr'}]});
  const profile = join(dir, 'profile.json');
  await writeFile(profile, JSON.stringify({
    meta: {name: 'ocr-fixture'},
    network: {
      allow_domain: ['localhost', '127.0.0.1'],
      credentials: ['mistral_ocr'],
      custom_credentials: {
        mistral_ocr: {
          ...route,
          upstream: `https://localhost:${port}`,
          credential_key: 'env://FIXTURE_MISTRAL_KEY',
          tls_ca: ca,
        },
      },
    },
  }));
  const proxy = spawn('nono', ['proxy', '--verbose', '--profile', profile, '--port', '0', '--proxy-ca-cert', ca, '--proxy-ca-key', caKey], {
    env: {PATH: process.env.PATH, HOME: dir, TMPDIR: dir, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, NONO_PROXY_PASS: 'mock-proxy-password', FIXTURE_MISTRAL_KEY: 'mock-mistral-key'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let spawnError;
  proxy.on('error', error => spawnError = error);
  proxy.stdout.on('data', data => output += data);
  proxy.stderr.on('data', data => output += data);
  const exited = new Promise(resolve => proxy.once('close', resolve));
  t.after(async () => {
    proxy.kill();
    const timer = setTimeout(() => proxy.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
  });
  let match;
  for (let i = 0; i < 200; i++) {
    if (spawnError) throw spawnError;
    assert.equal(proxy.exitCode, null, output);
    match = /nono proxy listening on 127\.0\.0\.1:(\d+)/.exec(output);
    if (match) break;
    await delay(25);
  }
  assert.ok(match, output);
  const proxyUrl = `http://x:mock-proxy-password@127.0.0.1:${match[1]}`;
  const input = join(dir, 'request.json');
  await writeFile(input, '{"fixture":"no real document"}');

  async function request(method, path, {host = 'localhost', password = 'mock-proxy-password', trust = ca} = {}) {
    // Only the test changes the fixed destination; no production override exists.
    const text = curlConfig({proxy: proxyUrl.replace('mock-proxy-password', password), ca: trust, model: 'unused'}, input)
      .replace(`url = "${ENDPOINT}"`, `url = "https://${host}:${port}${path}"`)
      .replace('request = "POST"', `request = "${method}"`);
    const file = join(dir, 'curl.config');
    await writeFile(file, text, {mode: 0o600});
    const {stdout} = await exec('curl', ['--disable', '--config', file], {env: {PATH: process.env.PATH}, timeout: 5000});
    return stdout.slice(-3);
  }

  assert.equal(await request('POST', '/v1/ocr'), '200', output);
  assert.deepEqual(received, [{authorization: 'Bearer mock-mistral-key', method: 'POST', path: '/v1/ocr', body: '{"fixture":"no real document"}'}]);
  for (const [method, path] of [['GET', '/v1/ocr'], ['POST', '/v1/chat/completions'], ['POST', '/v1/files'], ['POST', '/v1/ocr/extra']]) {
    assert.equal(await request(method, path), '403', output);
  }
  assert.equal(received.length, 1, 'denied methods/paths must not reach upstream');
  assert.equal(await request('POST', '/v1/ocr', {host: '127.0.0.1'}), '200', output);
  assert.equal(received.at(-1).authorization, 'Bearer proxied', 'different host must never receive the real credential');
  await assert.rejects(() => request('POST', '/v1/ocr', {password: 'wrong-password'}));
  await writeFile(join(dir, 'bad-ca'), 'not a certificate');
  await assert.rejects(() => request('POST', '/v1/ocr', {trust: join(dir, 'bad-ca')}));
  assert.equal(received.length, 2);
});
