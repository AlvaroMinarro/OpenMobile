/**
 * In-process fake RtcService + EmulatorController gRPC server (probe-b2
 * harness). The bridge's RTC world (GrpcRtcClient, GrpcRtcAdapter, RtcSession,
 * gateway) is tested against this server with NO emulator: the test drives
 * the emulator side by queueing outbound JSEP wire messages per guid and by
 * inspecting the recorded client sends.
 *
 * Replay semantics mirror the live probe B flow:
 *  - `requestRtcStream` issues a fresh opaque guid and starts a JSEP
 *    negotiation for it (messages queued for that guid flow later),
 *  - `receiveJsepMessages(guid)` is a BLOCKING server stream: it writes the
 *    queued messages one by one and suspends until the test pushes more
 *    (or the client cancels — which ends the stream cleanly),
 *  - `sendJsepMessage` records {guid, message, auth} verbatim,
 *  - `getStatus` answers `{}` (or fails with the configured grpc status) so
 *    the watchdog probes are exercised without a device.
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  EMULATOR_CONTROLLER_PROTO,
  PROTOS_DIR,
  RTC_SERVICE_PROTO,
} from "../../src/device/grpc";

export interface RecordedSend {
  guid: string;
  message: string;
  auth: string | undefined;
}

export interface StatusFailure {
  code: number;
  message: string;
}

const LOAD_OPTS = { includeDirs: [PROTOS_DIR], keepCase: true, defaults: true };

export class FakeRtcServer {
  private server = new grpc.Server();
  /** Port the server bound (set by start()). */
  port = 0;
  addr = "";

  /** guid counter — requestRtcStream issues guid-1, guid-2, … */
  private guidCounter = 0;
  /** Queued outbound wire messages per guid (the emulator side of the pipe). */
  private outbound = new Map<string, string[]>();
  /** Resolvers waiting for the next outbound message per guid. */
  private waiters = new Map<string, Array<(m: string | null) => void>>();
  /** Cancelled receive streams per guid (a cancelled wait resolves null). */
  private cancelled = new Set<string>();

  /** Client sendJsepMessage calls, recorded verbatim. */
  sends: RecordedSend[] = [];
  /** Number of requestRtcStream calls (lifecycle assertions). */
  requestRtcStreamCalls = 0;
  /** When set, getStatus (and optionally everything) fails with this status. */
  getStatusFailure: StatusFailure | undefined;
  /** When set, requestRtcStream fails with this status (e.g. PERMISSION_DENIED). */
  requestRtcStreamFailure: StatusFailure | undefined;
  /** Bearer token the last sendJsepMessage carried (allowlist probe). */
  lastSendAuth: string | undefined;

  /** Start and bind on an ephemeral loopback port. */
  async start(): Promise<void> {
    const [rtcPkg, ctrlPkg] = await Promise.all([
      protoLoader.load(RTC_SERVICE_PROTO, LOAD_OPTS),
      protoLoader.load(EMULATOR_CONTROLLER_PROTO, LOAD_OPTS),
    ]);
    const rtcObj = grpc.loadPackageDefinition(rtcPkg) as unknown as {
      android: { emulation: { control: { Rtc: { service: grpc.ServiceDefinition } } } };
    };
    const ctrlObj = grpc.loadPackageDefinition(ctrlPkg) as unknown as {
      android: { emulation: { control: { EmulatorController: { service: grpc.ServiceDefinition } } } };
    };
    this.server.addService(rtcObj.android.emulation.control.Rtc.service, {
      requestRtcStream: (_call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<unknown>) => {
        this.requestRtcStreamCalls += 1;
        if (this.requestRtcStreamFailure) {
          cb({ code: this.requestRtcStreamFailure.code, message: this.requestRtcStreamFailure.message });
          return;
        }
        this.guidCounter += 1;
        cb(null, { guid: `guid-${this.guidCounter}` });
      },
      sendJsepMessage: (call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<unknown>) => {
        const req = call.request as { id?: { guid?: string }; message?: string };
        this.sends.push({
          guid: req.id?.guid ?? "",
          message: req.message ?? "",
          auth: call.metadata.get("authorization")[0] as string | undefined,
        });
        this.lastSendAuth = call.metadata.get("authorization")[0] as string | undefined;
        cb(null, {});
      },
      receiveJsepMessages: (call: grpc.ServerWritableStream<unknown, unknown>) => {
        const guid = (call.request as { guid?: string }).guid ?? "";
        void this.pump(call, guid);
      },
      receiveJsepMessage: (_call: unknown, cb: grpc.sendUnaryData<unknown>) => {
        // Deprecated polling variant — unused by the v1 adapter; reject loudly
        // so a drift onto it is caught by the conformance tests.
        cb({ code: grpc.status.UNIMPLEMENTED, message: "receiveJsepMessage is deprecated; use the stream" });
      },
    } as unknown as grpc.UntypedServiceImplementation);
    this.server.addService(ctrlObj.android.emulation.control.EmulatorController.service, {
      getStatus: (_call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<unknown>) => {
        if (this.getStatusFailure) {
          cb({ code: this.getStatusFailure.code, message: this.getStatusFailure.message });
          return;
        }
        cb(null, {});
      },
    } as unknown as grpc.UntypedServiceImplementation);
    const port = await new Promise<number>((res, rej) =>
      this.server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) =>
        e ? rej(e) : res(p),
      ),
    );
    this.port = port;
    this.addr = `127.0.0.1:${port}`;
  }

  /** Emulator side: queue a JSEP wire message for `guid` (raw JSON string). */
  push(guid: string, message: string): void {
    const queue = this.outbound.get(guid) ?? [];
    queue.push(message);
    this.outbound.set(guid, queue);
    const waiting = this.waiters.get(guid) ?? [];
    const next = waiting.shift();
    if (next) next(message);
  }

  /** True when every waiter is gone (streams ended). */
  hasWaiter(guid: string): boolean {
    return (this.waiters.get(guid)?.length ?? 0) > 0;
  }

  /** Terminate the server (tests only). */
  stop(): void {
    // Release blocked waiters so server code doesn't dangle.
    for (const [guid, waiters] of this.waiters) {
      for (const w of waiters) w(null);
      waiters.length = 0;
      this.cancelled.add(guid);
    }
    this.server.forceShutdown();
  }

  /** Blocking pump: write queued messages, then suspend until push/cancel. */
  private async pump(call: grpc.ServerWritableStream<unknown, unknown>, guid: string): Promise<void> {
    const waiters = this.waiters.get(guid) ?? [];
    this.waiters.set(guid, waiters);
    call.on("cancelled", () => {
      this.cancelled.add(guid);
      const pending = this.waiters.get(guid) ?? [];
      for (const w of pending) w(null);
      pending.length = 0;
      call.end();
    });
    for (;;) {
      const queue = this.outbound.get(guid) ?? [];
      const next = queue.shift();
      this.outbound.set(guid, queue);
      if (next !== undefined) {
        if (call.cancelled) return;
        call.write({ id: { guid }, message: next });
        continue;
      }
      if (this.cancelled.has(guid) || call.cancelled) return;
      const resume = await new Promise<string | null>((resolve) => waiters.push(resolve));
      if (resume === null || this.cancelled.has(guid) || call.cancelled) return;
    }
  }
}
