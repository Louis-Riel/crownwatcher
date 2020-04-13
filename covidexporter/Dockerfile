FROM node:12

ARG UID
ARG GID
ARG user
RUN apt-get update
RUN apt-get install -y libaio1 netcat

EXPOSE 8008

RUN grep :${GID}: /etc/group && groupmod --gid ${GID} -n exporter || groupadd --gid ${GID} exporter
RUN useradd --create-home --shell /bin/false -u ${UID} -g ${GID} ${user}
ENV HOME /home/${user}

RUN mkdir $HOME/src

WORKDIR $HOME/src
COPY ./* $HOME/src/

RUN npm install
RUN chown -R ${user}:exporter $HOME/src
USER ${user}
