"use strict"
/*jshint esversion: 6 */

import http from 'http'
import https from 'https'

export default class CovidExporter {
    constructor() {
        this.jhumetrics = ['confirmed', 'deaths', 'recovered']
        this.covidapitmetrics = ["cases", "todayCases", "deaths", "todayDeaths", "recovered", "active",
            "critical", "casesPerOneMillion", "deathsPerOneMillion", "tests", "testsPerOneMillion"]
        this.jhuhmetrics = ["cases", "deaths", "recovered"]
    }

    bootStrapStats() {
        return new Promise((resolve, reject) => {
            http.get({
                host: 'influxdb',
                port: 8086,
                path: '/query?pretty=true&db=telegraf&q=SELECT%20time,min(confirmed)%20FROM%20jhu_covid',
                headers: {
                    'cache-control': 'no-cache'
                }
            }, (covidres) => {
                let data = ''
                console.log("Getting First Date")
                covidres.setEncoding('utf8')

                covidres.on('error', function (err) {
                    console.log("Error during HTTP request")
                    console.log(err)
                })

                covidres.on('data', (stats) => {
                    data += stats
                })
                covidres.on('end', () => {
                    var curstat = JSON.parse(data)
                    if (curstat.results[0].error) {
                        console.error("Cannot connect to influxdb")
                        process.exit(1)
                    }
                    https.get({
                        host: 'corona.lmao.ninja',
                        path: '/v2/historical?lastdays=all',
                        headers: {
                            'cache-control': 'no-cache'
                        }
                    }, (covidres) => {
                        let data = ''
                        covidres.setEncoding('utf8')
                        console.log("Getting corona jhu Historical Stats")

                        covidres.on('error', function (err) {
                            console.log("Error during HTTP request")
                            console.log(err)
                        })

                        covidres.on('data', (stats) => {
                            data += stats
                        })
                        covidres.on('end', () => {
                            var stats = JSON.parse(data)
                            var cnt = 0

                            var mindt
                            try {
                                mindt = new Date(new Date(curstat.results[0].series[0].values[0][0]) - (8 * 60 * 1000))
                                console.log("Stats started at %s %s", mindt, curstat.results[0].series[0].values[0][0])
                            } catch (err) {
                                mindt = new Date(new Date().toDateString())
                                mindt.setTime(mindt.getTime() - (5 * 60 * 1000))
                                console.log("Stats defaulted to yesterday %s", mindt)
                            }

                            this.importStat(mindt, stats, 0).then((cnt) => {
                                resolve(cnt)
                            })
                        })
                    }).end()
                })
            })
        })
    }

    importStat(mindt, stats, cnt) {
        return new Promise(async (resolve, reject) => {
            var stat, tmpstat
            var ifm = ""
            var curidx = `${mindt.getMonth() + 1}/${mindt.getDate()}/${mindt.getFullYear() - 2000}`
            if (!stats[0].timeline.cases[curidx]) {
                console.log("Done importing %d historical stats on %s", cnt, curidx)
                resolve(cnt)
                return;
            }
            if ((mindt.getHours() == 0) && (mindt.getMinutes() == 0)) {
                console.log("Processing %s", mindt)
            }

            try {
                for (const statidx in stats) {
                    stat = stats[statidx]
                    if (!stat.province) {
                        var skipit = false
                        for (const statidx in stats) {
                            tmpstat = stats[statidx]
                            skipit |= tmpstat.country == stat.country && stat.province && stat.province != ""
                            if (skipit)
                                continue
                        }
                        if (skipit)
                            continue
                    }

                    ifm += `jhu_covid,generation=19,province=${stat.province ? stat.province.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_') : ""},country=${stat.country.replace(/[^a-zA-Z0-9]/g, '_')
                        .replace(/^USA$/, 'US')
                        .replace(/^UK$/, 'United_Kingdom')} `.replace(/[a-z]+=,/g, '')
                    for (const metric in this.jhuhmetrics) {
                        if (this.jhuhmetrics[metric] == "cases") {
                            ifm += `confirmed=${stat.timeline.cases[curidx]}`
                        }
                        else {
                            ifm += `${this.jhuhmetrics[metric]}=${stat.timeline[this.jhuhmetrics[metric]][curidx]}`
                        }
                        if (metric < this.jhuhmetrics.length - 1) {
                            ifm += ","
                        } else {
                            ifm += ` ${mindt.getTime()}000000\n`
                        }
                    }
                }
                await this.postToInflux(ifm).then((result) => {
                    cnt += ifm.split('\n').length
                })
                ifm = ""
                var countryStats = {}
                for (const statidx in stats) {
                    stat = stats[statidx]
                    if (!countryStats[stat.country]) {
                        countryStats[stat.country] = { country: stat.country }
                        for (const metric in this.covidapitmetrics) {
                            countryStats[stat.country][this.covidapitmetrics[metric]] = 0
                        }
                    }

                    for (const metric in this.covidapitmetrics) {
                        if (stat.timeline[this.covidapitmetrics[metric]]) {
                            countryStats[stat.country][this.covidapitmetrics[metric]] += Number(stat.timeline[this.covidapitmetrics[metric]][curidx])
                        }
                    }
                }
                var msg = ""
                for (const statidx in countryStats) {
                    stat = countryStats[statidx]
                    msg = `covidapi,generation=19,country=${stat.country.replace(/[^a-zA-Z0-9]/g, '_')} `
                    for (const metric in this.covidapitmetrics) {
                        msg += `${this.covidapitmetrics[metric]}=${stat[this.covidapitmetrics[metric]]}`
                        if (metric < this.covidapitmetrics.length - 1) {
                            msg += ","
                        } else {
                            msg += ` ${mindt.getTime()}000000`
                        }
                    }
                    ifm += msg + "\n"
                }
                await this.postToInflux(ifm).then((result) => {
                    cnt += ifm.split('\n').length
                })
                mindt.setTime(mindt.getTime() - 86400000)
                setImmediate(
                    function () {
                        this.importStat(mindt, stats, 0)
                    }.bind(this)
                )
                resolve(cnt)
            }
            catch (err) {
                console.log(err)
                reject(err)
            }
        })
    }

    getTheStats() {
        return Promise.all([
            new Promise((resolve, reject) => {
                https.get({
                    host: 'corona.lmao.ninja',
                    path: '/v2/jhucsse',
                    headers: {
                        'cache-control': 'no-cache'
                    }
                }, (covidres) => {
                    let data = ''
                    console.log("Getting corona api Stats")
                    covidres.setEncoding('utf8')

                    covidres.on('error', function (err) {
                        console.log("Error during HTTP request")
                        console.log(err)
                    })

                    covidres.on('data', (stats) => {
                        data += stats
                    })
                    covidres.on('end', () => {
                        console.log("Done getting corona jhu Stats")
                        JSON.parse(data).forEach(function (stat) {
                            var ifm = `jhu_covid,generation=19,province=${stat.province ? stat.province.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_') : ""},latitude=${stat.coordinates.latitude},longitude=${stat.coordinates.longitude},country=${stat.country.replace(/[^a-zA-Z0-9]/g, '_')} `.replace(/[a-z]+=,/g, '')
                            for (const metric in this.jhumetrics) {
                                if (stat.stats[this.jhumetrics[metric]] != undefined) {
                                    ifm += `${this.jhumetrics[metric]}=${stat.stats[this.jhumetrics[metric]]},`
                                }
                            }
                            resolve(this.postToInflux(ifm.substr(0, ifm.length - 1)))
                        }.bind(this))
                    })
                })
            }),
            new Promise((resolve, reject) => {
                https.get({
                    host: 'corona.lmao.ninja',
                    path: '/v2/countries',
                    headers: {
                        'cache-control': 'no-cache'
                    }
                }, (covidres) => {
                    let data = ''
                    covidres.setEncoding('utf8')
                    console.log("Getting corona jhu Stats")

                    covidres.on('error', function (err) {
                        console.log("Error during HTTP request")
                        console.log(err)
                    })

                    covidres.on('data', (stats) => {
                        data += stats
                    })

                    covidres.on('end', () => {
                        console.log("Done getting corona api Stats")
                        JSON.parse(data).forEach(function (stat) {
                            var ifm = `covidapi,generation=19,latitude=${stat.countryInfo.lat},longitude=${stat.countryInfo.long},country=${stat.country.replace(/[^a-zA-Z0-9]/g, '_')} `
                            for (const metric in this.covidapitmetrics) {
                                if (stat[this.covidapitmetrics[metric]] != undefined) {
                                    ifm += `${this.covidapitmetrics[metric]}=${stat[this.covidapitmetrics[metric]]},`
                                }
                            }
                            resolve(this.postToInflux(ifm.substr(0, ifm.length - 1)))
                        }.bind(this))
                    })
                })
            })
        ])
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
            req.write(metric)
            req.end()
        })
    }
}

let covidExplorer = new CovidExporter()
covidExplorer.bootStrapStats()
covidExplorer.getTheStats()
setInterval(function () {
    covidExplorer.getTheStats()
}, 3600000)
