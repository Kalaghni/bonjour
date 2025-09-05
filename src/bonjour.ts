/* eslint-disable @typescript-eslint/ban-types */
// Minimal bonjour-like library using multicast-dns (from scratch)
import { EventEmitter } from "events";
import os from "os";
import crypto from "node:crypto";
import mdns, { QueryPacket, ResponsePacket } from "multicast-dns";

export type Protocol = "tcp" | "udp";

export interface PublishOptions {
    /** Instance display name (left of the service type) */
    name: string;
    /** Service type without leading underscore (e.g. "http", "ipp", "airplay") */
    type: string;
    /** TCP/UDP port */
    port: number;
    /** Protocol (default: 'tcp') */
    protocol?: Protocol;
    /** Optional hostname target for SRV (default: "<host>.local") */
    host?: string;
    /** TXT key/values */
    txt?: Record<string, string | number | boolean>;
    /** Optional subtypes (e.g., ['sub1','sub2']) */
    subtypes?: string[];
    /** Domain (default: 'local') */
    domain?: string;
    /** Disable IPv6 AAAA advertising (default: true for simplicity) */
    disableIPv6?: boolean;
    /** TTL seconds for records (default: 120) */
    ttl?: number;
}

export interface FindOptions {
    /** Service type ("http" → _http._tcp.local) */
    type?: string;
    /** Protocol (default 'tcp') */
    protocol?: Protocol;
    /** Domain (default 'local') */
    domain?: string;
    /** Optional subtype filters (not strictly required) */
    subtypes?: string[];
}

export type ServiceUp = {
    name: string;            // instance name (left label)
    fqdn: string;            // full service instance name
    host: string;            // SRV target hostname
    port: number;            // SRV port
    addresses: string[];     // collected A/AAAA
    txt: Record<string, string>;
};

export interface BonjourOptions {
    /** Bind to udp4 or udp6 (default 'udp4') */
    type?: "udp4" | "udp6";
    /** Force a specific interface IP to bind (helps multi-NIC Windows) */
    interface?: string;
    /** reuseAddr + loopback forwarded to multicast-dns (defaults true) */
    reuseAddr?: boolean;
    loopback?: boolean;
    /** Domain (default 'local') */
    domain?: string;
    /** Override instanceId used for self-ignore (TXT id) */
    instanceId?: string;
    /** Randomize active discovery query timings (default true) */
    jitter?: boolean;
}

/* ------------------------------ helpers ------------------------------ */

const TLD = "local";
const DEFAULT_TTL = 120;

function fqdnOf(type: string, protocol: Protocol = "tcp", domain = TLD) {
    const dom = domain.endsWith(".") ? domain.slice(0, -1) : domain;
    return `_${type}._${protocol}.${dom}`;
}

function hostnameLocal(): string {
    const h = os.hostname() || "host";
    return h.endsWith(".local") ? h : `${h}.local`;
}

function pickLanIPv4(): string | undefined {
    const ifs = os.networkInterfaces();
    for (const k of Object.keys(ifs)) {
        for (const ni of ifs[k] ?? []) {
            if (
                ni &&
                ni.family === "IPv4" &&
                !ni.internal &&
                ni.address &&
                !ni.address.startsWith("169.254.")
            ) {
                return ni.address;
            }
        }
    }
    return undefined;
}

function toTxtBuffers(txt: Record<string, string | number | boolean> = {}): Buffer[] {
    const out: Buffer[] = [];
    for (const [k, v] of Object.entries(txt)) out.push(Buffer.from(`${k}=${String(v)}`));
    return out;
}

function parseTxt(data: any): Record<string, string> {
    const arr: Buffer[] = Array.isArray(data)
        ? data.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))
        : [Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""))];
    const obj: Record<string, string> = {};
    for (const b of arr) {
        const s = b.toString("utf8");
        const i = s.indexOf("=");
        if (i === -1) {
            if (s) obj[s.toLowerCase()] = "";
        } else {
            obj[s.slice(0, i).toLowerCase()] = s.slice(i + 1);
        }
    }
    return obj;
}

/* ------------------------------ Service ------------------------------ */

export class Service extends EventEmitter {
    private bonjour: Bonjour;
    private opts: Required<PublishOptions>;
    private active = false;
    private queryHandler?: (q: QueryPacket) => void;
    private addresses: string[] = [];
    readonly fqdn: string;
    readonly instanceId: string; // used in TXT for self-ignore

    constructor(bonjour: Bonjour, opts: PublishOptions, instanceId: string) {
        super();
        const protocol = opts.protocol ?? "tcp";
        const domain = (opts.domain ?? bonjour.domain ?? TLD).replace(/\.+$/, "");
        const ttl = opts.ttl ?? DEFAULT_TTL;

        this.bonjour = bonjour;
        this.instanceId = instanceId;

        this.opts = {
            name: opts.name,
            type: opts.type,
            port: opts.port,
            protocol,
            host: opts.host ?? hostnameLocal(),
            txt: opts.txt ?? {},
            subtypes: opts.subtypes ?? [],
            domain,
            disableIPv6: opts.disableIPv6 ?? true,
            ttl
        };

        this.fqdn = `${this.opts.name}.${fqdnOf(this.opts.type, this.opts.protocol, this.opts.domain)}`;
    }

    start() {
        if (this.active) return;
        this.active = true;

        // Prepare addresses we’ll announce (A/AAAA)
        const ipv4 = pickLanIPv4();
        if (ipv4) this.addresses.push(ipv4);

        // Handle queries addressed to our PTR/SRV/TXT/A
        this.queryHandler = (q: QueryPacket) => {
            const wantsPTR = (q.questions || []).some(
                (qq) => qq.type === "PTR" && qq.name === fqdnOf(this.opts.type, this.opts.protocol, this.opts.domain)
            );
            const wantsSRV = (q.questions || []).some((qq) => qq.type === "SRV" && qq.name === this.fqdn);
            const wantsTXT = (q.questions || []).some((qq) => qq.type === "TXT" && qq.name === this.fqdn);
            const wantsA   = (q.questions || []).some((qq) => qq.type === "A"   && qq.name === this.opts.host);
            const wantsAAAA= (q.questions || []).some((qq) => qq.type === "AAAA"&& qq.name === this.opts.host);

            if (wantsPTR || wantsSRV || wantsTXT || wantsA || wantsAAAA) {
                this.advertise(this.opts.ttl);
            }
        };

        this.bonjour._mdns.on("query", this.queryHandler);

        // Unsolicited announcements (twice per RFC6762)
        this.advertise(this.opts.ttl);
        setTimeout(() => this.advertise(this.opts.ttl), 1000);
    }

    stop() {
        if (!this.active) return;
        try {
            // Goodbye (TTL=0)
            this.advertise(0);
            if (this.queryHandler) this.bonjour._mdns.removeListener("query", this.queryHandler);
        } catch (e) {
            this.emit("error", e);
        } finally {
            this.queryHandler = undefined;
            this.active = false;
        }
    }

    private advertise(ttl: number) {
        // TXT includes our instanceId for self-ignore
        const txt = toTxtBuffers({ id: this.instanceId, ...this.opts.txt });

        const answers: any[] = [
            {
                name: fqdnOf(this.opts.type, this.opts.protocol, this.opts.domain),
                type: "PTR",
                ttl,
                data: this.fqdn
            },
            {
                name: this.fqdn,
                type: "SRV",
                ttl,
                data: {
                    port: this.opts.port,
                    target: this.opts.host,
                    priority: 0,
                    weight: 0
                }
            },
            {
                name: this.fqdn,
                type: "TXT",
                ttl,
                data: txt
            }
        ];

        const additionals: any[] = [];
        for (const ip of this.addresses) {
            additionals.push({ name: this.opts.host, type: "A", ttl, data: ip });
        }
        // (Optional) add AAAA if you want v6; omitted by default

        this.bonjour._mdns.respond({ answers, additionals });
    }
}

/* ------------------------------ Browser ------------------------------ */

export class Browser extends EventEmitter {
    private bonjour: Bonjour;
    private opts: Required<FindOptions>;
    private started = false;
    private services = new Map<string, ServiceUp>(); // fqdn -> service
    private timers = new Map<string, NodeJS.Timeout>();

    constructor(bonjour: Bonjour, opts: FindOptions = {}) {
        super();
        this.bonjour = bonjour;
        this.opts = {
            type: opts.type!,
            protocol: opts.protocol ?? "tcp",
            domain: (opts.domain ?? bonjour.domain ?? TLD).replace(/\.+$/, ""),
            subtypes: opts.subtypes ?? []
        };
    }

    start() {
        if (this.started) return;
        this.started = true;

        this.bonjour._mdns.on("response", this.onResponse);
        // discover already-online services
        this.update();
        setTimeout(() => this.update(), 750);
        setTimeout(() => this.update(), 3000);
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        try {
            this.bonjour._mdns.removeListener("response", this.onResponse);
        } catch {}
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
        this.services.clear();
    }

    /** Actively query (PTR for requested type, or wildcard for types) */
    update() {
        if (!this.started) return;
        if (this.opts.type) {
            this.bonjour._mdns.query([{ name: fqdnOf(this.opts.type, this.opts.protocol, this.opts.domain), type: "PTR" }]);
        } else {
            // Wildcard type discovery
            this.bonjour._mdns.query([{ name: `_services._dns-sd._udp.${this.opts.domain}`, type: "PTR" }]);
        }
    }

    /** Expire all cached services (forces fresh 'up' on next response) */
    expire() {
        for (const [fqdn, svc] of this.services.entries()) {
            this.emit("down", svc);
            this.services.delete(fqdn);
            const t = this.timers.get(fqdn);
            if (t) clearTimeout(t);
            this.timers.delete(fqdn);
        }
    }

    /* -------- internals -------- */

    private onResponse = (res: ResponsePacket) => {
        const all = [...(res.answers || []), ...(res.additionals || [])];

        // Goodbyes for our type
        if (this.opts.type) {
            const typeFqdn = fqdnOf(this.opts.type, this.opts.protocol, this.opts.domain);
            const bye = all.filter((rr) => rr.type === "PTR" && rr.name === typeFqdn && (rr as any).ttl === 0);
            for (const rr of bye) {
                const fqdn = String((rr as any).data);
                const svc = this.services.get(fqdn);
                if (svc) {
                    this.services.delete(fqdn);
                    const t = this.timers.get(fqdn);
                    if (t) clearTimeout(t);
                    this.timers.delete(fqdn);
                    this.emit("down", svc);
                }
            }
        }

        // Ignore TTL=0 in the rest
        const records = all.filter((rr) => (rr as any).ttl === undefined || (rr as any).ttl > 0);

        // Wildcard path: new types we should now query
        if (!this.opts.type) {
            const dnsSd = `_services._dns-sd._udp.${this.opts.domain}`;
            const ptrs = records.filter((rr) => rr.type === "PTR" && rr.name === dnsSd);
            for (const p of ptrs) {
                const serviceType = String((p as any).data); // like "_http._tcp.local"
                // Ask for instances of this type
                this.bonjour._mdns.query([{ name: serviceType, type: "PTR" }]);
            }
            return;
        }

        // Normal path: collect instances for our type
        const typeFqdn = fqdnOf(this.opts.type, this.opts.protocol, this.opts.domain);
        const ptrs = records.filter((rr) => rr.type === "PTR" && rr.name === typeFqdn);

        for (const ptr of ptrs) {
            const instanceFqdn = String((ptr as any).data);
            const srv = records.find((rr) => rr.type === "SRV" && rr.name === instanceFqdn) as any;
            const txt = records.find((rr) => rr.type === "TXT" && rr.name === instanceFqdn) as any;
            if (!srv) continue;

            const host = srv.data?.target ?? hostnameLocal();
            const port = Number(srv.data?.port ?? 0);

            const addrs: string[] = [];
            for (const rr of records) {
                if ((rr.type === "A" || rr.type === "AAAA") && rr.name === host) addrs.push(String((rr as any).data));
            }

            const parts = instanceFqdn.split(".");
            const name = parts[0] || instanceFqdn;
            const txtObj = txt ? parseTxt(txt.data) : {};

            // self-ignore by TXT id
            const ownId = this.bonjour.instanceId;
            if (txtObj.id && ownId && txtObj.id === ownId) continue;

            const next: ServiceUp = { name, fqdn: instanceFqdn, host, port, addresses: addrs, txt: txtObj };

            const seen = this.services.get(instanceFqdn);
            this.services.set(instanceFqdn, next);

            // Refresh expiry (use whichever TTL we have)
            const ttl = (ptr as any).ttl ?? srv.ttl ?? txt?.ttl ?? DEFAULT_TTL;
            const prevT = this.timers.get(instanceFqdn);
            if (prevT) clearTimeout(prevT);
            const t = setTimeout(() => {
                const cur = this.services.get(instanceFqdn);
                if (cur) {
                    this.services.delete(instanceFqdn);
                    this.emit("down", cur);
                }
            }, Math.max(1, ttl) * 1000 + (this.bonjour.jitter ? 500 + Math.floor(Math.random() * 500) : 0));
            this.timers.set(instanceFqdn, t);

            if (!seen || seen.port !== next.port || seen.host !== next.host) {
                this.emit("up", next);
            }
        }
    };
}

/* ------------------------------ Bonjour ------------------------------ */

export class Bonjour {
    readonly _mdns: ReturnType<typeof mdns>;
    readonly domain: string;
    readonly instanceId: string;
    readonly jitter: boolean;

    constructor(opts: BonjourOptions = {}) {
        const iface = opts.interface ?? pickLanIPv4();
        this._mdns = mdns({
            type: opts.type ?? "udp4",
            interface: iface,
            reuseAddr: opts.reuseAddr ?? true,
            loopback: opts.loopback ?? true
        });

        this.domain = (opts.domain ?? TLD).replace(/\.+$/, "");
        this.instanceId = opts.instanceId ?? crypto.randomUUID();
        this.jitter = opts.jitter ?? true;
    }

    /** Start advertising a service */
    publish(opts: PublishOptions): Service {
        const svc = new Service(this, opts, this.instanceId);
        svc.start();
        return svc;
    }

    /** Create a browser for services; attach 'up'/'down', then start() or call update() */
    find(opts: FindOptions = {}, onUp?: (svc: ServiceUp) => void): Browser {
        const b = new Browser(this, opts);
        if (onUp) b.on("up", onUp);
        b.start();
        return b;
    }

    /** Close the underlying mdns socket */
    destroy() {
        try { this._mdns.removeAllListeners(); } catch {}
        try { this._mdns.destroy(); } catch {}
    }
}

/* ------------------------------ Usage example ------------------------------ */
/*
import { Bonjour } from './bonjour';

// Publisher
const bonjour = new Bonjour();
const svc = bonjour.publish({
  name: "Paperless " + crypto.randomUUID(),
  type: "twc-paperless",
  protocol: "tcp",
  port: 3003,
  txt: { version: "1.2.3" }
});

// Browser
const browser = bonjour.find({ type: "twc-paperless", protocol: "tcp" });
browser.on("up",   (s) => console.log("UP", s.name, s.host, s.port, s.txt));
browser.on("down", (s) => console.log("DOWN", s.name));

process.on("SIGINT", () => {
  svc.stop();
  bonjour.destroy();
  process.exit(0);
});
*/
