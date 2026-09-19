// Authoritative game room ("lightning mode"): all actions for roomAuthority runs go over Colyseus.
import { Client, type Room } from "colyseus.js";
import { MogApi, APP_VERSION } from "../mog/api.js";
import { mergeState } from "./delta.js";

export type Action =
  | { type: "move"; direction: Dir; targetX: number; targetY: number }
  | { type: "attack"; direction: Dir; targetEnemyId: string }
  | { type: "break"; direction: Dir; targetId: string }
  | { type: "pass" }
  | { type: "upgrade_selected"; upgradeId: string }
  | { type: "use_item"; slotIndex: number; targetX?: number; targetY?: number }
  | { type: "discard_item"; slotIndex: number; pickupPendingId?: string }
  | { type: "select_talent"; talentId: string }
  | { type: "reroll_talent" };
export type RunAction =
  | { type: "teleport" } | { type: "reroll" } | { type: "enter_upgrade_room" }
  | { type: "portal_gambit_bet"; wager: number } | { type: "ring_race_bet"; lane: number; wager: number }
  | { type: "trainer_swap"; talentId: string };
export type Dir = "up" | "down" | "left" | "right";
export interface StepResult { gameState: any; events: any[]; isGameOver: boolean; serverProcessMs?: number; rttMs: number }

export class MoveRejected extends Error { constructor(public code: string) { super(`move rejected: ${code}`); } }

export class GameRoom {
  private room: Room | null = null;
  state: any = null;
  private pending: { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  backpressure = false;
  closedReason: string | null = null;

  constructor(private api: MogApi, readonly runId: string, private log: (m: string) => void = () => {}) {}

  async connect(timeoutMs = 15_000) {
    const { token, url } = await this.api.post(`/api/runs/${this.runId}/colyseus-token`, undefined, { retry: true });
    const client = new Client(url ?? "wss://colyseus-production-2853.up.railway.app");
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("room ready timeout")), timeoutMs);
      (async () => {
        const room = await client.joinOrCreate("mog_game", { runId: this.runId, token, appVersion: Number(APP_VERSION), gameVersion: "v2" });
        this.room = room; this.closedReason = null;
        room.onMessage("ready", (m: any) => {
          if (m?.gameState) this.state = this.state && this.state.currentFloor === m.gameState.currentFloor ? mergeState(this.state, m.gameState) : m.gameState;
          clearTimeout(t); resolve();
        });
        room.onMessage("__playground_message_types", () => {});
        room.onMessage("authority:backpressure", (m: any) => { this.backpressure = m?.active === true; this.log(`backpressure=${this.backpressure}`); });
        room.onMessage("move:ack", (m: any) => this.settle(null, m));
        room.onMessage("move:error", (m: any) => this.settle(new MoveRejected(m?.code ?? "UNKNOWN")));
        room.onMessage("run_action:ack", (m: any) => this.settle(null, m));
        room.onMessage("run_action:error", (m: any) => this.settle(new MoveRejected(m?.code ?? "UNKNOWN")));
        room.onMessage("*", (type: any, m: any) => this.log(`room msg ${String(type)} ${JSON.stringify(m).slice(0, 200)}`));
        room.onError((code, msg) => this.log(`room error ${code} ${msg}`));
        room.onLeave((code) => { this.closedReason = `leave:${code}`; this.room = null; this.settle(new Error(`room closed (${code})`)); });
      })().catch((e) => { clearTimeout(t); reject(e); });
    });
    await ready;
    if (!this.state) this.state = await this.api.get(`/api/runs/${this.runId}`).then((r) => r.gameState ?? r);
    return this.state;
  }

  private settle(err: Error | null, val?: any) {
    const p = this.pending; if (!p) return;
    this.pending = null; clearTimeout(p.timer);
    err ? p.reject(err) : p.resolve(val);
  }

  private sendAndWait(type: "move" | "run_action", payload: unknown, timeoutMs: number): Promise<any> {
    if (!this.room) return Promise.reject(new Error("room not connected"));
    if (this.pending) return Promise.reject(new Error("action already in flight"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = null; reject(new Error(`${type} ack timeout`)); }, timeoutMs);
      this.pending = { resolve, reject, timer };
      try { this.room!.send(type, payload); } catch (e) { this.settle(e as Error); }
    });
  }

  async act(action: Action, timeoutMs = 8_000): Promise<StepResult> {
    const t0 = performance.now();
    const ack = await this.sendAndWait("move", { action, expectedTurnNumber: this.state?.turnNumber }, timeoutMs);
    if (!ack?.gameState) throw new Error(`malformed move:ack keys=${Object.keys(ack ?? {})}`);
    this.state = mergeState(this.state, ack.gameState);
    return { gameState: this.state, events: ack.events ?? [], isGameOver: !!ack.isGameOver, serverProcessMs: ack.serverProcessMs, rttMs: performance.now() - t0 };
  }

  async runAction(action: RunAction, timeoutMs = 8_000) {
    const ack = await this.sendAndWait("run_action", { action }, timeoutMs);
    if (ack?.gameState) this.state = mergeState(this.state, ack.gameState);
    return ack;
  }

  async leave() { try { await this.room?.leave(true); } catch { /* ignore */ } this.room = null; }
  get connected() { return !!this.room; }
}
