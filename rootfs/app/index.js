#!/usr/bin/env node
// @ts-nocheck
/**
 * TheElectronChain v4.1.0
 *
 * Cologne MaLo Aggregation Platform — Local Flexibility Market
 * - 200+ MaLos across 9 Kölner Stadtbezirke
 * - MaLo-ID: 11-digit BDEW format | MELo-ID: 33-char DE prefix
 * - Redispatch 3.0 Datenmodell (TransnetBW/E-Bridge): RDV, MOL, Abruf, Abrechnung
 * - Pay-as-bid Merit-Order-Liste (MOL) per 15-min slot
 * - AgNes BNetzA: dynamic grid fees with 15-min granularity
 * - Peaq Blockchain: DID registry + on-chain settlement
 * - BSI TR-03109 SMGW certificate → DID identity
 * - PVSimulator: pvlib-style JS (Spencer, Kasten-Young, isotropic sky)
 * - EnergyChartsAPI: EPEX day-ahead DE-LU
 * - Anker Solix + Zendure Hyper 2000 (HA-integrated real nodes)
 * - Dark theme dashboard, Leaflet Cologne map, WebSocket live
 */

import crypto from 'crypto';
import { Wallet } from 'ethers';
import express from 'express';
import fs from 'fs/promises';
import http from 'http';
import cron from 'node-cron';
import { WebSocketServer } from 'ws';

// ===========================================================================
// SMGCertificate — Smart Meter Gateway identity (BSI TR-03109 / X.509)
// ===========================================================================
class SMGCertificate {
  constructor(pemOrId = null) {
    this.raw         = pemOrId;
    this.fingerprint = null;
    this.cn          = null;
    this.zaehlpunkt  = null;

    if (!pemOrId) {
      this.fingerprint = crypto.randomBytes(16).toString('hex');
    } else if (pemOrId.startsWith('-----BEGIN')) {
      this._parsePEM(pemOrId);
    } else {
      this.fingerprint = crypto.createHash('sha256').update(pemOrId).digest('hex');
      this.cn = pemOrId;
      const m = pemOrId.match(/DE[0-9A-Za-z]{30,}/);
      if (m) this.zaehlpunkt = m[0].toUpperCase();
    }
  }

  _parsePEM(pem) {
    try {
      const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
      const der = Buffer.from(b64, 'base64');
      this.fingerprint = crypto.createHash('sha256').update(der).digest('hex');
      const cm = pem.match(/CN=([^,\n\/\r]+)/i);
      if (cm) {
        this.cn = cm[1].trim();
        const zm = this.cn.match(/DE[0-9A-Za-z]{30,}/);
        if (zm) this.zaehlpunkt = zm[0].toUpperCase();
      }
    } catch {
      this.fingerprint = crypto.randomBytes(16).toString('hex');
    }
  }

  getDID() {
    return 'did:peaq:smg_' + (this.fingerprint || 'anon').slice(0, 32);
  }

  toJSON() {
    return {
      fingerprint: this.fingerprint ? this.fingerprint.slice(0, 16) + '...' : null,
      cn:          this.cn,
      zaehlpunkt:  this.zaehlpunkt
    };
  }
}

// ===========================================================================
// PVSimulator — JavaScript pvlib-style solar generation model
// ===========================================================================
class PVSimulator {
  constructor({ lat = 50.94, lon = 6.96, tilt = 30, azimuth = 180, peakWp = 1000, pr = 0.75 } = {}) {
    this.latRad  = lat * Math.PI / 180;
    this.lon     = lon;
    this.tiltRad = tilt * Math.PI / 180;
    this.azRad   = azimuth * Math.PI / 180;
    this.peakWp  = peakWp;
    this.pr      = pr;
    this.config  = { lat, lon, tilt, azimuth, peakWp, pr };
  }

  _declination(dayOfYear) {
    const B = (2 * Math.PI * (dayOfYear - 1)) / 365;
    return 0.006918 - 0.399912 * Math.cos(B)   + 0.070257 * Math.sin(B)
                    - 0.006758 * Math.cos(2*B)  + 0.000907 * Math.sin(2*B)
                    - 0.002697 * Math.cos(3*B)  + 0.001480 * Math.sin(3*B);
  }

  _hourAngle(date) {
    const hUTC    = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const solarH  = hUTC + this.lon / 15;
    return (solarH - 12) * 15 * Math.PI / 180;
  }

  _dayOfYear(date) {
    return Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86_400_000);
  }

  _solarAngles(date) {
    const dec = this._declination(this._dayOfYear(date));
    const ha  = this._hourAngle(date);
    const lat = this.latRad;

    const cosZ   = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
    const zenith = Math.acos(Math.max(-1, Math.min(1, cosZ)));

    const sinZ = Math.sin(zenith);
    const cosAz = sinZ > 1e-6
      ? (Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(ha)) / sinZ
      : 0;
    const az = ha > 0
      ? Math.PI + Math.acos(Math.max(-1, Math.min(1, cosAz)))
      : Math.PI - Math.acos(Math.max(-1, Math.min(1, cosAz)));

    return { zenith, solarAz: az };
  }

  _poaIrradiance(date) {
    const { zenith, solarAz } = this._solarAngles(date);
    const cosZ = Math.cos(zenith);
    if (cosZ <= 0.017) return 0;

    const zenDeg = zenith * 180 / Math.PI;
    const AM     = 1 / (cosZ + 0.50572 * Math.pow(96.07995 - zenDeg, -1.6364));
    const DNI    = 1353 * Math.pow(0.7, Math.pow(AM, 0.678));
    const GHI    = DNI * cosZ;
    const DHI    = 0.1 * GHI;

    const cosAOI = Math.cos(zenith) * Math.cos(this.tiltRad)
                 + Math.sin(zenith) * Math.sin(this.tiltRad) * Math.cos(solarAz - this.azRad);
    const beam    = Math.max(0, DNI * cosAOI);
    const diffuse = DHI * (1 + Math.cos(this.tiltRad)) / 2;
    const ground  = GHI * 0.2 * (1 - Math.cos(this.tiltRad)) / 2;

    return Math.max(0, beam + diffuse + ground);
  }

  currentPower(date = new Date()) {
    const poa = this._poaIrradiance(date);
    return Math.round((poa / 1000) * this.peakWp * this.pr);
  }

  forecast48h(start = new Date()) {
    const t0 = new Date(start);
    t0.setMinutes(0, 0, 0);
    return Array.from({ length: 192 }, (_, i) => {
      const dt = new Date(t0.getTime() + i * 900_000);
      return { time: dt, powerW: this.currentPower(dt) };
    });
  }
}

// ===========================================================================
// Cologne Stadtbezirke — 9 districts with coordinates and PLZ ranges
// ===========================================================================
const KOELN_BEZIRKE = [
  { id: 1, name: 'Innenstadt',    lat: 50.9375, lon: 6.9603, plzPrefix: '506', color: '#ef4444' },
  { id: 2, name: 'Rodenkirchen',  lat: 50.8833, lon: 6.9833, plzPrefix: '509', color: '#f97316' },
  { id: 3, name: 'Lindenthal',    lat: 50.9333, lon: 6.8833, plzPrefix: '508', color: '#eab308' },
  { id: 4, name: 'Ehrenfeld',     lat: 50.9500, lon: 6.9167, plzPrefix: '507', color: '#22c55e' },
  { id: 5, name: 'Nippes',        lat: 50.9667, lon: 6.9500, plzPrefix: '506', color: '#06b6d4' },
  { id: 6, name: 'Chorweiler',    lat: 51.0167, lon: 6.8833, plzPrefix: '507', color: '#3b82f6' },
  { id: 7, name: 'Porz',          lat: 50.8667, lon: 7.0667, plzPrefix: '510', color: '#8b5cf6' },
  { id: 8, name: 'Kalk',          lat: 50.9333, lon: 7.0167, plzPrefix: '511', color: '#ec4899' },
  { id: 9, name: 'Muelheim',      lat: 50.9583, lon: 7.0083, plzPrefix: '510', color: '#14b8a6' }
];

// ===========================================================================
// MaloNode — Marktlokation node in the DePIN network
// ===========================================================================
class MaloNode {
  constructor({ id, maloId, meloId, name, lat, lon, stadtbezirk, address = '', haPrefix = null,
                battery = {}, solar = {}, smgCert = null, pvConfig = null, prosumerType = 'prosumer',
                isLocal = false, isPeer = false, isDemo = false, peerAddress = null, smgwId = null }) {
    this.id          = id;
    this.maloId      = maloId;
    this.meloId      = meloId;
    this.name        = name;
    this.lat         = lat;
    this.lon         = lon;
    this.stadtbezirk = stadtbezirk;
    this.address     = address;
    this.haPrefix    = haPrefix;
    this.prosumerType = prosumerType;
    this.isLocal     = isLocal;
    this.isPeer      = isPeer;
    this.isDemo      = isDemo;
    this.peerAddress = peerAddress;
    this.smgwId      = smgwId;

    this.smgCert = (smgCert instanceof SMGCertificate)
      ? smgCert
      : new SMGCertificate(smgCert || meloId || id + '_' + name);

    this.did = null;

    this.pvSim = pvConfig
      ? new PVSimulator({ lat, lon, ...pvConfig })
      : null;

    this.battery = {
      soc:         battery.soc         ?? (Math.random() * 80 + 10),
      powerW:      battery.powerW      ?? 0,
      capacityWh:  battery.capacityWh  ?? 5000,
      charging:    false,
      discharging: false,
      type:        battery.type        ?? 'generic',
      lastUpdate:  null
    };

    this.solar = {
      powerW:   solar.powerW   ?? 0,
      dailyWh:  solar.dailyWh  ?? 0,
      hasSolar: solar.hasSolar ?? (Math.random() > 0.15),
      peakW:    solar.peakW    ?? 2000,
      lastUpdate: null
    };

    this.consumption = Math.round(200 + Math.random() * 800);
    this.online    = true;
    this.lastSeen  = new Date();

    this.flexSpace = null;
    this.currentFlexKw = 0;
    this.flexHistory = [];
  }

  get surplusW() {
    if (!this.solar.hasSolar || this.solar.powerW < 50) return 0;
    const chargingDraw = this.battery.soc < 95 ? 400 : 0;
    return Math.max(0, this.solar.powerW - this.consumption - chargingDraw);
  }

  get canOffer()  { return this.surplusW > 50 || this.battery.soc > 40; }
  get needsDemand() { return this.battery.soc < 30 && this.solar.powerW < 100; }

  get availableFlexKw() {
    const battFlex = (this.battery.soc - 20) / 100 * this.battery.capacityWh / 1000;
    const solarFlex = this.surplusW / 1000;
    return Math.max(0, +(battFlex + solarFlex).toFixed(2));
  }

  generateFlexSpace() {
    const now = new Date();
    const slotStart = new Date(now);
    slotStart.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0);
    const slotEnd = new Date(slotStart.getTime() + 900_000);

    this.flexSpace = {
      id: crypto.randomUUID(),
      maloId: this.maloId,
      meloId: this.meloId,
      status: 'available',
      externallyTradeable: true,
      autoTradeable: true,
      validity: {
        start: slotStart.toISOString(),
        end: slotEnd.toISOString()
      },
      flexibleLoads: [{
        id: 'fl_' + this.id,
        powerStates: [
          { power: { value: this.availableFlexKw, unit: 'kW' }, direction: this.canOffer ? 'feedIn' : 'consumption' }
        ],
        reactionDuration: { value: 60, unit: 's' }
      }],
      storages: this.battery.capacityWh > 0 ? [{
        id: 'batt_' + this.id,
        type: this.battery.type,
        capacityKwh: +(this.battery.capacityWh / 1000).toFixed(1),
        currentSoc: +this.battery.soc.toFixed(1),
        maxChargeKw: +(this.battery.capacityWh / 2000).toFixed(1),
        maxDischargeKw: +(this.battery.capacityWh / 2000).toFixed(1)
      }] : [],
      location: {
        meterLocation: this.meloId,
        coordinates: { lat: this.lat, lon: this.lon }
      }
    };
    return this.flexSpace;
  }

  toJSON() {
    return {
      id: this.id, maloId: this.maloId, meloId: this.meloId,
      name: this.name, lat: this.lat, lon: this.lon,
      stadtbezirk: this.stadtbezirk,
      address: this.address, did: this.did,
      prosumerType: this.prosumerType,
      isLocal: this.isLocal, isPeer: this.isPeer, isDemo: this.isDemo,
      peerAddress: this.peerAddress, smgwId: this.smgwId,
      smgCert: this.smgCert.toJSON(),
      battery:  { ...this.battery },
      solar:    { ...this.solar },
      pvConfig: this.pvSim?.config ?? null,
      surplusW: Math.round(this.surplusW),
      canOffer:  this.canOffer,
      needsDemand: this.needsDemand,
      availableFlexKw: this.availableFlexKw,
      haPrefix: this.haPrefix,
      online:   this.online,
      lastSeen: this.lastSeen
    };
  }
}

// ===========================================================================
// MaloRegistry — manages MaLo nodes across 9 Cologne Stadtbezirke
// ===========================================================================
class MaloRegistry {
  constructor() {
    this.nodes = new Map();
    this.bezirkStats = new Map();
  }

  register(node) { this.nodes.set(node.id, node); return node; }
  remove(id)     { return this.nodes.delete(id); }
  get(id)        { return this.nodes.get(id); }
  getAll()       { return [...this.nodes.values()]; }
  getLocal()     { return this.getAll().filter(n => n.isLocal); }
  getPeers()     { return this.getAll().filter(n => n.isPeer); }
  getDemo()      { return this.getAll().filter(n => n.isDemo); }

  getByBezirk(bezirkName) {
    return this.getAll().filter(n => n.stadtbezirk === bezirkName);
  }

  static generateMaloId(index) {
    const base = 50662000000 + index;
    return String(base).slice(0, 11);
  }

  static generateMeloId(index) {
    const num = String(index).padStart(13, '0');
    return 'DE0004622030000000' + num + '00';
  }

  generateDemoNodes(count = 20) {
    const battTypes = ['BYD HVS', 'Pylontech US5000', 'Sonnen eco 10', 'E3/DC S10',
                       'SENEC V3', 'Anker Solix', 'Zendure Hyper', 'Tesla Powerwall'];
    const caps = [5000, 7500, 10000, 13500, 15000];
    const prosumerTypes = ['prosumer', 'prosumer', 'prosumer', 'consumer', 'producer'];

    for (let i = 0; i < count; i++) {
      const bezirk = KOELN_BEZIRKE[i % 9];
      const spread = 0.025;
      const capWh  = caps[Math.floor(Math.random() * caps.length)];
      const hasSolar = Math.random() > 0.15;
      const peakW  = [2000, 3000, 5000, 7000, 10000][Math.floor(Math.random() * 5)];
      const lat    = bezirk.lat + (Math.random() - 0.5) * spread * 2;
      const lon    = bezirk.lon + (Math.random() - 0.5) * spread * 2;
      const maloId = MaloRegistry.generateMaloId(i + 1);
      const meloId = MaloRegistry.generateMeloId(i + 1);

      this.register(new MaloNode({
        id:          'demo_' + (i + 1),
        maloId, meloId,
        name:        bezirk.name + ' Demo-' + (i + 1),
        lat, lon,
        stadtbezirk: bezirk.name,
        address:     bezirk.name + ', ' + bezirk.plzPrefix + '00 Köln',
        prosumerType: prosumerTypes[Math.floor(Math.random() * prosumerTypes.length)],
        smgCert:     meloId,
        isDemo:      true,
        battery:     { soc: Math.random() * 80 + 10, capacityWh: capWh,
                       type: battTypes[Math.floor(Math.random() * battTypes.length)] },
        solar:       { hasSolar, powerW: 0, peakW },
        pvConfig:    hasSolar ? { tilt: 15 + Math.random() * 30,
                                  azimuth: 140 + Math.random() * 80,
                                  peakWp: peakW, pr: 0.72 + Math.random() * 0.08 } : null
      }));
    }
  }

  updateDemoStates() {
    const now = new Date();
    for (const node of this.nodes.values()) {
      if (!node.isDemo) continue;

      if (node.solar.hasSolar) {
        if (node.pvSim) {
          const cloud = 0.4 + Math.random() * 0.6;
          node.solar.powerW = Math.round(node.pvSim.currentPower(now) * cloud);
        } else {
          const h = now.getHours() + now.getMinutes() / 60;
          const solarFactor = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
          const cloud = 0.4 + Math.random() * 0.6;
          node.solar.powerW = Math.round(solarFactor * node.solar.peakW * cloud);
        }
      }

      const surplus = node.surplusW;
      if (surplus > 50) {
        node.battery.soc        = Math.min(100, node.battery.soc + 0.3);
        node.battery.charging   = true;
        node.battery.discharging = false;
        node.battery.powerW     = surplus;
      } else if (node.battery.soc > 15) {
        node.battery.soc        = Math.max(5, node.battery.soc - 0.15);
        node.battery.charging   = false;
        node.battery.discharging = true;
        node.battery.powerW     = -(100 + Math.random() * 300);
      }

      node.consumption = Math.round(200 + Math.random() * 800 + (now.getHours() >= 17 && now.getHours() <= 21 ? 400 : 0));
      node.lastSeen = new Date();
    }
  }

  refreshAllFlexSpaces() {
    for (const node of this.nodes.values()) {
      node.generateFlexSpace();
    }
  }

  getBezirkSummary() {
    const summary = {};
    for (const b of KOELN_BEZIRKE) {
      const nodes = this.getByBezirk(b.name);
      summary[b.name] = {
        count:         nodes.length,
        online:        nodes.filter(n => n.online).length,
        totalSolarW:   Math.round(nodes.reduce((s, n) => s + (n.solar.powerW || 0), 0)),
        totalFlexKw:   +nodes.reduce((s, n) => s + n.availableFlexKw, 0).toFixed(1),
        avgSoc:        nodes.length > 0 ? +(nodes.reduce((s, n) => s + n.battery.soc, 0) / nodes.length).toFixed(1) : 0,
        canOffer:      nodes.filter(n => n.canOffer).length,
        needsDemand:   nodes.filter(n => n.needsDemand).length,
        color:         b.color,
        lat:           b.lat,
        lon:           b.lon
      };
    }
    return summary;
  }

  summary() {
    const all = this.getAll();
    return {
      total:          all.length,
      online:         all.filter(n => n.online).length,
      withSolar:      all.filter(n => n.solar.hasSolar).length,
      totalSolarW:    Math.round(all.reduce((s, n) => s + (n.solar.powerW || 0), 0)),
      totalSurplusW:  Math.round(all.reduce((s, n) => s + n.surplusW, 0)),
      totalFlexKw:    +all.reduce((s, n) => s + n.availableFlexKw, 0).toFixed(1),
      totalCapacityKwh: +(all.reduce((s, n) => s + n.battery.capacityWh, 0) / 1000).toFixed(0),
      avgSoc:         all.length > 0 ? +(all.reduce((s, n) => s + n.battery.soc, 0) / all.length).toFixed(1) : 0,
      canOffer:       all.filter(n => n.canOffer).length,
      needsDemand:    all.filter(n => n.needsDemand).length,
      bezirke:        9,
      consumption:    Math.round(all.reduce((s, n) => s + n.consumption, 0))
    };
  }
}

// ===========================================================================
// EnergyChartsAPI — Day-ahead + intraday prices (api.energy-charts.info)
// ===========================================================================
class EnergyChartsAPI {
  constructor() {
    this._cache     = null;
    this._cacheTime = 0;
    this._ttlMs     = 15 * 60_000;
  }

  async fetchDayAhead(date = new Date()) {
    if (this._cache && Date.now() - this._cacheTime < this._ttlMs) {
      return this._cache;
    }
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end   = new Date(start.getTime() + 2 * 86_400_000);
    const fmt   = d => d.toISOString().slice(0, 10);
    const url   = 'https://api.energy-charts.info/price?bzn=DE-LU&start=' + fmt(start) + '&end=' + fmt(end);
    try {
      const { default: fetch } = await import('node-fetch');
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!Array.isArray(data.unix_seconds) || !Array.isArray(data.price)) {
        throw new Error('Unexpected response format');
      }
      const prices = data.unix_seconds
        .map((ts, i) => ({
          time:    new Date(ts * 1000),
          endTime: new Date((ts + 3600) * 1000),
          price:   (data.price[i] ?? 0) / 1000
        }))
        .filter(p => !isNaN(p.price));
      this._cache     = prices;
      this._cacheTime = Date.now();
      return prices;
    } catch (err) {
      console.log('[EnergyCharts] ' + err.message.slice(0, 80));
      return null;
    }
  }

  invalidate() { this._cache = null; }
}

// ===========================================================================
// SmgwClient — BSI TR-03109 IF-1 HAN client (reads meter values from a
// Smart Meter Gateway reachable inside the Home Area Network).
// Supports https (REST-style polling) as a pragmatic first-pass transport.
// Real COSEM/DLMS negotiation is handled externally (e.g. by an HA add-on
// that exposes the SMGw as HA sensors) — this client is the direct path
// for setups where the SMGw itself offers an HTTP(S) endpoint.
// ===========================================================================
class SmgwClient {
  constructor({ host, port = 443, protocol = 'https', username = '', password = '' }) {
    this.host     = host;
    this.port     = port;
    this.protocol = protocol;
    this.username = username;
    this.password = password;
    this.lastRead = null;
    this.lastError = null;
  }

  get baseUrl() {
    return this.protocol + '://' + this.host + ':' + this.port;
  }

  _authHeader() {
    if (!this.username) return {};
    const token = Buffer.from(this.username + ':' + this.password).toString('base64');
    return { Authorization: 'Basic ' + token };
  }

  async readMeter(obisEndpoint = '/smgw/meter/current') {
    if (!this.host) return null;
    try {
      const { default: fetch } = await import('node-fetch');
      const res = await fetch(this.baseUrl + obisEndpoint, {
        headers: { 'Accept': 'application/json', ...this._authHeader() },
        signal:  AbortSignal.timeout(5000)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      this.lastRead = {
        timestamp: new Date().toISOString(),
        activePowerW:   data.activePowerW   ?? data.power    ?? null,
        importKwh:      data.importKwh      ?? data.import   ?? null,
        exportKwh:      data.exportKwh      ?? data.export   ?? null,
        raw: data
      };
      this.lastError = null;
      return this.lastRead;
    } catch (err) {
      this.lastError = err.message.slice(0, 120);
      return null;
    }
  }

  toJSON() {
    return {
      host:      this.host,
      port:      this.port,
      protocol:  this.protocol,
      configured: !!this.host,
      lastRead:  this.lastRead,
      lastError: this.lastError
    };
  }
}

// ===========================================================================
// ECDSAKeyring
// ===========================================================================
class ECDSAKeyring {
  constructor(privateKey) {
    this.wallet = privateKey ? new Wallet(privateKey) : Wallet.createRandom();
  }
  getAddress()           { return this.wallet.address; }
  getPrivateKey()        { return this.wallet.privateKey; }
  getMnemonic()          { return this.wallet.mnemonic?.phrase || null; }
  async signMessage(msg) { return this.wallet.signMessage(msg); }
}

// ===========================================================================
// PeaqChain
// ===========================================================================
class PeaqChain {
  constructor(networkUrl, wallet) {
    this.networkUrl = networkUrl;
    this.wallet     = wallet;
    this.sdk        = null;
    this.connected  = false;
    this.demoMode   = false;
  }

  async connect() {
    try {
      const { Sdk } = await import('@peaq-network/sdk');
      const seed    = this.wallet.getMnemonic() || this.wallet.getPrivateKey();
      this.sdk      = await Sdk.createInstance({ baseUrl: this.networkUrl, seed });
      this.connected = true;
      this.demoMode  = false;
      console.log('[CHAIN] Connected to ' + this.networkUrl);
      return true;
    } catch (err) {
      console.log('[CHAIN] SDK unavailable (' + err.message.slice(0, 80) + ') — demo mode');
      this.demoMode  = true;
      this.connected = true;
      return false;
    }
  }

  async createDID(name, metadata = {}) {
    const address = this.wallet.getAddress();
    if (!this.sdk) return 'did:peaq:' + address.toLowerCase();
    try {
      await this.sdk.did.create({
        name, address,
        customDocumentFields: {
          serviceEndpoint: 'http://localhost:8099',
          deviceType: 'TheElectronChain_Hub',
          ...metadata
        }
      });
    } catch {
      try { await this.sdk.did.read({ name, address }); } catch {}
    }
    return 'did:peaq:' + address.toLowerCase();
  }

  async storeData(itemType, value) {
    if (!this.sdk) return null;
    try {
      const seed = this.wallet.getMnemonic() || this.wallet.getPrivateKey();
      const item = typeof value === 'string' ? value : JSON.stringify(value);
      await this.sdk.storage.updateItem({
        item: { itemType, item },
        address: this.wallet.getAddress(),
        seed
      });
      return true;
    } catch (err) {
      console.log('[CHAIN] storeData(' + itemType + '): ' + err.message.slice(0, 60));
      return null;
    }
  }

  async readData(itemType, address) {
    if (!this.sdk) return null;
    try {
      const result = await this.sdk.storage.getItem({
        itemType,
        address: address || this.wallet.getAddress()
      });
      if (!result) return null;
      try { return JSON.parse(result); } catch { return result; }
    } catch { return null; }
  }

  async disconnect() {
    try { if (this.sdk?.disconnect) await this.sdk.disconnect(); } catch {}
  }
}

// ===========================================================================
// FlexBid — Redispatch 3.0 Gebot (kurzfristiges Arbeitsangebot)
// Datenmodell nach TransnetBW/E-Bridge "Redispatch 3.0: Zielmodell"
// ===========================================================================
class FlexBid {
  constructor({ maloId, meloId, did, slotStart, direction, powerKw, priceEurKwh,
                source = 'battery', flexSpaceRef = null, priority = 5,
                poolId = null, clusterId = null, sensitivitaet = 1.0 }) {
    this.gebotId      = 'gbt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    // Legacy alias
    this.bidId        = this.gebotId;
    this.gebotTyp     = 'kurzfristig';
    this.maloId       = maloId;
    this.meloId       = meloId;
    this.did          = did;
    this.poolId       = poolId || ('pool_' + maloId);
    this.clusterId    = clusterId;

    // Fahrplan-Slot (Viertelstundenbasis)
    this.slotStart    = slotStart;
    this.slotEnd      = new Date(new Date(slotStart).getTime() + 900_000).toISOString();

    // RDV — Redispatch-Vermögen
    this.direction    = direction;
    this.rdvKw        = powerKw;
    this.powerKw      = powerKw;
    this.energyKwh    = +(powerKw * 0.25).toFixed(4);

    // Angebotspreis (pay-as-bid)
    this.angebotspreis = priceEurKwh;
    this.priceEurKwh  = priceEurKwh;

    // Netzwirksamkeit
    this.sensitivitaet = sensitivitaet;
    this.netzwirksamerBeitragKw = +(powerKw * sensitivitaet).toFixed(2);

    this.source       = source;
    this.flexSpaceRef = flexSpaceRef;
    this.priority     = Math.max(1, Math.min(10, Math.round(priority)));

    // Status-Lifecycle: offen → bezuschlagt → abgerufen → ausgefuehrt → abgerechnet
    this.status       = 'pending';
    this.createdAt    = new Date().toISOString();
    this.clearingPrice = null;
    this.matchedWith  = null;

    // Fahrplan (Planwertmodell)
    this.fahrplan     = {
      slotStart:    this.slotStart,
      slotEnd:      this.slotEnd,
      planwertKw:   powerKw,
      istwertKw:    null,
      abweichungKw: null
    };
  }

  toRedispatchGebot() {
    return {
      gebotId:         this.gebotId,
      gebotTyp:        this.gebotTyp,
      maloId:          this.maloId,
      meloId:          this.meloId,
      poolId:          this.poolId,
      clusterId:       this.clusterId,
      did:             this.did,
      slotStart:       this.slotStart,
      slotEnd:         this.slotEnd,
      direction:       this.direction,
      rdvKw:           this.rdvKw,
      energyKwh:       this.energyKwh,
      angebotspreis:   this.angebotspreis,
      sensitivitaet:   this.sensitivitaet,
      netzwirksamerBeitragKw: this.netzwirksamerBeitragKw,
      source:          this.source,
      status:          this.status,
      fahrplan:        this.fahrplan,
      createdAt:       this.createdAt
    };
  }

  toJSON() {
    return this.toRedispatchGebot();
  }
}

// ===========================================================================
// ClearingMatcher — Redispatch 3.0 Merit-Order-Liste (MOL)
// Gemeinsame MOL aus kosten- und marktbasierten Geboten, pay-as-bid
// ===========================================================================
class ClearingMatcher {
  constructor() {
    this.clearingHistory = [];
  }

  buildMeritOrderListe(bids) {
    const offers = bids.filter(b => b.direction === 'offer' && b.status === 'pending')
      .sort((a, b) => a.angebotspreis - b.angebotspreis || b.priority - a.priority);
    const demands = bids.filter(b => b.direction === 'demand' && b.status === 'pending')
      .sort((a, b) => b.angebotspreis - a.angebotspreis || b.priority - a.priority);

    return {
      offers: offers.map((b, rang) => ({
        rang: rang + 1,
        gebotId: b.gebotId,
        maloId: b.maloId,
        poolId: b.poolId,
        rdvKw: b.rdvKw,
        energyKwh: b.energyKwh,
        angebotspreis: b.angebotspreis,
        sensitivitaet: b.sensitivitaet,
        netzwirksamerBeitragKw: b.netzwirksamerBeitragKw,
        source: b.source,
        bid: b
      })),
      demands: demands.map((b, rang) => ({
        rang: rang + 1,
        gebotId: b.gebotId,
        maloId: b.maloId,
        poolId: b.poolId,
        rdvKw: b.rdvKw,
        energyKwh: b.energyKwh,
        angebotspreis: b.angebotspreis,
        sensitivitaet: b.sensitivitaet,
        netzwirksamerBeitragKw: b.netzwirksamerBeitragKw,
        source: b.source,
        bid: b
      }))
    };
  }

  clearSlot(bids, slotStart) {
    const mol = this.buildMeritOrderListe(bids);

    if (mol.offers.length === 0 || mol.demands.length === 0) {
      return { slotStart, clearingPrice: null, meritOrderListe: mol, matchedPairs: [],
        unmatchedOffers: mol.offers.length, unmatchedDemands: mol.demands.length,
        totalVolumeKwh: 0, verfahren: 'pay_as_bid' };
    }

    let clearingPrice = null;
    let si = 0, di = 0;
    let matchedSupply = 0, matchedDemand = 0;

    while (si < mol.offers.length && di < mol.demands.length) {
      const offer = mol.offers[si];
      const demand = mol.demands[di];

      if (offer.angebotspreis <= demand.angebotspreis) {
        clearingPrice = offer.angebotspreis;
        matchedSupply += offer.energyKwh;
        matchedDemand += demand.energyKwh;
        if (matchedSupply <= matchedDemand) si++;
        if (matchedDemand <= matchedSupply) di++;
      } else {
        break;
      }
    }

    if (clearingPrice === null) {
      return { slotStart, clearingPrice: null, meritOrderListe: mol, matchedPairs: [],
        unmatchedOffers: mol.offers.length, unmatchedDemands: mol.demands.length,
        totalVolumeKwh: 0, verfahren: 'pay_as_bid' };
    }

    const matchedPairs = [];
    const usedDemands = new Set();

    for (const o of mol.offers) {
      if (o.angebotspreis > clearingPrice) continue;
      for (const d of mol.demands) {
        if (usedDemands.has(d.gebotId)) continue;
        if (d.angebotspreis < clearingPrice) continue;
        if (o.maloId === d.maloId) continue;

        const volumeKwh = Math.min(o.energyKwh, d.energyKwh);
        // Pay-as-bid: jedes Gebot wird zum eigenen Angebotspreis vergütet
        const abrufpreisOffer = o.angebotspreis;
        const abrufpreisDemand = d.angebotspreis;
        const midPrice = +((abrufpreisOffer + abrufpreisDemand) / 2).toFixed(4);

        matchedPairs.push({
          // RD3.0 Abruf-Struktur
          abrufId:       'abruf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 4),
          offerGebotId:  o.gebotId,
          demandGebotId: d.gebotId,
          offerBid:      o.gebotId,
          demandBid:     d.gebotId,
          offerMalo:     o.maloId,
          demandMalo:    d.maloId,
          offerPool:     o.poolId,
          demandPool:    d.poolId,
          abrufLeistungKw: +(volumeKwh * 4).toFixed(2),
          volumeKwh:     +volumeKwh.toFixed(4),
          abrufpreisOffer: abrufpreisOffer,
          abrufpreisDemand: abrufpreisDemand,
          clearingPrice: midPrice,
          totalEur:      +(volumeKwh * midPrice).toFixed(4),
          verguetungOffer: +(volumeKwh * abrufpreisOffer).toFixed(4),
          verguetungDemand: +(volumeKwh * abrufpreisDemand).toFixed(4),
          verfahren:     'pay_as_bid'
        });

        o.bid.status = 'matched';
        o.bid.clearingPrice = abrufpreisOffer;
        o.bid.matchedWith = d.gebotId;
        o.bid.fahrplan.istwertKw = o.bid.fahrplan.planwertKw;
        o.bid.fahrplan.abweichungKw = 0;

        d.bid.status = 'matched';
        d.bid.clearingPrice = abrufpreisDemand;
        d.bid.matchedWith = o.gebotId;
        d.bid.fahrplan.istwertKw = d.bid.fahrplan.planwertKw;
        d.bid.fahrplan.abweichungKw = 0;

        usedDemands.add(d.gebotId);
        break;
      }
    }

    const result = {
      slotStart,
      slotEnd: new Date(new Date(slotStart).getTime() + 900_000).toISOString(),
      verfahren: 'pay_as_bid',
      clearingPrice: +clearingPrice.toFixed(4),
      meritOrderListe: { offerCount: mol.offers.length, demandCount: mol.demands.length },
      matchedPairs,
      unmatchedOffers: mol.offers.filter(o => o.bid.status === 'pending').length,
      unmatchedDemands: mol.demands.filter(d => d.bid.status === 'pending').length,
      totalVolumeKwh: +matchedPairs.reduce((s, p) => s + p.volumeKwh, 0).toFixed(4),
      totalEur: +matchedPairs.reduce((s, p) => s + p.totalEur, 0).toFixed(4),
      timestamp: new Date().toISOString()
    };

    this.clearingHistory.unshift(result);
    if (this.clearingHistory.length > 96) this.clearingHistory.pop();
    return result;
  }

  getHistory(n = 24) {
    return this.clearingHistory.slice(0, n);
  }
}

// ===========================================================================
// SlotScheduler — 15-minute slot management
// ===========================================================================
class SlotScheduler {
  constructor() {
    this.currentSlot   = null;
    this.nextSlot      = null;
    this.slotBids      = new Map();
    this.activeSlotKey = null;
  }

  static slotKey(date) {
    const d = new Date(date);
    d.setSeconds(0, 0);
    d.setMinutes(Math.floor(d.getMinutes() / 15) * 15);
    return d.toISOString();
  }

  static nextSlotStart(date = new Date()) {
    const d = new Date(date);
    d.setSeconds(0, 0);
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15);
    if (d <= date) d.setMinutes(d.getMinutes() + 15);
    return d;
  }

  static slotLabel(isoStr) {
    const d = new Date(isoStr);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  getCurrentSlotKey() {
    return SlotScheduler.slotKey(new Date());
  }

  getNextSlotKey() {
    return SlotScheduler.nextSlotStart().toISOString();
  }

  addBid(bid) {
    const key = bid.slotStart;
    if (!this.slotBids.has(key)) this.slotBids.set(key, []);
    this.slotBids.get(key).push(bid);
    return bid;
  }

  getBidsForSlot(slotKey) {
    return this.slotBids.get(slotKey) || [];
  }

  cleanOldSlots() {
    const cutoff = new Date(Date.now() - 3_600_000).toISOString();
    for (const [key] of this.slotBids) {
      if (key < cutoff) this.slotBids.delete(key);
    }
  }
}

// ===========================================================================
// Rd30Adapter — Redispatch 3.0 Datenmodell (RDV, Abruf, Abrechnung)
// (TransnetBW/E-Bridge "Redispatch 3.0: Zielmodell" + OctoFlexBW/DataFlex)
// Kurzfristige Arbeitsangebote, Pool-Aggregation, Planwertmodell
// ===========================================================================
class Rd30Adapter {

  static _uuid() {
    return crypto.randomUUID();
  }

  // RDV-Meldung (Redispatch-Vermögen) für eine MaLo
  static createRdvMeldung(maloNode) {
    const fs = maloNode.generateFlexSpace();
    const flexKw = maloNode.availableFlexKw;

    return {
      meldungId:    Rd30Adapter._uuid(),
      typ:          'RDV_MELDUNG',
      maloId:       maloNode.maloId,
      meloId:       maloNode.meloId,
      poolId:       'pool_' + maloNode.maloId,
      did:          maloNode.did,
      slotStart:    fs.validity.start,
      slotEnd:      fs.validity.end,
      rdvPositivKw: maloNode.canOffer ? +flexKw.toFixed(2) : 0,
      rdvNegativKw: maloNode.needsDemand ? +flexKw.toFixed(2) : 0,
      fahrplan: {
        slotStart: fs.validity.start,
        slotEnd:   fs.validity.end,
        planwertKw: +flexKw.toFixed(2),
        source:     maloNode.solar.powerW > 200 ? 'pv' : 'battery'
      },
      speicher: maloNode.battery.capacityWh > 0 ? {
        typ:           maloNode.battery.type,
        kapazitaetKwh: +(maloNode.battery.capacityWh / 1000).toFixed(1),
        socProzent:    +maloNode.battery.soc.toFixed(1),
        maxLadeKw:     +(maloNode.battery.capacityWh / 2000).toFixed(1),
        maxEntladeKw:  +(maloNode.battery.capacityWh / 2000).toFixed(1)
      } : null,
      standort: {
        meterLocation: maloNode.meloId,
        lat: maloNode.lat,
        lon: maloNode.lon,
        spannungsebeneKv: 0.4
      },
      status:    'verfuegbar',
      createdAt: new Date().toISOString()
    };
  }

  // Aggregierte Pool-RDV-Meldung für Redispatch 3.0
  static createAggregatedRdvMeldung(maloNodes, slotStart, slotEnd) {
    const ressourcen = [];
    let totalRdvPositivKw = 0;
    let totalRdvNegativKw = 0;

    for (const node of maloNodes) {
      if (!node.online) continue;
      const flexKw = node.availableFlexKw;
      if (flexKw < 0.1) continue;

      const rdvPos = node.canOffer ? flexKw : 0;
      const rdvNeg = node.needsDemand ? flexKw : 0;
      totalRdvPositivKw += rdvPos;
      totalRdvNegativKw += rdvNeg;

      ressourcen.push({
        maloId:        node.maloId,
        meloId:        node.meloId,
        poolId:        'pool_' + node.maloId,
        did:           node.did,
        rdvPositivKw:  +rdvPos.toFixed(2),
        rdvNegativKw:  +rdvNeg.toFixed(2),
        source:        node.solar.powerW > 200 ? 'pv' : 'battery',
        socProzent:    +node.battery.soc.toFixed(1),
        sensitivitaet: 1.0
      });
    }

    return {
      meldungId:     Rd30Adapter._uuid(),
      typ:           'AGGREGIERTE_RDV_MELDUNG',
      aggregatorId:  'TheElectronChain',
      slotStart,
      slotEnd,
      aggregationsebene: 'pool',
      totalRdvPositivKw: +totalRdvPositivKw.toFixed(2),
      totalRdvNegativKw: +totalRdvNegativKw.toFixed(2),
      totalRdvNettoKw:   +(totalRdvPositivKw - totalRdvNegativKw).toFixed(2),
      ressourcenCount:   ressourcen.length,
      ressourcen,
      bilanzierungsmodell: 'planwert',
      createdAt:     new Date().toISOString()
    };
  }

  // RD3.0 Abruf (Call-off) für ein matched pair
  static createAbruf(matchedPair, clearing) {
    return {
      abrufId:          matchedPair.abrufId,
      typ:              'RD30_ABRUF',
      slotStart:        clearing.slotStart,
      slotEnd:          clearing.slotEnd || new Date(new Date(clearing.slotStart).getTime() + 900_000).toISOString(),
      offerGebot: {
        gebotId:        matchedPair.offerGebotId || matchedPair.offerBid,
        maloId:         matchedPair.offerMalo,
        poolId:         matchedPair.offerPool,
        abrufLeistungKw: matchedPair.abrufLeistungKw,
        angebotspreis:  matchedPair.abrufpreisOffer,
        verguetungEur:  matchedPair.verguetungOffer
      },
      demandGebot: {
        gebotId:        matchedPair.demandGebotId || matchedPair.demandBid,
        maloId:         matchedPair.demandMalo,
        poolId:         matchedPair.demandPool,
        abrufLeistungKw: matchedPair.abrufLeistungKw,
        angebotspreis:  matchedPair.abrufpreisDemand,
        kostenEur:      matchedPair.verguetungDemand
      },
      volumeKwh:        matchedPair.volumeKwh,
      verfahren:        matchedPair.verfahren || 'pay_as_bid',
      status:           'abgerufen',
      createdAt:        new Date().toISOString()
    };
  }

  // RD3.0 Abruf für zentrale Redispatch-Allokation
  static createRedispatchAbruf(allocatedBids, aggregated) {
    return {
      abrufId:     'rdabruf_' + Date.now(),
      typ:         'RD30_ZENTRALER_ABRUF',
      slotStart:   aggregated.slotStart,
      slotEnd:     aggregated.slotEnd,
      aggregationId: aggregated.id,
      redispatchPreis: aggregated.redispatchPrice,
      direction:   aggregated.direction,
      massnahmen:  allocatedBids.map(bid => ({
        gebotId:          bid.gebotId,
        maloId:           bid.maloId,
        poolId:           bid.poolId,
        abrufLeistungKw:  +bid.powerKw.toFixed(2),
        abrufEnergieKwh:  +(bid.powerKw * 0.25).toFixed(4),
        angebotspreis:    bid.angebotspreis,
        verguetungEur:    +(bid.powerKw * 0.25 * aggregated.redispatchPrice).toFixed(4),
        fahrplan: {
          planwertKw: +bid.powerKw.toFixed(2),
          istwertKw:  +bid.powerKw.toFixed(2),
          abweichungKw: 0
        }
      })),
      totalLeistungKw:  +allocatedBids.reduce((s, b) => s + b.powerKw, 0).toFixed(2),
      totalEnergieKwh:  +allocatedBids.reduce((s, b) => s + b.powerKw * 0.25, 0).toFixed(4),
      totalVerguetungEur: +allocatedBids.reduce((s, b) => s + b.powerKw * 0.25 * aggregated.redispatchPrice, 0).toFixed(4),
      status:      'abgerufen',
      createdAt:   new Date().toISOString()
    };
  }

  // RD3.0 Abrechnung (Settlement) im Planwertmodell
  static createAbrechnung(matchedPair, clearing) {
    return {
      abrechnungId:   'abr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 4),
      typ:            'RD30_ABRECHNUNG',
      abrufId:        matchedPair.abrufId,
      slotStart:      clearing.slotStart,
      slotEnd:        clearing.slotEnd || new Date(new Date(clearing.slotStart).getTime() + 900_000).toISOString(),
      bilanzierungsmodell: 'planwert',
      offer: {
        gebotId:      matchedPair.offerGebotId || matchedPair.offerBid,
        maloId:       matchedPair.offerMalo,
        planwertKw:   matchedPair.abrufLeistungKw,
        istwertKw:    matchedPair.abrufLeistungKw,
        ausfallarbeitKwh: matchedPair.volumeKwh,
        angebotspreis: matchedPair.abrufpreisOffer,
        verguetungEur: matchedPair.verguetungOffer,
        bilanzkreisAusgleich: 'erfolgt'
      },
      demand: {
        gebotId:      matchedPair.demandGebotId || matchedPair.demandBid,
        maloId:       matchedPair.demandMalo,
        planwertKw:   matchedPair.abrufLeistungKw,
        istwertKw:    matchedPair.abrufLeistungKw,
        ausfallarbeitKwh: matchedPair.volumeKwh,
        angebotspreis: matchedPair.abrufpreisDemand,
        kostenEur:    matchedPair.verguetungDemand,
        bilanzkreisAusgleich: 'erfolgt'
      },
      volumeKwh:     matchedPair.volumeKwh,
      verfahren:     'pay_as_bid',
      status:        'abgerechnet',
      createdAt:     new Date().toISOString()
    };
  }
}

// ===========================================================================
// SettlementEngine — Redispatch 3.0 Planwertmodell Settlement
// ===========================================================================
class SettlementEngine {
  constructor(chain) {
    this.chain = chain;
    this.settlements = [];
    this.totalSettledEur = 0;
    this.totalSettledKwh = 0;
  }

  async settleClearing(clearing) {
    if (!clearing || !clearing.matchedPairs || clearing.matchedPairs.length === 0) return null;

    const abrufe = clearing.matchedPairs.map(pair => Rd30Adapter.createAbruf(pair, clearing));
    const abrechnungen = clearing.matchedPairs.map(pair => Rd30Adapter.createAbrechnung(pair, clearing));

    const settlement = {
      id:            'stl_' + Date.now(),
      typ:           'RD30_SETTLEMENT',
      verfahren:     'pay_as_bid',
      bilanzierungsmodell: 'planwert',
      slotStart:     clearing.slotStart,
      slotEnd:       clearing.slotEnd,
      clearingPrice: clearing.clearingPrice,
      pairs:         clearing.matchedPairs.length,
      totalKwh:      clearing.totalVolumeKwh,
      totalEur:      +clearing.matchedPairs.reduce((s, p) => s + p.totalEur, 0).toFixed(4),
      abrufe,
      abrechnungen,
      meritOrderListe: clearing.meritOrderListe,
      timestamp:     new Date().toISOString(),
      onChain:       false,
      txHash:        null
    };

    const chainRecord = {
      type:           'RD30_SETTLEMENT',
      settlement_id:  settlement.id,
      slot:           clearing.slotStart,
      verfahren:      'pay_as_bid',
      clearing_price: clearing.clearingPrice,
      volume_kwh:     settlement.totalKwh,
      total_eur:      settlement.totalEur,
      abrufe,
      abrechnungen,
      timestamp:      settlement.timestamp
    };

    const stored = await this.chain?.storeData('settlement_' + settlement.id, chainRecord);
    if (stored) {
      settlement.onChain = true;
      settlement.txHash  = 'peaq:' + settlement.id;
    }

    this.settlements.unshift(settlement);
    if (this.settlements.length > 96) this.settlements.pop();
    this.totalSettledEur += settlement.totalEur;
    this.totalSettledKwh += settlement.totalKwh;

    return settlement;
  }

  getHistory(n = 24) {
    return this.settlements.slice(0, n);
  }

  getSummary() {
    return {
      totalSettlements: this.settlements.length,
      totalSettledEur:  +this.totalSettledEur.toFixed(4),
      totalSettledKwh:  +this.totalSettledKwh.toFixed(4),
      avgClearingPrice: this.settlements.length > 0
        ? +(this.settlements.reduce((s, st) => s + (st.clearingPrice || 0), 0) / this.settlements.length).toFixed(4)
        : 0,
      lastSettlement:   this.settlements[0] || null
    };
  }
}

// ===========================================================================
// RedispatchAggregator — Aggregated flex offering for Redispatch 3.0
// ===========================================================================
class RedispatchAggregator {
  constructor(gatewayUrl = null) {
    this.gatewayUrl = gatewayUrl;
    this.aggregatedOffers = new Map();
    this.redispatchResults = [];
    this.callbackTimeout = 120_000;
  }

  aggregateSlot(bids, slotStart, maloNodes = [], bezirkSummary = {}) {
    const offers = bids.filter(b => b.direction === 'offer' && b.status === 'pending');
    const demands = bids.filter(b => b.direction === 'demand' && b.status === 'pending');

    const totalOfferKw = offers.reduce((s, b) => s + b.powerKw, 0);
    const totalDemandKw = demands.reduce((s, b) => s + b.powerKw, 0);
    const netFlexKw = totalOfferKw - totalDemandKw;

    const avgOfferPrice = offers.length > 0
      ? offers.reduce((s, b) => s + b.priceEurKwh, 0) / offers.length : 0;

    const slotEnd = new Date(new Date(slotStart).getTime() + 900_000).toISOString();

    const participatingMaloIds = [...new Set(offers.map(b => b.maloId))];
    const participatingNodes = maloNodes.filter(n => participatingMaloIds.includes(n.maloId));
    const rdvMeldung = participatingNodes.length > 0
      ? Rd30Adapter.createAggregatedRdvMeldung(participatingNodes, slotStart, slotEnd)
      : null;

    const aggregated = {
      id: 'rdagg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      slotStart,
      slotEnd,
      totalOfferKw: +totalOfferKw.toFixed(2),
      totalDemandKw: +totalDemandKw.toFixed(2),
      netFlexKw: +netFlexKw.toFixed(2),
      netFlexKwh: +(netFlexKw * 0.25).toFixed(4),
      avgPriceEurKwh: +avgOfferPrice.toFixed(4),
      offerCount: offers.length,
      demandCount: demands.length,
      maloIds: participatingMaloIds,
      bezirkSummary,
      direction: netFlexKw >= 0 ? 'feedIn' : 'consumption',
      status: 'pending',
      submittedAt: null,
      redispatchCalled: false,
      redispatchVolume: 0,
      redispatchPrice: null,
      callbackReceived: false,
      rdvMeldung,
      abruf: null,
      createdAt: new Date().toISOString()
    };

    this.aggregatedOffers.set(slotStart, aggregated);
    this.cleanOld();
    return aggregated;
  }

  async submitToGateway(aggregated) {
    aggregated.submittedAt = new Date().toISOString();

    if (!this.gatewayUrl) {
      aggregated.status = 'simulated';
      const called = Math.random() < 0.15;
      aggregated.redispatchCalled = called;
      if (called) {
        aggregated.redispatchVolume = +(aggregated.netFlexKw * (0.3 + Math.random() * 0.5)).toFixed(2);
        aggregated.redispatchPrice = +(aggregated.avgPriceEurKwh * (1.1 + Math.random() * 0.3)).toFixed(4);
      }
      aggregated.callbackReceived = true;
      return aggregated;
    }

    try {
      const payload = {
        type: 'FLEX_AGGREGATION_OFFER',
        slotStart: aggregated.slotStart,
        slotEnd: aggregated.slotEnd,
        direction: aggregated.direction,
        netFlexKw: aggregated.netFlexKw,
        netFlexKwh: aggregated.netFlexKwh,
        priceEurKwh: aggregated.avgPriceEurKwh,
        maloCount: aggregated.maloIds.length,
        aggregatorId: aggregated.id,
        rdvMeldung: aggregated.rdvMeldung,
        timestamp: new Date().toISOString()
      };

      const resp = await fetch(this.gatewayUrl + '/api/v1/flex/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000)
      });

      if (resp.ok) {
        const result = await resp.json();
        aggregated.status = 'submitted';
        aggregated.gatewayRef = result.referenceId || null;
      } else {
        aggregated.status = 'gateway_error';
      }
    } catch (err) {
      aggregated.status = 'gateway_unreachable';
    }

    return aggregated;
  }

  async waitForCallback(slotStart) {
    const aggregated = this.aggregatedOffers.get(slotStart);
    if (!aggregated) return null;
    if (aggregated.callbackReceived) return aggregated;

    if (this.gatewayUrl && aggregated.gatewayRef) {
      try {
        const resp = await fetch(
          this.gatewayUrl + '/api/v1/flex/status/' + aggregated.gatewayRef,
          { signal: AbortSignal.timeout(10_000) }
        );
        if (resp.ok) {
          const result = await resp.json();
          aggregated.redispatchCalled = result.called === true;
          aggregated.redispatchVolume = result.volumeKw || 0;
          aggregated.redispatchPrice = result.priceEurKwh || null;
          aggregated.callbackReceived = true;
        }
      } catch {}
    }

    if (!aggregated.callbackReceived) {
      aggregated.callbackReceived = true;
      aggregated.redispatchCalled = false;
    }

    return aggregated;
  }

  getResidualBids(bids, aggregated) {
    if (!aggregated.redispatchCalled) return bids;

    let remainingRedispatchKw = aggregated.redispatchVolume;
    const offers = bids.filter(b => b.direction === 'offer' && b.status === 'pending')
      .sort((a, b) => a.priceEurKwh - b.priceEurKwh);

    for (const offer of offers) {
      if (remainingRedispatchKw <= 0) break;
      if (offer.powerKw <= remainingRedispatchKw) {
        offer.status = 'redispatch_allocated';
        offer.clearingPrice = aggregated.redispatchPrice;
        remainingRedispatchKw -= offer.powerKw;
      } else {
        const originalPower = offer.powerKw;
        offer.powerKw = +(originalPower - remainingRedispatchKw).toFixed(2);
        offer.energyKwh = +(offer.powerKw * 0.25).toFixed(4);

        const rdBid = new FlexBid({
          maloId: offer.maloId, meloId: offer.meloId, did: offer.did,
          slotStart: offer.slotStart, direction: 'offer',
          powerKw: +remainingRedispatchKw.toFixed(2),
          priceEurKwh: aggregated.redispatchPrice,
          source: offer.source, flexSpaceRef: offer.flexSpaceRef, priority: offer.priority
        });
        rdBid.status = 'redispatch_allocated';
        rdBid.clearingPrice = aggregated.redispatchPrice;
        bids.push(rdBid);

        remainingRedispatchKw = 0;
      }
    }

    return bids.filter(b => b.status === 'pending');
  }

  createRedispatchSettlement(aggregated, allocatedBids) {
    if (!aggregated.redispatchCalled || allocatedBids.length === 0) return null;

    const abruf = Rd30Adapter.createRedispatchAbruf(allocatedBids, aggregated);
    aggregated.abruf = abruf;

    return {
      id: 'rdstl_' + Date.now(),
      typ: 'RD30_SETTLEMENT',
      verfahren: 'pay_as_bid',
      bilanzierungsmodell: 'planwert',
      slotStart: aggregated.slotStart,
      slotEnd: aggregated.slotEnd,
      aggregationId: aggregated.id,
      direction: aggregated.direction,
      abruf,
      totalLeistungKw: abruf.totalLeistungKw,
      totalEnergieKwh: abruf.totalEnergieKwh,
      totalVerguetungEur: abruf.totalVerguetungEur,
      redispatchPreis: aggregated.redispatchPrice,
      maloIds: [...new Set(allocatedBids.map(b => b.maloId))],
      gebotCount: allocatedBids.length,
      timestamp: new Date().toISOString()
    };
  }

  getForSlot(slotStart) {
    return this.aggregatedOffers.get(slotStart) || null;
  }

  getHistory(n = 24) {
    return [...this.aggregatedOffers.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, n);
  }

  cleanOld() {
    const cutoff = new Date(Date.now() - 7_200_000).toISOString();
    for (const [key, val] of this.aggregatedOffers) {
      if (val.createdAt < cutoff) this.aggregatedOffers.delete(key);
    }
  }
}

// ===========================================================================
// DynamicGridFee — AgNes BNetzA dynamic grid fees (15-min granularity)
// ===========================================================================
class DynamicGridFee {
  constructor() {
    this.baseGridFee   = 0.08;
    this.currentFee    = 0.08;
    this.feeSchedule   = [];
    this.agnesEnabled  = false;
  }

  enable() { this.agnesEnabled = true; }
  disable() { this.agnesEnabled = false; }

  generateSchedule(hours = 48) {
    const now = new Date();
    now.setMinutes(Math.floor(now.getMinutes() / 15) * 15, 0, 0);
    this.feeSchedule = [];

    for (let i = 0; i < hours * 4; i++) {
      const t = new Date(now.getTime() + i * 900_000);
      const h = t.getHours();
      const isWeekend = [0, 6].includes(t.getDay());

      let fee = this.baseGridFee;
      if (!this.agnesEnabled) {
        this.feeSchedule.push({ time: t.toISOString(), fee, tier: 'flat' });
        continue;
      }

      let tier = 'normal';
      if (h >= 7 && h <= 9) {
        fee = this.baseGridFee * 1.5;
        tier = 'peak';
      } else if (h >= 11 && h <= 14) {
        fee = this.baseGridFee * 0.5;
        tier = 'solar_valley';
      } else if (h >= 17 && h <= 20) {
        fee = this.baseGridFee * 1.8;
        tier = 'evening_peak';
      } else if (h >= 0 && h <= 5) {
        fee = this.baseGridFee * 0.3;
        tier = 'off_peak';
      }

      if (isWeekend) fee *= 0.8;

      fee += (Math.random() - 0.5) * 0.005;
      fee = Math.max(0.01, Math.min(0.20, fee));

      this.feeSchedule.push({
        time: t.toISOString(),
        fee:  +fee.toFixed(4),
        tier
      });
    }

    if (this.feeSchedule.length > 0) {
      this.currentFee = this.feeSchedule[0].fee;
    }
    return this.feeSchedule;
  }

  getCurrentFee() {
    if (!this.agnesEnabled) return this.baseGridFee;
    const now = new Date().toISOString();
    const current = this.feeSchedule.find(s => s.time <= now) || this.feeSchedule[0];
    if (current) this.currentFee = current.fee;
    return this.currentFee;
  }

  getSchedule(n = 48) {
    return this.feeSchedule.slice(0, n * 4);
  }
}

// ===========================================================================
// Order (with priority + source) — legacy order book compatibility
// ===========================================================================
class Order {
  constructor({ type, nodeId, did, energyWh, pricePerKwh, priority = 5, source = 'manual', smgCertFingerprint = null, validForMinutes = 60, maloId = null }) {
    this.id                 = type[0].toLowerCase() + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    this.type               = type;
    this.nodeId             = nodeId;
    this.maloId             = maloId;
    this.did                = did;
    this.energyWh           = energyWh;
    this.pricePerKwh        = pricePerKwh;
    this.priority           = Math.max(1, Math.min(10, Math.round(priority)));
    this.source             = source;
    this.smgCertFingerprint = smgCertFingerprint;
    this.validUntil         = new Date(Date.now() + validForMinutes * 60_000).toISOString();
    this.status             = 'open';
    this.createdAt          = new Date().toISOString();
    this.matchedWith        = null;
    this.txHash             = null;
    this.clearingPrice      = null;
  }
}

// ===========================================================================
// OrderBook (priority-aware matching)
// ===========================================================================
class OrderBook {
  constructor() {
    this.orders = new Map();
  }

  add(order)  { this.orders.set(order.id, order); return order; }
  get(id)     { return this.orders.get(id); }

  cancel(id) {
    const o = this.orders.get(id);
    if (o && o.status === 'open') { o.status = 'cancelled'; return true; }
    return false;
  }

  expireOld() {
    const now = new Date();
    let n = 0;
    for (const o of this.orders.values()) {
      if (o.status === 'open' && new Date(o.validUntil) <= now) { o.status = 'expired'; n++; }
    }
    return n;
  }

  getOpen() {
    const now = new Date();
    return [...this.orders.values()].filter(
      o => o.status === 'open' && new Date(o.validUntil) > now
    );
  }

  getBuyOrders() {
    return this.getOpen().filter(o => o.type === 'BUY').sort((a, b) => {
      if (b.pricePerKwh !== a.pricePerKwh) return b.pricePerKwh - a.pricePerKwh;
      if (b.priority    !== a.priority)    return b.priority    - a.priority;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
  }

  getSellOrders() {
    return this.getOpen().filter(o => o.type === 'SELL').sort((a, b) => {
      if (a.pricePerKwh !== b.pricePerKwh) return a.pricePerKwh - b.pricePerKwh;
      if (b.priority    !== a.priority)    return b.priority    - a.priority;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
  }

  getAll() {
    return [...this.orders.values()]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  findMatches() {
    const buys     = this.getBuyOrders();
    const sells    = this.getSellOrders();
    const matches  = [];
    const usedBuy  = new Set();
    const usedSell = new Set();

    for (const buy of buys) {
      if (usedBuy.has(buy.id)) continue;
      for (const sell of sells) {
        if (usedSell.has(sell.id)) continue;
        if (sell.nodeId !== buy.nodeId && buy.pricePerKwh >= sell.pricePerKwh) {
          matches.push({
            buy, sell,
            clearingPrice:    +((buy.pricePerKwh + sell.pricePerKwh) / 2).toFixed(4),
            energyWh:         Math.min(buy.energyWh, sell.energyWh),
            combinedPriority: buy.priority + sell.priority
          });
          usedBuy.add(buy.id);
          usedSell.add(sell.id);
          break;
        }
      }
    }
    return matches.sort((a, b) => b.combinedPriority - a.combinedPriority);
  }

  summary() {
    const buys  = this.getBuyOrders();
    const sells = this.getSellOrders();
    return {
      openBuys:    buys.length,
      openSells:   sells.length,
      bestBid:     buys[0]?.pricePerKwh   ?? null,
      bestAsk:     sells[0]?.pricePerKwh  ?? null,
      spread:      (buys[0] && sells[0])
                     ? +(buys[0].pricePerKwh - sells[0].pricePerKwh).toFixed(4)
                     : null,
      totalOrders: this.orders.size
    };
  }
}

// ===========================================================================
// Main Application — TheElectronChain
// ===========================================================================
class TheElectronChain {
  constructor() {
    this.config        = null;
    this.machineWallet = null;
    this.did           = null;
    this.chain         = null;

    this.maloRegistry     = new MaloRegistry();
    this.localNode        = null;
    this.smgwClient       = null;
    this.discoveredPeers  = new Map();  // address -> meta
    this._discoveryTimer  = null;
    this.orderBook        = new OrderBook();
    this.p2pTrades        = [];
    this.activeEnergyFlow = null;

    this.clearingMatcher      = new ClearingMatcher();
    this.slotScheduler        = new SlotScheduler();
    this.settlementEngine     = null;
    this.redispatchAggregator = null;
    this.dynamicGridFee       = new DynamicGridFee();

    this.epexPrices    = [];
    this.pvForecast48h = [];
    this.energyCharts  = new EnergyChartsAPI();
    this.currentPrice  = 0;
    this.tradingPlan = {
      sellHours: [], buyHours: [],
      avgSellPrice: 0, avgBuyPrice: 0,
      sellTimes: [], buyTimes: [],
      lastOptimized: null
    };

    this.currentMode  = 'HOLD';
    this.trades       = [];
    this.earnings     = 0;
    this.sessionStart = new Date();

    this.hassApiUrl = 'http://supervisor/core/api';
    this.hassToken  = process.env.SUPERVISOR_TOKEN;
    this.wsClients  = new Set();
  }

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------
  async loadConfig() {
    try {
      const raw = await fs.readFile('/data/options.json', 'utf8');
      this.config = JSON.parse(raw);
    } catch {
      this.log('warning', 'No options.json — using env/defaults');
      this.config = {};
    }

    const c = this.config;
    this.config = {
      network_url:     process.env.NETWORK_URL   || c.network_url   || 'wss://wss-async.agung.peaq.network',
      network_type:    process.env.NETWORK_TYPE  || c.network_type  || 'agung',
      machine_name:    process.env.MACHINE_NAME  || c.machine_name  || 'TheElectronChain',
      update_interval: parseInt(process.env.UPDATE_INTERVAL) || c.update_interval || 300,
      log_level:       process.env.LOG_LEVEL     || c.log_level     || 'info',
      timezone:        process.env.TZ            || c.timezone      || 'Europe/Berlin',

      enable_trading:     (process.env.ENABLE_TRADING === 'true') || c.enable_trading !== false,
      min_sell_price:     parseFloat(process.env.MIN_SELL_PRICE)  || c.min_sell_price  || 0.25,
      max_buy_price:      parseFloat(process.env.MAX_BUY_PRICE)   || c.max_buy_price   || 0.22,
      min_buy_price:      parseFloat(process.env.MIN_BUY_PRICE)   || c.min_buy_price   || 0.02,
      battery_reserve:    parseInt(process.env.BATTERY_RESERVE)   || c.battery_reserve || 20,
      max_feedin_power:   parseInt(process.env.MAX_FEEDIN_POWER)  || c.max_feedin_power || 800,
      p2p_trade_amount_wh: c.p2p_trade_amount_wh || 100,

      agnes_enabled:         c.agnes_enabled !== false,
      community_flex_enabled: c.community_flex_enabled !== false,
      clearing_mode:         c.clearing_mode || 'pay_as_bid',
      min_flex_bid_kw:       c.min_flex_bid_kw || 0.1,
      settlement_penalty_pct: c.settlement_penalty_pct || 10,

      redispatch_enabled:    c.redispatch_enabled !== false,
      redispatch_gateway_url: c.redispatch_gateway_url || '',
      redispatch_min_flex_kw: c.redispatch_min_flex_kw || 1.0,

      // Local node (single MaLo per HA instance)
      node_name:       c.node_name       || 'My MaLo',
      node_lat:        c.node_lat        ?? 50.9333,
      node_lon:        c.node_lon        ?? 6.9500,
      node_malo_id:    c.node_malo_id    || '',
      node_melo_id:    c.node_melo_id    || '',
      node_smgw_id:    c.node_smgw_id    || '',
      node_address:    c.node_address    || '',
      node_pv_tilt:    c.node_pv_tilt    ?? 30,
      node_pv_azimuth: c.node_pv_azimuth ?? 180,
      node_pv_peak_wp: c.node_pv_peak_wp ?? 2000,

      // SMGw HAN (BSI TR-03109 IF-1)
      smgw_enabled:  c.smgw_enabled === true,
      smgw_host:     c.smgw_host     || '',
      smgw_port:     c.smgw_port     || 443,
      smgw_protocol: c.smgw_protocol || 'https',
      smgw_username: c.smgw_username || '',
      smgw_password: c.smgw_password || '',

      // Optional device sensors
      anker_battery_sensor:  c.anker_battery_sensor  || '',
      anker_power_sensor:    c.anker_power_sensor    || '',
      anker_output_control:  c.anker_output_control  || '',
      anker_ac_charging:     c.anker_ac_charging     || '',
      anker_device_id:       c.anker_device_id       || '',
      zendure_battery_sensor: c.zendure_battery_sensor || '',
      zendure_power_sensor:   c.zendure_power_sensor   || '',
      zendure_output_control: c.zendure_output_control || '',
      zendure_input_control:  c.zendure_input_control  || '',
      zendure_ac_mode:        c.zendure_ac_mode        || '',

      // Peer discovery
      discovery_seeds:    c.discovery_seeds    || '',
      discovery_interval: c.discovery_interval || 600,

      // Demo nodes (Köln fleet)
      demo_nodes_enabled: c.demo_nodes_enabled !== false,
      demo_nodes_count:   c.demo_nodes_count   ?? 20,

      epex_sensor:      c.epex_sensor      || 'sensor.epex_spot_data_total_price',
      machine_mnemonic: process.env.MACHINE_MNEMONIC || c.machine_mnemonic
    };

    process.env.TZ = this.config.timezone;
    if (this.config.agnes_enabled) this.dynamicGridFee.enable();
    this.log('info', 'Config: ' + this.config.machine_name + ' @ ' + this.config.network_type + ' | TZ=' + this.config.timezone + ' | AgNes=' + this.config.agnes_enabled);
    return true;
  }

  // -------------------------------------------------------------------------
  // Wallet
  // -------------------------------------------------------------------------
  async initializeMachineWallet() {
    const walletFile = '/data/machine_wallet.json';
    try {
      const saved = JSON.parse(await fs.readFile(walletFile, 'utf8'));
      this.machineWallet = new ECDSAKeyring(saved.privateKey);
      this.log('info', 'Wallet: ' + this.machineWallet.getAddress().slice(0, 10) + '...');
    } catch {
      if (this.config.machine_mnemonic) {
        try {
          const w = Wallet.fromPhrase(this.config.machine_mnemonic);
          this.machineWallet = new ECDSAKeyring(w.privateKey);
        } catch { this.machineWallet = new ECDSAKeyring(); }
      } else {
        this.machineWallet = new ECDSAKeyring();
      }
      await fs.writeFile(walletFile, JSON.stringify({
        address:    this.machineWallet.getAddress(),
        privateKey: this.machineWallet.getPrivateKey(),
        mnemonic:   this.machineWallet.getMnemonic(),
        created:    new Date().toISOString()
      }, null, 2));
      this.log('info',    'Wallet created: ' + this.machineWallet.getAddress());
      this.log('warning', 'Fund via faucet: https://faucet.' + this.config.network_type + '.peaq.network');
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Peaq Blockchain
  // -------------------------------------------------------------------------
  async connectToPeaq() {
    this.chain = new PeaqChain(this.config.network_url, this.machineWallet);
    await this.chain.connect();
    this.settlementEngine = new SettlementEngine(this.chain);
    this.redispatchAggregator = new RedispatchAggregator(
      this.config.redispatch_gateway_url || null
    );
    this.log('info', this.chain.demoMode
      ? 'Running in demo mode (no on-chain writes)'
      : 'Connected to Peaq ' + this.config.network_type
    );
    return true;
  }

  async registerMachineDID() {
    const didFile = '/data/machine_did.json';
    try {
      this.did = JSON.parse(await fs.readFile(didFile, 'utf8')).did;
      this.log('info', 'DID loaded: ' + this.did.slice(0, 28) + '...');
      return true;
    } catch {}

    this.did = await this.chain.createDID(this.config.machine_name, {
      node:     this.config.node_name,
      maloId:   this.config.node_malo_id,
      platform: 'TheElectronChain_v4'
    });

    await fs.writeFile(didFile, JSON.stringify({
      did:          this.did,
      address:      this.machineWallet.getAddress(),
      machine_name: this.config.machine_name,
      created:      new Date().toISOString()
    }, null, 2));

    this.log('info', 'DID registered: ' + this.did);
    return true;
  }

  // -------------------------------------------------------------------------
  // MaLo Registry Initialization
  // -------------------------------------------------------------------------
  async initializeNodes() {
    // SMGw HAN client (optional)
    if (this.config.smgw_enabled && this.config.smgw_host) {
      this.smgwClient = new SmgwClient({
        host:     this.config.smgw_host,
        port:     this.config.smgw_port,
        protocol: this.config.smgw_protocol,
        username: this.config.smgw_username,
        password: this.config.smgw_password
      });
      this.log('info', 'SMGw HAN: ' + this.smgwClient.baseUrl);
    }

    // Local MaLo node — exactly one per HA instance
    const hasAnker   = !!this.config.anker_battery_sensor;
    const hasZendure = !!this.config.zendure_battery_sensor;
    const deviceTag  = hasAnker ? 'Anker Solix' : hasZendure ? 'Zendure Hyper' : 'PV-only';
    const capacityWh = hasAnker ? 1600 : hasZendure ? 2000 : 5000;

    this.localNode = new MaloNode({
      id:          'local',
      maloId:      this.config.node_malo_id,
      meloId:      this.config.node_melo_id,
      smgwId:      this.config.node_smgw_id,
      name:        this.config.node_name,
      lat:         this.config.node_lat,
      lon:         this.config.node_lon,
      stadtbezirk: 'Local',
      address:     this.config.node_address || this.config.node_name,
      haPrefix:    hasAnker ? 'anker' : hasZendure ? 'zendure' : null,
      isLocal:     true,
      battery:     { capacityWh, type: deviceTag },
      solar:       { hasSolar: true, peakW: this.config.node_pv_peak_wp },
      smgCert:     this.config.node_smgw_id || this.config.node_melo_id || this.config.node_malo_id,
      pvConfig: {
        tilt:    this.config.node_pv_tilt,
        azimuth: this.config.node_pv_azimuth,
        peakWp:  this.config.node_pv_peak_wp,
        pr:      0.76
      }
    });
    this.localNode.did = this.did;
    this.maloRegistry.register(this.localNode);

    // Optional: populate Köln demo fleet for visualization / testing
    if (this.config.demo_nodes_enabled && this.config.demo_nodes_count > 0) {
      this.maloRegistry.generateDemoNodes(this.config.demo_nodes_count);
      this.log('info', 'Demo fleet: ' + this.config.demo_nodes_count + ' Köln nodes generated');
    }

    this.maloRegistry.refreshAllFlexSpaces();
    this.dynamicGridFee.generateSchedule(48);

    this.log('info', 'MaloRegistry: 1 local (' + deviceTag + ') + '
      + this.maloRegistry.getDemo().length + ' demo nodes');
  }

  // -------------------------------------------------------------------------
  // Peer Discovery — publish local node metadata to peaq storage and
  // read metadata from known seed addresses (1-hop gossip via knownPeers).
  // -------------------------------------------------------------------------
  async publishLocalNode() {
    if (!this.chain || this.chain.demoMode || !this.localNode) return;
    const rdv = Rd30Adapter.createRdvMeldung(this.localNode);
    const meta = {
      version:    2,
      did:        this.did,
      address:    this.machineWallet.getAddress(),
      name:       this.localNode.name,
      maloId:     this.localNode.maloId,
      meloId:     this.localNode.meloId,
      smgwId:     this.localNode.smgwId,
      lat:        this.localNode.lat,
      lon:        this.localNode.lon,
      addressStr: this.localNode.address,
      pvPeakW:    this.config.node_pv_peak_wp,
      rdvPositivKw: rdv.rdvPositivKw,
      rdvNegativKw: rdv.rdvNegativKw,
      socProzent:   +this.localNode.battery.soc.toFixed(1),
      knownPeers: [...this.discoveredPeers.keys()],
      publishedAt: new Date().toISOString()
    };
    const ok = await this.chain.storeData('tec_node_v2', meta);
    if (ok) this.log('debug', 'Published local node metadata to peaq storage');
  }

  async discoverPeers() {
    if (!this.chain) return;

    const seeds = String(this.config.discovery_seeds || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    if (seeds.length === 0) {
      this.log('debug', 'Discovery: no seeds configured');
      return;
    }

    const visited = new Set();
    const queue = [...seeds];

    while (queue.length > 0) {
      const addr = queue.shift();
      if (!addr || visited.has(addr.toLowerCase())) continue;
      visited.add(addr.toLowerCase());

      let meta = await this.chain.readData('tec_node_v2', addr);
      if (!meta || !meta.address) {
        meta = await this.chain.readData('tec_node_v1', addr);
      }
      if (!meta || !meta.address) continue;

      this.discoveredPeers.set(meta.address.toLowerCase(), meta);

      const existingId = 'peer_' + meta.address.slice(2, 10).toLowerCase();
      let node = this.maloRegistry.get(existingId);
      if (!node) {
        node = new MaloNode({
          id:          existingId,
          maloId:      meta.maloId || '',
          meloId:      meta.meloId || '',
          smgwId:      meta.smgwId || '',
          name:        meta.name || 'Peer',
          lat:         meta.lat ?? 51.0,
          lon:         meta.lon ?? 10.0,
          stadtbezirk: 'Peer',
          address:     meta.addressStr || '',
          isPeer:      true,
          peerAddress: meta.address,
          battery:     { capacityWh: 5000, type: 'remote' },
          solar:       { hasSolar: true, peakW: meta.pvPeakW || 2000 }
        });
        node.did = meta.did || null;
        this.maloRegistry.register(node);
      } else {
        node.lat = meta.lat ?? node.lat;
        node.lon = meta.lon ?? node.lon;
        node.lastSeen = new Date();
      }
      if (meta.socProzent !== undefined && node.battery) {
        node.battery.soc = meta.socProzent;
      }

      // 1-hop gossip: enqueue peers-of-peers
      if (Array.isArray(meta.knownPeers)) {
        for (const kp of meta.knownPeers) {
          if (!visited.has(String(kp).toLowerCase())) queue.push(kp);
        }
      }
    }

    this.log('info', 'Discovery: ' + this.discoveredPeers.size + ' peer nodes reachable');
  }

  startDiscoveryLoop() {
    if (this._discoveryTimer) clearInterval(this._discoveryTimer);
    const intervalMs = (this.config.discovery_interval || 600) * 1000;
    this._discoveryTimer = setInterval(async () => {
      try {
        await this.publishLocalNode();
        await this.discoverPeers();
      } catch (err) {
        this.log('debug', 'Discovery loop: ' + err.message.slice(0, 80));
      }
    }, intervalMs);
  }

  // -------------------------------------------------------------------------
  // HA API
  // -------------------------------------------------------------------------
  async hassApiCall(endpoint, method = 'GET', body = null) {
    const options = {
      method,
      headers: {
        'Authorization': 'Bearer ' + this.hassToken,
        'Content-Type':  'application/json'
      }
    };
    if (body) options.body = JSON.stringify(body);
    try {
      const { default: fetch } = await import('node-fetch');
      const res = await fetch(this.hassApiUrl + endpoint, options);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      this.log('debug', 'HA API (' + endpoint + '): ' + err.message);
      return null;
    }
  }

  async getEntityState(id)             { return this.hassApiCall('/states/' + id); }
  async callService(domain, svc, data) { return this.hassApiCall('/services/' + domain + '/' + svc, 'POST', data); }

  // -------------------------------------------------------------------------
  // Node State Updates
  // -------------------------------------------------------------------------
  async updateAllNodeStates() {
    await this.updateLocalNode();
    this.maloRegistry.updateDemoStates();
  }

  async updateLocalNode() {
    const node = this.localNode;
    if (!node) return;

    // SMGw HAN — highest-trust source if configured
    if (this.smgwClient) {
      const reading = await this.smgwClient.readMeter();
      if (reading && reading.activePowerW !== null) {
        node.battery.powerW = reading.activePowerW;
        node.lastSeen = new Date();
        node.online   = true;
      }
    }

    // Anker Solix sensors (via HA)
    if (this.config.anker_battery_sensor) {
      try {
        const bat = await this.getEntityState(this.config.anker_battery_sensor);
        if (bat) node.battery.soc = parseFloat(bat.state) || node.battery.soc;
        const pwr = await this.getEntityState(this.config.anker_power_sensor);
        if (pwr) {
          node.battery.powerW     = parseFloat(pwr.state) || 0;
          node.battery.discharging = node.battery.powerW > 0;
          node.battery.charging    = node.battery.powerW < 0;
        }
        if (this.config.anker_ac_charging) {
          const ac = await this.getEntityState(this.config.anker_ac_charging);
          if (ac) node.battery.acCharging = ac.state === 'on';
        }
        node.online = true;
      } catch { /* fall through */ }
    }

    // Zendure Hyper sensors (via HA)
    if (this.config.zendure_battery_sensor) {
      try {
        const bat = await this.getEntityState(this.config.zendure_battery_sensor);
        if (bat) node.battery.soc = parseFloat(bat.state) || node.battery.soc;
        const pwr = await this.getEntityState(this.config.zendure_power_sensor);
        if (pwr) {
          node.battery.powerW     = parseFloat(pwr.state) || 0;
          node.battery.discharging = node.battery.powerW > 0;
          node.battery.charging    = node.battery.powerW < 0;
        }
        node.online = true;
      } catch { /* fall through */ }
    }

    // PV-only fallback: synth SoC/power from PVSim
    if (!this.config.anker_battery_sensor && !this.config.zendure_battery_sensor && !this.smgwClient) {
      if (node.pvSim) node.solar.powerW = Math.round(node.pvSim.currentPower(new Date()));
    }

    node.battery.lastUpdate = new Date();
    node.lastSeen = new Date();
  }

  // -------------------------------------------------------------------------
  // HA Device Control
  // -------------------------------------------------------------------------
  async startAnkerCharging(durationHours = 2) {
    try {
      await this.callService('switch', 'turn_on', { entity_id: this.config.anker_ac_charging });
      await this.callService('anker_solix', 'modify_solix_backup_charge', {
        device_id: this.config.anker_device_id,
        backup_duration: { hours: durationHours, minutes: 0, seconds: 0 },
        enable_backup: true,
        backup_start: new Date().toISOString().replace('T', ' ').slice(0, 19)
      });
      return true;
    } catch { return false; }
  }

  async stopAnkerCharging() {
    try {
      await this.callService('switch', 'turn_off', { entity_id: this.config.anker_ac_charging });
      await this.callService('anker_solix', 'modify_solix_backup_charge', {
        device_id: this.config.anker_device_id, enable_backup: false
      });
      return true;
    } catch { return false; }
  }

  async setAnkerOutput(watts) {
    try {
      await this.callService('number', 'set_value', { entity_id: this.config.anker_output_control, value: watts });
      return true;
    } catch { return false; }
  }

  async setZendureOutputLimit(watts) {
    try {
      await this.callService('number', 'set_value', { entity_id: this.config.zendure_output_control, value: watts });
      return true;
    } catch { return false; }
  }

  async startZendureCharging() {
    try {
      await this.callService('select', 'select_option', { entity_id: this.config.zendure_ac_mode, option: 'Grid charge' });
      return true;
    } catch { return false; }
  }

  async stopZendureCharging() {
    try {
      await this.callService('select', 'select_option', { entity_id: this.config.zendure_ac_mode, option: 'Auto' });
      return true;
    } catch { return false; }
  }

  // -------------------------------------------------------------------------
  // EPEX Prices (HA sensor -> Energycharts API -> demo fallback)
  // -------------------------------------------------------------------------
  async fetchEPEXPrices() {
    let loaded = false;
    try {
      const state = await this.getEntityState(this.config.epex_sensor);
      if (state) {
        let price = parseFloat(state.state) || 0;
        if (price > 1) price = price / 100;
        this.currentPrice = price;
        const attrs = state.attributes || {};
        if (attrs.data && Array.isArray(attrs.data)) {
          this.epexPrices = attrs.data.map(item => ({
            time:    new Date(item.start_time),
            endTime: new Date(item.end_time),
            price:   item.price_ct_per_kwh  ? item.price_ct_per_kwh / 100
                   : item.price_eur_per_mwh ? item.price_eur_per_mwh / 1000
                   : (parseFloat(item.price) || 0) / 100,
            source: 'ha'
          }));
          this.log('info', 'EPEX (HA): ' + this.epexPrices.length + ' price points');
          loaded = true;
        }
      }
    } catch (err) {
      this.log('debug', 'EPEX HA sensor: ' + err.message);
    }

    if (!loaded) {
      const ecPrices = await this.energyCharts.fetchDayAhead();
      if (ecPrices && ecPrices.length > 0) {
        this.epexPrices = ecPrices.map(p => ({ ...p, source: 'energycharts' }));
        const now = Date.now();
        const cur = this.epexPrices.reduce((best, p) =>
          Math.abs(p.time - now) < Math.abs(best.time - now) ? p : best
        );
        this.currentPrice = cur.price;
        this.log('info', 'EPEX (Energycharts): ' + this.epexPrices.length + ' pts  current=' + (this.currentPrice*100).toFixed(1) + 'ct');
        loaded = true;
      }
    }

    if (!loaded) this.generateDemoPrices();

    this._refreshPVForecast();
    this.dynamicGridFee.generateSchedule(48);
    return loaded;
  }

  _refreshPVForecast() {
    const pvNodes = this.maloRegistry.getAll().filter(n => n.pvSim);
    if (pvNodes.length === 0) { this.pvForecast48h = []; return; }
    const sampleNodes = pvNodes.slice(0, 20);
    const base = sampleNodes[0].pvSim.forecast48h();
    const scale = pvNodes.length / sampleNodes.length;
    const combined = base.map((slot, i) => ({
      time:   slot.time,
      powerW: Math.round(sampleNodes.reduce((sum, n) => {
        const h = n.pvSim.forecast48h()[i];
        return sum + (h ? h.powerW : 0);
      }, 0) * scale)
    }));
    this.pvForecast48h = combined;
  }

  generateDemoPrices() {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    this.epexPrices = [];
    for (let i = 0; i < 48; i++) {
      const t = new Date(now.getTime() + i * 3_600_000);
      const h = t.getHours();
      const wknd = [0, 6].includes(t.getDay());
      let base = 0.18;
      if (h >= 6  && h <= 9)  base = 0.28;
      if (h >= 11 && h <= 14) base = 0.12;
      if (h >= 17 && h <= 21) base = 0.32;
      if (h >= 0  && h <= 5)  base = 0.06;
      if (wknd) base *= 0.85;
      this.epexPrices.push({
        time: t, endTime: new Date(t.getTime() + 3_600_000),
        price: Math.max(0.02, Math.min(0.50, base + (Math.random() - 0.5) * 0.08))
      });
    }
    this.currentPrice = this.epexPrices[0]?.price || 0.20;
  }

  // -------------------------------------------------------------------------
  // Flex Bid Generation + Slot Auction
  // -------------------------------------------------------------------------
  generateFlexBids() {
    const nextSlot = this.slotScheduler.getNextSlotKey();
    const nodes = this.maloRegistry.getAll();
    let bidCount = 0;

    for (const node of nodes) {
      if (!node.online) continue;
      const flex = node.availableFlexKw;
      if (flex < this.config.min_flex_bid_kw) continue;

      const gridFee = this.dynamicGridFee.getCurrentFee();
      const epexPrice = this.currentPrice;

      if (node.canOffer && flex > 0.1) {
        const price = Math.max(0.02, epexPrice - gridFee * 0.5 + (Math.random() - 0.3) * 0.03);
        const bid = new FlexBid({
          maloId:       node.maloId,
          meloId:       node.meloId,
          did:          node.did || ('did:peaq:malo_' + node.maloId),
          slotStart:    nextSlot,
          direction:    'offer',
          powerKw:      Math.min(flex, 5 + Math.random() * 10),
          priceEurKwh:  +price.toFixed(4),
          source:       node.solar.powerW > 200 ? 'pv' : 'battery',
          flexSpaceRef: node.flexSpace?.id,
          priority:     Math.max(3, 9 - Math.floor(flex / 2))
        });
        this.slotScheduler.addBid(bid);
        bidCount++;
      }

      if (node.needsDemand) {
        const price = Math.min(0.40, epexPrice + gridFee * 0.3 + (Math.random() - 0.2) * 0.03);
        const demandKw = Math.min(5, (1 - node.battery.soc / 100) * node.battery.capacityWh / 1000);
        if (demandKw > this.config.min_flex_bid_kw) {
          const bid = new FlexBid({
            maloId:       node.maloId,
            meloId:       node.meloId,
            did:          node.did || ('did:peaq:malo_' + node.maloId),
            slotStart:    nextSlot,
            direction:    'demand',
            powerKw:      +demandKw.toFixed(2),
            priceEurKwh:  +price.toFixed(4),
            source:       'battery',
            flexSpaceRef: node.flexSpace?.id,
            priority:     node.battery.soc < 20 ? 9 : 6
          });
          this.slotScheduler.addBid(bid);
          bidCount++;
        }
      }
    }

    this.log('debug', 'FlexBids: ' + bidCount + ' bids for slot ' + SlotScheduler.slotLabel(nextSlot));
    return bidCount;
  }

  async runSlotAuction() {
    const currentSlotKey = this.slotScheduler.getCurrentSlotKey();
    const bids = this.slotScheduler.getBidsForSlot(currentSlotKey);

    if (bids.length < 2) {
      this.log('debug', 'MOL-Clearing: nicht genug Gebote (' + bids.length + ')');
      return null;
    }

    // --- Phase 1: Redispatch 3.0 Aggregation ---
    let redispatchSettlement = null;
    let residualBids = bids;

    if (this.config.redispatch_enabled && this.redispatchAggregator) {
      const bezirkSummary = this.maloRegistry.getBezirkSummary();
      const maloNodes = this.maloRegistry.getAll();
      const aggregated = this.redispatchAggregator.aggregateSlot(bids, currentSlotKey, maloNodes, bezirkSummary);

      if (aggregated.netFlexKw >= this.config.redispatch_min_flex_kw) {
        this.log('info', 'RD3.0 ' + SlotScheduler.slotLabel(currentSlotKey) +
          ': aggregated ' + aggregated.netFlexKw.toFixed(1) + ' kW (' +
          aggregated.offerCount + ' offers) → submitting');

        await this.redispatchAggregator.submitToGateway(aggregated);
        await this.redispatchAggregator.waitForCallback(currentSlotKey);

        if (aggregated.redispatchCalled) {
          this.redispatchAggregator.getResidualBids(bids, aggregated);
          const allocated = bids.filter(b => b.status === 'redispatch_allocated');
          redispatchSettlement = this.redispatchAggregator.createRedispatchSettlement(aggregated, allocated);

          if (redispatchSettlement) {
            const chainRecord = {
              type: 'REDISPATCH_30_SETTLEMENT',
              ...redispatchSettlement
            };
            await this.chain?.storeData('rd30_' + redispatchSettlement.id, chainRecord);
            this.earnings += redispatchSettlement.totalVerguetungEur;

            this.log('info', 'RD3.0 ABRUF ' + SlotScheduler.slotLabel(currentSlotKey) +
              ': ' + redispatchSettlement.totalLeistungKw.toFixed(1) + ' kW @ ' +
              (redispatchSettlement.redispatchPreis * 100).toFixed(1) + ' ct/kWh | ' +
              redispatchSettlement.totalVerguetungEur.toFixed(4) + ' EUR');
          }

          residualBids = bids.filter(b => b.status === 'pending');
        } else {
          this.log('info', 'RD3.0 ' + SlotScheduler.slotLabel(currentSlotKey) +
            ': kein Abruf → P2P-Clearing');
        }
      }
    }

    // --- Phase 2: P2P-Clearing für residuale Bids ---
    let clearing = null;
    const pendingBids = residualBids.filter(b => b.status === 'pending');

    if (pendingBids.length >= 2) {
      clearing = this.clearingMatcher.clearSlot(pendingBids, currentSlotKey);

      if (clearing.matchedPairs.length > 0) {
        this.log('info', 'P2P CLEARING ' + SlotScheduler.slotLabel(currentSlotKey) +
          ': ' + clearing.matchedPairs.length + ' pairs @ ' + (clearing.clearingPrice * 100).toFixed(1) +
          ' ct/kWh | ' + clearing.totalVolumeKwh.toFixed(2) + ' kWh');

        const settlement = await this.settlementEngine.settleClearing(clearing);
        if (settlement) {
          this.earnings += settlement.totalEur;
          this.log('info', 'Settlement: ' + settlement.id + ' | ' + settlement.totalEur.toFixed(4) + ' EUR' +
            (settlement.onChain ? ' [on-chain]' : ' [local]'));
        }
      }
    }

    // Planwertmodell: Istwert-Korrektur via SMGw (wenn verfügbar)
    if (this.smgwClient && this.localNode) {
      const meterReading = await this.smgwClient.readMeter();
      if (meterReading && meterReading.activePowerW !== null) {
        const actualKw = +(Math.abs(meterReading.activePowerW) / 1000).toFixed(2);
        for (const bid of bids) {
          if (bid.maloId === this.localNode.maloId && bid.status === 'matched' && bid.fahrplan) {
            bid.fahrplan.istwertKw = actualKw;
            bid.fahrplan.abweichungKw = +(actualKw - bid.fahrplan.planwertKw).toFixed(2);
          }
        }
      }
    }

    this.broadcastWS({
      type: 'clearing',
      slot: currentSlotKey,
      redispatch: redispatchSettlement ? {
        called: true,
        volumeKw: redispatchSettlement.totalLeistungKw,
        preisEurKwh: redispatchSettlement.redispatchPreis,
        verguetungEur: redispatchSettlement.totalVerguetungEur
      } : { called: false },
      clearingPrice: clearing?.clearingPrice || null,
      pairs: clearing?.matchedPairs?.length || 0,
      volumeKwh: clearing?.totalVolumeKwh || 0
    });

    this.slotScheduler.cleanOldSlots();
    return { clearing, redispatchSettlement };
  }

  // -------------------------------------------------------------------------
  // Forecast Optimization + Auto-Orders
  // -------------------------------------------------------------------------
  async optimizeForForecast() {
    if (this.epexPrices.length < 12) return;
    const sorted  = [...this.epexPrices].sort((a, b) => b.price - a.price);
    const top8    = sorted.slice(0, 8);
    const bottom8 = sorted.slice(-8);
    this.tradingPlan = {
      sellHours:    top8.map(p => p.time.getHours()),
      buyHours:     bottom8.map(p => p.time.getHours()),
      avgSellPrice: top8.reduce((s, p) => s + p.price, 0) / top8.length,
      avgBuyPrice:  bottom8.reduce((s, p) => s + p.price, 0) / bottom8.length,
      sellTimes:    top8.map(p => p.time.toISOString()),
      buyTimes:     bottom8.map(p => p.time.toISOString()),
      lastOptimized: new Date()
    };
    this.log('info', 'Forecast: SELL avg ' + (this.tradingPlan.avgSellPrice * 100).toFixed(1) + 'ct  BUY avg ' + (this.tradingPlan.avgBuyPrice * 100).toFixed(1) + 'ct');
    await this.createSolarOrders();
  }

  async createSolarOrders() {
    if (!this.did) return;
    for (const node of this.maloRegistry.getAll()) {
      const surplus = node.surplusW;
      if (surplus < 100) continue;
      const existing = this.orderBook.getSellOrders().find(o => o.nodeId === node.id && o.source === 'auto_solar');
      if (existing) continue;
      const energyWh = Math.round(surplus * 0.25);
      const priority = Math.max(3, 9 - Math.floor(surplus / 400));
      const price = Math.max(this.config.min_sell_price * 0.80, (this.tradingPlan.avgSellPrice || this.config.min_sell_price) - 0.015);
      const order = new Order({
        type: 'SELL', nodeId: node.id, maloId: node.maloId,
        did: node.did || ('did:peaq:malo_' + node.maloId),
        energyWh: Math.max(10, energyWh), pricePerKwh: +price.toFixed(4),
        priority, source: 'auto_solar',
        smgCertFingerprint: node.smgCert.fingerprint, validForMinutes: 30
      });
      this.orderBook.add(order);
    }
  }

  // -------------------------------------------------------------------------
  // Order Management
  // -------------------------------------------------------------------------
  async processOrderMatches() {
    this.orderBook.expireOld();
    const matches = this.orderBook.findMatches();
    for (const match of matches) {
      await this.executeMatchedTrade(match);
    }
    if (matches.length > 0) this.broadcastWS({ type: 'matches', count: matches.length });
  }

  async executeMatchedTrade({ buy, sell, clearingPrice, energyWh }) {
    this.log('info', 'MATCH: ' + sell.nodeId + ' -> ' + buy.nodeId + '  ' + energyWh + 'Wh @ ' + (clearingPrice * 100).toFixed(1) + 'ct');
    buy.status = 'matched'; sell.status = 'matched';
    buy.matchedWith = sell.id; sell.matchedWith = buy.id;
    buy.clearingPrice = sell.clearingPrice = clearingPrice;

    const trade = await this.executeP2PTrade(sell.nodeId, buy.nodeId, energyWh, clearingPrice);
    setTimeout(() => { buy.status = 'executed'; sell.status = 'executed'; }, 2000);

    const chainRecord = {
      type: 'P2P_TRADE', buyOrderId: buy.id, sellOrderId: sell.id,
      buyerNode: buy.nodeId, sellerNode: sell.nodeId,
      buyerDid: buy.did, sellerDid: sell.did,
      energyWh, clearingPrice,
      totalEur: +((energyWh / 1000) * clearingPrice).toFixed(4),
      timestamp: new Date().toISOString(), tradeId: trade.id
    };
    const stored = await this.chain?.storeData('trade_' + trade.id, chainRecord);
    if (stored) { buy.txHash = sell.txHash = 'peaq:' + trade.id; }
    return trade;
  }

  // -------------------------------------------------------------------------
  // P2P Physical Execution
  // -------------------------------------------------------------------------
  async executeP2PTrade(fromNodeId, toNodeId, energyWh, pricePerKwh = null) {
    const price = pricePerKwh ?? this.currentPrice;
    const trade = {
      id: 'p2p_' + Date.now(), timestamp: new Date().toISOString(),
      from: fromNodeId, to: toNodeId, energyWh,
      pricePerKwh: price, totalEur: +((energyWh / 1000) * price).toFixed(4),
      status: 'pending'
    };
    this.activeEnergyFlow = { from: fromNodeId, to: toNodeId, powerWh: energyWh, startTime: new Date() };
    try {
      if (fromNodeId === 'node_ha1') await this.setAnkerOutput(Math.min(this.config.max_feedin_power, energyWh));
      else if (fromNodeId === 'node_ha2') await this.setZendureOutputLimit(Math.min(this.config.max_feedin_power, energyWh));
      if (toNodeId === 'node_ha1') await this.startAnkerCharging(1);
      else if (toNodeId === 'node_ha2') await this.startZendureCharging();
      trade.status = 'active';
      const durationMs = Math.min((energyWh / 800) * 3_600_000, 60_000);
      setTimeout(() => {
        trade.status = 'completed';
        this.activeEnergyFlow = null;
        this.p2pTrades.push(trade);
        this.earnings += trade.totalEur;
        this.broadcastWS({ type: 'trade_completed', trade });
      }, durationMs);
    } catch (err) {
      trade.status = 'failed'; this.activeEnergyFlow = null;
      this.log('error', 'P2P: ' + err.message);
    }
    return trade;
  }

  // -------------------------------------------------------------------------
  // EPEX Trading Decision
  // -------------------------------------------------------------------------
  async makeTradingDecision() {
    if (!this.config.enable_trading) { this.currentMode = 'DISABLED'; return; }
    const price   = this.currentPrice;
    const battery = this.localNode?.battery.soc ?? 0;
    const reserve = this.config.battery_reserve;
    let decision = 'HOLD';
    if (price >= this.config.min_sell_price && battery > reserve) decision = 'SELL';
    else if (price <= this.config.max_buy_price && price >= this.config.min_buy_price && battery < 90) decision = 'BUY';
    if (decision !== this.currentMode) {
      this.log('info', 'Mode: ' + this.currentMode + ' -> ' + decision + '  (' + (price * 100).toFixed(1) + 'ct, ' + battery.toFixed(0) + '%)');
      if (decision === 'BUY') await this.startAnkerCharging(2);
      else if (decision === 'SELL') { await this.stopAnkerCharging(); await this.setAnkerOutput(this.config.max_feedin_power); }
      else { await this.stopAnkerCharging(); await this.setAnkerOutput(0); }
    }
    this.currentMode = decision;
  }

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------
  broadcastWS(payload) {
    if (!this.wsClients.size) return;
    const msg = JSON.stringify(payload);
    for (const ws of this.wsClients) try { ws.send(msg); } catch {}
  }

  broadcastState() {
    const ns = this.maloRegistry.summary();
    const bs = this.maloRegistry.getBezirkSummary();
    this.broadcastWS({
      type:         'state',
      timestamp:    new Date().toISOString(),
      connected:    this.chain?.connected,
      demoMode:     this.chain?.demoMode,
      currentMode:  this.currentMode,
      currentPrice: this.currentPrice,
      earnings:     this.earnings,
      gridFee:      this.dynamicGridFee.getCurrentFee(),
      localSoc:     this.localNode?.battery.soc,
      localPower:   this.localNode?.battery.powerW,
      localSolarW:  this.localNode?.solar.powerW,
      localName:    this.localNode?.name,
      peerCount:    this.discoveredPeers.size,
      activeEnergyFlow: this.activeEnergyFlow,
      orderSummary: this.orderBook.summary(),
      maloSummary:  ns,
      bezirkSummary: bs,
      clearingHistory: this.clearingMatcher.getHistory(4),
      redispatchHistory: this.redispatchAggregator?.getHistory(4) || [],
      settlementSummary: this.settlementEngine?.getSummary(),
      nextSlot: this.slotScheduler.getNextSlotKey(),
      trades:       this.trades.length,
      p2pTrades:    this.p2pTrades.length
    });
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------
  log(level, msg) {
    const levels = { debug: 0, info: 1, warning: 2, error: 3 };
    const cfgLevel = levels[this.config?.log_level || 'info'] ?? 1;
    if ((levels[level] ?? 1) >= cfgLevel) {
      const ts = new Date().toISOString().slice(11, 19);
      console.log('[' + ts + '] [' + level.toUpperCase() + '] ' + msg);
    }
  }

  // -------------------------------------------------------------------------
  // Web UI
  // -------------------------------------------------------------------------
  startWebUI() {
    const app    = express();
    const server = http.createServer(app);
    const wss    = new WebSocketServer({ server, path: '/ws' });
    app.use(express.json());

    wss.on('connection', ws => {
      this.wsClients.add(ws);
      ws.on('close', () => this.wsClients.delete(ws));
      ws.send(JSON.stringify({ type: 'state', ...this.getStateSnapshot() }));
    });

    // --- API Endpoints ---
    app.get('/api/health',  (_, res) => res.json({ status: 'ok', version: '4.1.0', platform: 'TheElectronChain', verfahren: 'RD3.0 Pay-as-Bid' }));
    app.get('/api/status',  (_, res) => res.json(this.getStateSnapshot()));

    app.get('/api/prices',  (_, res) => res.json({
      current: this.currentPrice,
      gridFee: this.dynamicGridFee.getCurrentFee(),
      agnesEnabled: this.config.agnes_enabled,
      forecast: this.epexPrices.map(p => ({
        time: p.time.toISOString(), hour: p.time.getHours(), price: p.price, source: p.source
      })),
      gridFeeSchedule: this.dynamicGridFee.getSchedule(12),
      pvForecast: this.pvForecast48h.slice(0, 192).map(h => ({ time: h.time.toISOString(), powerW: h.powerW }))
    }));

    app.get('/api/malos', (_, res) => res.json({
      summary: this.maloRegistry.summary(),
      bezirke: this.maloRegistry.getBezirkSummary(),
      malos:   this.maloRegistry.getAll().map(n => n.toJSON())
    }));

    app.get('/api/malos/:id', (req, res) => {
      const n = this.maloRegistry.get(req.params.id);
      if (!n) return res.status(404).json({ error: 'not found' });
      res.json(n.toJSON());
    });

    app.get('/api/communities', (_, res) => res.json({
      bezirke: this.maloRegistry.getBezirkSummary(),
      totalMalos: this.maloRegistry.getAll().length,
      totalFlexKw: this.maloRegistry.summary().totalFlexKw
    }));

    app.get('/api/flex/bids', (req, res) => {
      const slot = req.query.slot || this.slotScheduler.getNextSlotKey();
      res.json({ slot, bids: this.slotScheduler.getBidsForSlot(slot).map(b => b.toJSON()) });
    });

    app.get('/api/flex/clearing', (_, res) => res.json({
      history: this.clearingMatcher.getHistory(24),
      nextSlot: this.slotScheduler.getNextSlotKey()
    }));

    app.get('/api/flex/clearing/:slot', (req, res) => {
      const entry = this.clearingMatcher.clearingHistory.find(c => c.slotStart === req.params.slot);
      res.json(entry || { error: 'no clearing for this slot' });
    });

    app.get('/api/flex/settlement', (_, res) => res.json({
      summary: this.settlementEngine?.getSummary(),
      history: this.settlementEngine?.getHistory(24)
    }));

    app.get('/api/redispatch', (_, res) => res.json({
      enabled: this.config.redispatch_enabled,
      gatewayConfigured: !!this.config.redispatch_gateway_url,
      minFlexKw: this.config.redispatch_min_flex_kw,
      history: this.redispatchAggregator?.getHistory(24) || [],
      currentSlot: this.redispatchAggregator?.getForSlot(this.slotScheduler.getCurrentSlotKey())
    }));

    app.get('/api/redispatch/:slot', (req, res) => {
      const entry = this.redispatchAggregator?.getForSlot(req.params.slot);
      res.json(entry || { error: 'no aggregation for this slot' });
    });

    app.post('/api/redispatch/callback', (req, res) => {
      const { slotStart, called, volumeKw, priceEurKwh } = req.body;
      const aggregated = this.redispatchAggregator?.getForSlot(slotStart);
      if (!aggregated) return res.status(404).json({ error: 'slot not found' });
      aggregated.redispatchCalled = called === true;
      aggregated.redispatchVolume = volumeKw || 0;
      aggregated.redispatchPrice = priceEurKwh || null;
      aggregated.callbackReceived = true;
      this.log('info', 'RD3.0 callback: slot=' + slotStart + ' called=' + called);
      res.json({ ok: true, aggregated });
    });

    app.get('/api/rd30/mol', (_, res) => {
      const nextSlot = this.slotScheduler.getNextSlotKey();
      const bids = this.slotScheduler.getBidsForSlot(nextSlot);
      const mol = this.clearingMatcher.buildMeritOrderListe(bids);
      res.json({
        slotStart: nextSlot,
        verfahren: 'pay_as_bid',
        offers: mol.offers.map(o => ({
          rang: o.rang, gebotId: o.gebotId, maloId: o.maloId, poolId: o.poolId,
          rdvKw: o.rdvKw, energyKwh: o.energyKwh, angebotspreis: o.angebotspreis,
          netzwirksamerBeitragKw: o.netzwirksamerBeitragKw, source: o.source
        })),
        demands: mol.demands.map(d => ({
          rang: d.rang, gebotId: d.gebotId, maloId: d.maloId, poolId: d.poolId,
          rdvKw: d.rdvKw, energyKwh: d.energyKwh, angebotspreis: d.angebotspreis,
          netzwirksamerBeitragKw: d.netzwirksamerBeitragKw, source: d.source
        }))
      });
    });

    app.get('/api/grid-fees', (_, res) => res.json({
      current: this.dynamicGridFee.getCurrentFee(),
      agnesEnabled: this.config.agnes_enabled,
      schedule: this.dynamicGridFee.getSchedule(48)
    }));

    app.get('/api/fleet', (_, res) => {
      const ns = this.maloRegistry.summary();
      const bs = this.maloRegistry.getBezirkSummary();
      res.json({
        totalMalos: ns.total, totalFlexKw: ns.totalFlexKw,
        totalCapacityKwh: ns.totalCapacityKwh, totalSolarW: ns.totalSolarW,
        avgSoc: ns.avgSoc, bezirke: bs
      });
    });

    app.get('/api/rd30/rdv/:id', (req, res) => {
      const node = this.maloRegistry.get(req.params.id);
      if (!node) return res.status(404).json({ error: 'not found' });
      res.json(Rd30Adapter.createRdvMeldung(node));
    });

    app.get('/api/rd30/rdv', (_, res) => {
      const currentSlotKey = this.slotScheduler.getCurrentSlotKey();
      const agg = this.redispatchAggregator?.getForSlot(currentSlotKey);
      if (!agg || !agg.rdvMeldung) {
        const nodes = this.maloRegistry.getAll();
        const slotEnd = new Date(new Date(currentSlotKey).getTime() + 900_000).toISOString();
        res.json(Rd30Adapter.createAggregatedRdvMeldung(nodes, currentSlotKey, slotEnd));
      } else {
        res.json(agg.rdvMeldung);
      }
    });

    app.get('/api/rd30/redispatch/:slot', (req, res) => {
      const agg = this.redispatchAggregator?.getForSlot(req.params.slot);
      if (!agg) return res.status(404).json({ error: 'no redispatch data for this slot' });
      res.json({
        aggregation: agg,
        rdvMeldung: agg.rdvMeldung,
        abruf: agg.abruf
      });
    });

    // Legacy order endpoints
    app.get('/api/orders', (_, res) => res.json({
      summary: this.orderBook.summary(),
      buys: this.orderBook.getBuyOrders(), sells: this.orderBook.getSellOrders(),
      all: this.orderBook.getAll().slice(0, 50)
    }));

    app.post('/api/orders', async (req, res) => {
      const { type, nodeId, energyWh, pricePerKwh, priority, validForMinutes } = req.body;
      if (!['BUY', 'SELL'].includes(type) || !nodeId || !energyWh || !pricePerKwh)
        return res.status(400).json({ error: 'type, nodeId, energyWh, pricePerKwh required' });
      const node = this.maloRegistry.get(nodeId);
      const order = new Order({
        type, nodeId, maloId: node?.maloId,
        did: node?.did || this.did, energyWh: +energyWh, pricePerKwh: +pricePerKwh,
        priority: priority || 5, source: 'manual',
        smgCertFingerprint: node?.smgCert.fingerprint, validForMinutes: validForMinutes || 60
      });
      this.orderBook.add(order);
      this.broadcastWS({ type: 'order_created', order });
      res.json(order);
    });

    app.delete('/api/orders/:id', (req, res) => {
      const ok = this.orderBook.cancel(req.params.id);
      if (ok) this.broadcastWS({ type: 'order_cancelled', id: req.params.id });
      res.json({ success: ok });
    });

    app.post('/api/orders/match', async (_, res) => {
      await this.processOrderMatches();
      res.json({ summary: this.orderBook.summary() });
    });

    app.post('/api/p2p/trade', async (req, res) => {
      const { from, to, energyWh } = req.body;
      res.json(await this.executeP2PTrade(from, to, energyWh || this.config.p2p_trade_amount_wh));
    });

    app.post('/api/nodes/:id/cert', (req, res) => {
      const node = this.maloRegistry.get(req.params.id);
      if (!node) return res.status(404).json({ error: 'node not found' });
      const { pem, fingerprint } = req.body;
      node.smgCert = new SMGCertificate(pem || fingerprint);
      node.did     = node.smgCert.getDID();
      res.json({ did: node.did, cert: node.smgCert.toJSON() });
    });

    // --- HTML Pages ---
    app.get('/',           (_, res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.send(this.generateDashboardHTML()); });
    app.get('/flex',       (_, res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.send(this.generateFlexMarktHTML()); });
    app.get('/netzwerk',   (_, res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.send(this.generateNetzwerkHTML()); });
    app.get('/settlement', (_, res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.send(this.generateSettlementHTML()); });

    server.listen(8099, '0.0.0.0', () => {
      this.log('info', 'Dashboard: http://localhost:8099  WS: ws://localhost:8099/ws');
    });

    setInterval(() => this.broadcastState(), 5000);
  }

  getStateSnapshot() {
    return {
      platform:     'TheElectronChain',
      version:      '4.1.0',
      connected:    this.chain?.connected,
      demoMode:     this.chain?.demoMode,
      wallet:       this.machineWallet?.getAddress(),
      did:          this.did,
      network:      this.config?.network_type,
      localNode:    this.localNode ? {
        name:         this.localNode.name,
        maloId:       this.localNode.maloId,
        meloId:       this.localNode.meloId,
        smgwId:       this.localNode.smgwId,
        address:      this.localNode.address,
        lat:          this.localNode.lat,
        lon:          this.localNode.lon,
        batteryLevel: this.localNode.battery.soc,
        batteryPower: this.localNode.battery.powerW,
        solarW:       this.localNode.solar.powerW,
        flexKw:       this.localNode.availableFlexKw,
        online:       this.localNode.online
      } : null,
      smgw:         this.smgwClient?.toJSON() || null,
      peers:        [...this.discoveredPeers.values()],
      currentPrice: this.currentPrice,
      gridFee:      this.dynamicGridFee.getCurrentFee(),
      currentMode:  this.currentMode,
      tradingPlan:  this.tradingPlan,
      activeEnergyFlow: this.activeEnergyFlow,
      orderSummary: this.orderBook.summary(),
      maloSummary:  this.maloRegistry.summary(),
      bezirkSummary: this.maloRegistry.getBezirkSummary(),
      clearingHistory: this.clearingMatcher.getHistory(4),
      redispatchHistory: this.redispatchAggregator?.getHistory(4) || [],
      settlementSummary: this.settlementEngine?.getSummary(),
      nextSlot:     this.slotScheduler.getNextSlotKey(),
      trades:       this.trades.length,
      p2pTrades:    this.p2pTrades.length,
      earnings:     this.earnings,
      config: {
        enable_trading:  this.config?.enable_trading,
        min_sell_price:  this.config?.min_sell_price,
        max_buy_price:   this.config?.max_buy_price,
        battery_reserve: this.config?.battery_reserve,
        agnes_enabled:   this.config?.agnes_enabled,
        clearing_mode:   this.config?.clearing_mode,
        redispatch_enabled: this.config?.redispatch_enabled
      }
    };
  }

  // -------------------------------------------------------------------------
  // HTML — escape helper
  // -------------------------------------------------------------------------
  _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // -------------------------------------------------------------------------
  // Dark theme shell
  // -------------------------------------------------------------------------
  _darkShell(activeHref, title, bodyHTML, extraHead) {
    const links = [['/', 'Dashboard'], ['/flex', 'Flex-Markt'], ['/netzwerk', 'Netzwerk'], ['/settlement', 'Settlement']];
    const nav = links.map(function([h, l]) {
      return '<a href="' + h + '"' + (h === activeHref ? ' class="active"' : '') + '>' + l + '</a>';
    }).join('');

    const allNodes = this.maloRegistry.getAll();

    return '<!DOCTYPE html><html lang="de"><head>\n'
+ '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n'
+ '<title>' + title + ' — TheElectronChain</title>\n'
+ (extraHead || '') + '\n'
+ '<style>\n'
+ ':root{--bg0:#09090b;--bg1:#0f0f12;--bg2:#18181b;--bg3:#27272a;--bg4:#3f3f46;--t0:#fafafa;--t1:#a1a1aa;--t2:#71717a;--t3:#52525b;--bdr:#27272a;--grn:#16a34a;--grn-l:#22c55e;--red:#dc2626;--red-l:#ef4444;--yel:#ca8a04;--yel-l:#eab308;--blu:#2563eb;--blu-l:#3b82f6;--ora:#f59e0b;--ora-l:#fbbf24;--pur:#7c3aed;--pur-l:#8b5cf6;--cyan:#06b6d4;--cyan-l:#22d3ee;--shadow:0 1px 4px rgba(0,0,0,.3)}\n'
+ '*{box-sizing:border-box;margin:0;padding:0}\n'
+ 'body{font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;background:var(--bg0);color:var(--t0);line-height:1.5;min-height:100vh}\n'
+ 'header{background:var(--bg1);border-bottom:1px solid var(--bdr);box-shadow:var(--shadow)}\n'
+ '.hdr-top{max-width:1440px;margin:0 auto;padding:10px 20px;display:flex;justify-content:space-between;align-items:center}\n'
+ 'h1{font-size:1.05rem;font-weight:700;color:var(--cyan);letter-spacing:-.01em;display:flex;align-items:center;gap:8px}\n'
+ 'h1 span{color:var(--t0);font-weight:400}\n'
+ '.hdr-r{display:flex;gap:10px;align-items:center;font-size:.72rem;color:var(--t1)}\n'
+ '.dot{width:7px;height:7px;border-radius:50%;background:var(--grn);animation:pulse 2s infinite}\n'
+ '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}\n'
+ 'nav{max-width:1440px;margin:0 auto;padding:0 20px;display:flex;gap:2px}\n'
+ 'nav a{padding:7px 14px;font-size:.72rem;font-weight:500;color:var(--t1);text-decoration:none;border-radius:4px 4px 0 0;border-bottom:2px solid transparent;transition:.15s}\n'
+ 'nav a:hover{color:var(--cyan-l);background:rgba(6,182,212,.08)}\n'
+ 'nav a.active{color:var(--cyan);border-bottom-color:var(--cyan);background:rgba(6,182,212,.1)}\n'
+ '.wrap{max-width:1440px;margin:0 auto;padding:16px 20px}\n'
+ '.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}\n'
+ '.card{background:var(--bg1);border:1px solid var(--bdr);border-radius:8px;padding:14px;box-shadow:var(--shadow)}\n'
+ '.ctitle{font-size:.62rem;font-weight:600;color:var(--t2);text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px}\n'
+ '.c2{grid-column:span 2}.c3{grid-column:span 3}.c4{grid-column:span 4}.c5{grid-column:span 5}.c6{grid-column:span 6}\n'
+ '.c7{grid-column:span 7}.c8{grid-column:span 8}.c9{grid-column:span 9}.c12{grid-column:span 12}\n'
+ '@media(max-width:1024px){.c2,.c3,.c4,.c5,.c6,.c7,.c8,.c9{grid-column:span 12}}\n'
+ '.big-num{font-size:2rem;font-weight:700;line-height:1}\n'
+ '.unit{font-size:.72rem;color:var(--t2)}\n'
+ '.badge{display:inline-block;padding:3px 12px;border-radius:16px;font-size:.7rem;font-weight:600;letter-spacing:.06em}\n'
+ '.badge-grn{background:rgba(22,163,74,.15);color:var(--grn-l);border:1px solid rgba(22,163,74,.3)}\n'
+ '.badge-red{background:rgba(220,38,38,.15);color:var(--red-l);border:1px solid rgba(220,38,38,.3)}\n'
+ '.badge-yel{background:rgba(202,138,4,.15);color:var(--yel-l);border:1px solid rgba(202,138,4,.3)}\n'
+ '.badge-cyan{background:rgba(6,182,212,.15);color:var(--cyan-l);border:1px solid rgba(6,182,212,.3)}\n'
+ '.badge-pur{background:rgba(124,58,237,.15);color:var(--pur-l);border:1px solid rgba(124,58,237,.3)}\n'
+ '.btn{padding:6px 12px;border:1px solid var(--bdr);border-radius:6px;background:var(--bg2);color:var(--t0);font-size:.7rem;cursor:pointer;transition:.15s;font-weight:500}\n'
+ '.btn:hover{background:rgba(6,182,212,.12);border-color:var(--cyan);color:var(--cyan)}\n'
+ '.btn-sm{padding:3px 8px;font-size:.62rem}\n'
+ '.btn-cyan{background:var(--cyan);color:#000;border-color:var(--cyan);font-weight:600}\n'
+ '.btn-cyan:hover{background:var(--cyan-l)}\n'
+ '.dim{color:var(--t2);font-size:.62rem}\n'
+ '.mono{font-family:"JetBrains Mono",monospace;font-size:.7rem}\n'
+ '#map{height:360px;border-radius:6px;border:1px solid var(--bdr)}\n'
+ '.bat-row{display:flex;gap:8px;margin-top:6px}\n'
+ '.bat-card{flex:1;background:var(--bg2);border-radius:6px;padding:10px;border:1px solid var(--bdr)}\n'
+ '.bat-name{font-size:.62rem;color:var(--t2);margin-bottom:3px}\n'
+ '.bat-soc{font-size:1.3rem;font-weight:700}\n'
+ '.bat-bar{height:4px;background:var(--bg4);border-radius:3px;margin:4px 0;overflow:hidden}\n'
+ '.bat-fill{height:100%;border-radius:3px}\n'
+ '.bat-pwr{font-size:.68rem;color:var(--t1)}\n'
+ '.bezirk-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}\n'
+ '.bezirk-card{background:var(--bg2);border-radius:6px;padding:8px;border:1px solid var(--bdr);font-size:.68rem}\n'
+ '.bezirk-name{font-weight:600;margin-bottom:2px;display:flex;align-items:center;gap:4px}\n'
+ '.bezirk-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}\n'
+ '.bezirk-stat{color:var(--t2);font-size:.6rem}\n'
+ 'table{width:100%;border-collapse:collapse}\n'
+ 'th{font-size:.58rem;color:var(--t2);text-align:left;padding:4px 6px;border-bottom:1px solid var(--bdr);text-transform:uppercase;letter-spacing:.06em}\n'
+ 'td{padding:5px 6px;border-bottom:1px solid var(--bg3);font-size:.68rem}\n'
+ 'tr:hover{background:var(--bg2)}\n'
+ '.fbar{min-width:3px;border-radius:2px 2px 0 0;cursor:crosshair;transition:opacity .1s}\n'
+ '.fbar:hover{opacity:.65}\n'
+ '.slot-card{background:var(--bg2);border:1px solid var(--cyan);border-radius:8px;padding:12px}\n'
+ '.slot-time{font-size:1.5rem;font-weight:700;color:var(--cyan)}\n'
+ '.slot-label{font-size:.6rem;color:var(--t2);text-transform:uppercase;letter-spacing:.08em}\n'
+ '.clearing-bar{display:flex;align-items:flex-end;gap:2px;height:80px;margin:8px 0}\n'
+ '.clearing-bar-item{flex:1;background:var(--cyan);border-radius:2px 2px 0 0;min-width:3px;opacity:.7}\n'
+ '.clearing-bar-item.active{opacity:1;outline:1px solid var(--cyan-l)}\n'
+ '.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}\n'
+ '.info-item{background:var(--bg2);padding:8px 10px;border-radius:6px;border:1px solid var(--bdr)}\n'
+ '.info-lbl{font-size:.56rem;color:var(--t2);margin-bottom:2px;text-transform:uppercase;letter-spacing:.06em}\n'
+ '.info-val{font-size:.7rem;font-family:monospace;word-break:break-all}\n'
+ '.scroll-y{max-height:300px;overflow-y:auto}\n'
+ 'footer{margin-top:16px;padding:12px 0;border-top:1px solid var(--bdr);text-align:center;font-size:.62rem;color:var(--t2)}\n'
+ 'footer a{color:var(--cyan);text-decoration:none}\n'
+ '</style></head>\n'
+ '<body>\n'
+ '<header>\n'
+ '  <div class="hdr-top">\n'
+ '    <h1>&#9889; <span>The</span>ElectronChain</h1>\n'
+ '    <div class="hdr-r">\n'
+ '      <span id="ws-status" style="color:var(--t2)">Verbinden...</span>\n'
+ '      <span class="dot"></span>\n'
+ '      <span>' + (this.config?.network_type?.toUpperCase() || 'AGUNG') + ' ' + (this.chain?.demoMode ? '&middot; DEMO' : '&middot; LIVE') + '</span>\n'
+ '      <span style="color:var(--cyan)">' + allNodes.length + ' MaLos</span>\n'
+ '      <span style="color:var(--t2)">9 Bezirke</span>\n'
+ '    </div>\n'
+ '  </div>\n'
+ '  <nav>' + nav + '</nav>\n'
+ '</header>\n'
+ '<div class="wrap">' + bodyHTML + '</div>\n'
+ '</body></html>';
  }

  // -------------------------------------------------------------------------
  // Dashboard HTML (main page)
  // -------------------------------------------------------------------------
  generateDashboardHTML() {
    const ns   = this.maloRegistry.summary();
    const bs   = this.maloRegistry.getBezirkSummary();
    const ob   = this.orderBook.summary();
    const local = this.localNode;
    const peers = this.maloRegistry.getPeers();
    const allNodes = this.maloRegistry.getAll();

    const mc = { SELL: 'var(--red)', BUY: 'var(--grn)', HOLD: 'var(--yel)', DISABLED: 'var(--t2)' }[this.currentMode] || 'var(--t2)';
    const priceColor = this.currentPrice >= this.config.min_sell_price ? 'var(--red)'
                     : this.currentPrice <= this.config.max_buy_price  ? 'var(--grn)'
                     : 'var(--yel)';

    const gridFee = this.dynamicGridFee.getCurrentFee();
    const nextSlot = SlotScheduler.slotLabel(this.slotScheduler.getNextSlotKey());
    const lastClearing = this.clearingMatcher.getHistory(1)[0];
    const stlSummary = this.settlementEngine?.getSummary() || {};

    // Local node values
    const localSocN  = local?.battery.soc ?? 0;
    const localPwr   = local?.battery.powerW ?? 0;
    const localSolar = local?.solar.powerW ?? 0;
    const localFlex  = local?.availableFlexKw ?? 0;
    const localType  = local?.battery.type || 'PV-only';
    const smgwInfo   = this.smgwClient
      ? (this.smgwClient.host + ':' + this.smgwClient.port + (this.smgwClient.lastError ? ' (err)' : ' (ok)'))
      : 'not configured';

    const peerListHTML = peers.length === 0
      ? 'Keine peaq-Peers entdeckt. Seeds in discovery_seeds konfigurieren.'
      : peers.map(function(p) {
          return '&bull; ' + (p.name || '?') + ' &middot; ' + (p.maloId || '?')
               + ' &middot; SoC ' + p.battery.soc.toFixed(0) + '%'
               + ' &middot; Flex ' + p.availableFlexKw.toFixed(1) + ' kW';
        }).join('<br>');

    // Bezirk cards
    const bezirkCards = KOELN_BEZIRKE.map(function(b) {
      const s = bs[b.name] || {};
      return '<div class="bezirk-card">'
        + '<div class="bezirk-name"><span class="bezirk-dot" style="background:' + b.color + '"></span>' + b.name + '</div>'
        + '<div class="bezirk-stat">' + (s.count || 0) + ' MaLos &middot; ' + (s.totalFlexKw || 0) + ' kW flex &middot; SoC ' + (s.avgSoc || 0) + '%</div>'
        + '</div>';
    }).join('');

    // Price chart
    const maxP = Math.max(...this.epexPrices.slice(0, 48).map(p => p.price), 0.01);
    const forecastBars = this.epexPrices.slice(0, 48).map(function(p, i) {
      var h = Math.max(6, (p.price / maxP) * 120);
      var color = p.price >= 0.25 ? 'var(--red)' : p.price <= 0.10 ? 'var(--grn)' : 'var(--blu)';
      return '<div style="flex:1;display:flex;align-items:flex-end;min-width:3px">'
        + '<div class="fbar" style="flex:1;height:' + h + 'px;background:' + color + (i === 0 ? ';outline:1px solid var(--cyan)' : '') + '" title="' + p.time.getHours() + ':00 ' + (p.price * 100).toFixed(1) + ' ct/kWh"></div>'
        + '</div>';
    }).join('');

    // Nodes JSON for map
    const nodesJson = JSON.stringify(allNodes.map(n => ({
      id: n.id, name: n.name, lat: n.lat, lon: n.lon,
      maloId: n.maloId, bezirk: n.stadtbezirk,
      soc: +n.battery.soc.toFixed(1), solarW: Math.round(n.solar.powerW),
      flex: n.availableFlexKw, canOffer: n.canOffer, needsDemand: n.needsDemand,
      isLocal: !!n.isLocal, isPeer: !!n.isPeer, isDemo: !!n.isDemo
    })));

    const bezirkeJson = JSON.stringify(KOELN_BEZIRKE);

    // RD3.0 aggregation state
    const currentSlotKey = this.slotScheduler.getCurrentSlotKey();
    const rdAgg = this.redispatchAggregator?.getForSlot(currentSlotKey);
    const rdHist = this.redispatchAggregator?.getHistory(6) || [];
    const rdCalledCount = rdHist.filter(a => a.redispatchCalled).length;

    // Clearing history mini bars
    const clearHist = this.clearingMatcher.getHistory(12);
    const maxClear = Math.max(...clearHist.map(c => c.totalVolumeKwh || 0), 0.01);
    const clearingBars = clearHist.map(function(c, i) {
      var h = Math.max(4, ((c.totalVolumeKwh || 0) / maxClear) * 70);
      return '<div class="clearing-bar-item' + (i === 0 ? ' active' : '') + '" style="height:' + h + 'px" title="' + (c.slotStart ? c.slotStart.slice(11, 16) : '') + ' | ' + (c.totalVolumeKwh || 0).toFixed(2) + ' kWh @ ' + ((c.clearingPrice || 0) * 100).toFixed(1) + ' ct"></div>';
    }).join('');

    // Client JS
    const clientJS = ''
      + 'var NODES = ' + nodesJson + ';\n'
      + 'var BEZIRKE = ' + bezirkeJson + ';\n'
      + 'var FLOW = ' + JSON.stringify(this.activeEnergyFlow) + ';\n'
      + '\n'
      + 'function initMap() {\n'
      + '  var el = document.getElementById("map");\n'
      + '  if (!el) return;\n'
      + '  var center = NODES.find(function(n) { return n.isLocal; }) || { lat: 50.94, lon: 6.96 };\n'
      + '  var map = L.map("map", { zoomControl: true, attributionControl: false, preferCanvas: true }).setView([center.lat, center.lon], 11);\n'
      + '  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(map);\n'
      + '  var rend = L.canvas({ padding: 0.5 });\n'
      + '  BEZIRKE.forEach(function(b) {\n'
      + '    L.circle([b.lat, b.lon], { radius: 1800, color: b.color, fillColor: b.color, fillOpacity: 0.06, weight: 1, dashArray: "4,4" }).addTo(map);\n'
      + '    L.marker([b.lat, b.lon], { icon: L.divIcon({ className: "", html: "<div style=\\"font-size:9px;color:" + b.color + ";font-weight:700;white-space:nowrap\\">" + b.name + "</div>", iconSize: [80, 14], iconAnchor: [40, 7] }) }).addTo(map);\n'
      + '  });\n'
      + '  NODES.forEach(function(n) {\n'
      + '    var bz = BEZIRKE.find(function(b) { return b.name === n.bezirk; });\n'
      + '    var color = n.isLocal ? "#06b6d4" : n.isPeer ? "#a855f7" : (bz ? bz.color : "#3b82f6");\n'
      + '    var radius = n.isLocal ? 10 : n.isPeer ? 7 : 3;\n'
      + '    var weight = n.isLocal ? 2 : n.isPeer ? 1.5 : 0.5;\n'
      + '    var marker = L.circleMarker([n.lat, n.lon], { renderer: rend, radius: radius, fillColor: color, color: (n.isLocal || n.isPeer) ? "#fff" : color, weight: weight, fillOpacity: (n.isLocal || n.isPeer) ? 1 : 0.7 });\n'
      + '    var kind = n.isLocal ? "LOCAL" : n.isPeer ? "PEER" : "DEMO";\n'
      + '    var tip = "<b>[" + kind + "] " + n.name + "</b><br>MaLo: " + (n.maloId || "-")\n'
      + '      + "<br>SoC: " + n.soc.toFixed(0) + "% | Flex: " + n.flex.toFixed(1) + " kW"\n'
      + '      + (n.solarW > 0 ? "<br>PV: " + n.solarW + " W" : "");\n'
      + '    marker.bindTooltip(tip, { direction: "top", offset: [0, -radius] });\n'
      + '    marker.addTo(map);\n'
      + '  });\n'
      + '  window._map = map;\n'
      + '}\n'
      + 'if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", initMap); } else { setTimeout(initMap, 50); }\n'
      + '\n'
      + 'function connectWS() {\n'
      + '  var proto = location.protocol === "https:" ? "wss:" : "ws:";\n'
      + '  var ws = new WebSocket(proto + "//" + location.host + "/ws");\n'
      + '  var st = document.getElementById("ws-status");\n'
      + '  ws.onopen = function() { st.textContent = "Live"; st.style.color = "#22c55e"; };\n'
      + '  ws.onclose = function() { st.textContent = "Reconnecting..."; st.style.color = "#ca8a04"; setTimeout(connectWS, 3000); };\n'
      + '  ws.onmessage = function(e) {\n'
      + '    try {\n'
      + '      var d = JSON.parse(e.data);\n'
      + '      if (d.type === "state") {\n'
      + '        if (d.currentPrice !== undefined) document.getElementById("price").textContent = (d.currentPrice * 100).toFixed(1);\n'
      + '        if (d.earnings !== undefined) document.getElementById("earnings").textContent = d.earnings.toFixed(2);\n'
      + '        if (d.gridFee !== undefined) document.getElementById("grid-fee").textContent = (d.gridFee * 100).toFixed(1);\n'
      + '        if (d.localSoc !== undefined && d.localSoc !== null) {\n'
      + '          var el = document.getElementById("local-soc"); if (el) el.textContent = d.localSoc.toFixed(0) + "%";\n'
      + '          var bar = document.getElementById("local-bar"); if (bar) bar.style.width = d.localSoc + "%";\n'
      + '        }\n'
      + '        if (d.localPower !== undefined && d.localPower !== null) {\n'
      + '          var pw = document.getElementById("local-pwr"); if (pw) pw.textContent = (d.localPower > 0 ? "+" : "") + d.localPower.toFixed(0) + " W";\n'
      + '        }\n'
      + '        if (d.peerCount !== undefined) {\n'
      + '          var pc = document.getElementById("peer-count"); if (pc) pc.textContent = d.peerCount;\n'
      + '        }\n'
      + '        if (d.maloSummary) {\n'
      + '          document.getElementById("malo-count").textContent = d.maloSummary.total;\n'
      + '          document.getElementById("total-flex").textContent = d.maloSummary.totalFlexKw.toFixed(1);\n'
      + '          document.getElementById("total-solar").textContent = (d.maloSummary.totalSolarW / 1000).toFixed(0);\n'
      + '        }\n'
      + '        if (d.nextSlot) document.getElementById("next-slot").textContent = d.nextSlot.slice(11, 16);\n'
      + '        if (d.redispatchHistory) {\n'
      + '          var rdh = d.redispatchHistory;\n'
      + '          var called = rdh.filter(function(a) { return a.redispatchCalled; }).length;\n'
      + '          var rdA = document.getElementById("rd-abrufe"); if (rdA) rdA.textContent = called + " / " + rdh.length;\n'
      + '          if (rdh.length > 0 && rdh[0].netFlexKw !== undefined) {\n'
      + '            var rdAg = document.getElementById("rd-agg"); if (rdAg) rdAg.textContent = rdh[0].netFlexKw.toFixed(1) + " kW (" + rdh[0].status + ")";\n'
      + '          }\n'
      + '        }\n'
      + '      }\n'
      + '    } catch(err) {}\n'
      + '  };\n'
      + '}\n'
      + 'connectWS();\n';

    const body = ''
+ '<div style="margin-top:12px">\n'
+ '  <div class="grid">\n'
+ '    <div class="card c3" style="text-align:center">\n'
+ '      <div class="ctitle">Trading Mode</div>\n'
+ '      <div class="badge badge-' + (this.currentMode === 'SELL' ? 'red' : this.currentMode === 'BUY' ? 'grn' : 'yel') + '" style="font-size:.82rem;padding:6px 20px">' + this.currentMode + '</div>\n'
+ '      <div class="big-num" id="earnings" style="color:var(--cyan);margin-top:10px">' + this.earnings.toFixed(2) + '</div>\n'
+ '      <div class="unit">EUR total revenue</div>\n'
+ '      <div style="margin-top:6px;font-size:.62rem;color:var(--t2)">Settlements: ' + (stlSummary.totalSettlements || 0) + ' | P2P: ' + this.p2pTrades.length + '</div>\n'
+ '    </div>\n'
+ '    <div class="card c3" style="text-align:center">\n'
+ '      <div class="ctitle">EPEX Spot + AgNes</div>\n'
+ '      <div><span class="big-num" id="price" style="color:' + priceColor + '">' + (this.currentPrice * 100).toFixed(1) + '</span><span class="unit"> ct/kWh</span></div>\n'
+ '      <div style="margin-top:4px;font-size:.7rem;color:var(--t1)">Netzentgelt: <span id="grid-fee" style="color:var(--pur-l)">' + (gridFee * 100).toFixed(1) + '</span> ct/kWh</div>\n'
+ '      <div style="margin-top:2px;font-size:.6rem;color:var(--t2)">' + (this.config.agnes_enabled ? 'AgNes dynamisch' : 'Flat-Tarif') + '</div>\n'
+ '    </div>\n'
+ '    <div class="card c6">\n'
+ '      <div class="ctitle">Local Node &middot; ' + this._esc(local?.name || '-') + '</div>\n'
+ '      <div class="bat-row">\n'
+ '        <div class="bat-card">\n'
+ '          <div class="bat-name">' + this._esc(localType) + '</div>\n'
+ '          <div class="bat-soc" id="local-soc" style="color:' + (localSocN > 50 ? 'var(--grn)' : 'var(--yel)') + '">' + localSocN.toFixed(0) + '%</div>\n'
+ '          <div class="bat-bar"><div id="local-bar" class="bat-fill" style="width:' + localSocN + '%;background:' + (localSocN > 50 ? 'var(--grn)' : 'var(--yel)') + '"></div></div>\n'
+ '          <div class="bat-pwr" id="local-pwr">' + (localPwr > 0 ? '+' : '') + localPwr.toFixed(0) + ' W</div>\n'
+ '          <div class="dim">MaLo: ' + this._esc(local?.maloId || '-') + '</div>\n'
+ '          <div class="dim">MeLo: ' + this._esc(local?.meloId || '-') + '</div>\n'
+ '          <div class="dim">SMGw: ' + this._esc(local?.smgwId || '-') + '</div>\n'
+ '          <div class="dim">' + this._esc(local?.address || '-') + '</div>\n'
+ '        </div>\n'
+ '        <div class="bat-card">\n'
+ '          <div class="bat-name">PV / Flex</div>\n'
+ '          <div class="bat-soc" style="color:var(--ora)">' + localSolar.toFixed(0) + ' W</div>\n'
+ '          <div class="bat-pwr">Flex: ' + localFlex.toFixed(2) + ' kW</div>\n'
+ '          <div class="dim">SMGw HAN: ' + this._esc(smgwInfo) + '</div>\n'
+ '          <div class="dim">Peers: <span id="peer-count">' + peers.length + '</span></div>\n'
+ '        </div>\n'
+ '      </div>\n'
+ '      <div style="margin-top:6px;font-size:.6rem;color:var(--t2);max-height:70px;overflow:auto">' + peerListHTML + '</div>\n'
+ '    </div>\n'
+ '    <div class="card c8">\n'
+ '      <div class="ctitle">MaLo Netzwerk &middot; <span id="malo-count">' + ns.total + '</span> Nodes (1 local + ' + peers.length + ' peers + ' + this.maloRegistry.getDemo().length + ' demo)</div>\n'
+ '      <div id="map"></div>\n'
+ '      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:.58rem;color:var(--t2)">\n'
+ '        <span style="display:flex;align-items:center;gap:3px"><span style="width:10px;height:10px;border-radius:50%;background:var(--cyan);border:1px solid #fff"></span>Local</span>\n'
+ '        <span style="display:flex;align-items:center;gap:3px"><span style="width:10px;height:10px;border-radius:50%;background:#a855f7;border:1px solid #fff"></span>Peer (peaq)</span>\n'
+ KOELN_BEZIRKE.map(function(b) {
  return '<span style="display:flex;align-items:center;gap:3px"><span style="width:8px;height:8px;border-radius:50%;background:' + b.color + '"></span>' + b.name + '</span>';
}).join('')
+ '      </div>\n'
+ '    </div>\n'
+ '    <div class="card c4">\n'
+ '      <div class="ctitle">Flex-Markt &middot; Next Slot</div>\n'
+ '      <div class="slot-card" style="text-align:center;margin-bottom:8px">\n'
+ '        <div class="slot-label">RD3.0 Merit-Order (15 min)</div>\n'
+ '        <div class="slot-time" id="next-slot">' + nextSlot + '</div>\n'
+ '      </div>\n'
+ '      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:.68rem">\n'
+ '        <div style="background:var(--bg2);padding:8px;border-radius:6px;border:1px solid var(--bdr)">\n'
+ '          <div class="dim">Total Flex</div>\n'
+ '          <div style="font-weight:700;color:var(--cyan)" id="total-flex">' + ns.totalFlexKw.toFixed(1) + '</div>\n'
+ '          <div class="dim">kW verfuegbar</div>\n'
+ '        </div>\n'
+ '        <div style="background:var(--bg2);padding:8px;border-radius:6px;border:1px solid var(--bdr)">\n'
+ '          <div class="dim">Solar Fleet</div>\n'
+ '          <div style="font-weight:700;color:var(--ora)" id="total-solar">' + (ns.totalSolarW / 1000).toFixed(0) + '</div>\n'
+ '          <div class="dim">kW Erzeugung</div>\n'
+ '        </div>\n'
+ '        <div style="background:var(--bg2);padding:8px;border-radius:6px;border:1px solid var(--bdr)">\n'
+ '          <div class="dim">Kapazitaet</div>\n'
+ '          <div style="font-weight:700;color:var(--pur-l)">' + ns.totalCapacityKwh + '</div>\n'
+ '          <div class="dim">kWh Speicher</div>\n'
+ '        </div>\n'
+ '        <div style="background:var(--bg2);padding:8px;border-radius:6px;border:1px solid var(--bdr)">\n'
+ '          <div class="dim">Avg SoC</div>\n'
+ '          <div style="font-weight:700;color:var(--grn-l)">' + ns.avgSoc + '%</div>\n'
+ '          <div class="dim">Flotte</div>\n'
+ '        </div>\n'
+ '      </div>\n'
+ '      <div style="margin-top:8px">\n'
+ '        <div class="dim" style="margin-bottom:4px">Clearing History (last 12 slots)</div>\n'
+ '        <div class="clearing-bar">' + clearingBars + '</div>\n'
+ '        <div style="font-size:.6rem;color:var(--t2);text-align:center">' + (lastClearing ? 'Last: ' + ((lastClearing.clearingPrice || 0) * 100).toFixed(1) + ' ct | ' + (lastClearing.totalVolumeKwh || 0).toFixed(2) + ' kWh | ' + (lastClearing.matchedPairs?.length || 0) + ' pairs' : 'No clearings yet') + '</div>\n'
+ '      </div>\n'
+ '    </div>\n'
+ '    <div class="card c12">\n'
+ '      <div class="ctitle">Stadtbezirke Koeln &middot; Community Fleet</div>\n'
+ '      <div class="bezirk-grid">' + bezirkCards + '</div>\n'
+ '    </div>\n'
+ '    <div class="card c8">\n'
+ '      <div class="ctitle">48h EPEX Preisprognose</div>\n'
+ '      <div style="display:flex;align-items:flex-end;gap:1px;height:120px;padding:0 2px">' + forecastBars + '</div>\n'
+ '      <div style="display:flex;justify-content:space-between;font-size:.58rem;color:var(--t2);margin-top:3px"><span>Jetzt</span><span>+12h</span><span>+24h</span><span>+36h</span><span>+48h</span></div>\n'
+ '    </div>\n'
+ '    <div class="card c4">\n'
+ '      <div class="ctitle">Redispatch 3.0</div>\n'
+ '      <div class="info-grid">\n'
+ '        <div class="info-item"><div class="info-lbl">Verfahren</div><div class="info-val">Pay-as-Bid (MOL)</div></div>\n'
+ '        <div class="info-item"><div class="info-lbl">Gateway</div><div class="info-val" style="color:' + (this.config.redispatch_gateway_url ? 'var(--grn)' : 'var(--yel)') + '">' + (this.config.redispatch_gateway_url ? 'Aktiv' : 'Simulation') + '</div></div>\n'
+ '        <div class="info-item"><div class="info-lbl">Aggregation</div><div class="info-val" id="rd-agg">' + (rdAgg ? rdAgg.netFlexKw.toFixed(1) + ' kW (' + rdAgg.status + ')' : '-') + '</div></div>\n'
+ '        <div class="info-item"><div class="info-lbl">Abrufe (6 Slots)</div><div class="info-val" id="rd-abrufe" style="color:' + (rdCalledCount > 0 ? 'var(--grn)' : 'var(--t1)') + '">' + rdCalledCount + ' / ' + rdHist.length + '</div></div>\n'
+ '        <div class="info-item"><div class="info-lbl">Min. Flex</div><div class="info-val">' + (this.config.redispatch_min_flex_kw || 1.0) + ' kW</div></div>\n'
+ '        <div class="info-item"><div class="info-lbl">Bilanzierung</div><div class="info-val">Planwertmodell</div></div>\n'
+ '      </div>\n'
+ '    </div>\n'
+ '    <div class="card c4">\n'
+ '      <div class="ctitle">Blockchain Identity</div>\n'
+ '      <div class="info-grid">\n'
+ '        <div class="info-item"><div class="info-lbl">Network</div><div class="info-val">' + (this.config.network_type || '') + '</div></div>\n'
+ '        <div class="info-item"><div class="info-lbl">Status</div><div class="info-val" style="color:' + (this.chain?.demoMode ? 'var(--yel)' : 'var(--grn)') + '">' + (this.chain?.demoMode ? 'Demo' : 'Live') + '</div></div>\n'
+ '        <div class="info-item"><div class="info-lbl">Wallet</div><div class="info-val">' + (this.machineWallet?.getAddress()?.slice(0, 18) + '...' || '') + '</div></div>\n'
+ '        <div class="info-item"><div class="info-lbl">DID</div><div class="info-val">' + (this.did?.slice(0, 24) + '...' || '') + '</div></div>\n'
+ '      </div>\n'
+ '    </div>\n'
+ '  </div>\n'
+ '  <footer>TheElectronChain v4.1.0 &middot; 1 local + ' + peers.length + ' peers + ' + this.maloRegistry.getDemo().length + ' demo &middot; Session: ' + this.sessionStart.toLocaleString('de-DE') + ' &middot; <a href="/flex">Flex-Markt</a> &middot; <a href="/settlement">Settlement</a> &middot; <a href="/api/status">API</a></footer>\n'
+ '</div>\n';

    return this._darkShell('/', 'Dashboard', body,
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.css"/>\n'
      + '<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js"></script>\n')
      .replace('</body>', '<script>\n' + clientJS + '</script>\n</body>');
  }

  // -------------------------------------------------------------------------
  // Flex-Markt HTML
  // -------------------------------------------------------------------------
  generateFlexMarktHTML() {
    const nextSlot = this.slotScheduler.getNextSlotKey();
    const nextLabel = SlotScheduler.slotLabel(nextSlot);
    const bids = this.slotScheduler.getBidsForSlot(nextSlot);
    const offers = bids.filter(b => b.direction === 'offer');
    const demands = bids.filter(b => b.direction === 'demand');
    const hist = this.clearingMatcher.getHistory(12);

    const offerRows = offers.slice(0, 15).map(function(b) {
      return '<tr>'
        + '<td style="color:var(--grn)">' + b.maloId + '</td>'
        + '<td>' + b.powerKw.toFixed(1) + '</td>'
        + '<td>' + (b.priceEurKwh * 100).toFixed(1) + '</td>'
        + '<td class="dim">' + b.source + '</td>'
        + '<td class="dim">' + b.priority + '</td>'
        + '<td><span class="badge badge-' + (b.status === 'matched' ? 'grn' : 'yel') + '">' + b.status + '</span></td>'
        + '</tr>';
    }).join('') || '<tr><td colspan="6" class="dim" style="text-align:center;padding:12px">Keine Angebote</td></tr>';

    const demandRows = demands.slice(0, 15).map(function(b) {
      return '<tr>'
        + '<td style="color:var(--red)">' + b.maloId + '</td>'
        + '<td>' + b.powerKw.toFixed(1) + '</td>'
        + '<td>' + (b.priceEurKwh * 100).toFixed(1) + '</td>'
        + '<td class="dim">' + b.source + '</td>'
        + '<td class="dim">' + b.priority + '</td>'
        + '<td><span class="badge badge-' + (b.status === 'matched' ? 'grn' : 'yel') + '">' + b.status + '</span></td>'
        + '</tr>';
    }).join('') || '<tr><td colspan="6" class="dim" style="text-align:center;padding:12px">Keine Nachfrage</td></tr>';

    const histRows = hist.map(function(c) {
      return '<tr>'
        + '<td style="color:var(--cyan)">' + (c.slotStart ? c.slotStart.slice(11, 16) : '-') + '</td>'
        + '<td>' + ((c.clearingPrice || 0) * 100).toFixed(1) + '</td>'
        + '<td>' + (c.matchedPairs?.length || 0) + '</td>'
        + '<td>' + (c.totalVolumeKwh || 0).toFixed(2) + '</td>'
        + '<td class="dim">' + (c.unmatchedOffers || 0) + '/' + (c.unmatchedDemands || 0) + '</td>'
        + '</tr>';
    }).join('') || '<tr><td colspan="5" class="dim" style="text-align:center;padding:12px">Noch keine Clearings</td></tr>';

    const body = ''
+ '<div style="margin-top:12px">\n'
+ '  <div class="grid">\n'
+ '    <div class="card c4" style="text-align:center">\n'
+ '      <div class="ctitle">Naechster 15-Min Slot</div>\n'
+ '      <div class="slot-card">\n'
+ '        <div class="slot-label">Pay-as-Bid (MOL)</div>\n'
+ '        <div class="slot-time">' + nextLabel + '</div>\n'
+ '        <div style="margin-top:6px;font-size:.7rem;color:var(--t1)">' + offers.length + ' Angebote &middot; ' + demands.length + ' Nachfrage</div>\n'
+ '      </div>\n'
+ '      <div style="margin-top:12px;text-align:left">\n'
+ '        <div class="dim" style="margin-bottom:6px">RD3.0 Slot-Lifecycle</div>\n'
+ '        <div style="font-size:.65rem;color:var(--t1);line-height:1.8">\n'
+ '          T-5min: RDV-Meldung Refresh<br>\n'
+ '          T-4min: Gebotssammlung (MOL)<br>\n'
+ '          T-2min: Aggregation &rarr; Gateway<br>\n'
+ '          T-1min: P2P-Clearing (Residual)<br>\n'
+ '          T+0: Abruf &amp; Fahrplan<br>\n'
+ '          T+15: Abrechnung (Planwert)\n'
+ '        </div>\n'
+ '      </div>\n'
+ '    </div>\n'
+ '    <div class="card c8">\n'
+ '      <div class="ctitle">Flex-Gebote &middot; Slot ' + nextLabel + '</div>\n'
+ '      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">\n'
+ '        <div>\n'
+ '          <div style="font-size:.7rem;font-weight:600;color:var(--grn);margin-bottom:4px">Angebote (Offer)</div>\n'
+ '          <div class="scroll-y"><table><thead><tr><th>MaLo</th><th>kW</th><th>ct/kWh</th><th>Src</th><th>Prio</th><th>Status</th></tr></thead><tbody>' + offerRows + '</tbody></table></div>\n'
+ '        </div>\n'
+ '        <div>\n'
+ '          <div style="font-size:.7rem;font-weight:600;color:var(--red);margin-bottom:4px">Nachfrage (Demand)</div>\n'
+ '          <div class="scroll-y"><table><thead><tr><th>MaLo</th><th>kW</th><th>ct/kWh</th><th>Src</th><th>Prio</th><th>Status</th></tr></thead><tbody>' + demandRows + '</tbody></table></div>\n'
+ '        </div>\n'
+ '      </div>\n'
+ '    </div>\n'
+ '    <div class="card c12">\n'
+ '      <div class="ctitle">Clearing History</div>\n'
+ '      <div class="scroll-y"><table><thead><tr><th>Slot</th><th>Clearing ct/kWh</th><th>Pairs</th><th>Volume kWh</th><th>Unmatched (O/D)</th></tr></thead><tbody>' + histRows + '</tbody></table></div>\n'
+ '    </div>\n'
+ '  </div>\n'
+ '  <footer>TheElectronChain v4.1.0 &middot; <a href="/">Dashboard</a> &middot; <a href="/settlement">Settlement</a> &middot; <a href="/api/flex/clearing">Clearing API</a></footer>\n'
+ '</div>\n';

    return this._darkShell('/flex', 'Flex-Markt', body, '');
  }

  // -------------------------------------------------------------------------
  // Netzwerk HTML
  // -------------------------------------------------------------------------
  generateNetzwerkHTML() {
    const allNodes = this.maloRegistry.getAll();
    const ns = this.maloRegistry.summary();
    const nodesJson = JSON.stringify(allNodes.map(n => ({
      id: n.id, name: n.name, lat: n.lat, lon: n.lon,
      maloId: n.maloId, meloId: n.meloId, bezirk: n.stadtbezirk,
      soc: +n.battery.soc.toFixed(1), solarW: Math.round(n.solar.powerW),
      flex: n.availableFlexKw, capKwh: +(n.battery.capacityWh / 1000).toFixed(1),
      type: n.battery.type || '-', canOffer: n.canOffer, needsDemand: n.needsDemand,
      isHA: !!n.haPrefix
    })));

    const tableRows = allNodes.slice(0, 50).map(function(n) {
      var socClr = n.battery.soc > 50 ? 'var(--grn)' : n.battery.soc > 20 ? 'var(--yel)' : 'var(--red)';
      var statusClr = n.canOffer ? 'var(--grn)' : n.needsDemand ? 'var(--red)' : 'var(--t2)';
      var statusTxt = n.canOffer ? 'OFFER' : n.needsDemand ? 'DEMAND' : '-';
      return '<tr' + (n.haPrefix ? ' style="background:rgba(6,182,212,.08)"' : '') + '>'
        + '<td style="font-weight:' + (n.haPrefix ? '600' : '400') + ';color:' + (n.haPrefix ? 'var(--cyan)' : 'var(--t0)') + '">' + (n.haPrefix ? '* ' : '') + n.name + '</td>'
        + '<td class="mono">' + n.maloId + '</td>'
        + '<td>' + n.stadtbezirk + '</td>'
        + '<td style="color:' + socClr + ';font-weight:600">' + n.battery.soc.toFixed(0) + '%</td>'
        + '<td style="color:var(--ora)">' + (n.solar.hasSolar ? Math.round(n.solar.powerW) + ' W' : '-') + '</td>'
        + '<td style="color:var(--cyan)">' + n.availableFlexKw.toFixed(1) + '</td>'
        + '<td>' + (n.battery.capacityWh / 1000).toFixed(1) + '</td>'
        + '<td style="color:' + statusClr + ';font-weight:600">' + statusTxt + '</td>'
        + '</tr>';
    }).join('');

    var moreNodes = allNodes.length > 50
      ? '<div class="dim" style="text-align:center;padding:8px">+' + (allNodes.length - 50) + ' weitere MaLos</div>'
      : '';

    var netzwerkJS = ''
      + 'var ND = ' + nodesJson + ';\n'
      + 'var BZ = ' + JSON.stringify(KOELN_BEZIRKE) + ';\n'
      + 'var map = L.map("nw-map", { preferCanvas: true }).setView([50.94, 6.96], 12);\n'
      + 'L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(map);\n'
      + 'var rend = L.canvas({ padding: 0.5 });\n'
      + 'BZ.forEach(function(b) {\n'
      + '  L.circle([b.lat, b.lon], { radius: 1800, color: b.color, fillColor: b.color, fillOpacity: 0.06, weight: 1, dashArray: "4,4" }).addTo(map);\n'
      + '});\n'
      + 'ND.forEach(function(n) {\n'
      + '  var bz = BZ.find(function(b) { return b.name === n.bezirk; });\n'
      + '  var color = n.isHA ? "#06b6d4" : (bz ? bz.color : "#3b82f6");\n'
      + '  var r = n.isHA ? 7 : 3;\n'
      + '  var m = L.circleMarker([n.lat, n.lon], { renderer: rend, radius: r, fillColor: color, color: n.isHA ? "#fff" : color, weight: n.isHA ? 2 : 0.5, fillOpacity: n.isHA ? 1 : 0.7 });\n'
      + '  m.bindTooltip("<b>" + n.name + "</b><br>MaLo: " + n.maloId + "<br>MELo: " + n.meloId.slice(0,20) + "...<br>SoC: " + n.soc + "% | Flex: " + n.flex + " kW<br>Batterie: " + n.capKwh + " kWh (" + n.type + ")");\n'
      + '  m.addTo(map);\n'
      + '});\n';

    const rdvAgg = this.redispatchAggregator?.getForSlot(this.slotScheduler.getCurrentSlotKey());
    const offerNodes = allNodes.filter(n => n.canOffer).length;
    const demandNodes = allNodes.filter(n => n.needsDemand).length;

    var body = ''
+ '<div style="margin-top:12px">\n'
+ '  <div class="grid">\n'
+ '    <div class="card c3">\n'
+ '      <div class="ctitle">RDV Pool-Aggregation</div>\n'
+ '      <div style="text-align:center">\n'
+ '        <div class="big-num" style="color:var(--cyan)">' + ns.totalFlexKw.toFixed(1) + '</div>\n'
+ '        <div class="unit">kW RDV gesamt</div>\n'
+ '      </div>\n'
+ '      <div style="margin-top:8px;font-size:.68rem;color:var(--t1)">\n'
+ '        <div style="display:flex;justify-content:space-between"><span>Angebot (positiv)</span><span style="color:var(--grn)">' + offerNodes + ' MaLos</span></div>\n'
+ '        <div style="display:flex;justify-content:space-between"><span>Nachfrage (negativ)</span><span style="color:var(--red)">' + demandNodes + ' MaLos</span></div>\n'
+ '        <div style="display:flex;justify-content:space-between;margin-top:4px"><span>Aggregation</span><span>' + (rdvAgg ? rdvAgg.status : 'pending') + '</span></div>\n'
+ '        <div style="display:flex;justify-content:space-between"><span>Netto-Flex</span><span style="color:var(--cyan)">' + (rdvAgg ? rdvAgg.netFlexKw.toFixed(1) : ns.totalFlexKw.toFixed(1)) + ' kW</span></div>\n'
+ '      </div>\n'
+ '    </div>\n'
+ '    <div class="card c9">\n'
+ '      <div class="ctitle">MaLo Netzwerk K&ouml;ln &middot; ' + ns.total + ' Marktlokationen &middot; 9 Stadtbezirke</div>\n'
+ '      <div id="nw-map" style="height:400px;border-radius:6px;border:1px solid var(--bdr)"></div>\n'
+ '    </div>\n'
+ '    <div class="card c12">\n'
+ '      <div class="ctitle">MaLo Registry</div>\n'
+ '      <div class="scroll-y" style="max-height:500px">\n'
+ '        <table><thead><tr><th>Name</th><th>MaLo-ID</th><th>Bezirk</th><th>SoC</th><th>PV</th><th>Flex kW</th><th>Cap kWh</th><th>Status</th></tr></thead>\n'
+ '        <tbody>' + tableRows + '</tbody></table>\n'
+ '        ' + moreNodes + '\n'
+ '      </div>\n'
+ '    </div>\n'
+ '  </div>\n'
+ '  <footer>TheElectronChain v4.1.0 &middot; <a href="/">Dashboard</a> &middot; <a href="/flex">Flex-Markt</a> &middot; <a href="/api/malos">MaLo API</a></footer>\n'
+ '</div>\n';

    return this._darkShell('/netzwerk', 'Netzwerk', body,
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.css"/>\n'
      + '<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js"></script>\n')
      .replace('</body>', '<script>\n' + netzwerkJS + '</script>\n</body>');
  }

  // -------------------------------------------------------------------------
  // Settlement HTML
  // -------------------------------------------------------------------------
  generateSettlementHTML() {
    const stl = this.settlementEngine?.getSummary() || {};
    const hist = this.settlementEngine?.getHistory(24) || [];
    const gridSchedule = this.dynamicGridFee.getSchedule(24);

    const rdHist = this.redispatchAggregator?.getHistory(24) || [];
    const rdRows = rdHist.filter(a => a.redispatchCalled).map(function(a) {
      return '<tr>'
        + '<td style="color:var(--cyan)">' + (a.slotStart ? a.slotStart.slice(11, 16) : '-') + '</td>'
        + '<td>' + (a.netFlexKw || 0).toFixed(1) + '</td>'
        + '<td>' + (a.redispatchVolume || 0).toFixed(1) + '</td>'
        + '<td>' + ((a.redispatchPrice || 0) * 100).toFixed(1) + '</td>'
        + '<td>' + (a.maloIds?.length || 0) + '</td>'
        + '<td><span class="badge badge-grn">Abgerufen</span></td>'
        + '</tr>';
    }).join('') || '<tr><td colspan="6" class="dim" style="text-align:center;padding:12px">Keine Redispatch-Abrufe</td></tr>';

    const stlRows = hist.map(function(s) {
      return '<tr>'
        + '<td style="color:var(--cyan)">' + (s.slotStart ? s.slotStart.slice(11, 16) : '-') + '</td>'
        + '<td>' + ((s.clearingPrice || 0) * 100).toFixed(1) + '</td>'
        + '<td>' + (s.totalKwh || 0).toFixed(3) + '</td>'
        + '<td style="color:var(--grn-l)">' + (s.totalEur || 0).toFixed(4) + '</td>'
        + '<td>' + (s.pairs || 0) + '</td>'
        + '<td><span class="badge ' + (s.onChain ? 'badge-grn' : 'badge-yel') + '">' + (s.onChain ? 'On-Chain' : 'Local') + '</span></td>'
        + '<td class="mono dim">' + (s.id || '-') + '</td>'
        + '</tr>';
    }).join('') || '<tr><td colspan="7" class="dim" style="text-align:center;padding:12px">Noch keine Settlements</td></tr>';

    const feeRows = gridSchedule.slice(0, 48).map(function(f) {
      var tierColor = f.tier === 'peak' || f.tier === 'evening_peak' ? 'var(--red)' : f.tier === 'off_peak' || f.tier === 'solar_valley' ? 'var(--grn)' : 'var(--t1)';
      return '<tr>'
        + '<td class="mono">' + (f.time ? f.time.slice(11, 16) : '-') + '</td>'
        + '<td style="font-weight:600;color:' + tierColor + '">' + (f.fee * 100).toFixed(2) + '</td>'
        + '<td><span class="badge badge-' + (f.tier === 'peak' || f.tier === 'evening_peak' ? 'red' : f.tier === 'off_peak' || f.tier === 'solar_valley' ? 'grn' : 'yel') + '">' + f.tier + '</span></td>'
        + '</tr>';
    }).join('');

    var body = ''
+ '<div style="margin-top:12px">\n'
+ '  <div class="grid">\n'
+ '    <div class="card c3" style="text-align:center">\n'
+ '      <div class="ctitle">Abrechnung (Planwertmodell)</div>\n'
+ '      <div class="big-num" style="color:var(--cyan)">' + (stl.totalSettledEur || 0).toFixed(2) + '</div>\n'
+ '      <div class="unit">EUR Verg&uuml;tung gesamt</div>\n'
+ '      <div style="margin-top:8px;font-size:.7rem;color:var(--t1)">\n'
+ '        ' + (stl.totalSettlements || 0) + ' Abrechnungen<br>\n'
+ '        ' + (stl.totalSettledKwh || 0).toFixed(2) + ' kWh gehandelt<br>\n'
+ '        &empty; ' + ((stl.avgClearingPrice || 0) * 100).toFixed(1) + ' ct/kWh (Pay-as-Bid)\n'
+ '      </div>\n'
+ '    </div>\n'
+ '    <div class="card c9">\n'
+ '      <div class="ctitle">Abrechnungshistorie (Peaq On-Chain)</div>\n'
+ '      <div class="scroll-y"><table><thead><tr><th>Slot</th><th>Preis ct</th><th>kWh</th><th>EUR</th><th>Abrufe</th><th>Status</th><th>ID</th></tr></thead><tbody>' + stlRows + '</tbody></table></div>\n'
+ '    </div>\n'
+ '    <div class="card c12">\n'
+ '      <div class="ctitle">Redispatch 3.0 Abrufhistorie (Zentral)</div>\n'
+ '      <div class="scroll-y" style="max-height:300px"><table><thead><tr><th>Slot</th><th>Aggreg. kW</th><th>Abruf kW</th><th>Preis ct</th><th>MaLos</th><th>Status</th></tr></thead><tbody>' + rdRows + '</tbody></table></div>\n'
+ '    </div>\n'
+ '    <div class="card c12">\n'
+ '      <div class="ctitle">AgNes Netzentgelte &middot; Dynamische Grid Fees (15-min Granularit&auml;t)</div>\n'
+ '      <div class="scroll-y" style="max-height:400px"><table><thead><tr><th>Zeit</th><th>Fee ct/kWh</th><th>Tier</th></tr></thead><tbody>' + feeRows + '</tbody></table></div>\n'
+ '    </div>\n'
+ '  </div>\n'
+ '  <footer>TheElectronChain v4.1.0 &middot; <a href="/">Dashboard</a> &middot; <a href="/flex">Flex-Markt</a> &middot; <a href="/api/flex/settlement">Settlement API</a></footer>\n'
+ '</div>\n';

    return this._darkShell('/settlement', 'Settlement', body, '');
  }

  // -------------------------------------------------------------------------
  // Cron Scheduling + Initialize
  // -------------------------------------------------------------------------
  async initialize() {
    console.log('');
    console.log('  ========================================');
    console.log('  TheElectronChain v4.1.0');
    console.log('  Decentralized MaLo Node');
    console.log('  Local Flexibility Market + Peaq DePIN');
    console.log('  ========================================');
    console.log('');

    await this.loadConfig();
    await this.initializeMachineWallet();
    await this.connectToPeaq();
    await this.registerMachineDID();
    await this.initializeNodes();
    await this.fetchEPEXPrices();
    await this.optimizeForForecast();

    this.generateFlexBids();

    this.startWebUI();

    // Peer discovery: publish local node metadata + read seeds (1-hop gossip)
    try {
      await this.publishLocalNode();
      await this.discoverPeers();
    } catch (err) {
      this.log('debug', 'Initial discovery: ' + err.message.slice(0, 80));
    }
    this.startDiscoveryLoop();

    // Every 15 minutes: EPEX prices + PV forecast + flex bid generation
    cron.schedule('*/15 * * * *', async () => {
      await this.fetchEPEXPrices();
      await this.optimizeForForecast();
      this.maloRegistry.refreshAllFlexSpaces();
      this.generateFlexBids();
    });

    // Every minute: node state update + order matching
    cron.schedule('* * * * *', async () => {
      await this.updateAllNodeStates();
      await this.processOrderMatches();
    });

    // Every 5 minutes: trading decision + flex auction
    cron.schedule('*/5 * * * *', async () => {
      await this.makeTradingDecision();
      await this.runSlotAuction();
    });

    // Slot boundary: run auction at :00, :15, :30, :45
    cron.schedule('0,15,30,45 * * * *', async () => {
      this.log('info', '--- SLOT BOUNDARY ---');
      this.maloRegistry.refreshAllFlexSpaces();
      this.generateFlexBids();
      await this.runSlotAuction();
    });

    this.log('info', 'TheElectronChain v4.1.0 running — 1 local + '
      + this.maloRegistry.getPeers().length + ' peers + '
      + this.maloRegistry.getDemo().length + ' demo nodes');
  }

  async cleanup() {
    this.log('info', 'Shutting down...');
    if (this._discoveryTimer) clearInterval(this._discoveryTimer);
    try {
      if (this.chain) await this.chain.storeData('session_end', {
        timestamp: new Date().toISOString(),
        trades: this.trades.length,
        earnings: this.earnings,
        settlements: this.settlementEngine?.settlements.length || 0
      });
      await this.chain?.disconnect();
    } catch {}
  }
}

// ===========================================================================
// Startup
// ===========================================================================
const app = new TheElectronChain();

process.on('SIGTERM', async () => { await app.cleanup(); process.exit(0); });
process.on('SIGINT',  async () => { await app.cleanup(); process.exit(0); });

app.initialize().catch(err => {
  console.error('[FATAL] ' + err.message);
  console.error(err.stack);
  process.exit(1);
});
