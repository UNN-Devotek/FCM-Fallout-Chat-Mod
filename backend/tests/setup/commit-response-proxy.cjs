// Transparent PostgreSQL wire proxy for an explicitly synthetic test database.
// It forwards authentication and ordinary queries unchanged. Only a COMMIT
// response is withheld, after an independent connection proves server commit.
const net = require('node:net');
async function createCommitResponseProxy(target, verifyCommitted) {
  const sockets = new Set(); let proofResolve, proofReject;
  const proof = new Promise((resolve, reject) => { proofResolve = resolve; proofReject = reject; });
  const server = net.createServer(client => {
    const upstream = net.connect({ host: target.hostname, port: Number(target.port || 5432) });
    sockets.add(client); sockets.add(upstream);
    client.on('error', () => {}); upstream.on('error', () => {});
    client.once('close', () => { sockets.delete(client); upstream.destroy(); });
    upstream.once('close', () => { sockets.delete(upstream); client.destroy(); });
    let input = Buffer.alloc(0), output = Buffer.alloc(0), started = false, commit = false, verifying = false;
    const statements = new Map(), portals = new Map();
    const cstring = (body, offset = 0) => { const end = body.indexOf(0, offset); return [body.toString('utf8', offset, end), end + 1]; };
    const isCommit = sql => /^COMMIT\s*;?\s*$/i.test(sql.trim());
    client.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      if (!started) {
        if (input.length < 4 || input.length < input.readInt32BE(0)) return;
        const size = input.readInt32BE(0); upstream.write(input.subarray(0, size)); input = input.subarray(size); started = true;
      }
      while (input.length >= 5) {
        const size = input.readInt32BE(1); if (size < 4 || size > 4 * 1024 * 1024) { client.destroy(); return; }
        if (input.length < size + 1) break;
        const packet = input.subarray(0, size + 1), body = packet.subarray(5), type = String.fromCharCode(packet[0]);
        input = input.subarray(size + 1);
        if (type === 'Q') commit ||= isCommit(cstring(body)[0]);
        if (type === 'P') { const [name, position] = cstring(body); statements.set(name, cstring(body, position)[0]); }
        if (type === 'B') { const [portal, position] = cstring(body); portals.set(portal, cstring(body, position)[0]); }
        if (type === 'E') commit ||= isCommit(statements.get(portals.get(cstring(body)[0])) || '');
        upstream.write(packet);
      }
    });
    upstream.on('data', chunk => {
      if (!commit) { client.write(chunk); return; }
      output = Buffer.concat([output, chunk]);
      while (output.length >= 5) {
        const size = output.readInt32BE(1); if (output.length < size + 1) break;
        const type = String.fromCharCode(output[0]); output = output.subarray(size + 1);
        if (type === 'Z' && !verifying) {
          verifying = true; upstream.pause();
          Promise.resolve().then(verifyCommitted).then(value => { proofResolve(value); client.destroy(); upstream.destroy(); }, error => { proofReject(error); client.destroy(); upstream.destroy(); });
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(target); url.hostname = '127.0.0.1'; url.port = String(server.address().port); url.searchParams.set('sslmode', 'disable'); url.searchParams.set('connection_limit', '1');
  return { url: url.toString(), proof, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createCommitResponseProxy };
