import { describe, expect, it } from "bun:test";

import { installHelp, readInstallDismissed, showInstallButton, writeInstallDismissed } from "./install.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

describe("installHelp", () => {
  it("points iPhones and iPads (which report a Mac) at Add to Home Screen", () => {
    expect(installHelp({ userAgent: IPHONE, secure: false, maxTouchPoints: 5 })).toContain("Add to Home Screen");
    expect(installHelp({ userAgent: IPAD, secure: true, maxTouchPoints: 5 })).toContain("Add to Home Screen");
  });

  it("names the platform's own route elsewhere", () => {
    expect(installHelp({ userAgent: IPAD, secure: true, maxTouchPoints: 0 })).toContain("Add to Dock");
    expect(installHelp({ userAgent: ANDROID, secure: true, maxTouchPoints: 5 })).toContain("Add to Home screen");
    expect(installHelp({ userAgent: CHROME, secure: true, maxTouchPoints: 0 })).toContain("address bar");
    expect(installHelp({ userAgent: FIREFOX, secure: true, maxTouchPoints: 0 })).toContain("Chrome or Edge");
  });

  it("asks for HTTPS before anything else a browser needs to install", () => {
    expect(installHelp({ userAgent: CHROME, secure: false, maxTouchPoints: 0 })).toContain("HTTPS");
    expect(installHelp({ userAgent: ANDROID, secure: false, maxTouchPoints: 5 })).toContain("HTTPS");
  });
});

describe("showInstallButton", () => {
  it("offers the sidebar button only for a one-tap install this device has not closed", () => {
    expect(showInstallButton({ installed: false, canInstall: true, dismissed: false })).toBe(true);
  });

  it("hides it where the browser has no prompt to show (iOS, plain HTTP, Firefox)", () => {
    expect(showInstallButton({ installed: false, canInstall: false, dismissed: false })).toBe(false);
  });

  it("hides it once the app is installed or this device closed the button", () => {
    expect(showInstallButton({ installed: true, canInstall: true, dismissed: false })).toBe(false);
    expect(showInstallButton({ installed: false, canInstall: true, dismissed: true })).toBe(false);
  });
});

describe("the closed install button", () => {
  const memoryStorage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
  };

  it("is remembered on this device once closed", () => {
    const storage = memoryStorage();
    expect(readInstallDismissed(storage)).toBe(false);
    writeInstallDismissed(storage);
    expect(readInstallDismissed(storage)).toBe(true);
  });

  it("reads as open and does not throw where storage is blocked, so it lasts only until the page reloads", () => {
    const blocked = {
      getItem: (): string | null => { throw new Error("storage blocked"); },
      setItem: (): void => { throw new Error("storage blocked"); },
    };
    expect(readInstallDismissed(blocked)).toBe(false);
    expect(() => writeInstallDismissed(blocked)).not.toThrow();
  });
});
