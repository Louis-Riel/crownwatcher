"use strict"
/*jshint esversion: 6 */

import https from 'https'
import { env } from 'process'
import { InfluxDB, flux, Point } from '@influxdata/influxdb-client'
import { HealthAPI } from '@influxdata/influxdb-client-apis'

const apis = [{
    "apiName": "jhu_covid",
    "countryMap": {
        "UK": "United_Kingdom",
        "USA": "US"
    },
    "fieldMap": { "cases": "confirmed" }
}]

export default class CovidExporter {
    constructor() {
        console.log(`Connecting to http://${env.INFLUX_HOST}:${env.INFLUX_PORT}`)
        this.jhumetrics = ['cases', 'deaths', 'recovered']
        let influxClient = new InfluxDB({ 'url': `http://${env.INFLUX_HOST}:${env.INFLUX_PORT}`, 'token': env.AUTH_TOKEN, 'timeout': 15000 })
        let influxhealth = new HealthAPI(influxClient)
        influxhealth.getHealth().then(res => {
            if (res.status == 'pass') {
                console.log("Connected")
                this.reader = influxClient.getQueryApi(env.INFLUX_ORG)
                this.writer = influxClient.getWriteApi(env.INFLUX_ORG, env.INFLUX_BUCKET, 'ns')
                this.getCurMaxDt()
                    .then(maxdt => this.fetchHistoricals(maxdt))
                    .catch(console.error)
            } else {
                reject(res.status)
            }
        })
    }

    compareProp(a, b, fld) {
        if (a[fld] &&
            b[fld])
            return a[fld].localeCompare(b[fld])

        return a[fld] ? 1 : !b[fld] ? 0 : -1
    }

    getCurMaxDt() {
        return new Promise((resolve, reject) => {
            const fluxQuery = flux `from(bucket: "${env.INFLUX_BUCKET}")
                |> range(start: -20d, stop: now())
                |> filter(fn: (r) => r["_measurement"] == "covidapi")
                |> filter(fn: (r) => r["_field"] == "deaths")`
            var maxDt = new Date("2020-01-01")
            this.reader.queryRows(fluxQuery, {
                next(row, tableMeta) {
                    var theRow = tableMeta.toObject(row)
                    var curDt = new Date(theRow._time)
                    if ((maxDt == null) || (curDt > maxDt)) {
                        //console.log(theRow)
                        maxDt = curDt
                    }
                },
                error(err) {
                    console.error("Error getting min dt")
                    reject(err.json)
                },
                complete() {
                    console.log(`last stat dated ${maxDt}`)
                    resolve(maxDt)
                }
            })
        });
    }

    fetchHistoricals(statDt) {
        return new Promise((resolve, reject) => {
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
                covidreq.on('end', () => { resolve(this.importHistoricalStat(statDt, JSON.parse(data), 0)) });
            }.bind(this));
        })
    }

    importHistoricalStat(statDt, stats, missingDays) {
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
                    this.getTheStats()
                    setInterval(this.getTheStats.bind(this), 3600000)
                    resolve(0);
                    return;
                }
            }

            if (stats[0].timeline.cases[curidx] !== undefined) {
                console.log("Processing %s", statDt)
                    //console.log(stats.filter(stat => stat.province)
                    //    .flatMap(stat => this.pointHistorical(stat, statDt, curidx)))
                this.writer.writePoints(
                    stats.filter(stat => stat.province)
                    .flatMap(stat => this.pointHistorical(stat, statDt, curidx))
                )
            }
            statDt.setTime(statDt.getTime() + 86400000);
            setImmediate(
                function() {
                    this.importHistoricalStat(statDt, stats, missingDays)
                }.bind(this)
            )
            resolve(statDt)
        })
    }

    pointHistorical(stat, statDt, curidx) {
        return this.jhumetrics.reduce((accum, metric) => {
            if (typeof(accum) === "string") {
                accum = apis.map(api => new Point(api.apiName)
                    .tag("province", stat.province.replace(/[^a-zA-Z0-9]/g, '_'))
                    .tag("generation", "19")
                    .tag("country", (Object.keys(api.countryMap)
                        .filter(country => stat.country == country)
                        .map(mappedCountry => api.countryMap[mappedCountry])[0] || stat.country).replace(/[^a-zA-Z0-9]/g, '_'))
                    .timestamp(statDt)
                    .floatField(this.getFieldName(api, accum), stat.timeline[accum][curidx] || 0)
                )
            }
            return accum.map((pt, idx) =>
                pt.floatField(this.getFieldName(apis[idx], metric), stat.timeline[metric][curidx] || 0)
            )
        })
    }

    getFieldName(api, metric) {
        return Object.keys(api.fieldMap)
            .filter(field => field == metric)
            .map(field => api.fieldMap[field])[0] || metric
    }

    getTheStats() {
        return Promise.all([
            this.getJHUStats(),
            this.getApiStats()
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
                    resolve(this.writer.writePoints(
                        JSON.parse(data)
                        .map(stat => {
                            let pt = new Point("covidapi")
                                .tag("country", stat.country.replace(/[^a-zA-Z0-9]/g, '_'))
                                .tag("generation", "19")
                                .tag("latitude", stat.countryInfo.lat)
                                .tag("longitude", stat.countryInfo.long)
                                .timestamp(new Date(stat.updated))
                            Object.keys(stat)
                                .filter(field => field != "updated" && field != "countryInfo")
                                .filter(field => !isNaN(stat[field]) && stat[field] != "")
                                .forEach(field => pt.floatField(field, stat[field]))
                            return pt
                        })
                    ))
                })
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
                    resolve(this.writer.writePoints(
                        JSON.parse(data)
                        .filter(stat => stat.province)
                        .map(stat => {
                            //console.log(stat)
                            let pt = new Point("jhu_covid")
                                .tag("country", stat.country.replace(/[^a-zA-Z0-9]/g, '_'))
                                .tag("generation", "19")
                                .tag("province", stat.province.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_'))
                                .tag("latitude", stat.coordinates.latitude)
                                .tag("longitude", stat.coordinates.longitude)
                                .timestamp(new Date(stat.updatedAt))
                            Object.keys(stat.stats)
                                .filter(field => !isNaN(stat.stats[field]) && stat.stats[field] != null)
                                .forEach(field => pt.floatField(field, stat.stats[field]))
                            return pt
                        })
                    ))
                })
            })
        })
    }
}

let covidExplorer = new CovidExporter()