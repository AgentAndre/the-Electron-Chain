#!/usr/bin/env node
// @ts-nocheck
/**
 * TheElectronChain v4.0.0
 *
 * Cologne MaLo Aggregation Platform — Local Flexibility Market
 * - 200+ MaLos across 9 Kölner Stadtbezirke
 * - MaLo-ID: 11-digit BDEW format | MELo-ID: 33-char DE prefix
 * - EFDM v1.1 (Fraunhofer/TU Darmstadt): FlexSpace, FLMP, FLMAP
 * - Uniform Price Auction (pay-as-cleared) per 15-min slot
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
                battery = {}, solar = {}, smgCert = null, pvConfig = null, prosumerType = 'prosumer' }) {
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
  get(id)        { return this.nodes.get(id); }
  getAll()       { return [...this.nodes.values()]; }
  getHA()        { return this.getAll().filter(n => n.haPrefix); }
  getDemo()      { return this.getAll().filter(n => !n.haPrefix); }

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

  generateCologneNodes(count = 200) {
    const battTypes = ['BYD HVS', 'Pylontech US5000', 'Sonnen eco 10', 'E3/DC S10', 'SENEC V3',
                       'Solarwatt MyReserve', 'Anker Solix', 'Zendure Hyper', 'VARTA pulse neo',
                       'Huawei LUNA2000', 'Tesla Powerwall', 'RCT Power Battery'];
    const caps = [2400, 5000, 7500, 10000, 13500, 15000, 20000];
    const streets = [
      'Aachener Str', 'Venloer Str', 'Subbelrather Str', 'Neusser Str', 'Amsterdamer Str',
      'Zülpicher Str', 'Luxemburger Str', 'Bonner Str', 'Siegburger Str', 'Deutzer Freiheit',
      'Kalker Hauptstr', 'Frankfurter Str', 'Mülheimer Freiheit', 'Berliner Str', 'Dürener Str',
      'Universitätsstr', 'Pohligstr', 'Sülzburgstr', 'Brühler Str', 'Rondorfer Hauptstr',
      'Chorweiler Ringstr', 'Militärringstr', 'Innere Kanalstr', 'Merheimer Str', 'Longericher Str',
      'Am Porzer Rheinufer', 'Gremberger Str', 'Poll-Vingster Str', 'Olpener Str', 'Thurner Str'
    ];
    const prosumerTypes = ['prosumer', 'prosumer', 'prosumer', 'consumer', 'producer'];

    for (let i = 0; i < count; i++) {
      const bezirk = KOELN_BEZIRKE[i % 9];
      const spread = 0.025;
      const capWh  = caps[Math.floor(Math.random() * caps.length)];
      const hasSolar = Math.random() > 0.15;
      const peakW    = [1600, 2000, 3000, 4000, 5000, 7000, 10000][Math.floor(Math.random() * 7)];
      const lat      = bezirk.lat + (Math.random() - 0.5) * spread * 2;
      const lon      = bezirk.lon + (Math.random() - 0.5) * spread * 2;
      const street   = streets[Math.floor(Math.random() * streets.length)];
      const houseNr  = Math.floor(Math.random() * 200) + 1;
      const maloId   = MaloRegistry.generateMaloId(i + 1);
      const meloId   = MaloRegistry.generateMeloId(i + 1);
      const pType    = prosumerTypes[Math.floor(Math.random() * prosumerTypes.length)];

      this.register(new MaloNode({
        id:          'malo_' + (i + 1),
        maloId:      maloId,
        meloId:      meloId,
        name:        bezirk.name + ' MaLo-' + (i + 1),
        lat, lon,
        stadtbezirk: bezirk.name,
        address:     street + ' ' + houseNr + ', ' + bezirk.plzPrefix + String(Math.floor(Math.random() * 100)).padStart(2, '0') + ' Köln',
        prosumerType: pType,
        smgCert:     meloId,
        battery: {
          soc:        Math.random() * 80 + 10,
          capacityWh: capWh,
          type:       battTypes[Math.floor(Math.random() * battTypes.length)]
        },
        solar: { hasSolar, powerW: 0, peakW },
        pvConfig: hasSolar ? {
          tilt:    15 + Math.random() * 30,
          azimuth: 140 + Math.random() * 80,
          peakWp:  peakW,
          pr:      0.72 + Math.random() * 0.08
        } : null
      }));
    }
  }

  updateDemoStates() {
    const now = new Date();
    for (const node of this.nodes.values()) {
      if (node.haPrefix) continue;

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
// FlexBid — Flexibility bid for 15-min slot auction
// ===========================================================================
class FlexBid {
  constructor({ maloId, meloId, did, slotStart, direction, powerKw, priceEurKwh,
                source = 'battery', flexSpaceRef = null, priority = 5 }) {
    this.bidId        = 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    this.maloId       = maloId;
    this.meloId       = meloId;
    this.did          = did;
    this.slotStart    = slotStart;
    this.direction    = direction;
    this.powerKw      = powerKw;
    this.energyKwh    = +(powerKw * 0.25).toFixed(4);
    this.priceEurKwh  = priceEurKwh;
    this.source       = source;
    this.flexSpaceRef = flexSpaceRef;
    this.priority     = Math.max(1, Math.min(10, Math.round(priority)));
    this.status       = 'pending';
    this.createdAt    = new Date().toISOString();
    this.clearingPrice = null;
    this.matchedWith  = null;
  }

  toJSON() {
    return { ...this };
  }
}

// ===========================================================================
// ClearingMatcher — Uniform Price Auction (pay-as-cleared)
// ===========================================================================
class ClearingMatcher {
  constructor() {
    this.clearingHistory = [];
  }

  clearSlot(bids, slotStart) {
    const offers  = bids.filter(b => b.direction === 'offer' && b.status === 'pending')
      .sort((a, b) => a.priceEurKwh - b.priceEurKwh || b.priority - a.priority);
    const demands = bids.filter(b => b.direction === 'demand' && b.status === 'pending')
      .sort((a, b) => b.priceEurKwh - a.priceEurKwh || b.priority - a.priority);

    if (offers.length === 0 || demands.length === 0) {
      return { slotStart, clearingPrice: null, matchedPairs: [], unmatchedOffers: offers.length, unmatchedDemands: demands.length, totalVolumeKwh: 0 };
    }

    let supplyKwh = 0;
    let demandKwh = 0;
    let clearingPrice = null;
    let si = 0, di = 0;

    const supplyStack = [];
    const demandStack = [];

    for (const o of offers) supplyStack.push({ bid: o, cumKwh: (supplyKwh += o.energyKwh) });
    for (const d of demands) demandStack.push({ bid: d, cumKwh: (demandKwh += d.energyKwh) });

    const totalVolume = Math.min(supplyKwh, demandKwh);

    let matchedSupply = 0;
    let matchedDemand = 0;
    si = 0; di = 0;

    while (si < supplyStack.length && di < demandStack.length) {
      const offer  = supplyStack[si].bid;
      const demand = demandStack[di].bid;

      if (offer.priceEurKwh <= demand.priceEurKwh) {
        clearingPrice = offer.priceEurKwh;
        matchedSupply += offer.energyKwh;
        matchedDemand += demand.energyKwh;

        if (matchedSupply <= matchedDemand) si++;
        if (matchedDemand <= matchedSupply) di++;
      } else {
        break;
      }
    }

    if (clearingPrice === null) {
      return { slotStart, clearingPrice: null, matchedPairs: [], unmatchedOffers: offers.length, unmatchedDemands: demands.length, totalVolumeKwh: 0 };
    }

    const matchedPairs = [];
    const usedOffers  = new Set();
    const usedDemands = new Set();

    for (const o of offers) {
      if (o.priceEurKwh > clearingPrice) continue;
      for (const d of demands) {
        if (usedDemands.has(d.bidId)) continue;
        if (d.priceEurKwh < clearingPrice) continue;
        if (o.maloId === d.maloId) continue;

        const volumeKwh = Math.min(o.energyKwh, d.energyKwh);
        matchedPairs.push({
          offerBid:     o.bidId,
          demandBid:    d.bidId,
          offerMalo:    o.maloId,
          demandMalo:   d.maloId,
          volumeKwh:    +volumeKwh.toFixed(4),
          clearingPrice: +clearingPrice.toFixed(4),
          totalEur:     +(volumeKwh * clearingPrice).toFixed(4)
        });

        o.status        = 'matched';
        o.clearingPrice = clearingPrice;
        o.matchedWith   = d.bidId;
        d.status        = 'matched';
        d.clearingPrice = clearingPrice;
        d.matchedWith   = o.bidId;

        usedOffers.add(o.bidId);
        usedDemands.add(d.bidId);
        break;
      }
    }

    const result = {
      slotStart,
      clearingPrice: +clearingPrice.toFixed(4),
      matchedPairs,
      unmatchedOffers:  offers.filter(o => o.status === 'pending').length,
      unmatchedDemands: demands.filter(d => d.status === 'pending').length,
      totalVolumeKwh:   +matchedPairs.reduce((s, p) => s + p.volumeKwh, 0).toFixed(4),
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
// EfdmAdapter — EFDM v1.1 compliant JSON generation
// ===========================================================================
class EfdmAdapter {
  static createFlexibilitySpace(maloNode) {
    const fs = maloNode.generateFlexSpace();
    return {
      '@context': 'https://2025.2.2.2.2.2.2.2.2.2/efdm/v1.1',
      '@type': 'FlexibilitaetsRaum',
      metadata: {
        id: fs.id,
        version: '1.1',
        created: new Date().toISOString(),
        source: 'TheElectronChain_v4'
      },
      utilizationContext: {
        status: fs.status,
        externallyTradeable: fs.externallyTradeable,
        autoTradeable: fs.autoTradeable
      },
      validity: fs.validity,
      flexibleLoads: fs.flexibleLoads,
      storages: fs.storages,
      location: fs.location,
      dependencies: []
    };
  }

  static createFLMP(matchedPair, clearing) {
    return {
      '@context': 'https://2025.2.2.2.2.2.2.2.2.2/efdm/v1.1',
      '@type': 'FlexibleLastMassnahmenPaket',
      metadata: {
        id: 'flmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        version: '1.1',
        created: new Date().toISOString()
      },
      status: 'toExecute',
      slotStart: clearing.slotStart,
      flexibleLoadMeasures: [{
        id: 'flm_' + matchedPair.offerBid,
        direction: 'feedIn',
        maloId: matchedPair.offerMalo,
        loadChangeProfile: {
          power: { value: matchedPair.volumeKwh * 4, unit: 'kW', referencePoint: 'scheduledLoad' },
          duration: { value: 15, unit: 'min' }
        },
        reward: {
          value: matchedPair.totalEur,
          unit: 'EUR',
          referencePoint: 'savings'
        }
      }, {
        id: 'flm_' + matchedPair.demandBid,
        direction: 'consumption',
        maloId: matchedPair.demandMalo,
        loadChangeProfile: {
          power: { value: matchedPair.volumeKwh * 4, unit: 'kW', referencePoint: 'scheduledLoad' },
          duration: { value: 15, unit: 'min' }
        },
        reward: {
          value: -matchedPair.totalEur,
          unit: 'EUR',
          referencePoint: 'cost'
        }
      }]
    };
  }

  static createFLMAP(flmp, wasSuccessful = true) {
    return {
      '@context': 'https://2025.2.2.2.2.2.2.2.2.2/efdm/v1.1',
      '@type': 'FlexibleLastMassnahmenAusfuehrungsProtokoll',
      metadata: {
        id: 'flmap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        version: '1.1',
        created: new Date().toISOString(),
        flmpRef: flmp.metadata.id
      },
      status: wasSuccessful ? 'executed' : 'partiallyExecuted',
      executionReport: {
        plannedStart: flmp.slotStart,
        actualStart:  flmp.slotStart,
        actualEnd:    new Date(new Date(flmp.slotStart).getTime() + 900_000).toISOString(),
        measures: flmp.flexibleLoadMeasures.map(m => ({
          id: m.id,
          status: wasSuccessful ? 'executed' : 'partiallyExecuted',
          achievedPower: m.loadChangeProfile.power,
          achievedDuration: m.loadChangeProfile.duration
        }))
      }
    };
  }
}

// ===========================================================================
// SettlementEngine — Post-slot Peaq on-chain settlement
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

    const settlement = {
      id:            'stl_' + Date.now(),
      slotStart:     clearing.slotStart,
      clearingPrice: clearing.clearingPrice,
      pairs:         clearing.matchedPairs.length,
      totalKwh:      clearing.totalVolumeKwh,
      totalEur:      +clearing.matchedPairs.reduce((s, p) => s + p.totalEur, 0).toFixed(4),
      timestamp:     new Date().toISOString(),
      onChain:       false,
      txHash:        null
    };

    const chainRecord = {
      type:          'FLEX_SETTLEMENT',
      settlement_id: settlement.id,
      slot:          clearing.slotStart,
      clearing_price: clearing.clearingPrice,
      volume_kwh:    settlement.totalKwh,
      total_eur:     settlement.totalEur,
      pairs:         clearing.matchedPairs,
      timestamp:     settlement.timestamp
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
    this.ankerNode        = null;
    this.zendureNode      = null;
    this.orderBook        = new OrderBook();
    this.p2pTrades        = [];
    this.activeEnergyFlow = null;

    this.clearingMatcher  = new ClearingMatcher();
    this.slotScheduler    = new SlotScheduler();
    this.settlementEngine = null;
    this.dynamicGridFee   = new DynamicGridFee();

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

      enable_trading:     (process.env.ENABLE_TRADING === 'true') || c.enable_trading !== false,
      min_sell_price:     parseFloat(process.env.MIN_SELL_PRICE)  || c.min_sell_price  || 0.25,
      max_buy_price:      parseFloat(process.env.MAX_BUY_PRICE)   || c.max_buy_price   || 0.22,
      min_buy_price:      parseFloat(process.env.MIN_BUY_PRICE)   || c.min_buy_price   || 0.02,
      battery_reserve:    parseInt(process.env.BATTERY_RESERVE)   || c.battery_reserve || 20,
      max_feedin_power:   parseInt(process.env.MAX_FEEDIN_POWER)  || c.max_feedin_power || 800,
      p2p_trade_amount_wh: c.p2p_trade_amount_wh || 100,
      malo_count:         c.malo_count || 200,

      agnes_enabled:         c.agnes_enabled !== false,
      community_flex_enabled: c.community_flex_enabled !== false,
      clearing_mode:         c.clearing_mode || 'uniform_price',
      min_flex_bid_kw:       c.min_flex_bid_kw || 0.1,
      settlement_penalty_pct: c.settlement_penalty_pct || 10,

      party1_name:           c.party1_name           || 'Gertrud Koch Str',
      party1_lat:            c.party1_lat            || 50.9333,
      party1_lon:            c.party1_lon            || 6.9500,
      party1_malo_id:        c.party1_malo_id        || '50662350764',
      party1_melo_id:        c.party1_melo_id        || 'DE000462203000000000000000000001',
      party1_smg_cert:       c.party1_smg_cert       || null,
      anker_battery_sensor:  c.anker_battery_sensor  || 'sensor.solarbank_2_e1600_battery_charge',
      anker_power_sensor:    c.anker_power_sensor    || 'sensor.solarbank_2_e1600_output_power',
      anker_output_control:  c.anker_output_control  || 'number.solarbank_2_e1600_output_preset',
      anker_ac_charging:     c.anker_ac_charging     || 'switch.solarbank_2_e1600_ac_notladeoption',
      anker_device_id:       c.anker_device_id       || 'b8214a38bd446ccbf2837f3c71ff5309',

      party2_name:            c.party2_name            || 'Eilendorfer Str',
      party2_lat:             c.party2_lat             || 50.7717,
      party2_lon:             c.party2_lon             || 6.1244,
      party2_malo_id:         c.party2_malo_id         || '50662350765',
      party2_melo_id:         c.party2_melo_id         || 'DE000462203000000000000000000002',
      party2_smg_cert:        c.party2_smg_cert        || null,
      zendure_battery_sensor: c.zendure_battery_sensor || 'sensor.hyper_2000_electric_level',
      zendure_power_sensor:   c.zendure_power_sensor   || 'sensor.hyper_2000_output_power',
      zendure_output_control: c.zendure_output_control || 'number.hyper_2000_output_limit',
      zendure_input_control:  c.zendure_input_control  || 'number.hyper_2000_input_limit',
      zendure_ac_mode:        c.zendure_ac_mode        || 'select.hyper_2000_ac_mode',

      epex_sensor:      c.epex_sensor      || 'sensor.epex_spot_data_total_price',
      machine_mnemonic: process.env.MACHINE_MNEMONIC || c.machine_mnemonic,

      party1_pv_tilt:    c.party1_pv_tilt    ?? 30,
      party1_pv_azimuth: c.party1_pv_azimuth ?? 180,
      party1_pv_peak_wp: c.party1_pv_peak_wp ?? 1600,
      party2_pv_tilt:    c.party2_pv_tilt    ?? 30,
      party2_pv_azimuth: c.party2_pv_azimuth ?? 180,
      party2_pv_peak_wp: c.party2_pv_peak_wp ?? 2000
    };

    if (this.config.agnes_enabled) this.dynamicGridFee.enable();
    this.log('info', 'Config: ' + this.config.machine_name + ' @ ' + this.config.network_type + ' | ' + this.config.malo_count + ' MaLos | AgNes=' + this.config.agnes_enabled);
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
      party1: this.config.party1_name,
      party2: this.config.party2_name,
      maloCount: this.config.malo_count,
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
    this.ankerNode = new MaloNode({
      id:          'node_ha1',
      maloId:      this.config.party1_malo_id,
      meloId:      this.config.party1_melo_id,
      name:        this.config.party1_name,
      lat:         this.config.party1_lat,
      lon:         this.config.party1_lon,
      stadtbezirk: 'Innenstadt',
      address:     this.config.party1_name + ', Köln',
      haPrefix:    'anker',
      battery:     { capacityWh: 1600, type: 'Anker Solix 1600 AC' },
      solar:       { hasSolar: true, peakW: this.config.party1_pv_peak_wp },
      smgCert:     this.config.party1_smg_cert || this.config.party1_melo_id,
      pvConfig: {
        tilt:    this.config.party1_pv_tilt,
        azimuth: this.config.party1_pv_azimuth,
        peakWp:  this.config.party1_pv_peak_wp,
        pr:      0.76
      }
    });
    this.ankerNode.did = this.did;
    this.maloRegistry.register(this.ankerNode);

    this.zendureNode = new MaloNode({
      id:          'node_ha2',
      maloId:      this.config.party2_malo_id,
      meloId:      this.config.party2_melo_id,
      name:        this.config.party2_name,
      lat:         this.config.party2_lat,
      lon:         this.config.party2_lon,
      stadtbezirk: 'Ehrenfeld',
      address:     this.config.party2_name + ', Köln',
      haPrefix:    'zendure',
      battery:     { capacityWh: 2000, type: 'Zendure Hyper 2000' },
      solar:       { hasSolar: true, peakW: this.config.party2_pv_peak_wp },
      smgCert:     this.config.party2_smg_cert || this.config.party2_melo_id,
      pvConfig: {
        tilt:    this.config.party2_pv_tilt,
        azimuth: this.config.party2_pv_azimuth,
        peakWp:  this.config.party2_pv_peak_wp,
        pr:      0.76
      }
    });
    this.zendureNode.did = 'did:peaq:smg_' + this.zendureNode.smgCert.fingerprint.slice(0, 32);
    this.maloRegistry.register(this.zendureNode);

    this.maloRegistry.generateCologneNodes(this.config.malo_count);
    this.maloRegistry.refreshAllFlexSpaces();
    this.dynamicGridFee.generateSchedule(48);

    this.log('info', 'MaloRegistry: ' + this.maloRegistry.getAll().length + ' MaLos (2 HA + ' + this.config.malo_count + ' Köln) across 9 Stadtbezirke');
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
    await this.updateAnkerNode();
    await this.updateZendureNode();
    this.maloRegistry.updateDemoStates();
  }

  async updateAnkerNode() {
    const node = this.ankerNode;
    if (!node) return;
    try {
      const bat = await this.getEntityState(this.config.anker_battery_sensor);
      if (bat) node.battery.soc = parseFloat(bat.state) || 0;
      const pwr = await this.getEntityState(this.config.anker_power_sensor);
      if (pwr) {
        node.battery.powerW     = parseFloat(pwr.state) || 0;
        node.battery.discharging = node.battery.powerW > 0;
        node.battery.charging    = node.battery.powerW < 0;
      }
      const ac = await this.getEntityState(this.config.anker_ac_charging);
      if (ac) node.battery.acCharging = ac.state === 'on';
      node.battery.lastUpdate = new Date();
      node.lastSeen = new Date();
      node.online   = true;
    } catch {
      node.battery.soc    = 45 + Math.random() * 35;
      node.battery.powerW = (Math.random() - 0.5) * 600;
      node.battery.lastUpdate = new Date();
    }
  }

  async updateZendureNode() {
    const node = this.zendureNode;
    if (!node) return;
    try {
      const bat = await this.getEntityState(this.config.zendure_battery_sensor);
      if (bat) node.battery.soc = parseFloat(bat.state) || 0;
      const pwr = await this.getEntityState(this.config.zendure_power_sensor);
      if (pwr) {
        node.battery.powerW     = parseFloat(pwr.state) || 0;
        node.battery.discharging = node.battery.powerW > 0;
        node.battery.charging    = node.battery.powerW < 0;
      }
      node.battery.lastUpdate = new Date();
      node.lastSeen = new Date();
      node.online   = true;
    } catch {
      node.battery.soc    = 55 + Math.random() * 30;
      node.battery.powerW = (Math.random() - 0.5) * 800;
      node.battery.lastUpdate = new Date();
    }
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
      this.log('debug', 'Slot auction: not enough bids (' + bids.length + ')');
      return null;
    }

    const clearing = this.clearingMatcher.clearSlot(bids, currentSlotKey);

    if (clearing.matchedPairs.length > 0) {
      this.log('info', 'CLEARING ' + SlotScheduler.slotLabel(currentSlotKey) +
        ': ' + clearing.matchedPairs.length + ' pairs @ ' + (clearing.clearingPrice * 100).toFixed(1) +
        ' ct/kWh | ' + clearing.totalVolumeKwh.toFixed(2) + ' kWh');

      const settlement = await this.settlementEngine.settleClearing(clearing);
      if (settlement) {
        this.earnings += settlement.totalEur;
        this.log('info', 'Settlement: ' + settlement.id + ' | ' + settlement.totalEur.toFixed(4) + ' EUR' +
          (settlement.onChain ? ' [on-chain]' : ' [local]'));
      }

      this.broadcastWS({
        type: 'clearing',
        slot: currentSlotKey,
        clearingPrice: clearing.clearingPrice,
        pairs: clearing.matchedPairs.length,
        volumeKwh: clearing.totalVolumeKwh
      });
    }

    this.slotScheduler.cleanOldSlots();
    return clearing;
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
    const battery = this.ankerNode?.battery.soc ?? 0;
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
      ankerSoc:     this.ankerNode?.battery.soc,
      zendureSoc:   this.zendureNode?.battery.soc,
      ankerPower:   this.ankerNode?.battery.powerW,
      zendurePower: this.zendureNode?.battery.powerW,
      activeEnergyFlow: this.activeEnergyFlow,
      orderSummary: this.orderBook.summary(),
      maloSummary:  ns,
      bezirkSummary: bs,
      clearingHistory: this.clearingMatcher.getHistory(4),
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
    app.get('/api/health',  (_, res) => res.json({ status: 'ok', version: '4.0.0', platform: 'TheElectronChain' }));
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

    app.get('/api/efdm/flexspace/:id', (req, res) => {
      const node = this.maloRegistry.get(req.params.id);
      if (!node) return res.status(404).json({ error: 'not found' });
      res.json(EfdmAdapter.createFlexibilitySpace(node));
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
      version:      '4.0.0',
      connected:    this.chain?.connected,
      demoMode:     this.chain?.demoMode,
      wallet:       this.machineWallet?.getAddress(),
      did:          this.did,
      network:      this.config?.network_type,
      ankerSolix:   this.ankerNode   ? { batteryLevel: this.ankerNode.battery.soc,   power: this.ankerNode.battery.powerW }   : null,
      zendureHyper: this.zendureNode ? { batteryLevel: this.zendureNode.battery.soc, power: this.zendureNode.battery.powerW } : null,
      currentPrice: this.currentPrice,
      gridFee:      this.dynamicGridFee.getCurrentFee(),
      currentMode:  this.currentMode,
      tradingPlan:  this.tradingPlan,
      activeEnergyFlow: this.activeEnergyFlow,
      orderSummary: this.orderBook.summary(),
      maloSummary:  this.maloRegistry.summary(),
      bezirkSummary: this.maloRegistry.getBezirkSummary(),
      clearingHistory: this.clearingMatcher.getHistory(4),
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
        malo_count:      this.config?.malo_count,
        clearing_mode:   this.config?.clearing_mode
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
    const anker   = this.ankerNode;
    const zendure = this.zendureNode;
    const allNodes = this.maloRegistry.getAll();

    const mc = { SELL: 'var(--red)', BUY: 'var(--grn)', HOLD: 'var(--yel)', DISABLED: 'var(--t2)' }[this.currentMode] || 'var(--t2)';
    const priceColor = this.currentPrice >= this.config.min_sell_price ? 'var(--red)'
                     : this.currentPrice <= this.config.max_buy_price  ? 'var(--grn)'
                     : 'var(--yel)';

    const gridFee = this.dynamicGridFee.getCurrentFee();
    const nextSlot = SlotScheduler.slotLabel(this.slotScheduler.getNextSlotKey());
    const lastClearing = this.clearingMatcher.getHistory(1)[0];
    const stlSummary = this.settlementEngine?.getSummary() || {};

    // Anker/Zendure values
    const ankerSocN = anker?.battery.soc ?? 0;
    const ankerPwr  = anker?.battery.powerW ?? 0;
    const zenSocN   = zendure?.battery.soc ?? 0;
    const zenPwr    = zendure?.battery.powerW ?? 0;

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
      isHA: !!n.haPrefix
    })));

    const bezirkeJson = JSON.stringify(KOELN_BEZIRKE);

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
      + '  var map = L.map("map", { zoomControl: true, attributionControl: false, preferCanvas: true }).setView([50.94, 6.96], 12);\n'
      + '  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(map);\n'
      + '  var rend = L.canvas({ padding: 0.5 });\n'
      + '  BEZIRKE.forEach(function(b) {\n'
      + '    L.circle([b.lat, b.lon], { radius: 1800, color: b.color, fillColor: b.color, fillOpacity: 0.06, weight: 1, dashArray: "4,4" }).addTo(map);\n'
      + '    L.marker([b.lat, b.lon], { icon: L.divIcon({ className: "", html: "<div style=\\"font-size:9px;color:" + b.color + ";font-weight:700;white-space:nowrap\\">" + b.name + "</div>", iconSize: [80, 14], iconAnchor: [40, 7] }) }).addTo(map);\n'
      + '  });\n'
      + '  NODES.forEach(function(n) {\n'
      + '    var isHA = n.isHA;\n'
      + '    var bz = BEZIRKE.find(function(b) { return b.name === n.bezirk; });\n'
      + '    var color = isHA ? "#06b6d4" : (bz ? bz.color : "#3b82f6");\n'
      + '    var radius = isHA ? 8 : 3;\n'
      + '    var marker = L.circleMarker([n.lat, n.lon], { renderer: rend, radius: radius, fillColor: color, color: isHA ? "#fff" : color, weight: isHA ? 2 : 0.5, fillOpacity: isHA ? 1 : 0.7 });\n'
      + '    var tip = "<b>" + n.name + "</b><br>MaLo: " + n.maloId + "<br>Bezirk: " + n.bezirk\n'
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
      + '        if (d.ankerSoc !== undefined) {\n'
      + '          document.getElementById("anker-soc").textContent = d.ankerSoc.toFixed(0) + "%";\n'
      + '          document.getElementById("anker-bar").style.width = d.ankerSoc + "%";\n'
      + '        }\n'
      + '        if (d.zendureSoc !== undefined) {\n'
      + '          document.getElementById("zen-soc").textContent = d.zendureSoc.toFixed(0) + "%";\n'
      + '          document.getElementById("zen-bar").style.width = d.zendureSoc + "%";\n'
      + '        }\n'
      + '        if (d.maloSummary) {\n'
      + '          document.getElementById("malo-count").textContent = d.maloSummary.total;\n'
      + '          document.getElementById("total-flex").textContent = d.maloSummary.totalFlexKw.toFixed(1);\n'
      + '          document.getElementById("total-solar").textContent = (d.maloSummary.totalSolarW / 1000).toFixed(0);\n'
      + '        }\n'
      + '        if (d.nextSlot) document.getElementById("next-slot").textContent = d.nextSlot.slice(11, 16);\n'
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
+ '      <div class="ctitle">HA Nodes</div>\n'
+ '      <div class="bat-row">\n'
+ '        <div class="bat-card">\n'
+ '          <div class="bat-name">' + this.config.party1_name + ' &middot; Anker Solix</div>\n'
+ '          <div class="bat-soc" id="anker-soc" style="color:' + (ankerSocN > 50 ? 'var(--grn)' : 'var(--yel)') + '">' + ankerSocN.toFixed(0) + '%</div>\n'
+ '          <div class="bat-bar"><div id="anker-bar" class="bat-fill" style="width:' + ankerSocN + '%;background:' + (ankerSocN > 50 ? 'var(--grn)' : 'var(--yel)') + '"></div></div>\n'
+ '          <div class="bat-pwr">' + (ankerPwr > 0 ? '+' : '') + ankerPwr.toFixed(0) + ' W</div>\n'
+ '          <div class="dim">MaLo: ' + this.config.party1_malo_id + '</div>\n'
+ '        </div>\n'
+ '        <div class="bat-card">\n'
+ '          <div class="bat-name">' + this.config.party2_name + ' &middot; Zendure Hyper</div>\n'
+ '          <div class="bat-soc" id="zen-soc" style="color:' + (zenSocN > 50 ? 'var(--grn)' : 'var(--yel)') + '">' + zenSocN.toFixed(0) + '%</div>\n'
+ '          <div class="bat-bar"><div id="zen-bar" class="bat-fill" style="width:' + zenSocN + '%;background:' + (zenSocN > 50 ? 'var(--grn)' : 'var(--yel)') + '"></div></div>\n'
+ '          <div class="bat-pwr">' + (zenPwr > 0 ? '+' : '') + zenPwr.toFixed(0) + ' W</div>\n'
+ '          <div class="dim">MaLo: ' + this.config.party2_malo_id + '</div>\n'
+ '        </div>\n'
+ '      </div>\n'
+ '    </div>\n'
+ '    <div class="card c8">\n'
+ '      <div class="ctitle">Koeln MaLo Netzwerk &middot; <span id="malo-count">' + ns.total + '</span> Marktlokationen</div>\n'
+ '      <div id="map"></div>\n'
+ '      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:.58rem;color:var(--t2)">\n'
+ KOELN_BEZIRKE.map(function(b) {
  return '<span style="display:flex;align-items:center;gap:3px"><span style="width:8px;height:8px;border-radius:50%;background:' + b.color + '"></span>' + b.name + '</span>';
}).join('')
+ '        <span style="display:flex;align-items:center;gap:3px"><span style="width:8px;height:8px;border-radius:50%;background:var(--cyan);border:1px solid #fff"></span>HA Node</span>\n'
+ '      </div>\n'
+ '    </div>\n'
+ '    <div class="card c4">\n'
+ '      <div class="ctitle">Flex-Markt &middot; Next Slot</div>\n'
+ '      <div class="slot-card" style="text-align:center;margin-bottom:8px">\n'
+ '        <div class="slot-label">Next 15-min Auction</div>\n'
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
+ '      <div class="ctitle">Blockchain Identity</div>\n'
+ '      <div class="info-grid">\n'
+ '        <div class="info-item"><div class="info-lbl">Network</div><div class="info-val">' + (this.config.network_type || '') + '</div></div>\n'
+ '        <div class="info-item"><div class="info-lbl">Status</div><div class="info-val" style="color:' + (this.chain?.demoMode ? 'var(--yel)' : 'var(--grn)') + '">' + (this.chain?.demoMode ? 'Demo' : 'Live') + '</div></div>\n'
+ '        <div class="info-item"><div class="info-lbl">Wallet</div><div class="info-val">' + (this.machineWallet?.getAddress()?.slice(0, 18) + '...' || '') + '</div></div>\n'
+ '        <div class="info-item"><div class="info-lbl">DID</div><div class="info-val">' + (this.did?.slice(0, 24) + '...' || '') + '</div></div>\n'
+ '      </div>\n'
+ '    </div>\n'
+ '  </div>\n'
+ '  <footer>TheElectronChain v4.0.0 &middot; ' + ns.total + ' MaLos &middot; 9 Bezirke &middot; Session: ' + this.sessionStart.toLocaleString('de-DE') + ' &middot; <a href="/flex">Flex-Markt</a> &middot; <a href="/settlement">Settlement</a> &middot; <a href="/api/status">API</a></footer>\n'
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
+ '        <div class="slot-label">Uniform Price Auction</div>\n'
+ '        <div class="slot-time">' + nextLabel + '</div>\n'
+ '        <div style="margin-top:6px;font-size:.7rem;color:var(--t1)">' + offers.length + ' Angebote &middot; ' + demands.length + ' Nachfrage</div>\n'
+ '      </div>\n'
+ '      <div style="margin-top:12px;text-align:left">\n'
+ '        <div class="dim" style="margin-bottom:6px">EFDM v1.1 Lifecycle</div>\n'
+ '        <div style="font-size:.65rem;color:var(--t1);line-height:1.8">\n'
+ '          T-5min: FlexSpace Refresh<br>\n'
+ '          T-4min: Bid Collection<br>\n'
+ '          T-2min: Community Clearing<br>\n'
+ '          T-1min: FLMP Creation<br>\n'
+ '          T+0: Execution<br>\n'
+ '          T+15: FLMAP + Settlement\n'
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
+ '  <footer>TheElectronChain v4.0.0 &middot; <a href="/">Dashboard</a> &middot; <a href="/settlement">Settlement</a> &middot; <a href="/api/flex/clearing">Clearing API</a></footer>\n'
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

    var body = ''
+ '<div style="margin-top:12px">\n'
+ '  <div class="grid">\n'
+ '    <div class="card c12">\n'
+ '      <div class="ctitle">MaLo Netzwerk Koeln &middot; ' + ns.total + ' Marktlokationen &middot; 9 Stadtbezirke</div>\n'
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
+ '  <footer>TheElectronChain v4.0.0 &middot; <a href="/">Dashboard</a> &middot; <a href="/flex">Flex-Markt</a> &middot; <a href="/api/malos">MaLo API</a></footer>\n'
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
+ '      <div class="ctitle">Settlement Summary</div>\n'
+ '      <div class="big-num" style="color:var(--cyan)">' + (stl.totalSettledEur || 0).toFixed(2) + '</div>\n'
+ '      <div class="unit">EUR total settled</div>\n'
+ '      <div style="margin-top:8px;font-size:.7rem;color:var(--t1)">\n'
+ '        ' + (stl.totalSettlements || 0) + ' settlements<br>\n'
+ '        ' + (stl.totalSettledKwh || 0).toFixed(2) + ' kWh traded<br>\n'
+ '        Avg: ' + ((stl.avgClearingPrice || 0) * 100).toFixed(1) + ' ct/kWh\n'
+ '      </div>\n'
+ '    </div>\n'
+ '    <div class="card c9">\n'
+ '      <div class="ctitle">Settlement History (on-chain Peaq)</div>\n'
+ '      <div class="scroll-y"><table><thead><tr><th>Slot</th><th>Clearing ct</th><th>kWh</th><th>EUR</th><th>Pairs</th><th>Status</th><th>ID</th></tr></thead><tbody>' + stlRows + '</tbody></table></div>\n'
+ '    </div>\n'
+ '    <div class="card c12">\n'
+ '      <div class="ctitle">AgNes Netzentgelte &middot; Dynamische Grid Fees (15-min Granularitaet)</div>\n'
+ '      <div class="scroll-y" style="max-height:400px"><table><thead><tr><th>Zeit</th><th>Fee ct/kWh</th><th>Tier</th></tr></thead><tbody>' + feeRows + '</tbody></table></div>\n'
+ '    </div>\n'
+ '  </div>\n'
+ '  <footer>TheElectronChain v4.0.0 &middot; <a href="/">Dashboard</a> &middot; <a href="/flex">Flex-Markt</a> &middot; <a href="/api/flex/settlement">Settlement API</a></footer>\n'
+ '</div>\n';

    return this._darkShell('/settlement', 'Settlement', body, '');
  }

  // -------------------------------------------------------------------------
  // Cron Scheduling + Initialize
  // -------------------------------------------------------------------------
  async initialize() {
    console.log('');
    console.log('  ========================================');
    console.log('  TheElectronChain v4.0.0');
    console.log('  Cologne MaLo Aggregation Platform');
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

    this.log('info', 'TheElectronChain v4.0.0 running — ' + this.maloRegistry.getAll().length + ' MaLos across 9 Kölner Stadtbezirke');
  }

  async cleanup() {
    this.log('info', 'Shutting down...');
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
