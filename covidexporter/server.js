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
                    .then(res => this.fixBadData())
                    .catch(console.error)
            } else {
                reject(res.status)
            }
        })
    }

    fixBadData() {
        return new Promise((resolve, reject) => {
            var curDays = Math.floor((new Date() - new Date(2020, 1, 1)) / (1000 * 60 * 60 * 24))
            curDays = this.fixBadDataBatch(curDays, resolve, reject)
        })
    }

    fixBadDataBatch(curDays, resolve, reject, lastRec, lastIssue) {
        if (curDays > 0) {
            var dt = new Date()
            dt.setDate(new Date().getDate() - curDays)
            console.log(`Looking ${dt} back`)
            const fluxQuery = flux `from(bucket: "${env.INFLUX_BUCKET}")
                    |> range(start: -${curDays}d, stop: -${curDays > 50 ? curDays - 50 : 0}d)
                    |> filter(fn: (r) => r["_measurement"] == "covidapi")
                    |> sort(columns: ["_measurement", "coutry", "province", "_field", "_time"])`
            let res = []
            let that = this

            this.reader.queryRows(fluxQuery, {
                next(row, tableMeta) {
                    var theRow = tableMeta.toObject(row)
                        //if (theRow._value == 0) {
                        //    console.log(theRow)
                        //    console.log(lastRec)
                        //}

                    if ((lastRec != null) &&
                        Object.keys(theRow).concat(Object.keys(lastRec))
                        .reduce((ret, cur) => {
                            var acc
                            if (typeof(ret) == "string") {
                                acc = ret
                                ret = [ret]
                            } else {
                                acc = ret[ret.length - 1]
                            }
                            if (ret[ret.length - 1].localeCompare(cur) != 0)
                                ret.push(acc)
                            return ret
                        })
                        .filter(fld => !["table", "_start", "_stop", "_time", "_value", "_result"].some(fld2 => fld.localeCompare(fld2) == 0))
                        .every(field => that.compareProp(theRow, lastRec, field) == 0)) {
                        if (((lastRec._value > 1000) || (lastIssue && lastIssue.start._value)) && ((theRow._value || 0) == 0)) {
                            res.push(lastIssue = { issue: "zeroed", start: lastIssue ? lastIssue.start : lastRec, end: theRow })
                                //console.log("zeroed")
                                //console.log(lastIssue)
                        } else if ((lastRec._value > 0) && (Math.abs(theRow._value - lastRec._value) > Math.max(lastRec._value * 3, 10000))) {
                            res.push(lastIssue = { issue: "valuegap", start: lastRec, end: theRow })
                                //console.log("valuegap")
                                //console.log(lastIssue)
                        } else if ((new Date(theRow._time) - new Date(lastRec._time)) > (1000 * 60 * 60 * 24 * 2)) {
                            res.push(lastIssue = { issue: "timegap", start: lastRec, end: theRow })
                                //console.log("timegap")
                                //console.log(lastIssue)
                        } else {
                            lastIssue = null
                        }
                    } else {
                        lastIssue = null
                    }
                    lastRec = theRow
                },
                error(err) {
                    console.error(err)
                    reject(err.json)
                },
                complete() {
                    resolve(that.fixIssues(res).then(res =>
                        setImmediate(
                            function() {
                                that.fixBadDataBatch(curDays - 50, resolve, reject, lastRec, lastIssue)
                            }.bind(that)
                        )))
                }
            })

        } else {
            resolve()
        }
    }

    compareProp(a, b, fld) {
        if (a[fld] &&
            b[fld])
            return a[fld].localeCompare(b[fld])

        return a[fld] ? 1 : !b[fld] ? 0 : -1
    }

    fixIssues(issues) {
        return new Promise((resolve, reject) => {
            try {
                issues = issues.filter(issue => issue.issue == "vvvvvvaluegap")
                    .map(issue => this.fixValueGap(issue))
                    .concat(
                        issues.filter(issue => issue.issue == "zeroed")
                        .map(issue => this.fixZeroGap(issue))
                    )
                    .filter(issue => issue)
                    .sort((a, b) => {
                        var ret = 0

                        if (((ret = this.compareProp(a, b, "_measurement")) == 0) &&
                            ((ret = this.compareProp(a, b, "country")) == 0) &&
                            ((ret = this.compareProp(a, b, "province")) == 0) &&
                            ((ret = this.compareProp(a, b, "_time")) == 0)) {
                            return this.compareProp(a, b, "_field")
                        }
                        return ret
                    })
                    .map(this.recordToPoint)

                if (issues && issues.length) {
                    this.writer.writePoints(
                        //console.log(
                        issues.reduce((ret, cur) => {
                            var acc
                            if (!Array.isArray(ret)) {
                                acc = ret
                                ret = [ret]
                            } else {
                                acc = ret[ret.length - 1]
                            }

                            if ((this.compareProp(acc, cur, "name") == 0) &&
                                (acc.time.getTime() == cur.time.getTime()) &&
                                Object.keys(acc.tags).concat(Object.keys(cur.tags))
                                .reduce((ret, cur) => {
                                    var acc
                                    if (typeof(ret) == "string") {
                                        acc = ret
                                        ret = [ret]
                                    } else {
                                        acc = ret[ret.length - 1]
                                    }
                                    if (ret[ret.length - 1].localeCompare(cur) != 0)
                                        ret.push(acc)
                                    return ret
                                }).every(field => this.compareProp(acc.tags, cur.tags, field) == 0)) {
                                Object.keys(cur.fields)
                                    .filter(field => !Object.keys(acc.fields).some(f1 => f1 == field))
                                    .forEach(field => acc.floatField(field, cur.fields[field]))
                            } else {
                                ret.push(cur)
                                    //console.log(cur)
                            }
                            return ret
                        }))
                }

                resolve()
            } catch (ex) {
                console.error(ex)
                reject(ex)
            }
        })
    }

    recordToPoint(issue) {
        var pt = new Point(issue._measurement)
        Object.keys(issue).forEach(field => {
            if (!field.startsWith("_") && (field != "result") && (field != "table")) {
                pt.tag(field, issue[field]);
            }
        })
        pt.floatField(issue._field, issue._value)
        pt.timestamp(new Date(issue._time))

        return pt;
    }

    fixZeroGap(issue) {
        if (issue && issue.end && issue.start &&
            (issue.end._value == 0) && (issue.start._value != 0)) {
            issue.end._value = issue.start._value
            return issue.end
        }
        console.warn(`weirdness is afoot`)
        console.warn(issue)
        return null
    }

    fixValueGap(issue) {
        if ((issue.end._value > issue.start._value) || (issue.end._value < 0)) {
            console.log(`${issue.end.country}/${issue.end.province}/${issue.end._field}(${issue.end._time}):${issue.end._value} <- ${issue.start._value}`)
            issue.end._value = issue.start._value
            return issue.end
        }
        console.warn(`weirdness is afoot.`)
        console.warn(issue)
        return null
    }

    getCurMaxDt() {
        return new Promise((resolve, reject) => {
            const fluxQuery = flux `from(bucket: "${env.INFLUX_BUCKET}")
                |> range(start: -20d, stop: now())
                |> filter(fn: (r) => r["_measurement"] == "covidapi")
                |> filter(fn: (r) => r["_field"] == "deaths")`
            var maxDt = null
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
                    setInterval(function() {
                        this.getTheStats()
                    }, 3600000)
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
                    var dt
                    this.writer.writePoints(
                        JSON.parse(data)
                        .map(stat => {
                            let pt = new Point("covidapi")
                                .tag("country", stat.country.replace(/[^a-zA-Z0-9]/g, '_'))
                                .tag("generation", "19")
                                .tag("latitude", stat.countryInfo.lat)
                                .tag("longitude", stat.countryInfo.long)
                                .timestamp(dt = new Date(stat.updated))
                            Object.keys(stat)
                                .filter(field => field != "updated" && field != "countryInfo")
                                .filter(field => !isNaN(stat[field]) && stat[field] != "")
                                .forEach(field => pt.floatField(field, stat[field]))
                                //console.log(pt)
                            return pt
                        }))
                    console.log(`Done getting corona jhu Stats for ${dt}`)
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
                    var dt
                    this.writer.writePoints(
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
                                .timestamp(dt = new Date(stat.updatedAt))
                            Object.keys(stat.stats)
                                .filter(field => !isNaN(stat.stats[field]) && stat.stats[field] != null)
                                .forEach(field => pt.floatField(field, stat.stats[field]))

                            //console.log(pt)
                            return pt
                        }))
                    console.log(`Done getting corona api Stats for ${dt}`);
                })
            })
        })
    }
}

let covidExplorer = new CovidExporter()