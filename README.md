# @joshtwc/bonjour

A tiny, from-scratch Bonjour/ZeroConf (mDNS + DNS-SD) library built directly on multicast-dns.
API is intentionally familiar if you’ve used bonjour/bonjour-service:

- new Bonjour(opts?)
- bonjour.publish({...}) → Service
- bonjour.find({ type, protocol? }, onUp?) → Browser
- browser.on('up' | 'down', fn) · browser.update() · browser.stop()
- service.start() · service.stop()
- bonjour.destroy()

Why this exists
- Works reliably on Windows (multi-NIC friendly): binds to your LAN IPv4 by default.
- Active discovery on start (no “only appears when a new device starts” issue).
- Sends proper goodbyes (TTL=0) on shutdown.
- Ignores its own adverts by a TXT id, so multiple instances on the same host don’t see themselves.
- Zero runtime deps besides multicast-dns.

Install

    npm i @joshtwc/bonjour

Node 18+ is recommended.

Quick start

Publish a service

    import { Bonjour } from '@joshtwc/bonjour';
    const bonjour = new Bonjour();
    const service = bonjour.publish({
      name: 'Paperless ' + crypto.randomUUID(),
      type: 'twc-paperless',     // -> _twc-paperless._tcp.local
      protocol: 'tcp',
      port: 3003,
      txt: { version: '1.2.3' }  // a TXT "id" is added automatically for self-ignore
    });
    // Stop on exit
    process.on('SIGINT', () => {
      service.stop();
      bonjour.destroy();
      process.exit(0);
    });

Discover services

    import { Bonjour } from '@joshtwc/bonjour';
    const bonjour = new Bonjour();
    const browser = bonjour.find({ type: 'twc-paperless', protocol: 'tcp' });
    browser.on('up',   (svc) => { console.log('UP', svc.name, svc.host, svc.port, svc.txt); });
    browser.on('down', (svc) => { console.log('DOWN', svc.name); });
    // actively query now (already called on start, but you can poke again)
    browser.update();

CommonJS usage

    const { Bonjour } = require('@joshtwc/bonjour');
    const bonjour = new Bonjour();

API

new Bonjour(opts?)

    type BonjourOptions = {
      type?: 'udp4' | 'udp6';        // default: 'udp4'
      interface?: string;            // bind to a specific local IP (e.g., '192.168.1.10')
      reuseAddr?: boolean;           // default: true
      loopback?: boolean;            // default: true
      domain?: string;               // default: 'local'
      instanceId?: string;           // override per-process TXT id (for self-ignore)
      jitter?: boolean;              // add small TTL jitter; default: true
    };

On Windows with Hyper-V/WSL/VPN adapters, you may want to pass interface: '192.168.x.x'.

bonjour.publish(options) → Service

    type PublishOptions = {
      name: string;                  // instance label (left of the service type)
      type: string;                  // e.g., 'http' -> _http._tcp.local
      port: number;
      protocol?: 'tcp' | 'udp';      // default: 'tcp'
      host?: string;                 // SRV target hostname (default: "<machine>.local")
      txt?: Record<string, string | number | boolean>;
      subtypes?: string[];
      domain?: string;               // default: 'local'
      disableIPv6?: boolean;         // default: true
      ttl?: number;                  // default: 120
    };

Returns a Service with:
- start() – begin advertising (called automatically by publish)
- stop() – send goodbye (TTL=0) and stop advertising
- events: 'error'

This implementation automatically injects a TXT id=<uuid> to support self-ignore.

bonjour.find(options?, onUp?) → Browser

    type FindOptions = {
      type?: string;                 // if omitted, wildcard discovery of types is used
      protocol?: 'tcp' | 'udp';      // default: 'tcp'
      domain?: string;               // default: 'local'
      subtypes?: string[];
    };

    browser.on('up', (service) => { /* ... */ })
    browser.on('down', (service) => { /* ... */ })
    browser.update();                // actively query now (PTR)
    browser.stop();

service object

    type ServiceUp = {
      name: string;                  // instance label
      fqdn: string;                  // full instance name
      host: string;                  // SRV target hostname
      port: number;
      addresses: string[];           // A/AAAA addresses observed
      txt: Record<string, string>;   // parsed TXT
    };

bonjour.destroy()

Closes the underlying mDNS socket and removes listeners.

Notes & tips
- Don’t set host to an IP. SRV target should be a hostname (e.g., myhost.local); A/AAAA records carry the IPs.
- Windows firewall: Ensure your app can receive unicast UDP replies. Private network profile is best.
- IPv6: This lib advertises A (IPv4) by default. If you need v6-only peers, extend to add AAAA records and/or run with type: 'udp6'.

Migration
From bonjour / bonjour-service:
- new Bonjour() is similar.
- publish({ name, type, port, txt }) and find({ type, protocol }) are compatible.
- This library actively queries on start, so you’ll get 'up' events for existing services immediately.
- Self-ignore is by TXT id, so multiple instances on the same host won’t see themselves even if they share a hostname.

License

ISC © Josh Wood
