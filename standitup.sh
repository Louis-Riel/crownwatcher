#!/bin/bash
has_docker_access="$(docker-compose ps &> /dev/null && echo yes || echo no)"
[[ "$has_docker_access" == "no" ]] && echo Your account does not have sufficient rights to run this script, please run the script using sudo && exit 4
chown -R 963:20000 grafana
chown -R 964:1001 grafana
docker-compose up -d;
docker-compose logs -f;
