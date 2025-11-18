const puppeteer = require("puppeteer");
const _ = require("lodash/fp");
const username = require("./username");
const fs = require("fs");

const initClient = async (
  browser,
  logger,
  joinUrl,
  webcam = false,
  microphone = false
) => {
  const page = await browser.newPage();
  await page.goto(joinUrl);

  // Helper function to dump page HTML for debugging
  const dumpPageHTML = async (reason) => {
    try {
      const html = await page.content();
      const timestamp = Date.now();
      const filename = `/tmp/bbb-debug-${timestamp}.html`;
      fs.writeFileSync(filename, html);
      logger.debug(`HTML dumped to ${filename} (reason: ${reason})`);
    } catch (err) {
      logger.debug(`Failed to dump HTML: ${err.message}`);
    }
  };

  // Helper function to join audio (for initial join and retries)
  const joinAudio = async (audioAction) => {
    logger.debug(`waiting for audio prompt ([aria-label="${audioAction}"])`);
    await page.waitForSelector(`[aria-label="${audioAction}"]`);
    logger.debug(`click on ${audioAction}`);
    await page.click(`[aria-label="${audioAction}"]`);
    if (microphone) {
      logger.debug("waiting for the echo test dialog");
      try {
        await page.waitForSelector(
          `[aria-label="Join audio"][data-test="joinEchoTestButton"]`,
          {
            timeout: 10000,
          }
        );
        logger.debug(
          'echo test dialog detected. clicking on "Join audio" button.'
        );
        await page.click(
          `[aria-label="Join audio"][data-test="joinEchoTestButton"]`
        );
      } catch (err) {
        logger.debug(
          "unable to detect the echo test dialog. Maybe echo test is disabled."
        );
      }
    }
    // Wait for modal to close - try multiple methods as BBB UI may have changed
    logger.debug("waiting for audio modal to close...");
    let modalClosed = false;

    // First try: detect main meeting interface elements (works in newer BBB versions)
    try {
      await page.waitForSelector(
        '[data-test="userListToggleButton"],[data-test="joinAudio"],[aria-label="Users and messages toggle"]',
        {
          timeout: 3000,
          hidden: false,
        }
      );
      logger.debug("modal closed (detected main meeting UI)");
      modalClosed = true;
    } catch (err) {
      logger.debug(
        "main UI elements not found, trying ReactModal detection..."
      );
    }

    // Second try: use ReactModal__Overlay (works in older BBB versions)
    if (!modalClosed) {
      try {
        await page.waitForSelector(".ReactModal__Overlay", {
          hidden: true,
          timeout: 2000,
        });
        logger.debug("modal closed (detected via .ReactModal__Overlay)");
        modalClosed = true;
      } catch (err) {
        logger.debug(
          "ReactModal__Overlay not found either, assuming modal closed"
        );
        await dumpPageHTML("modal close detection failed");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };

  const audioAction = microphone ? "Microphone" : "Listen only";
  await joinAudio(audioAction);

  // Verify audio connection for microphone users
  if (microphone) {
    logger.debug("Verifying audio connection...");
    let audioConnected = false;

    try {
      // Check if audio is connected by looking for mute/unmute buttons
      await page.waitForSelector('[aria-label="Mute"],[aria-label="Unmute"]', {
        timeout: 5000,
      });
      audioConnected = true;
      logger.debug("audio successfully connected");

      // If we are muted, click on Unmute
      const unmuteButton = await page.$('[aria-label="Unmute"]');
      if (unmuteButton !== null) {
        logger.debug("clicking on unmute button");
        await unmuteButton.click();
      }
    } catch (err) {
      // Check if we have the "no audio" icon (icon-bbb-no_audio) which means audio failed to connect
      const noAudioButton = await page.$('[data-test="joinAudio"]');
      if (noAudioButton !== null) {
        logger.debug("audio connection failed, retrying...");
        audioConnected = false;
      } else {
        // Assume connected if we don't see the no audio button
        logger.debug(
          "audio connection verification unclear, assuming connected"
        );
        audioConnected = true;
      }
    }

    // Retry audio connection if it failed
    if (!audioConnected) {
      logger.debug("attempting to reconnect audio...");
      try {
        // Press ESC to close any open modals
        await page.keyboard.press("Escape");
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Click the "Join audio" button in the toolbar
        await page.waitForSelector('[data-test="joinAudio"]', {
          timeout: 5000,
        });
        await page.click('[data-test="joinAudio"]');
        logger.debug("clicked join audio button in toolbar");

        // Go through the audio join flow again
        await joinAudio(audioAction);

        // Verify connection again
        await page.waitForSelector(
          '[aria-label="Mute"],[aria-label="Unmute"]',
          {
            timeout: 10000,
          }
        );
        logger.debug("audio reconnection successful");

        // Check unmute status
        const unmuteButton = await page.$('[aria-label="Unmute"]');
        if (unmuteButton !== null) {
          logger.debug("clicking on unmute button");
          await unmuteButton.click();
        }
      } catch (retryErr) {
        logger.debug(
          `audio reconnection failed: ${retryErr.message}. Continuing anyway...`
        );
      }
    }
  }
  if (webcam) {
    logger.debug("waiting for share webcam button");
    await page.waitForSelector('[aria-label="Share webcam"]');
    await page.click('[aria-label="Share webcam"]');
    logger.debug("clicked on share webcam button");
    // Wait for webcam settings modal to appear
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      await page.waitForSelector("#setCam > option", { timeout: 5000 });
    } catch (err) {
      logger.debug("camera selection not found, continuing...");
    }
    await page.waitForSelector('[aria-label="Start sharing"]');
    logger.debug("clicking on start sharing");
    await page.click('[aria-label="Start sharing"]');
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
