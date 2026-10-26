import { expect, test } from "bun:test";
import { FakeModel, text } from "./fake-model";
import { signIn, testApp } from "./helpers";

const PHOTO = "https://ireland.apollo.olxcdn.com/v1/files/abc/image;s=320x240";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const photoPath = (url: string) => `/listing-photo?url=${encodeURIComponent(url)}`;

test("a listings block draws, and its photos come through the brain from the marketplace", async () => {
  const block = `\`\`\`chart\n${JSON.stringify({
    type: "listings",
    unit: "zł",
    items: [
      {
        title: "RTX 3080 10GB",
        price: 1850,
        url: "https://www.olx.pl/d/oferta/a.html",
        photo: PHOTO,
      },
      { title: "RTX 3080 Ti", price: 2300, url: "https://www.vinted.pl/items/1", site: "Vinted" },
    ],
  })}\n\`\`\``;
  const model = new FakeModel([{ content: [text(`Two under 2,500 zł:\n\n${block}`)] }]);
  const t = await testApp(model);
  const fetched: string[] = [];
  t.outside.fetch = async (url) => {
    fetched.push(url);
    return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
  };
  await t.thread.post("3080s on OLX?").done;
  expect(t.thread.list().at(-1)?.text).toBe(`Two under 2,500 zł:\n\n${block}`);
  expect(model.requests).toHaveLength(1);

  const { cookie } = signIn(t);
  for (let i = 0; i < 2; i++) {
    const res = await t.call("GET", photoPath(PHOTO), undefined, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
  }
  expect(fetched).toEqual([PHOTO]);
});

test("a photo from anywhere else, redirected elsewhere, or that isn't a picture isn't passed on", async () => {
  const t = await testApp();
  const fetched: string[] = [];
  t.outside.fetch = async (url) => {
    fetched.push(url);
    if (url.includes("moved"))
      return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
    if (url.includes("svg"))
      return new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
    return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
  };
  const { cookie } = signIn(t);
  const refused = [
    "https://evil.example/a.jpg?k=secret",
    "https://olxcdn.com.evil.example/a.jpg",
    "http://ireland.apollo.olxcdn.com/a.jpg",
    "https://ireland.apollo.olxcdn.com:8443/a.jpg",
    "https://images1.vinted.net/moved.jpg",
    "https://a.allegroimg.com/svg",
  ];
  for (const url of refused) {
    const res = await t.call("GET", photoPath(url), undefined, { cookie });
    expect([url, res.status]).toEqual([url, 404]);
  }
  expect(fetched).toEqual(["https://images1.vinted.net/moved.jpg", "https://a.allegroimg.com/svg"]);
  expect((await t.call("GET", photoPath(PHOTO))).status).toBe(401);
});
