# @joshtwc/bonjour

> A tiny, from‑scratch Bonjour/ZeroConf (mDNS + DNS‑SD) library built directly on multicast‑dns.  
> Active discovery, proper goodbyes, self‑ignore via TXT `id`, and Windows‑friendly NIC binding.

## Table of contents

- [Features](#features)
- [Installation](#installation)
- [Requirements](#requirements)
- [Quick start](#quick-start)
  - [Publish a service](#publish-a-service)
  - [Discover services](#discover-services)
  - [CommonJS usage](#commonjs-usage)
- [API](#api)
  - [Bonjour](#bonjour)
  - [Service](#service)
  - [Browser](#browser)
  - [Types](#types)
- [Advanced](#advanced)
  - [Wildcard type discovery](#wildcard-type-discovery)
  - [Binding to a specific interface (Windows, multi‑NIC)](#binding-to-a-specific-interface-windows-multi-nic)
  - [IPv6 notes](#ipv6-notes)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Features

- Works reliably on Windows (multi‑NIC friendly): binds to your LAN IPv4 by default.
- **Active discovery** on start (no “only appears when a new device starts” issue).
- Sends proper **goodbyes** (TTL=0) on shutdown.
- **Self‑ignore** by a TXT `id`, so multiple instances on the same host don’t see themselves.
- Zero runtime deps besides `multicast-dns`.
- Dual ESM + CJS builds with bundled type definitions.

## Installation

    npm i @joshtwc/bonjour

## Requirements

- Node.js 18 or newer is recommended.
- If your network has multiple adapters (Hyper‑V, WSL, VPN, Docker), consider binding to a specific IPv4 (see Advanced).

## Quick start

### Publish a service

    import { Bonjour } from '@joshtwc/bonjour';
    import crypto from 'node:crypto';
    
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

### Discover services

    import { Bonjour } from '@joshtwc/bonjour';
    
    const bonjour = new Bonjour();
    
    const browser = bonjour.find({ type: 'twc-paperless', protocol: 'tcp' });
    
    browser.on('up',   (svc) => { console.log('UP', svc.name, svc.host, svc.port, svc.txt); });
    browser.on('down', (svc) => { console.log('DOWN', svc.name); });
    
    // actively query now (already called on start, but you can poke again)
    browser.update();

### CommonJS usage

    const { Bonjour } = require('@joshtwc/bonjour');
    const bonjour = new Bonjour();

## API

### Bonjour

Constructor

    new Bonjour(options?)

Options

    type?: 'udp4' | 'udp6'        // default: 'udp4'
    interface?: string            // bind to a specific local IP (e.g., '192.168.1.10')
    reuseAddr?: boolean           // default: true
    loopback?: boolean            // default: true
    domain?: string               // default: 'local'
    instanceId?: string           // override per-process TXT id (for self-ignore)
    jitter?: boolean              // add small TTL jitter; default: true

Methods

- `publish(opts) → Service` — start advertising immediately.
- `find(opts?, onUp?) → Browser` — create and start a browser; optional `onUp` shortcut.
- `destroy()` — close the underlying mDNS socket and remove listeners.

### Service

Created by `bonjour.publish({...})`

Options

    name: string                  // instance label (left of the service type)
    type: string                  // e.g., 'http' -> _http._tcp.local
    port: number
    protocol?: 'tcp' | 'udp'      // default: 'tcp'
    host?: string                 // SRV target hostname (default: "<machine>.local")
    txt?: Record<string, string | number | boolean>
    subtypes?: string[]
    domain?: string               // default: 'local'
    disableIPv6?: boolean         // default: true
    ttl?: number                  // default: 120

Methods

- `start()` — begin advertising (called automatically by `publish`).
- `stop()` — send a goodbye (TTL=0) and stop advertising.

Notes

- The library injects `txt.id = <uuid>` automatically to support self‑ignore.

### Browser

Created by `bonjour.find({...})`

Options

    type?: string                 // if omitted, wildcard discovery of types is used
    protocol?: 'tcp' | 'udp'      // default: 'tcp'
    domain?: string               // default: 'local'
    subtypes?: string[]

Events

- `'up'` — `(service: ServiceUp)` when a service becomes available
- `'down'` — `(service: ServiceUp)` when a service expires or announces goodbye

Methods

- `start()` — begin listening and actively query (called automatically by `find`).
- `stop()` — stop listening and clear timers.
- `update()` — actively send a PTR query now.
- `expire()` — force local cache expiration (emits `'down'` for all).

### Types

`ServiceUp` (payload for `'up'/'down'` events)

    {
      name: string,                // instance label
      fqdn: string,                // full instance name
      host: string,                // SRV target hostname
      port: number,
      addresses: string[],         // A/AAAA addresses observed
      txt: Record<string, string>  // parsed TXT
    }

## Advanced

### Wildcard type discovery

If you call `find({})` without a `type`, the browser first queries `_services._dns-sd._udp.local` to discover available types, then queries each type for instances.

### Binding to a specific interface (Windows, multi‑NIC)

When multiple adapters are present (VPN, Hyper‑V, WSL, Docker), you may want to force the mDNS socket to your LAN IPv4:

    const bonjour = new Bonjour({ interface: '192.168.1.42' });

### IPv6 notes

By default the library advertises A (IPv4). If your network is IPv6‑only, run with `type: 'udp6'` and extend the announcement to include AAAA records.

## Troubleshooting

- Ensure your firewall allows **inbound UDP** for your Node/Electron executable (unicast replies may target an ephemeral port).
- Prefer a **Private** network profile on Windows for mDNS testing.
- Do not set `host` to an IP; SRV `target` should be a hostname (e.g., `myhost.local`). IPs are carried in A/AAAA records.
- If services appear only when a new device starts, call `browser.update()` right after attaching event handlers, and verify NIC binding (see Advanced).

## License

ISC © Josh Wood
