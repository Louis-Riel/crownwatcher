"use strict"
/*jshint esversion: 6 */

import http from 'http'
import https from 'https'
import { resolve } from 'path'

export default class CovidExporter {
    constructor() {
        this.jhumetrics = ['confirmed', 'deaths', 'recovered']
        this.covidapitmetrics = ["cases", "todayCases", "deaths", "todayDeaths", "recovered", "active",
            "critical", "casesPerOneMillion", "deathsPerOneMillion", "tests", "testsPerOneMillion"
        ]
        this.jhuhmetrics = ["cases", "deaths", "recovered"]
        console.log("Getting stats info...")
        https.get({
            host: 'disease.sh',
            path: '/v3/covid-19/all',
            headers: {
                'cache-control': 'no-cache'
            }
        }, (statReq) => {
            let data = ''
            statReq.setEncoding('utf8')
            statReq.on('error', err => console.error(err));
            statReq.on('data', (stats) => data += stats);
            statReq.on('end', () => {
                this.covidapitmetrics = Object.keys(JSON.parse(data))
                    .filter(field => field != "updated" && field != "affectedCountries");
                covidExplorer.bootStrapStats();
            });
        }).on("error", err => console.error(err))
    }

    bootStrapStats() {
        this.getCurMinDt().then(mindt => this.fetchHistoricals(mindt));
    }

    getCurMinDt() {
        return new Promise((resolve, reject) => {
            http.get({
                host: 'influxdb',
                port: 8086,
                path: '/query?pretty=true&db=telegraf&q=SELECT%20time,min(confirmed)%20FROM%20jhu_covid',
                headers: {
                    'cache-control': 'no-cache'
                }
            }, (influxres) => {
                let data = ''
                console.log("Getting First Date")
                influxres.setEncoding('utf8')

                influxres.on('error', reject);
                influxres.on('data', stats => data += stats);
                influxres.on('end', () => {
                    var curstat = JSON.parse(data)
                    var mindt

                    if (curstat.results[0].error) {
                        console.error("Cannot connect to influxdb")
                        process.exit(1)
                    }

                    try {
                        mindt = new Date(new Date(curstat.results[0].series[0].values[0][0]) - (8 * 60 * 1000))
                        console.log("Stats started at %s %s", mindt, curstat.results[0].series[0].values[0][0])
                    } catch (err) {
                        mindt = new Date(new Date().toDateString())
                        mindt.setTime(mindt.getTime() - (25 * 60 * 60 * 1000))
                        console.log("Stats defaulted to yesterday %s", mindt)
                    }
                    resolve(mindt);
                })
            })
        });
    }

    fetchHistoricals(statDt) {
        console.log(`Getting historical from ${statDt}`);
        https.get({
            host: 'disease.sh',
            path: '/v3/covid-19/historical?lastdays=all',
            headers: {
                'cache-control': 'no-cache'
            }
        }, function(covidreq) {
            let data = ''
            covidreq.setEncoding('utf8')
            console.log("Getting corona jhu Historical Stats")


            covidreq.on('error', err => reject(err));
            covidreq.on('data', stats => data += stats);
            covidreq.on('end', () => { this.importStat(statDt, JSON.parse(data), 0) });
        }.bind(this));
    }

    importStat(statDt, stats, missingDays) {
        return new Promise(async(resolve, reject) => {
            if (statDt == null) {
                reject({ "error": "Missing stat date" });
                return;
            }
            var curidx = `${statDt.getMonth() + 1}/${statDt.getDate()}/${statDt.getFullYear() - 2000}`
            if (stats[0].timeline.cases[curidx] === undefined) {
                missingDays += 1
                if (missingDays > 10) {
                    console.log("Done importing historical stats on %s", curidx);
                    resolve(0)
                    this.getTheStats()
                    setInterval(function() {
                        this.getTheStats()
                    }.bind(this), 3600000)

                    return;
                }
            }
            if ((statDt.getHours() == 0) && (statDt.getMinutes() == 0)) {
                console.log("Processing %s", statDt)
            }

            try {

                if (stats[0].timeline.cases[curidx] !== undefined) {
                    await this.postToInflux(
                        stats.filter(stat => stat.province ||
                            stats.some(tmpstat => tmpstat.country == stat.country &&
                                stat.province &&
                                stat.province != ""))
                        .map(stat => this.getDatedInfluxRecordRequest(stat, curidx, statDt))
                        .join("\n"));

                    await this.postToInflux(
                        this.getCountryStats(stats, curidx)
                        .map(stat => this.getInfluxCountryRequest(stat, statDt))
                        .join("\n"));
                }
                statDt.setTime(statDt.getTime() - 86400000);
                setImmediate(
                    function() {
                        this.importStat(statDt, stats, missingDays)
                    }.bind(this)
                )
                resolve(0);
            } catch (err) {
                console.log(err)
                reject(err)
            }
        })
    }

    getInfluxCountryRequest(stat, statDt) {
        return `covidapi,generation=19,country=${stat.country.replace(/[^a-zA-Z0-9]/g, '_')} ` +
            this.covidapitmetrics.map(metric => `${metric}=${stat[metric]}`)
            .join(",") + ` ${statDt.getTime()}000000`;
    }

    getCountryStats(stats, curidx) {
        return stats.reduce((ret, stat, idx) => {
            var countryStats;
            if (idx == 1) {
                countryStats = { country: ret.country };
                this.covidapitmetrics.forEach(metric => {
                    countryStats[metric] = 0
                    if (ret.timeline[this.covidapitmetrics[metric]]) {
                        countryStats[ret.country][metric] += Number(ret.timeline[metric][curidx])
                    }
                });
                ret = [];
                ret.push(countryStats);
            }
            countryStats = ret.find(cstat => cstat.country == stat.country);
            if (!countryStats) {
                countryStats = { country: stat.country };
                this.covidapitmetrics.forEach(metric => countryStats[metric] = 0);
                ret.push(countryStats);
            }
            this.covidapitmetrics.forEach(metric => {
                if (stat.timeline[this.covidapitmetrics[metric]]) {
                    countryStats[stat.country][metric] += Number(stat.timeline[metric][curidx])
                }
            });
            return ret;
        });
    }

    getDatedInfluxRecordRequest(stat, curidx, statDt) {
        return `jhu_covid,generation=19,province=${stat.province ? stat.province.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_') : ""},country=${stat.country.replace(/[^a-zA-Z0-9]/g, '_')
            .replace(/^USA$/, 'US')
            .replace(/^UK$/, 'United_Kingdom')} `.replace(/[a-z]+=,/g, '') +
            this.jhuhmetrics.map(metric => this.getInfluxMetric(metric, stat, curidx)).join(",") + ` ${statDt.getTime()}000000\n`;
    }

    getInfluxMetric(metric, stat, curidx) {
        if (metric == "cases") {
            metric = "confirmed";
        }
        return `${metric}=${Number.isNaN(stat.timeline.cases[curidx])?0:stat.timeline.cases[curidx]}`;
    }

    getTheStats() {
        return Promise.all([
            this.getApiStats(),
            this.getJHUStats()
        ]);
    }

    getJHUStats() {
        return new Promise((resolve, reject) => {
            https.get({
                host: 'disease.sh',
                path: '/v3/covid-19/countries',
                headers: {
                    'cache-control': 'no-cache'
                }
            }, (covidres) => {
                let data = ''
                covidres.setEncoding('utf8')
                console.log("Getting corona jhu Stats")

                covidres.on('error', err => reject(err));
                covidres.on('data', stats => data += stats);
                covidres.on('end', () => {
                    JSON.parse(data).forEach(stat => this.postToInflux(`covidapi,generation=19,latitude=${stat.countryInfo.lat},longitude=${stat.countryInfo.long},country=${stat.country.replace(/[^a-zA-Z0-9]/g, '_')} ` +
                        this.covidapitmetrics.map(metric => `${metric}=${stat[metric]}`).join(",")));
                    console.log("Done getting corona api Stats")
                    resolve();
                });
            })
        })
    }

    getApiStats() {
        return new Promise((resolve, reject) => {
            https.get({
                host: 'disease.sh',
                path: '/v3/covid-19/jhucsse',
                headers: {
                    'cache-control': 'no-cache'
                }
            }, (covidres) => {
                let data = ''
                console.log("Getting corona api Stats")
                covidres.setEncoding('utf8')

                covidres.on('error', err => reject(err));
                covidres.on('data', stats => data += stats);
                covidres.on('end', () => {
                    console.log("Done getting corona jhu Stats");
                    JSON.parse(data).forEach(stat => {
                        var ifm = `jhu_covid,generation=19,province=${stat.province ? stat.province.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_') : ""},latitude=${stat.coordinates.latitude},longitude=${stat.coordinates.longitude},country=${stat.country.replace(/[^a-zA-Z0-9]/g, '_')} `.replace(/[a-z]+=,/g, '')
                        ifm += this.jhumetrics.map(metric => `${metric}=${stat.stats[metric]}`).join(",");
                        resolve(this.postToInflux(ifm));
                    })
                })
            })
        })
    }

    postToInflux(metric) {
        return new Promise((resolve, reject) => {
            let req = new http.request({
                port: 8086,
                host: 'influxdb',
                method: 'POST',
                path: '/write?db=telegraf',
                agent: false,
                headers: {
                    'cache-control': 'no-cache'
                }
            }, (statres) => {
                statres.setEncoding('utf8')
                if (statres.statusCode > 204) {
                    console.log(`STATUS: ${statres.statusCode}`)
                    console.log(`HEADERS: ${JSON.stringify(statres.headers)}`)
                    console.log("metric %s", metric)
                }
                resolve(statres.statusCode)
            })
            req.write(metric.replace(/undefined/g, "0"))
            req.end()
        })
    }
}

let covidExplorer = new CovidExporter()