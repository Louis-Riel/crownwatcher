'use strict';
import DDSnmpExporter from '../ddsnmp/index.js'
import http from 'http'
import { match } from 'assert';
import { join } from 'path';

const stringConstructor = "".constructor;
const arrayConstructor = [].constructor;

export default class StatsExtractor {
    constructor() {
        console.log("Starting...");
        this.ddwrt = new DDSnmpExporter();
        this.getStats();
        //this.ddwrt.getSystemStats().then(this.getClientStats.bind(this)).then(stats => console.log(JSON.stringify(stats, null, 2)));
    }

    getStats() {
        this.ddwrt.getSystemStats().then(
                this.getLanStats.bind(this))
            .then(stats => Promise.all(
                [
                    this.postToInflux(this.getInfluxLine("ddwrtsystem", stats))
                ].join(stats.networks.map(network => this.postToInflux(this.getInfluxLine("ddwrtnetwork", network))))
            ).then(res => Promise.all(stats.networks.filter(network => network.ips != null)
                .map(network =>
                    network.ips.map(client =>
                        this.postToInflux(this.getInfluxLine("ddwrtclient", client))
                    )
                )
            ))).then(setTimeout(this.getStats.bind(this), process.env.PULL_PERIOD_MS));
    }

    getWanStats(stats) {
        return new Promise((resolve, reject) => {
            try {
                http.get({
                    port: 80,
                    host: process.env.DDWRT_ADDR,
                    method: 'GET',
                    path: `/Status_Wan.live.asp`,
                    agent: false,
                    headers: {
                        'cache-control': 'no-cache',
                        'Authorization': `Basic YWRtaW46aW5mb1gyNWM`
                    }
                }, (res) => {
                    res.on("data", data => this.GetIPClientStats(data, stats));
                    res.on("end", () => resolve(stats));
                }).on("error", reject)
            } catch (err) {
                reject(err);
            }
        });
    }

    getLanStats(stats) {
        return new Promise((resolve, reject) => {
            try {
                http.get({
                    port: 80,
                    host: process.env.DDWRT_ADDR,
                    method: 'GET',
                    path: `/Status_Lan.live.asp`,
                    agent: false,
                    headers: {
                        'cache-control': 'no-cache',
                        'Authorization': `Basic YWRtaW46aW5mb1gyNWM`
                    }
                }, (res) => {
                    res.on("data", data => this.GetIPClientStats(data, stats));
                    res.on("end", () => resolve(stats));
                }).on("error", reject)
            } catch (err) {
                reject(err);
            }
        });
    }

    GetIPClientStats(resp, stats) {
        var lines = String(resp).match(/{([^}]*)}/g);
        lines.filter(match => match.indexOf("dhcp_leases::") > 0)
            .filter(match => match.substring(15).match(/('([^']*)','([^']*)','[^']*','[^']*','[^']*')/g)
                .map(entry => {
                    var entries = entry.match(/'([^']*)'/g).map(tmp => tmp.replaceAll("'", ""));
                    stats.networks
                        .filter(net => net.ips != null)
                        .filter(net => net.ips.filter(ip => ip.addr.join('.') == entries[1])
                            .forEach(net => {
                                net["name"] = entries[0];
                                net["mac"] = entries[2];
                            }));
                    return `${entries[0]}:${entries[1]}`;
                }));
        lines.filter(match => match.indexOf("arp_table::") > 0)
            .filter(match => match.substring(15).match(/('([^']*)','([^']*)','[^']*','[^']*','[^']*')/g)
                .map(entry => {
                    var entries = entry.match(/'([^']*)'/g).map(tmp => tmp.replaceAll("'", ""));
                    stats.networks
                        .filter(net => net.ips != null)
                        .filter(net => net.ips.filter(ip => ip.addr.join('.') == entries[2])
                            .forEach(net => {
                                net["connections"] = entries[4];
                                net["network"] = entries[0];
                            }));
                    return `${entries[0]}:${entries[1]}`;
                }));
    }

    parseDhcpEntry(entry, stats) {
        var parsed = entry.map(elem => {
            elem.replace(",", "");
        });
        var dev = stats.ips.find(ip => ip.addr == parsed[1]);
        if (dev) {
            dev["name"] = parsed[0];
        }
    }
    postToInflux(post) {
        return new Promise((resolve, reject) => {
            try {
                http.request({
                        port: 8086,
                        host: process.env.INFLUX_ADDR,
                        method: 'POST',
                        path: `/write?db=${process.env.INFLUX_DB}`,
                        agent: false,
                        headers: {
                            'cache-control': 'no-cache'
                        }
                    })
                    .on("error", reject)
                    .on("response", resp => resp.statusCode > 204 ? reject(`${resp.statusMessage}:${post}`) : resolve(resp.statusMessage))
                    .on("socket", (sock) => {
                        sock.parser.outgoing.write(post);
                        sock.parser.outgoing.end();
                    });
            } catch (err) {
                reject(err);
            }
        });
    }

    getInfluxLine(name, obj) {
            var dt = Date.now();
            return `${name}${Object.keys(obj).find(attr => this.isString(obj[attr])) != null ? 
                        "," + Object.keys(obj)
                                .filter(attr => this.isString(obj[attr]) && obj[attr] !== "")
                                .map(attr => `${attr}=${obj[attr]}`)
                                .join(',') + " "
                    : " " } ${Object.keys(obj)
                        .filter(attr => !this.isString(obj[attr]))
                        .filter(attr => obj[attr] !== "")
                        .map(attr => this.isArray(obj[attr]) ? `${attr}=${obj[attr].length}` : `${attr}=${obj[attr]}`)
                        .join(',') + " "} ${dt}000000`;
    }
        
        
    isArray(obj) {
        return (obj.constructor === arrayConstructor);
    }
        
        
    isString(obj) {
        return ((obj.constructor === stringConstructor) && isNaN(obj));
    }
}