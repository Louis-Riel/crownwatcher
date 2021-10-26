'use strict';
import DDSnmpExporter from '../ddsnmp/index.js'
import http from 'http'
import { env, stdout } from 'process'
import { InfluxDB, flux, Point } from '@influxdata/influxdb-client'
import { HealthAPI } from '@influxdata/influxdb-client-apis'
import * as fs from 'fs'

const stringConstructor = "".constructor;
const arrayConstructor = [].constructor;

export default class StatsExtractor {
    constructor() {
        console.log("Starting...");
        this.ddwrt = new DDSnmpExporter();
        console.log(`Connecting to http://${env.INFLUX_HOST}:${env.INFLUX_PORT}`)
        let influxClient = new InfluxDB({ 'url': `http://${env.INFLUX_HOST}:${env.INFLUX_PORT}`, 'token': env.AUTH_TOKEN, 'timeout': 15000 })
        let influxhealth = new HealthAPI(influxClient)
        fs.readFile("/run/secrets/ddwrtauthkey","utf8",(err,data) => {
            if (err)
                console.error(err);
            else{
                this.ddwrtauthkey = data;
                influxhealth.getHealth().then(res => {
                    if (res.status == 'pass') {
                        console.log("Connected")
                        this.reader = influxClient.getQueryApi(env.INFLUX_ORG);
                        this.writer = influxClient.getWriteApi(env.INFLUX_ORG, env.INFLUX_BUCKET, 'ns');
                        this.getStats();
                    } else {
                        reject(res.status);
                    }
                });
            }
        });
    }

    getStats() {
        this.ddwrt.getSystemStats()
            .then(this.getLanStats.bind(this))
            .then(this.getWanStats.bind(this))
            .then(stats => stats.networks
                .filter(network => network.ips != null)
                .flatMap(network => network.ips.map(ip => this.toInluxPoint("ddwrtclient", ip)))
                .concat(stats.networks.map(network => this.toInluxPoint("ddwrtnetwork", network)))
                .concat(this.toInluxPoint("ddwrtsystem", stats)))
            .then(stats => this.writer.writePoints(stats))
            .then(stats =>
                setTimeout(this.getStats.bind(this), parseInt(process.env.PULL_PERIOD_MS)))
    }

    getWanStats(stats) {
        return new Promise((resolve, reject) => {
            try {
                http.get({
                    port: 80,
                    host: process.env.DDWRT_ADDR,
                    method: 'GET',
                    path: `/Status_Wireless.live.asp`,
                    agent: false,
                    headers: {
                        'cache-control': 'no-cache',
                        'Authorization': `Basic ${this.ddwrtauthkey}`
                    }
                }, (res) => {
                    res.on("data", data =>
                        this.GetIPClientStats(data.toString(), stats));
                    //res.on("data", data => this.GetIPClientStats(data, stats));
                    res.on("end", () =>
                        resolve(stats));
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
                        'Authorization': `Basic ${this.ddwrtauthkey}`
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
            .forEach(match =>
                this.SplitidySplit(match, 5)
                .map(entries => {
                    return stats.networks
                        .filter(net => net.ips != null)
                        .filter(net => net.ips.filter(ip => ip.addr.join('.') == entries[1])
                            .forEach(net => {
                                net["name"] = entries[0];
                                net["mac"] = entries[2];
                            }))
                        .map(net => `${entries[0]}:${entries[2]}`)
                }));
        lines.filter(match => match.indexOf("arp_table::") > 0)
            .forEach(match =>
                this.SplitidySplit(match, 5)
                .map(entries => {
                    stats.networks
                        .filter(net => net.ips != null)
                        .filter(net => net.ips.filter(ip => ip.addr.join('.') == entries[1])
                            .forEach(net => {
                                net["connections"] = entries[3];
                                net["network"] = entries[4];
                            }));
                    return `${entries[0]}:${entries[1]}`;
                }));
        lines.filter(match => match.indexOf("active_wireless::") > 0)
            .forEach(match =>
                this.SplitidySplit(match, 15)
                .map(entries => {
                    stats.networks
                        .filter(net => net.ips != null)
                        .filter(net => net.ips.filter(ip => ip.mac == entries[0])
                            .forEach(net => {
                                net["uptime"] = entries[3];
                                net["txrate"] = entries[4].replaceAll("M", "");
                                net["rxrate"] = entries[5].replaceAll("M", "");
                                net["info"] = entries[6];
                                net["signal"] = entries[7];
                                net["noise"] = entries[8];
                                net["snr"] = entries[9];
                                net["quality"] = entries[10] / 10;
                            }));
                    return `${entries[0]}:${entries[1]}`;
                }));
    }

    SplitidySplit(match, len) {
        return match.substring(match.indexOf("::") + 2).match(/'([^']*)'/g)
            .map(item => item.replaceAll("'", ""))
            .reduce((ret, cur, idx) => {
                if (ret.constructor !== arrayConstructor) {
                    ret = [
                        [ret, cur]
                    ];
                } else if (idx % len == 0) {
                    ret.push([cur]);
                } else {
                    ret[ret.length - 1].push(cur);
                }
                return ret;
            });
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

    toInluxPoint(name, obj) {
        var pt = new Point(name) //.timestamp(Date.now());
        try {
            Object.keys(obj)
                .filter(attr => obj[attr] != "")
                .forEach(attr => {
                    if (this.isIp(obj[attr])) {
                        pt.tag(attr, obj[attr].join('.'))
                    } else if (this.isString(obj[attr])) {
                        pt.tag(attr, obj[attr])
                    } else if (this.isArray(obj[attr])) {
                        pt.floatField(attr, obj[attr].length)
                    } else {
                        pt.floatField(attr, obj[attr])
                    }
                })
        } catch (ex) {
            console.error(ex)
        }
        return pt;
    }


    isArray(obj) {
        return (obj.constructor === arrayConstructor);
    }

    isIp(obj) {
        return this.isArray(obj) && obj.filter(val => val >= 0 && val <= 255).length == 4
    }

    isString(obj) {
        return ((obj.constructor === stringConstructor) && (isNaN(obj)));
    }
}