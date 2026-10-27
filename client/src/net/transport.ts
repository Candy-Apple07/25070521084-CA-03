// A Link is one bidirectional message pipe between the host and a client.

export interface Link {
  send(msg: unknown): void;
  close(): void;
  onMessage: (msg: unknown) => void;
  onClose: () => void;
}

class LoopbackLink implements Link {
  peer: LoopbackLink | null = null;
  closed = false;
  onMessage: (msg: unknown) => void = () => {};
  onClose: () => void = () => {};
  send(msg: unknown) {
    if (this.closed) return;
    const copy = JSON.parse(JSON.stringify(msg));
    const peer = this.peer;
    queueMicrotask(() => peer && !peer.closed && peer.onMessage(copy));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.peer?.close();
    this.onClose();
  }
}

/** Two in-memory ends of a link, used when the host's own browser is also a player. */
export function loopbackPair(): [Link, Link] {
  const a = new LoopbackLink();
  const b = new LoopbackLink();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
