import { cp, mkdir, rm } from "node:fs/promises";

const output = new URL("../dist/", import.meta.url);
const client = new URL("client/", output);
const server = new URL("server/", output);

await rm(output, { force: true, recursive: true });
await mkdir(client, { recursive: true });
await mkdir(server, { recursive: true });

await Promise.all([
  cp(new URL("../index.html", import.meta.url), new URL("index.html", client)),
  cp(new URL("../og.png", import.meta.url), new URL("og.png", client)),
  cp(new URL("../src/", import.meta.url), new URL("src/", client), { recursive: true }),
  mkdir(new URL("data/", client), { recursive: true }).then(() =>
    Promise.all([
      cp(new URL("../data/courses.json", import.meta.url), new URL("data/courses.json", client)),
      cp(new URL("../data/programs.json", import.meta.url), new URL("data/programs.json", client)),
    ]),
  ),
  cp(new URL("../worker/", import.meta.url), server, { recursive: true }),
]);

console.log("Built static client and plan API worker in dist/.");
