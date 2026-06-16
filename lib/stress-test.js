const puppeteer = require("puppeteer");
const _ = require("lodash/fp");
const username = require("./username");

// BigBlueButton 3.0 join flow.
//
// On join, BBB 3.0 shows a single "audio settings" modal
// ([data-test="audioModal"]) containing the device pickers and a primary
// "Join audio" button ([data-test="joinEchoTestButton"]). "Listen only" is no
// longer a separate button: it is the "No microphone (listen only)" entry in
// the microphone <select>. We drive the modal via stable data-test attributes
// so the automation is independent of the server UI language.
const initClient = async (
  browser,
  logger,
  joinUrl,
  webcam = false,
  microphone = false
) => {
  const page = await browser.newPage();
  await page.goto(joinUrl);

  const listenOnly = !microphone;

  logger.debug('waiting for the audio modal ([data-test="audioModal"])');
  await page.waitForSelector('[data-test="audioModal"]', { timeout: 45000 });

  // The device <select> elements only populate after enumerateDevices()
  // resolves. Clicking "Join audio" before that leaves the modal stuck open
  // (and makes listen-only selection a no-op). The "No microphone (listen
  // only)" entry is added once enumeration completes, so wait for it.
  logger.debug("waiting for audio devices to populate");
  await page.waitForFunction(
    () => {
      const sel = document.querySelector('[data-test="audioModal"] select');
      return (
        sel &&
        Array.from(sel.options).some((o) =>
          /listen[ -]only/i.test(`${o.textContent} ${o.value}`)
        )
      );
    },
    { timeout: 30000 }
  );

  if (listenOnly) {
    logger.debug('selecting the "No microphone (listen only)" device');
    const selected = await page.evaluate(() => {
      const selects = Array.from(
        document.querySelectorAll('[data-test="audioModal"] select')
      );
      const sel = selects.find((s) =>
        Array.from(s.options).some((o) =>
          /listen[ -]only/i.test(`${o.textContent} ${o.value}`)
        )
      );
      if (!sel) return false;
      const opt = Array.from(sel.options).find((o) =>
        /listen[ -]only/i.test(`${o.textContent} ${o.value}`)
      );
      // Use the native setter so React picks up the controlled-value change.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value"
      ).set;
      setter.call(sel, opt.value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
    logger.debug(`listen-only device selected: ${selected}`);
    // Let React commit the controlled-value change before clicking join.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  logger.debug('clicking the "Join audio" button');
  const joined = await page.evaluate(() => {
    const modal = document.querySelector('[data-test="audioModal"]');
    if (!modal) return false;
    let btn = modal.querySelector('[data-test="joinEchoTestButton"]');
    if (!btn) {
      // Fallback: match the primary action by label, any language.
      btn = Array.from(modal.querySelectorAll("button")).find((b) =>
        /join audio|rejoindre l'audio|confirmer/i.test(
          `${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`
        )
      );
    }
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!joined) {
    throw new Error('could not find the "Join audio" button in the audio modal');
  }

  logger.debug("waiting for the audio modal to close (audio connected)");
  await page.waitForSelector('[data-test="audioModal"]', {
    hidden: true,
    timeout: 30000,
  });
  logger.debug("audio connected");

  if (microphone) {
    // Clients may join muted; best-effort unmute so the mic actually publishes.
    try {
      await page.waitForSelector('[data-test="unmuteMicButton"]', {
        timeout: 5000,
      });
      await page.click('[data-test="unmuteMicButton"]');
      logger.debug("microphone unmuted");
    } catch (err) {
      logger.debug("no unmute button (already live or join-muted disabled)");
    }
  }

  if (webcam) {
    try {
      logger.debug("opening the webcam share modal");
      await page.waitForSelector('[data-test="joinVideo"]', { timeout: 10000 });
      await page.click('[data-test="joinVideo"]');
      // Let the webcam settings modal render, then start sharing.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const shared = await page.evaluate(() => {
        const byTest = document.querySelector('[data-test="startSharingWebcam"]');
        const btn =
          byTest ||
          Array.from(document.querySelectorAll("button")).find((b) =>
            /start sharing|démarrer le partage|commencer le partage/i.test(
              `${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`
            )
          );
        if (!btn) return false;
        btn.click();
        return true;
      });
      logger.debug(`webcam "Start sharing" clicked: ${shared}`);
    } catch (err) {
      logger.debug(`webcam share failed: ${err.message}`);
    }
  }

  return Promise.resolve(page);
};

const generateClientConfig = (webcam = false, microphone = false) => {
  return {
    username: username.getRandom(),
    webcam,
    microphone,
  };
};

async function start(
  bbbClient,
  logger,
  meetingID,
  testDuration,
  clientWithCamera,
  clientWithMicrophone,
  clientListening
) {
  const [browser, meetingPassword] = await Promise.all([
    puppeteer.launch({
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/lib/chromium/chromium",
      // A loaded browser is slow to answer CDP; give it room before erroring
      // (default 180s throws "Target.createTarget timed out" under load).
      protocolTimeout: 300000,
      // Don't let Puppeteer trap SIGINT/SIGTERM — it tries to gracefully close
      // a possibly-wedged browser, which is why Ctrl+C needed several presses.
      // We install our own fast shutdown below.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--disable-crash-reporter",
        "--disable-background-networking",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--mute-audio",
      ],
    }),
    bbbClient.getModeratorPassword(meetingID),
  ]);

  // Kill Chromium and exit promptly on Ctrl+C / termination (the container is
  // ephemeral, so a hard kill is fine and avoids hanging on a stuck browser).
  const shutdown = () => {
    logger.info("Shutting down...");
    try {
      const proc = browser.process();
      if (proc) proc.kill("SIGKILL");
    } catch (err) {
      /* ignore */
    }
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const clientsConfig = [
    ...[...Array(clientWithCamera)].map(() => generateClientConfig(true, true)),
    ...[...Array(clientWithMicrophone)].map(() =>
      generateClientConfig(false, true)
    ),
    ...[...Array(clientListening)].map(() =>
      generateClientConfig(false, false)
    ),
  ];

  for (let idx = 0; idx < clientsConfig.length; idx++) {
    logger.info(`${clientsConfig[idx].username} join the conference`);
    await initClient(
      browser,
      logger,
      bbbClient.getJoinUrl(
        clientsConfig[idx].username,
        meetingID,
        meetingPassword
      ),
      clientsConfig[idx].webcam,
      clientsConfig[idx].microphone
    ).catch((err) => {
      logger.error(
        `Unable to initialize client ${clientsConfig[idx].username} : ${err}`
      );
      Promise.resolve(null);
    });
  }

  logger.info("All user joined the conference");
  logger.info(`Sleeping ${testDuration}s`);
  await new Promise((resolve) => setTimeout(resolve, testDuration * 1000));
  logger.info("Test finished");
  return browser.close();
}

module.exports = {
  start,
};
