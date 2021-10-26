FROM nodered/node-red:latest-10-minimal
ENV LANG C.UTF-8
USER root
RUN apk add android-tools --update-cache \
        --repository https://alpine.global.ssl.fastly.net/alpine/edge/community \
        --repository https://alpine.global.ssl.fastly.net/alpine/edge/main \
        --repository https://dl-3.alpinelinux.org/alpine/edge/testing \
        --repository http://dl-cdn.alpinelinux.org/alpine/edge/testing
COPY logcatter /usr/src/node-red/custom-nodes/logcatter
RUN chown -R node-red:root /usr/src/node-red/custom-nodes && chmod 700 /usr/src/node-red/custom-nodes/logcatter
RUN mkdir /usr/src/node-red/.ssh && chown -R node-red:root /usr/src/node-red/.ssh && chmod 700 /usr/src/node-red/.ssh
USER node-red
RUN npm add /usr/src/node-red/custom-nodes/logcatter