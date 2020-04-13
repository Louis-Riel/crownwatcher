# crownwatcher
This docker getup will allows you to monitor in real time the Corona virus information on a Grafana Dashboard. To install:

- Install and upgrate docker and docker-compose
- Clone this repo onto a folder with enough space to hold a database
- Go to that folder and type docker-compose up -d, or however you like to start your containers
- Point your favorite browser over to http://localhost/dashboard and login as admin/admin and change that pass
- Create a new datasource of type InfluxDB, use http://influxdb:8086 for the URL and telegraf for the database name 

![](images/configinfluxdb.png)
- Click on Import 

![](images/importdash.png)
- Copy/paste the content of a [dashboard](grafana/dashboards) in there and click Load

On the first run, historical statistics will be imported. The imported historical data will be at a resolution of 1 day and less detailed than the live data collected whilst thing is chugging along. Here is a screenshot of Grafana while the historical data is being imported

Here is Grafana whilst the historical data is being loaded
![](images/stats_loading.png)

For the first day you run this thing, there will be a data gap from the beginning of the day up to the first run. There is no "current day" historical data. For certain countries, the historical data is not broken down by region. Here is an example of the historical data turning into live data:

![](images/stats_initial.png)

Here is the Global dashboard

![](images/globaltotals.png)

Here is the country details dashboars
![](images/countrydetail.png)