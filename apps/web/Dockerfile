FROM node:20-alpine

WORKDIR /srv

# npm ci, not npm install: it installs exactly what package-lock.json pins, so
# a rebuild cannot silently pull a newer transitive dependency than the one
# that was reviewed. It needs the lockfile, which the previous COPY left out -
# that omission is what made `npm install` the only option here.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# node:20-alpine ships an unprivileged `node` user. .next is created here so
# that the dev compose file's anonymous volume for it inherits this ownership;
# a volume over a path absent from the image is created root-owned, which the
# dev server then cannot write to.
RUN mkdir -p /srv/.next /srv/out \
 && chown -R node:node /srv
USER node

EXPOSE 3000
CMD ["npm", "run", "dev"]
