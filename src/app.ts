/**
 * Cinema's two sides in one chat, without the page: the link, what this side shares, what it watches, and the
 * `hello` each side says when the other opens. Either side may share a library and watch the other's.
 *
 *   hello {v, rev, name?}   on start and whenever the contact opens: this side's library revision (0: none)
 *   hello {…, re: 1}        the answer to a hello: what was said before the contact's app listened may be lost
 *   lib {rev}               this side's library changed
 */
import { Link, PROTOCOL } from "./link.ts";
import { Share, type PictureMaker } from "./share.ts";
import { Watch } from "./watch.ts";
import type { MiniAppApi } from "./vendor/miniApp.ts";

export interface PeerState {
  open: boolean;
  /** The contact's app version, while open. */
  version?: string;
  /** The contact's name in this chat, when its side may tell it (the `name` permission). */
  name?: string;
  /** The contact's protocol, from its hello. */
  protocol?: number;
}

export class Cinema {
  readonly link: Link;
  readonly share: Share;
  readonly watch: Watch;
  peer: PeerState = { open: false };
  /** This side's name in the chat, said in hello. */
  name?: string;
  private listeners = new Set<() => void>();

  constructor(
    private readonly api: MiniAppApi,
    pictures: PictureMaker,
  ) {
    this.share = new Share(api, pictures, (rev) => void this.link.say({ t: "lib", rev }).catch(() => {}));
    this.link = new Link(api, {
      serve: (ask) => this.share.serve(ask),
      onFrame: (frame) => this.frame(frame),
      onPeer: (open, version) => {
        this.peer = open ? { ...this.peer, open, ...(version && { version }) } : { ...this.peer, open: false };
        if (open) this.hello();
        this.changed();
      },
    });
    this.watch = new Watch(api, this.link);
  }

  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const l of this.listeners) l();
  }

  /** Reads what this chat kept, and says hello when the contact is open already. */
  async start(): Promise<void> {
    const context = await this.api.context();
    this.name = context.name;
    await Promise.all([this.share.load(), this.watch.load()]);
    if (context.peer) {
      this.link.setPeer(true);
      this.peer = { open: true, version: context.peer.version };
      this.hello();
    }
    this.changed();
  }

  private hello(answer = false): void {
    void this.link.say({ t: "hello", v: PROTOCOL, rev: this.share.rev, ...(this.name && { name: this.name.slice(0, 64) }), ...(answer && { re: 1 }) }).catch(() => {});
  }

  private frame(f: { [key: string]: unknown }): void {
    const rev = typeof f.rev === "number" && Number.isFinite(f.rev) && f.rev >= 0 ? f.rev : undefined;
    if (f.t === "hello") {
      const name = typeof f.name === "string" ? f.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) : undefined;
      this.peer = { ...this.peer, open: true, ...(typeof f.v === "number" && { protocol: f.v }), ...(name && { name }) };
      this.changed();
      if (f.re !== 1) this.hello(true);
      if (rev !== undefined) void this.watch.heard(rev).catch(() => {});
    } else if (f.t === "lib" && rev !== undefined) {
      void this.watch.heard(rev).catch(() => {});
    }
  }

  close(): void {
    this.link.close();
  }
}
