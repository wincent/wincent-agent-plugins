import {readFileSync, writeFileSync} from 'node:fs';
import {get} from 'node:http';
import {join} from 'node:path';

/** Exercise inherited policy against only a synthetic file and loopback HTTP. */
export default function (pi) {
  pi.on('before_agent_start', async (_event, ctx) => {
    const url = process.env.SUBAGENT_TEST_PROBE_URL;
    if (!url) return;
    const taskDir = process.env.PI_SUBAGENT_BUS_DIR;
    let readError;
    try {
      readFileSync(process.env.SUBAGENT_TEST_DENIED_FILE);
    } catch (error) {
      readError = error.code;
    }
    const proxy = new URL(process.env.HTTP_PROXY);
    const response = await new Promise((resolve, reject) => {
      const req = get({
        hostname: proxy.hostname,
        port: proxy.port,
        path: url + (taskDir ? '/child' : '/controller'),
        headers: {
          Host: new URL(url).host,
          'Proxy-Authorization': 'Basic ' + Buffer.from(
            decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password),
          ).toString('base64'),
        },
      }, (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({status: res.statusCode, body}));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('test proxy timed out')));
    });
    // Record the socket address, never the proxy's auth token.
    writeFileSync(join(taskDir ?? ctx.cwd, 'sandbox-probe.json'), JSON.stringify({
      readError, proxy: proxy.origin, response,
    }));
  });
}
