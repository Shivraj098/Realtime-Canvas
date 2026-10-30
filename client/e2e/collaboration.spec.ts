import { expect, test, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";

const SERVER_PORT = 8787;

/** A room nobody else is in, so tests running in parallel do not see each other's shapes. */
const uniqueRoom = (): string => `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function openBoard(context: BrowserContext, room: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?room=${room}`);
  await expect(page.locator("#status")).toHaveAttribute("data-status", "open");
  return page;
}

const shapeItems = (page: Page) => page.locator("#shape-list li");
const status = (page: Page) => page.locator("#status");

/** Drags out a rectangle with the rectangle tool, the way a person would. */
async function drawRectangle(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.keyboard.press("r");
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 8 });
  await page.mouse.up();
}

/**
 * Sits between a page and the server so a test can cut the connection and
 * restore it. While "offline", new connections are refused straight away.
 */
async function controllableNetwork(page: Page) {
  let offline = false;
  let refused = 0;
  const live: WebSocketRoute[] = [];
  await page.routeWebSocket(new RegExp(`localhost:${SERVER_PORT}`), (route) => {
    if (offline) {
      refused += 1;
      void route.close();
      return;
    }
    route.connectToServer();
    live.push(route);
  });
  return {
    /** Connection attempts turned away while offline. */
    refusals: () => refused,
    async goOffline(): Promise<void> {
      offline = true;
      await Promise.all(live.splice(0).map((route) => route.close()));
    },
    /** The network returns, and the browser says so, as it would with a real `online` event. */
    async goOnline(): Promise<void> {
      offline = false;
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
    },
  };
}

/** Drags out a shape with the tool the key chooses. */
async function drawWith(
  page: Page,
  key: string,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  await page.keyboard.press(key);
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 8 });
  await page.mouse.up();
}

test("an arrow that points up and left, and a labelled ellipse, reach another browser", async ({
  browser,
}) => {
  const room = uniqueRoom();
  const alice = await openBoard(await browser.newContext(), room);
  const bob = await openBoard(await browser.newContext(), room);

  await drawWith(alice, "a", [400, 300], [300, 250]);
  await expect(bob.locator("#shape-list li[data-kind=arrow]")).toHaveAttribute("data-width", "-100");
  await expect(bob.locator("#shape-list li[data-kind=arrow]")).toHaveAttribute("data-height", "-50");

  await drawWith(alice, "o", [500, 400], [620, 480]);
  await alice.mouse.dblclick(560, 440);
  await expect(alice.locator(".text-editor")).toBeVisible();
  await alice.keyboard.type("Hello");
  await alice.keyboard.press("Enter");

  await expect(bob.locator("#shape-list li[data-kind=ellipse]")).toHaveAttribute("data-text", "Hello");
  await expect(alice.locator(".text-editor")).toBeHidden();
});

test("double-clicking empty canvas types a new text shape that the other browser sees", async ({
  browser,
}) => {
  const room = uniqueRoom();
  const alice = await openBoard(await browser.newContext(), room);
  const bob = await openBoard(await browser.newContext(), room);

  await alice.mouse.dblclick(300, 300);
  await expect(alice.locator(".text-editor")).toBeVisible();
  await alice.keyboard.type("note to self");
  await alice.keyboard.press("Enter");

  await expect(bob.locator("#shape-list li[data-kind=text]")).toHaveAttribute("data-text", "note to self");
  // Escape throws typing away: nothing is created.
  await alice.mouse.dblclick(700, 500);
  await expect(alice.locator(".text-editor")).toBeVisible();
  await alice.keyboard.type("never mind");
  await alice.keyboard.press("Escape");
  await expect(shapeItems(bob)).toHaveCount(1);
});

test("typing the letters of a shortcut into a label does not change tools or delete the shape", async ({
  page,
}) => {
  await page.goto(`/?room=${uniqueRoom()}`);
  await expect(status(page)).toHaveAttribute("data-status", "open");
  await drawWith(page, "r", [300, 300], [420, 380]);
  await page.mouse.dblclick(360, 340);
  await expect(page.locator(".text-editor")).toBeVisible();
  await page.keyboard.type("rod a lot");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await expect(shapeItems(page)).toHaveCount(1);
  await expect(shapeItems(page).first()).toHaveAttribute("data-text", "rod a lo");
});

test("duplicate copies the selected shape, and the help card opens with ?", async ({ page }) => {
  await page.goto(`/?room=${uniqueRoom()}`);
  await expect(status(page)).toHaveAttribute("data-status", "open");
  await drawWith(page, "d", [300, 300], [420, 380]);
  await page.keyboard.press("Control+d");
  await expect(shapeItems(page)).toHaveCount(2);
  await expect(shapeItems(page).nth(1)).toHaveAttribute("data-kind", "diamond");
  await expect(shapeItems(page).nth(1)).toHaveAttribute("data-x", "324");

  await page.keyboard.press("?");
  await expect(page.locator("#help")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#help")).toBeHidden();
});

test("opening the app without a room creates a private one and keeps it across a reload", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\?room=[A-Za-z0-9_-]{22}$/);
  const url = page.url();
  await page.reload();
  expect(page.url()).toBe(url);
  await expect(status(page)).toHaveAttribute("data-status", "open");
});

test("a rectangle drawn in one browser appears in another", async ({ browser }) => {
  const room = uniqueRoom();
  const alice = await openBoard(await browser.newContext(), room);
  const bob = await openBoard(await browser.newContext(), room);

  await drawRectangle(alice, [300, 300], [420, 380]);

  for (const page of [alice, bob]) {
    await expect(shapeItems(page)).toHaveCount(1);
    await expect(shapeItems(page).first()).toHaveAttribute("data-x", "300");
    await expect(shapeItems(page).first()).toHaveAttribute("data-y", "300");
    await expect(shapeItems(page).first()).toHaveAttribute("data-width", "120");
    await expect(shapeItems(page).first()).toHaveAttribute("data-height", "80");
  }
});

test("a person joining later sees what was already drawn", async ({ browser }) => {
  const room = uniqueRoom();
  const alice = await openBoard(await browser.newContext(), room);
  await drawRectangle(alice, [300, 300], [420, 380]);
  await expect(shapeItems(alice)).toHaveCount(1);

  const late = await openBoard(await browser.newContext(), room);
  await expect(shapeItems(late)).toHaveCount(1);
});

test("dragging a shape shows a live preview to others, then commits one move", async ({ browser }) => {
  const room = uniqueRoom();
  const alice = await openBoard(await browser.newContext(), room);
  const bob = await openBoard(await browser.newContext(), room);
  await drawRectangle(alice, [300, 300], [420, 380]);
  await expect(shapeItems(bob)).toHaveCount(1);

  await alice.mouse.move(360, 340);
  await alice.mouse.down();
  await alice.mouse.move(460, 440, { steps: 10 });

  // Bob sees it moving before Alice lets go...
  await expect(shapeItems(bob).first()).toHaveAttribute("data-preview-x", "400");
  await expect(shapeItems(bob).first()).toHaveAttribute("data-preview-y", "400");
  // ...but the committed position has not changed yet.
  await expect(shapeItems(bob).first()).toHaveAttribute("data-x", "300");

  await alice.mouse.up();
  await expect(shapeItems(bob).first()).toHaveAttribute("data-x", "400");
  await expect(shapeItems(bob).first()).toHaveAttribute("data-y", "400");
  await expect(shapeItems(bob).first()).not.toHaveAttribute("data-preview-x", /.*/);
  await expect(shapeItems(alice).first()).toHaveAttribute("data-x", "400");
});

test("resizing from a corner handle changes the size for everyone", async ({ browser }) => {
  const room = uniqueRoom();
  const alice = await openBoard(await browser.newContext(), room);
  const bob = await openBoard(await browser.newContext(), room);
  await drawRectangle(alice, [300, 300], [420, 380]);
  await expect(shapeItems(bob)).toHaveCount(1);

  // The new shape is selected, so its south-east handle is at (420, 380).
  await alice.mouse.move(420, 380);
  await alice.mouse.down();
  await alice.mouse.move(480, 420, { steps: 6 });
  await alice.mouse.up();

  await expect(shapeItems(bob).first()).toHaveAttribute("data-width", "180");
  await expect(shapeItems(bob).first()).toHaveAttribute("data-height", "120");
  await expect(shapeItems(bob).first()).toHaveAttribute("data-x", "300");
});

test("recolouring and deleting reach the other browser", async ({ browser }) => {
  const room = uniqueRoom();
  const alice = await openBoard(await browser.newContext(), room);
  const bob = await openBoard(await browser.newContext(), room);
  await drawRectangle(alice, [300, 300], [420, 380]);
  await expect(shapeItems(bob)).toHaveCount(1);

  await alice.getByRole("button", { name: "Coral" }).click();
  await expect(shapeItems(bob).first()).toHaveAttribute("data-color", "#f28b82");

  await expect(alice.locator("#delete")).toBeEnabled();
  await alice.keyboard.press("Delete");
  await expect(shapeItems(alice)).toHaveCount(0);
  await expect(shapeItems(bob)).toHaveCount(0);
  await expect(alice.locator("#delete")).toBeDisabled();
});

test("presence and remote cursors are shown", async ({ browser }) => {
  const room = uniqueRoom();
  const alice = await openBoard(await browser.newContext(), room);
  const bob = await openBoard(await browser.newContext(), room);

  await expect(alice.locator("#presence")).toHaveAttribute("data-count", "2");
  await expect(bob.locator("#presence")).toHaveAttribute("data-count", "2");

  await alice.mouse.move(500, 400);
  await alice.mouse.move(600, 450, { steps: 5 });
  await expect(bob.locator("#board")).toHaveAttribute("data-remote-cursors", "1");
});

test("two tabs of one browser are two participants", async ({ context }) => {
  const room = uniqueRoom();
  const first = await openBoard(context, room);
  const second = await openBoard(context, room);

  await expect(first.locator("#presence")).toHaveAttribute("data-count", "2");
  await drawRectangle(first, [300, 300], [420, 380]);
  await expect(shapeItems(second)).toHaveCount(1);
});

test("edits made offline are kept, shown, and delivered when the connection returns", async ({ browser }) => {
  const room = uniqueRoom();
  const alice = await openBoard(await browser.newContext(), room);
  const bobPage = await (await browser.newContext()).newPage();
  const bobNetwork = await controllableNetwork(bobPage);
  await bobPage.goto(`/?room=${room}`);
  await expect(status(bobPage)).toHaveAttribute("data-status", "open");

  await drawRectangle(alice, [300, 300], [420, 380]);
  await expect(shapeItems(bobPage)).toHaveCount(1);

  await bobNetwork.goOffline();
  await expect(status(bobPage)).not.toHaveAttribute("data-status", "open");

  // Alice keeps working; Bob, offline, does too.
  await drawRectangle(alice, [600, 300], [720, 380]);
  await drawRectangle(bobPage, [300, 500], [420, 580]);
  await expect(shapeItems(bobPage)).toHaveCount(2); // his own edit shows at once
  await expect(bobPage.locator("#pending")).toHaveAttribute("data-count", "1");

  // Let the client fail twice, so its next wait is 4 seconds or more. Then the
  // browser's "online" signal must cut that wait short; backoff alone would not.
  await expect.poll(() => bobNetwork.refusals(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await expect(status(bobPage)).toHaveAttribute("data-status", "waiting");
  await bobNetwork.goOnline();
  await expect(status(bobPage)).toHaveAttribute("data-status", "open", { timeout: 2500 });

  await expect(shapeItems(bobPage)).toHaveCount(3); // caught up on Alice's shape
  await expect(shapeItems(alice)).toHaveCount(3); // and Alice got Bob's
  await expect(bobPage.locator("#pending")).toHaveAttribute("data-count", "0");
});

test("the canvas is sharp on dense screens and follows the window size", async ({ browser }) => {
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 900, height: 600 } });
  const page = await openBoard(context, uniqueRoom());
  const size = () =>
    page.locator("#board").evaluate((canvas: HTMLCanvasElement) => ({
      cssWidth: canvas.clientWidth,
      width: canvas.width,
      cssHeight: canvas.clientHeight,
      height: canvas.height,
    }));

  // The backing store has twice as many pixels as the CSS size on a 2x screen.
  expect(await size()).toEqual({ cssWidth: 900, width: 1800, cssHeight: 600, height: 1200 });

  await page.setViewportSize({ width: 700, height: 500 });
  await expect.poll(size).toEqual({ cssWidth: 700, width: 1400, cssHeight: 500, height: 1000 });
});

test("the server reports that it is healthy", async ({ request }) => {
  const response = await request.get(`http://localhost:${SERVER_PORT}/health`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: "ok" });
});

test("a full board says so, and the shape that did not fit disappears for everyone", async ({ browser }) => {
  const room = uniqueRoom();
  const alice = await openBoard(await browser.newContext(), room);
  const bob = await openBoard(await browser.newContext(), room);

  // The test server allows 25 shapes per room. Fill the board with clicks.
  const place = async (index: number) => {
    await alice.keyboard.press("r");
    await alice.mouse.click(160 + (index % 8) * 140, 160 + Math.floor(index / 8) * 110);
  };
  for (let i = 0; i < 25; i++) await place(i);
  await expect(shapeItems(alice)).toHaveCount(25);
  await expect(shapeItems(bob)).toHaveCount(25);
  await expect(alice.locator("#notice")).toBeHidden();

  await place(25);

  await expect(alice.locator("#notice")).toBeVisible();
  await expect(alice.locator("#notice")).toContainText("board is full");
  // The optimistic shape was taken back, and Bob never saw it.
  await expect(shapeItems(alice)).toHaveCount(25);
  await expect(shapeItems(bob)).toHaveCount(25);
  await expect(alice.locator("#pending")).toHaveAttribute("data-count", "0");
});
