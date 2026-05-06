/**
 * Tiny WebRTC peer-connection wrapper for the remote-control feature.
 *
 * Both phone (`/remote`) and laptop (Reviewer) use the same machinery; the
 * differences are who creates the offer and who creates the data channel.
 *
 * Goals:
 *   - Get a low-latency `RTCDataChannel` between phone and laptop when
 *     they share a network route (USB tether, same WiFi). When ICE finds
 *     a direct path, action latency drops from ~300 ms (hub) to ~50–80 ms
 *     end-to-end.
 *   - Never block or break the existing SSE+POST hub. WebRTC is best-
 *     effort: any failure path silently degrades to the hub.
 *   - Clean teardown — the parent component's effect-cleanup must be able
 *     to call `dispose()` and have the connection actually gone.
 */

export type SignalEnvelope =
  | { type: 'webrtc-offer'; sdp: string }
  | { type: 'webrtc-answer'; sdp: string }
  | { type: 'webrtc-ice'; candidate: RTCIceCandidateInit | null }
  | { type: 'webrtc-bye' };

/**
 * Public STUN servers. STUN is enough for most home/office NATs; we
 * intentionally don't ship a TURN server because (a) it costs money to
 * relay traffic and (b) when we'd need TURN we're back at hub-mediated
 * latency anyway, so the SSE fallback already handles it. Using two
 * providers so a single outage doesn't kill the feature.
 */
const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ],
};

/** Label used for the action data channel, so both sides agree. */
const CHANNEL_LABEL = 'cards-remote';

export function isSignal(action: { type: string }): action is SignalEnvelope {
  return action.type === 'webrtc-offer'
      || action.type === 'webrtc-answer'
      || action.type === 'webrtc-ice'
      || action.type === 'webrtc-bye';
}

export interface PeerOptions {
  /**
   * Send a signal to the other peer. Implementation is the existing
   * /api/sync/remote POST — same auth, same wire format, just signaling
   * envelopes instead of user actions.
   */
  sendSignal(s: SignalEnvelope): void | Promise<void>;
  /** Called when the data channel reaches `open` state. */
  onOpen(send: (data: string) => void): void;
  /** Called whenever the channel closes or the peer connection fails. */
  onClose(): void;
  /** Inbound message from the data channel (e.g. action JSON). */
  onMessage(text: string): void;
}

export interface Peer {
  /** True if the local peer-connection is currently the initiator. */
  readonly initiator: boolean;
  /** Push an incoming signal envelope (received via the SSE hub). */
  handleSignal(s: SignalEnvelope): Promise<void>;
  /** Send a string over the data channel. Returns false if not open. */
  send(text: string): boolean;
  /** Tear down: closes peer connection + data channel + stops listeners. */
  dispose(): void;
  /** True iff the data channel is currently `open`. */
  isOpen(): boolean;
}

function isWebRTCAvailable(): boolean {
  return typeof window !== 'undefined' && typeof RTCPeerConnection !== 'undefined';
}

/**
 * Build a peer in `initiator` mode (the side that creates the offer +
 * the data channel). Used by the phone.
 */
export function createInitiator(opts: PeerOptions): Peer | null {
  if (!isWebRTCAvailable()) return null;
  return makePeer(true, opts);
}

/**
 * Build a peer in `responder` mode (waits for an offer, replies with an
 * answer; data channel arrives via the `datachannel` event). Used by the
 * laptop.
 */
export function createResponder(opts: PeerOptions): Peer | null {
  if (!isWebRTCAvailable()) return null;
  return makePeer(false, opts);
}

function makePeer(initiator: boolean, opts: PeerOptions): Peer {
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let disposed = false;
  // Buffer ICE candidates that arrive before the remote description is set.
  const pendingRemoteIce: RTCIceCandidateInit[] = [];

  const tearDown = (notifyClose: boolean) => {
    if (disposed) return;
    disposed = true;
    try { dc?.close(); } catch { /* ignore */ }
    try { pc?.close(); } catch { /* ignore */ }
    dc = null;
    pc = null;
    if (notifyClose) {
      try { opts.onClose(); } catch { /* swallow */ }
    }
  };

  const wireDataChannel = (channel: RTCDataChannel) => {
    dc = channel;
    channel.onopen = () => {
      if (disposed) return;
      try { opts.onOpen((data) => { try { channel.send(data); } catch { /* drop */ } }); }
      catch { /* swallow */ }
    };
    channel.onclose = () => { if (!disposed) opts.onClose(); };
    channel.onerror = () => { /* error doesn't always close; let onclose handle it */ };
    channel.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try { opts.onMessage(ev.data); } catch { /* swallow */ }
      }
    };
  };

  try {
    pc = new RTCPeerConnection(ICE_CONFIG);
  } catch {
    // RTCPeerConnection constructor throws on misconfigured ICE config;
    // bail and let the hub handle everything.
    tearDown(true);
    return makeNullPeer(initiator);
  }

  pc.onicecandidate = (ev) => {
    void opts.sendSignal({ type: 'webrtc-ice', candidate: ev.candidate?.toJSON() ?? null });
  };
  pc.onconnectionstatechange = () => {
    const s = pc?.connectionState;
    if (s === 'failed' || s === 'closed' || s === 'disconnected') {
      // 'disconnected' can self-heal; we don't tear down on it. 'failed'
      // is terminal — caller should fall back to the hub.
      if (s === 'failed' || s === 'closed') tearDown(true);
    }
  };
  if (!initiator) {
    pc.ondatachannel = (ev) => wireDataChannel(ev.channel);
  }

  if (initiator) {
    // Create the channel + offer right away. Negotiation is "perfect
    // enough" — we don't expect glare since the laptop only ever
    // responds, never creates an offer of its own.
    try {
      const channel = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
      wireDataChannel(channel);
    } catch {
      tearDown(true);
      return makeNullPeer(initiator);
    }
    void (async () => {
      try {
        const offer = await pc!.createOffer();
        await pc!.setLocalDescription(offer);
        if (disposed || !pc?.localDescription) return;
        await opts.sendSignal({ type: 'webrtc-offer', sdp: pc.localDescription.sdp });
      } catch {
        tearDown(true);
      }
    })();
  }

  return {
    initiator,
    isOpen: () => dc?.readyState === 'open',
    send: (text) => {
      if (!dc || dc.readyState !== 'open') return false;
      try { dc.send(text); return true; } catch { return false; }
    },
    handleSignal: async (s) => {
      if (disposed || !pc) return;
      try {
        if (s.type === 'webrtc-offer') {
          if (initiator) return; // initiator never receives offers
          await pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
          for (const c of pendingRemoteIce) {
            try { await pc.addIceCandidate(c); } catch { /* ignore */ }
          }
          pendingRemoteIce.length = 0;
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (disposed || !pc.localDescription) return;
          await opts.sendSignal({ type: 'webrtc-answer', sdp: pc.localDescription.sdp });
        } else if (s.type === 'webrtc-answer') {
          if (!initiator) return;
          if (pc.signalingState === 'stable') return; // already answered
          await pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
          for (const c of pendingRemoteIce) {
            try { await pc.addIceCandidate(c); } catch { /* ignore */ }
          }
          pendingRemoteIce.length = 0;
        } else if (s.type === 'webrtc-ice') {
          if (s.candidate === null) return; // end-of-candidates; no-op
          if (pc.remoteDescription) {
            try { await pc.addIceCandidate(s.candidate); } catch { /* ignore */ }
          } else {
            pendingRemoteIce.push(s.candidate);
          }
        } else if (s.type === 'webrtc-bye') {
          tearDown(true);
        }
      } catch {
        // Any handshake error → fall back to hub. Don't crash.
        tearDown(true);
      }
    },
    dispose: () => {
      // Best-effort 'bye' so the other side stops waiting on us.
      try { void opts.sendSignal({ type: 'webrtc-bye' }); } catch { /* ignore */ }
      tearDown(false);
    },
  };
}

function makeNullPeer(initiator: boolean): Peer {
  return {
    initiator,
    isOpen: () => false,
    send: () => false,
    handleSignal: async () => { /* no-op */ },
    dispose: () => { /* no-op */ },
  };
}
