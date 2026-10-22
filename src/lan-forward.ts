// A loopback TCP forwarder for self-hosted servers on the LAN.
//
// rs-sdk's lite client picks its scheme from the address: plain HTTP/WS only for localhost and 127.x,
// HTTPS/WSS for anything else. A self-hosted server on another machine usually speaks plain HTTP, so
// the lite client is given 127.0.0.1:<port> instead, and this forwards those connections byte for byte
// to the real host:port. HTTP, WebSockets and the cache downloads all pass through unchanged.

import type { Socket, TCPSocketListener } from 'bun';

interface End {
    peer: Socket<End> | null;
    /** Bytes waiting to be written to this socket (it was busy), or received for a peer not connected yet. */
    backlog: Uint8Array[];
    closed: boolean;
}

function write(to: Socket<End>, chunk: Uint8Array): void {
    if (to.data.backlog.length) { to.data.backlog.push(chunk); return; }
    const sent = to.write(chunk);
    if (sent < chunk.length) to.data.backlog.push(chunk.subarray(Math.max(0, sent)));
}

function flush(s: Socket<End>): void {
    while (s.data.backlog.length) {
        const chunk = s.data.backlog[0]!;
        const sent = s.write(chunk);
        if (sent < chunk.length) { s.data.backlog[0] = chunk.subarray(Math.max(0, sent)); return; }
        s.data.backlog.shift();
    }
}

function closePair(s: Socket<End>): void {
    if (s.data.closed) return;
    s.data.closed = true;
    const peer = s.data.peer;
    if (peer && !peer.data.closed) { peer.data.closed = true; peer.end(); }
}

class LanForward {
    private listener: TCPSocketListener<End> | null = null;
    private target = '';

    /** Start (or retarget) forwarding to host:port; returns the local address to use instead. */
    start(targetHostPort: string): string {
        const m = targetHostPort.match(/^(.+):(\d+)$/);
        if (!m) throw new Error(`Expected host:port, got ${targetHostPort}`);
        const [, host, port] = m as unknown as [string, string, string];
        if (this.listener && this.target === targetHostPort) return `127.0.0.1:${this.listener.port}`;
        this.stop();
        this.target = targetHostPort;
        this.listener = Bun.listen<End>({
            hostname: '127.0.0.1',
            port: 0,
            socket: {
                open(client) {
                    client.data = { peer: null, backlog: [], closed: false };
                    Bun.connect<End>({
                        hostname: host,
                        port: Number(port),
                        socket: {
                            open(upstream) {
                                upstream.data = { peer: client, backlog: [], closed: false };
                                if (client.data.closed) { upstream.end(); return; }
                                // Anything the client sent before the upstream connection was ready.
                                const early = client.data.backlog.splice(0);
                                client.data.peer = upstream;
                                for (const chunk of early) write(upstream, chunk);
                            },
                            data(upstream, chunk) { if (!client.data.closed) write(client, chunk); },
                            drain(upstream) { flush(upstream); },
                            close(upstream) { closePair(upstream); },
                            error(upstream) { closePair(upstream); },
                        },
                    }).catch(() => { client.data.closed = true; client.end(); });
                },
                data(client, chunk) {
                    const upstream = client.data.peer;
                    if (upstream) write(upstream, chunk);
                    else client.data.backlog.push(new Uint8Array(chunk)); // held until the upstream opens
                },
                drain(client) { if (client.data.peer) flush(client); },
                close(client) { closePair(client); },
                error(client) { closePair(client); },
            },
        });
        return `127.0.0.1:${this.listener.port}`;
    }

    stop(): void {
        this.listener?.stop(true);
        this.listener = null;
        this.target = '';
    }
}

export const lanForward = new LanForward();
