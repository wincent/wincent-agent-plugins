import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../skills/confluence/scripts/atlassian-curl.sh', import.meta.url));
const jira = fileURLToPath(new URL('../skills/jira/scripts/atlassian-curl.sh', import.meta.url));
const origin = 'https://test-tenant.atlassian.net';

// Never inherit account credentials, proxy settings, shell hooks, or curl config.
// The only curl on PATH is this mock. No network requests are made.
function run(t, args, {env = {}, input = '', scriptPath = script, trace = false} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atlassian curl test '));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const capture = join(dir, 'capture.json');
  writeFileSync(join(dir, 'curl'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.CAPTURE, JSON.stringify({
  args: process.argv.slice(2),
  input: fs.readFileSync(0, 'utf8'),
  proxy: process.env.HTTPS_PROXY,
  ca: process.env.CURL_CA_BUNDLE,
  sslCert: process.env.SSL_CERT_FILE,
  noProxy: process.env.NO_PROXY,
}));
process.stdout.write(process.env.MOCK_BODY || '{}');
process.stderr.write(process.env.MOCK_ERROR || '');
process.exit(Number(process.env.MOCK_STATUS || 0));
`, {mode: 0o755});
  const environment = {
    PATH: `${dir}:/usr/bin:/bin`,
    HOME: dir,
    LC_ALL: 'C',
    CAPTURE: capture,
    ATLASSIAN_SITE: 'test-tenant',
    ATLASSIAN_EMAIL: 'reader@example.invalid',
    ATLASSIAN_API_KEY: 'nono_fake_phantom',
    ...env,
  };
  for (const key of Object.keys(environment)) {
    if (environment[key] === undefined) delete environment[key];
  }
  const result = spawnSync('/bin/sh', [...(trace ? ['-x'] : []), scriptPath, ...args], {
    cwd: dir,
    env: environment,
    encoding: 'utf8',
    input,
  });
  assert.ifError(result.error);
  let call;
  try {
    call = JSON.parse(readFileSync(capture, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {...result, call};
}

function expected(url, options = [], email = 'reader@example.invalid', phantom = 'nono_fake_phantom') {
  return [
    '--disable', '--silent', '--show-error', '--fail-with-body', '--globoff', '--basic',
    '--user', `${email}:${phantom}`, '--header', 'Accept: application/json',
    ...options, '--url', url,
  ];
}

test('constructs one HTTPS request with Basic auth and a phantom', (t) => {
  const result = run(t, ['/rest/api/3/issue/TEST-1']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.call.args, expected(`${origin}/rest/api/3/issue/TEST-1`));
});

test('preserves quoting and special characters in credentials and query options', (t) => {
  const email = "o'reilly+test@example.invalid";
  const phantom = 'nono_fake :$`"\'\\;&*?[]()';
  const options = ['--get', '--data-urlencode', 'jql=summary ~ "hello & goodbye"',
    '--data-urlencode', 'nextPageToken=a+b/c==', '--data-urlencode', 'fields=summary,status'];
  const result = run(t, ['/rest/api/3/search/jql', ...options], {
    env: {ATLASSIAN_EMAIL: email, ATLASSIAN_API_KEY: phantom}, trace: true,
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.call.args, expected(`${origin}/rest/api/3/search/jql`, options, email, phantom));
  assert.ok(!result.stderr.includes(phantom));
  assert.ok(!result.stderr.includes(email));
});

test('preserves caller method, JSON body, output path, and stdin', (t) => {
  const input = '{"body":{"text":"quotes \\\" and & $ and café"}}\n';
  const options = ['--request', 'PUT', '--header', 'Content-Type: application/json',
    '--data-binary', '@-', '--output', 'response with spaces.json'];
  const result = run(t, ['/rest/api/3/issue/TEST-1', ...options], {input});
  assert.equal(result.status, 0);
  assert.equal(result.call.input, input);
  assert.deepEqual(result.call.args, expected(`${origin}/rest/api/3/issue/TEST-1`, options));
});

test('preserves an inline POST search body and file-body options verbatim', (t) => {
  for (const body of ['{"jql":"project = TEST","fields":["summary"]}', '@body with spaces.json']) {
    const options = ['--header', 'Content-Type: application/json', '--data-binary', body];
    const result = run(t, ['/rest/api/3/search/jql', ...options]);
    assert.equal(result.status, 0);
    assert.deepEqual(result.call.args, expected(`${origin}/rest/api/3/search/jql`, options));
  }
});

test('accepts the configured full host and same-origin pagination URLs', (t) => {
  for (const target of [
    '/wiki/rest/api/search?cql=type%3Dpage&cursor=a%2Bb%3D',
    `${origin}/wiki/api/v2/pages?limit=25&cursor=a%2Fb`,
    `${origin}/rest/api/3/search/jql?nextPageToken=opaque`,
    `${origin}?query=value`, origin,
    '/wiki/api/v2/pages?literal=[1-3]{a,b}',
  ]) {
    const result = run(t, [target], {env: {ATLASSIAN_SITE: 'test-tenant.atlassian.net'}});
    assert.equal(result.status, 0, target);
    let url = target.startsWith('/') ? origin + target : target;
    if (target === origin) url += '/';
    if (target.startsWith(`${origin}?`)) url = `${origin}/${target.slice(origin.length)}`;
    assert.deepEqual(result.call.args, expected(url));
  }
});

test('rejects other origins, userinfo, ports, and malformed targets before curl', (t) => {
  for (const target of [
    'https://other.atlassian.net/rest/api/3/issue/TEST-1',
    'https://test-tenant.atlassian.net.evil.invalid/wiki/api/v2/pages',
    'https://test-tenant.atlassian.net@evil.invalid/',
    'https://user@test-tenant.atlassian.net/',
    'https://user:password@test-tenant.atlassian.net/',
    `${origin}:443/wiki/api/v2/pages`, `${origin}:8443/`,
    'http://test-tenant.atlassian.net/wiki/api/v2/pages',
    'https:///test-tenant.atlassian.net/', 'https://test-tenant.atlassian.net./',
    'https://test-tenant.atlassian.net%2Fevil.invalid/',
    'https://{test-tenant,other}.atlassian.net/',
    '//other.atlassian.net/rest/api/3/issue/TEST-1', `${origin}//other.atlassian.net/`,
    '/wiki/api/v2/pages#fragment', '/wiki/api/v2/pages?title=raw space',
    '/wiki/\napi/v2/pages', '/wiki/\tapi/v2/pages', '/wiki/\r\nheader:bad',
    '/wiki/\\evil.invalid', `${origin}\\@evil.invalid/`,
    'rest/api/3/issue/TEST-1', '--url', 'file:///etc/passwd',
  ]) {
    const result = run(t, [target]);
    assert.equal(result.status, 64, target);
    assert.equal(result.call, undefined, target);
    assert.ok(!result.stderr.includes(target), 'do not echo a potentially sensitive URL');
  }
});

test('rejects invalid site configuration without printing its value', (t) => {
  for (const site of [
    'https://test-tenant.atlassian.net', 'test-tenant.atlassian.net/path',
    'evil.invalid', 'test-tenant.atlassian.net:443', 'user@test-tenant.atlassian.net',
    'one.two.atlassian.net', '.atlassian.net', '-tenant', 'tenant-',
    'tenant_name', 'tenant name', 'tenant\nname', '{one,two}', 'x'.repeat(64),
  ]) {
    const result = run(t, ['/rest/api/3/search/jql'], {env: {ATLASSIAN_SITE: site}});
    assert.equal(result.status, 64, site);
    assert.equal(result.call, undefined);
    assert.equal(result.stderr, site.length > 63
      ? 'atlassian-curl: ATLASSIAN_SITE tenant label is too long\n'
      : 'atlassian-curl: ATLASSIAN_SITE must be a tenant subdomain or tenant.atlassian.net host (no URL or port)\n');
  }
});

test('requires each nonempty configuration variable with actionable diagnostics', (t) => {
  for (const key of ['ATLASSIAN_SITE', 'ATLASSIAN_EMAIL', 'ATLASSIAN_API_KEY']) {
    for (const value of [undefined, '']) {
      const result = run(t, ['/rest/api/3/search/jql'], {env: {[key]: value}});
      assert.notEqual(result.status, 0);
      assert.equal(result.call, undefined);
      assert.ok(result.stderr.includes(key));
      assert.match(result.stderr, /host\/VM|configure nono/);
      assert.ok(!result.stderr.includes('nono_fake_phantom'));
      assert.ok(!result.stderr.includes('reader@example.invalid'));
    }
  }
});

test('help works without configuration and no target reports usage', (t) => {
  const env = {ATLASSIAN_SITE: undefined, ATLASSIAN_EMAIL: undefined, ATLASSIAN_API_KEY: undefined};
  for (const flag of ['--help', '-h']) {
    const result = run(t, [flag], {env});
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.call, undefined);
  }
  const result = run(t, [], {env});
  assert.equal(result.status, 64);
  assert.match(result.stderr, /Usage:/);
  assert.equal(result.call, undefined);
});

test('does not modify proxy or CA environment', (t) => {
  const env = {
    HTTPS_PROXY: 'http://fake-proxy.invalid:18099',
    CURL_CA_BUNDLE: '/fake/CA bundle.pem',
    SSL_CERT_FILE: '/fake/cert.pem',
    NO_PROXY: 'localhost,127.0.0.1',
  };
  const result = run(t, ['/wiki/api/v2/spaces'], {env});
  assert.equal(result.status, 0);
  assert.equal(result.call.proxy, env.HTTPS_PROXY);
  assert.equal(result.call.ca, env.CURL_CA_BUNDLE);
  assert.equal(result.call.sslCert, env.SSL_CERT_FILE);
  assert.equal(result.call.noProxy, env.NO_PROXY);
  assert.deepEqual(result.call.args, expected(`${origin}/wiki/api/v2/spaces`));
});

test('propagates curl failure codes, HTTP error bodies, and stderr', (t) => {
  for (const status of [7, 22, 60]) {
    const result = run(t, ['/wiki/api/v2/pages'], {
      env: {MOCK_STATUS: String(status), MOCK_BODY: '{"error":"fake failure"}', MOCK_ERROR: 'fake curl error\n'},
    });
    assert.equal(result.status, status);
    assert.equal(result.stdout, '{"error":"fake failure"}');
    assert.equal(result.stderr, 'fake curl error\n');
  }
});

test('Jira and Pi symlinks still resolve to the single implementation', (t) => {
  const paths = [
    jira,
    fileURLToPath(new URL('../../../pi/skills/atlassian-jira/scripts/atlassian-curl.sh', import.meta.url)),
    fileURLToPath(new URL('../../../pi/skills/atlassian-confluence/scripts/atlassian-curl.sh', import.meta.url)),
  ];
  for (const scriptPath of paths) {
    assert.equal(realpathSync(scriptPath), realpathSync(script));
    const result = run(t, ['/rest/api/3/issue/TEST-1'], {scriptPath});
    assert.equal(result.status, 0);
    assert.deepEqual(result.call.args, expected(`${origin}/rest/api/3/issue/TEST-1`));
  }
});
