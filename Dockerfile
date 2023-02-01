FROM node:slim

RUN apt-get update && apt-get install -y ffmpeg

COPY . /app

WORKDIR /app

RUN yarn install

CMD ["yarn", "start", "--", "/app/test/"]