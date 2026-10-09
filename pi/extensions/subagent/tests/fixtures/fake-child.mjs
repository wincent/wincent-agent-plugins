import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {createConnection} from 'node:net';

const mode = process.argv.at(-1);
writeFileSync(`${process.env.PI_SUBAGENT_BUS_DIR}/socket-env.json`, JSON.stringify({
  busDir: process.env.PI_SUBAGENT_BUS_DIR,
  socketPath: process.env.PI_SUBAGENT_SOCKET_PATH,
}));
if (mode === 'exit-early') {
  process.stderr.write('launcher failure\n');
  process.exit(23);
}
if (mode === 'no-connect') {
  setInterval(() => {}, 1_000);
} else {
  const socket = createConnection(process.env.PI_SUBAGENT_SOCKET_PATH);
  let id = 0;
  const send = (type, payload) => socket.write(JSON.stringify({
    v: 1, id: `fake_${++id}`, ts: new Date().toISOString(), from: 'sub', type, payload,
  }) + '\n');
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (data) => {
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (message.type === 'answer') {
        send('report', {summary: message.payload.text});
        send('done', {status: 'ok'});
        socket.end();
      } else if (message.type === 'cancel' && mode === 'cancel') {
        send('done', {status: 'aborted'});
        socket.end();
      }
    }
  });
  socket.on('connect', () => {
    process.stdout.write(`${process.cwd()}\n${process.env.PI_SUBAGENT_TASK_ID}\n`);
    process.stderr.write('fake diagnostic\n');
    if (mode === 'ask') {
      send('ask', {question: 'Choose a value'});
    } else if (mode === 'crash') {
      socket.end();
      process.exitCode = 7;
    } else if (mode === 'cancel') {
      send('progress', {text: 'ready'});
    } else if (mode === 'descendant') {
      process.on('SIGTERM', () => process.exit(0));
      const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.send(process.pid); setInterval(() => {}, 1000);'], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      descendant.once('message', (pid) => {
        writeFileSync(`${process.env.PI_SUBAGENT_BUS_DIR}/descendant-pid`, String(pid));
        send('progress', {text: 'ready'});
      });
    } else if (mode === 'stubborn') {
      process.on('SIGTERM', () => {});
      send('progress', {text: 'ready'});
    } else {
      send('report', {summary: 'finished'});
      send('done', {status: 'ok'});
      if (mode === 'hang-done') {
        setInterval(() => {}, 1_000);
      } else {
        socket.end();
        process.exitCode = mode === 'bad-exit' ? 9 : 0;
        setTimeout(() => {}, 150);
      }
    }
  });
}
