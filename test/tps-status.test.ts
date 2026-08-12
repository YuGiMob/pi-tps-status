import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getSettingsListTheme: vi.fn(),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class {},
}));

import { SettingsStore, TpsMeter, validateConfig, type TokenSpeedConfig } from "../index.js";

const baseConfig: TokenSpeedConfig = {
  display: "tps",
  tpsSlow: 0,
  tpsMedium: 15,
  tpsFast: 30,
  tpsBlazing: 45,
  colorSlow: "#ff4444",
  colorMedium: "#ffaa00",
  colorFast: "#00ff88",
  colorBlazing: "#44ddff",
  slidingWindow: 1000,
  useProviderTokens: true,
  countStrategy: "estimate",
  endTpsBehavior: "average",
};

describe("validateConfig", () => {
  it("returns defaults for empty input", () => {
    const { config, errors } = validateConfig(undefined);
    expect(config.display).toBe("tps");
    expect(config.slidingWindow).toBe(1000);
    expect(config.tpsSlow).toBe(0);
    expect(config.countStrategy).toBe("provider");
    expect(errors).toEqual([]);
  });

  it("accepts valid overrides", () => {
    const { config, errors } = validateConfig({
      display: "full",
      tpsBlazing: 60,
      slidingWindow: 5000,
      useProviderTokens: false,
      countStrategy: "direct",
      endTpsBehavior: "last",
    });
    expect(config.display).toBe("full");
    expect(config.tpsBlazing).toBe(60);
    expect(config.slidingWindow).toBe(5000);
    expect(config.useProviderTokens).toBe(false);
    expect(config.countStrategy).toBe("direct");
    expect(config.endTpsBehavior).toBe("last");
    expect(errors).toEqual([]);
  });

  it("falls back on invalid enum values", () => {
    const { config, errors } = validateConfig({ display: "bogus", countStrategy: "nope" });
    expect(config.display).toBe("tps");
    expect(config.countStrategy).toBe("provider");
    expect(errors).toHaveLength(2);
  });

  it("reports non-ascending thresholds", () => {
    const { errors } = validateConfig({ tpsSlow: 50, tpsMedium: 10 });
    expect(errors.some((e) => e.includes("strictly ascending"))).toBe(true);
  });

  it("rejects invalid colors and out-of-range numbers", () => {
    const { config, errors } = validateConfig({ colorFast: "red", slidingWindow: 5 });
    expect(config.colorFast).toBe("#00ff88");
    expect(config.slidingWindow).toBe(1000);
    expect(errors).toHaveLength(2);
  });
});

describe("TpsMeter", () => {
  let meter: TpsMeter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    meter = new TpsMeter();
    meter.configure(baseConfig);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with zero tokens and null rate", () => {
    expect(meter.tokens).toBe(0);
    expect(meter.tps).toBeNull();
  });

  it("counts estimate strategy tokens as chars/4", () => {
    meter.start();
    meter.recordDelta("abcdefgh");
    expect(meter.tokens).toBe(2);
    expect(meter.tpsSource).toBe("estimate");
  });

  it("counts direct strategy as one token per delta", () => {
    meter.configure({ ...baseConfig, countStrategy: "direct" });
    meter.start();
    meter.recordDelta("abcdefgh");
    meter.recordDelta("x");
    expect(meter.tokens).toBe(2);
    expect(meter.tpsSource).toBe("direct");
  });

  it("does not count deltas with provider-only strategy", () => {
    meter.configure({ ...baseConfig, countStrategy: "provider" });
    meter.start();
    meter.recordDelta("abcdefgh");
    expect(meter.tokens).toBe(0);
  });

  it("ignores deltas while not streaming", () => {
    meter.recordDelta("abcdefgh");
    expect(meter.tokens).toBe(0);
  });

  it("computes window rate from samples", () => {
    meter.start();
    meter.recordDelta("a".repeat(40));
    vi.advanceTimersByTime(1000);
    meter.recordDelta("a".repeat(40));
    expect(meter.tps).toBe(10);
  });

  it("pauses tool execution time out of the rate", () => {
    meter.start();
    meter.pause();
    vi.advanceTimersByTime(2000);
    meter.resume();
    meter.recordDelta("a".repeat(40));
    vi.advanceTimersByTime(1000);
    meter.stop();
    expect(meter.elapsedSeconds).toBeCloseTo(1, 1);
    expect(meter.tps).toBe(10);
  });

  it("reconciles provider totals", () => {
    meter.start();
    meter.recordDelta("a".repeat(40));
    meter.reconcile(50);
    expect(meter.tokens).toBe(60);
    meter.stop();
    expect(meter.tpsSource).toBe("provider");
  });

  it("keeps uncovered fallback tokens when provider reports zero", () => {
    meter.start();
    meter.recordDelta("a".repeat(40));
    meter.reconcile(0);
    expect(meter.tokens).toBe(10);
  });

  it("records final provider usage when enabled", () => {
    meter.start();
    meter.recordDelta("a".repeat(40));
    meter.recordFinalUsage(60);
    expect(meter.tokens).toBe(60);
    expect(meter.tpsSource).toBe("provider");
  });

  it("ignores final usage once provider usage was already counted", () => {
    meter.start();
    meter.recordDelta("a".repeat(40));
    meter.recordFinalUsage(60);
    meter.recordFinalUsage(5);
    expect(meter.tokens).toBe(60);
  });

  it("ignores final usage when provider tokens are disabled", () => {
    meter.configure({ ...baseConfig, useProviderTokens: false });
    meter.start();
    meter.recordDelta("a".repeat(40));
    meter.recordFinalUsage(60);
    expect(meter.tokens).toBe(10);
  });


  it("measures ttft", () => {
    meter.startTtft();
    vi.advanceTimersByTime(250);
    meter.stopTtft();
    expect(meter.ttftMs).toBe(250);
  });

  it("returns average rate after stop with average behavior", () => {
    meter.configure({ ...baseConfig, endTpsBehavior: "average" });
    meter.start();
    meter.recordDelta("a".repeat(40));
    vi.advanceTimersByTime(1000);
    meter.stop();
    expect(meter.tps).toBe(10);
  });

  it("freezes the last window rate after stop with last behavior", () => {
    meter.configure({ ...baseConfig, endTpsBehavior: "last" });
    meter.start();
    meter.recordDelta("a".repeat(40));
    vi.advanceTimersByTime(1000);
    meter.recordDelta("a".repeat(40));
    vi.advanceTimersByTime(1000);
    meter.stop();
    expect(meter.tps).toBe(10);
  });
});

describe("SettingsStore", () => {
  async function withTempHome(run: (tmpHome: string) => Promise<void>): Promise<void> {
    const tmpHome = await mkdtemp(join(tmpdir(), "pi-tps-status-config-test-"));
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("XDG_CONFIG_HOME", "");
    try {
      await run(tmpHome);
    } finally {
      vi.unstubAllEnvs();
      await rm(tmpHome, { recursive: true, force: true });
    }
  }

  it("defaults when no config file exists", async () => {
    await withTempHome(async () => {
      const store = new SettingsStore();
      await store.initialize();
      expect(store.config.countStrategy).toBe("provider");
      expect(store.validationErrors).toEqual([]);
    });
  });

  it("persists updates to ~/.config/pi-tps-status/config.json", async () => {
    await withTempHome(async (tmpHome) => {
      const store = new SettingsStore();
      await store.update({ display: "full" });
      const raw = JSON.parse(
        await readFile(join(tmpHome, ".config", "pi-tps-status", "config.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(raw.display).toBe("full");
      expect(raw.countStrategy).toBe("provider");
      const reloaded = new SettingsStore();
      await reloaded.initialize();
      expect(reloaded.config.display).toBe("full");
    });
  });

  it("honors XDG_CONFIG_HOME when set", async () => {
    await withTempHome(async (tmpHome) => {
      const xdg = join(tmpHome, "xdg");
      vi.stubEnv("XDG_CONFIG_HOME", xdg);
      const store = new SettingsStore();
      await store.update({ display: "stats" });
      const raw = JSON.parse(
        await readFile(join(xdg, "pi-tps-status", "config.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(raw.display).toBe("stats");
    });
  });

  it("leaves no temp files behind", async () => {
    await withTempHome(async (tmpHome) => {
      const store = new SettingsStore();
      await store.update({ display: "tps" });
      await store.update({ display: "full" });
      const entries = await readdir(join(tmpHome, ".config", "pi-tps-status"));
      expect(entries).toEqual(["config.json"]);
    });
  });

  it("falls back to defaults on a corrupted config file", async () => {
    await withTempHome(async (tmpHome) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const configDir = join(tmpHome, ".config", "pi-tps-status");
        await mkdir(configDir, { recursive: true });
        await writeFile(join(configDir, "config.json"), "{not json", "utf8");
        const store = new SettingsStore();
        await store.initialize();
        expect(store.config.display).toBe("tps");
        expect(store.validationErrors).toEqual([]);
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
