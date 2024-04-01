FROM node:alpine

RUN apk update && apk add bash tzdata \
    && cp -r -f /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
RUN apk add g++ make python

WORKDIR /usr/src/app

COPY package*.json ./

RUN yarn install --production

COPY . .

EXPOSE 3000

ENTRYPOINT ["yarn", "run"]
CMD ["pro"]
