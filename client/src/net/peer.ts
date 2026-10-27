// WebRTC data channels via PeerJS. The public PeerJS broker only introduces the browsers;
// after that, game traffic flows directly between friends.

import Peer, { type DataConnection } from 'peerjs';
import { PEER_PREFIX } from './protocol';
import type { Link } from './transport';

function wrap(conn: DataConnection): Link {
  let closed = false;
  const link: Link = {
    send(msg) {
      if (!closed && conn.open) conn.send(msg);
    },
    close() {
      if (closed) return;
      closed = true;
      try { conn.close(); } catch { /* already gone */ }
      link.onClose();
    },
    onMessage: () => {},
    onClose: () => {},
  };
  conn.on('data', (d) => link.onMessage(d));
  conn.on('close', () => link.close());
  conn.on('error', () => link.close());
  // Data channels can linger after a network drop; watch the ICE state too.
  const pc = conn.peerConnection;
  if (pc) {
    pc.addEventListener('iceconnectionstatechange', () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') link.close();
    });
  }
  return link;
}

export interface OnlineHost {
  peer: Peer;
  close(): void;
}

/** Register the room code with the broker and accept friends as they arrive. */
export function hostOnline(code: string, onLink: (l: Link) => void): Promise<OnlineHost> {
  return new Promise((resolve, reject) => {
    const peer = new Peer(PEER_PREFIX + code, { debug: 0 });
    let opened = false;
    peer.on('open', () => {
      opened = true;
      resolve({ peer, close: () => peer.destroy() });
    });
    peer.on('connection', (conn) => {
      conn.on('open', () => onLink(wrap(conn)));
    });
    peer.on('disconnected', () => {
      // Lost the broker; existing games keep going, but new friends can't join until we reconnect.
      if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1500);
    });
    peer.on('error', (err: Error & { type?: string }) => {
      if (!opened) {
        peer.destroy();
        reject(err);
      }
    });
  });
}

export interface OnlineClient {
  link: Link;
  close(): void;
}

export function joinOnline(code: string, timeoutMs = 15000): Promise<OnlineClient> {
  return new Promise((resolve, reject) => {
    const peer = new Peer({ debug: 0 });
    let done = false;
    const fail = (e: Error) => {
      if (done) return;
      done = true;
      peer.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('timeout')), timeoutMs);
    peer.on('open', () => {
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      conn.on('open', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const link = wrap(conn);
        const origClose = link.close;
        link.close = () => { origClose(); peer.destroy(); };
        resolve({ link, close: () => link.close() });
      });
    });
    peer.on('error', (err: Error & { type?: string }) => {
      clearTimeout(timer);
      fail(err.type === 'peer-unavailable' ? new Error('not-found') : err);
    });
  });
}
