#!/bin/bash
has_docker_access="$(docker-compose ps &> /dev/null && echo yes || echo no)"
[[ "$has_docker_access" == "no" ]] && echo Your account does not have sufficient rights to run this script, please run the script using sudo && exit 4
chown -R 963:20000 grafana/serverconfig
chown -R 964:1001 influxdb
docker-compose build;
docker-compose up -d;
sleep 10
docker exec -it dashboard grafana-cli plugins install grafana-piechart-panel
docker exec -it dashboard grafana-cli plugins install grafana-worldmap-panel
docker-compose restart dashboard
docker-compose logs -f;
