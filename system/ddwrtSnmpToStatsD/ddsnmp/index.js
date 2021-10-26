'use strict';
import snmp from 'snmp-native'

const netIfMappings = [
    { name: "name", idx: 2 },
    { name: "mac", idx: 6 },
    { name: "MTU", idx: 4 },
    { name: "speed", idx: 5 },
    { name: "status", idx: 8 },
    { name: "intcp", idx: 10 },
    { name: "outtcp", idx: 16 },
    { name: "inudp", idx: 10 },
    { name: "outudp", idx: 17 },
    { name: "discarts", idx: 13 },
    { name: "inerrors", idx: 14 },
    { name: "outerrors", idx: 20 }
];

const sysMappings = [
    { name: "interrupts_sec", cat: 11, idx: 7 },
    { name: "context_sec", cat: 11, idx: 8 },
    { name: "cpu_user", cat: 11, idx: 9 },
    { name: "cpu_system", cat: 11, idx: 10 },
    { name: "cpu_idle", cat: 11, idx: 11 },
    { name: "mem_total", cat: 4, idx: 5 },
    { name: "mem_avail", cat: 4, idx: 6 },
    { name: "mem_free", cat: 4, idx: 11 },
    { name: "mem_shared", cat: 4, idx: 13 },
    { name: "mem_buffered", cat: 4, idx: 14 },
    { name: "mem_cached", cat: 4, idx: 15 },
    { name: "load1", cat: 10, idx: 1, beforeLast: 3, last: 1 },
    { name: "load5", cat: 10, idx: 1, beforeLast: 3, last: 2 },
    { name: "load10", cat: 10, idx: 1, beforeLast: 3, last: 3 },
];
const netBaseOid = [1, 3, 6, 1, 2, 1, 2, 2, 1];
const netAddrsOid = [1, 3, 6, 1, 2, 1, 4, 22, 1];
const netAddrsDtlOid = [1, 3, 6, 1, 2, 1, 4, 35, 1];
const sysStatsOid = [1, 3, 6, 1, 4, 1, 2021];

export default class DDSnmpExporter {
    constructor() {
        console.log(`Connecting to ddwrt @${process.env.DDWRT_ADDR}`)
        this.session = new snmp.Session({ host: process.env.DDWRT_ADDR });
    }

    getSystemStats() {
        return new Promise((resolve, reject) => {
            var stats = {};

            this.session.getSubtree({ oid: sysStatsOid }, (err, binds) => {
                if (err) {
                    reject(err);
                } else {
                    binds.forEach(vb => this.parseSysStat(vb, stats));
                    this.getNetworkInterfaces().then(netIfs => {
                        stats.networks = netIfs;
                        resolve(stats);
                    });
                }
            });
        });
    }

    getNetworkInterfaces() {
        return new Promise((resolve, reject) => {
            var devices = [];

            this.session.getSubtree({ oid: netBaseOid }, (err, binds) => {
                if (err) {
                    reject(err);
                } else {
                    binds.forEach(vb => this.parseNetifStat(vb, devices));
                    resolve(this.getInterfaceAddresses(devices));
                }
            });
        });
    }

    getInterfaceAddressesDetails(devices) {
        return new Promise((resolve, reject) => {
            this.session.getSubtree({ oid: netAddrsDtlOid }, (err, binds) => {
                if (err) {
                    reject(err);
                } else {
                    binds.forEach(vb => this.parseAddrDtlStat(vb, devices));
                    resolve(devices);
                }
            });
        });
    }

    getInterfaceAddresses(devices) {
        return new Promise((resolve, reject) => {
            this.session.getSubtree({ oid: netAddrsOid }, (err, binds) => {
                if (err) {
                    reject(err);
                } else {
                    binds.forEach(vb => this.parseAddrStat(vb, devices));
                    resolve(this.getInterfaceAddressesDetails(devices));
                }
            });
        });
    }

    parseSysStat(stat, stats) {
        sysMappings.filter(mapping => ((mapping.idx == stat.oid[sysStatsOid.length + 1]) && (mapping.cat == stat.oid[sysStatsOid.length])))
            .filter(mapping => ((mapping.beforeLast == undefined) || (stat.oid[stat.oid.length - 2] == mapping.beforeLast)))
            .filter(mapping => ((mapping.last == undefined) || (stat.oid[stat.oid.length - 1] == mapping.last)))
            .forEach(mapping => stats[mapping.name] = this.getStatValue(stat, mapping));
    }

    parseAddrDtlStat(stat, devices) {
        var statIdx = stat.oid[netAddrsOid.length];
        var devIdx = stat.oid[netAddrsOid.length + 1];
        var statIp = stat.oid.filter((i, idx, arr) => idx > (arr.length - 5));
        var device = devices.find(device => device.idx == devIdx);
        var ip = device.ips.find(ip => ip.addr.every((i, idx) => i == statIp[idx]));
        if (ip == null) {
            device.ips.push(ip = { addr: statIp, name: statIp.join('.') });
        }

        if (statIdx == 5) {
            ip.uptime = stat.value;
        }
        if (statIdx == 7) {
            ip.state = stat.value == 3 ? "delay" : stat.value == 2 ? "reachable" : "stale";
        }
    }

    parseAddrStat(stat, devices) {
        if (stat.oid[netAddrsOid.length] == 3) {
            devices.filter(device => (device.idx == stat.oid[netAddrsOid.length + 1]))
                .forEach(device => {
                    device.ips = device.ips || [];
                    device.ips.push({ addr: stat.value });
                });
        }
    }

    parseNetifStat(stat, devices) {
        if (stat.oid.length == netBaseOid.length + 2) {
            var devIdx = stat.oid[stat.oid.length - 1];
            var dev = devices.find(cdev => cdev.idx == devIdx);
            if (dev == undefined) {
                devices.push(dev = { idx: devIdx });
            }

            netIfMappings.filter(mapping => mapping.idx == stat.oid[netBaseOid.length])
                .forEach(mapping => dev[mapping.name] = this.getStatValue(stat, mapping));
        }
    }

    getStatValue(stat, mapping) {
        var ret = stat.value;
        if ((mapping.name == "mac") && (stat.valueHex !== "")) {
            ret = stat.valueHex.replaceAll(/(..)/g,"$1:").substring(0,17);
        }

        return ret;
    }
}