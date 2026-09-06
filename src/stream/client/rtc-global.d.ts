/**
 * Browser-only WebRTC global. This project typechecks with `lib: ESNext`
 * (no DOM), and the client never RUNS the default peer-connection factory
 * under bun (tests inject a fake), so a minimal ambient declaration keeps
 * the platform edge honest: one `as unknown as PeerConnectionLike` cast at
 * the construction site, real WebRTC on the browser demo page.
 */
declare var RTCPeerConnection: new () => never;
